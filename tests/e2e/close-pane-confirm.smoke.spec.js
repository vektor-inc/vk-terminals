const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #184: 誤クローズ防止。ペインの ✕ ボタンで閉じる時に、config の
// `confirmClose`（never / busy / always・既定 busy）と status に応じて
// アプリ内確認ダイアログ（.confirm-overlay）を挟む変更の end-to-end 確認。
//   - busy（既定）: waiting のペインは確認あり（キャンセルで無傷 / 承認で終了）、idle は確認なし
//   - always: idle でも確認あり
//   - never: waiting でも確認なし
// HTTP API 経由（force）は従来どおり確認なし（close-pane.smoke.spec.js が担保）。

// GET /api/states を叩き、terminals（paneId -> state）を返す。
async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return json.terminals || {};
}

function termIdsOf(states) {
  return Object.values(states)
    .map((t) => (t && t.termId != null ? String(t.termId) : null))
    .filter(Boolean);
}

// 指定 termId が states に現れる / 消えるまで待つ（report-states は 2 秒間隔）。
async function waitForTermId(port, termId, shouldExist, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      const ids = termIdsOf(states);
      lastSeen = ids;
      if (ids.includes(String(termId)) === shouldExist) return ids;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `termId ${termId} did not reach exists=${shouldExist} in time. last states: ${JSON.stringify(lastSeen)}`
  );
}

// 指定 termId のペインが目的の status になるまで待ち、paneId を返す。
async function waitForStatus(port, termId, status, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      for (const [paneId, t] of Object.entries(states)) {
        if (t && String(t.termId) === String(termId)) {
          last = t.status;
          if (t.status === status) return paneId;
        }
      }
    } catch (_e) { /* 起動待ちと同様に吸収 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`termId ${termId} did not become ${status} in time (last: ${last})`);
}

async function postJson(port, pathname, payload) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch (_e) { /* 非 JSON 応答も診断のため許容 */ }
  return { status: res.status, body };
}

// 一時 HOME に confirmClose を含む config を書き、素のシェル（--no-claude）で起動する。
async function launchConfirmApp(port, configOverrides = {}) {
  return await launchApp({
    port,
    prefix: 'vk-terminals-e2e-confirm-',
    config: configOverrides,
  });
}

// 終了対象の追加ペインを作り、waiting にして paneId を返す共通手順。
async function createWaitingPane(port) {
  const created = await postJson(port, '/api/new-pane', { noClaude: true });
  expect(created.status).toBe(200);
  const termId = String(created.body.termId);
  await waitForTermId(port, termId, true);
  const set = await postJson(port, '/api/set-status', { termId, waiting: true });
  expect(set.status).toBe(200);
  const paneId = await waitForStatus(port, termId, 'waiting');
  return { termId, paneId };
}

test('confirmClose 既定（busy）: waiting のペインは確認あり・idle は確認なし', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchConfirmApp(port); // confirmClose 未指定 = 既定 busy
  try {
    await waitForTermId(port, '1', true);
    const { termId, paneId } = await createWaitingPane(port);
    const closeBtn = win.locator(`.pane[data-id="${paneId}"] .btn-close`);
    const overlay = win.locator('.confirm-overlay');

    // サイドバーを開いた状態に揃え、確認ダイアログの Escape が背後へ届かないことも見る。
    const sidebarOpen = await win.locator('#root').evaluate(
      (root) => root.classList.contains('sidebar-open')
    );
    if (!sidebarOpen) await win.locator('#menu-btn').click();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // (1) ✕ → 確認ダイアログが出る → Escape でキャンセル → ペイン・PTY とも無傷で残る。
    await closeBtn.click();
    await expect(overlay).toBeVisible();
    await win.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
    // サイドバーを閉じたときの遅延フォーカス時間（約 220ms）を越えても、
    // ダイアログを開いた操作元の ✕ ボタンへフォーカスが戻ったままかを確かめる。
    await win.waitForTimeout(400);
    await expect(closeBtn).toBeFocused();
    await new Promise((r) => setTimeout(r, 2500)); // report-states 1 周期分待って残存を確認
    expect(termIdsOf(await getStates(port))).toContain(termId);

    // (2) ✕ → 確認ダイアログ → 「閉じる」 → ペインが終了する。
    await closeBtn.click();
    await expect(overlay).toBeVisible();
    await win.locator('.confirm-close-pane').click();
    await expect(overlay).toHaveCount(0);
    await waitForTermId(port, termId, false);

    // (3) idle のペインは確認なしで即閉じる。
    const created = await postJson(port, '/api/new-pane', { noClaude: true });
    expect(created.status).toBe(200);
    const idleTermId = String(created.body.termId);
    await waitForTermId(port, idleTermId, true);
    // 起動直後のシェル出力による running が収まり idle になるまで待つ。
    const idlePaneId = await waitForStatus(port, idleTermId, 'idle');
    await win.locator(`.pane[data-id="${idlePaneId}"] .btn-close`).click();
    await expect(overlay).toHaveCount(0);
    await waitForTermId(port, idleTermId, false);

    // 最初のペイン（"1"）は一連の操作後も残っていること。
    expect(termIdsOf(await getStates(port))).toContain('1');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('confirmClose: always は idle でも確認あり', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchConfirmApp(port, { confirmClose: 'always' });
  try {
    await waitForTermId(port, '1', true);
    const created = await postJson(port, '/api/new-pane', { noClaude: true });
    expect(created.status).toBe(200);
    const termId = String(created.body.termId);
    await waitForTermId(port, termId, true);
    const paneId = await waitForStatus(port, termId, 'idle');

    const overlay = win.locator('.confirm-overlay');
    await win.locator(`.pane[data-id="${paneId}"] .btn-close`).click();
    await expect(overlay).toBeVisible();
    await win.locator('.confirm-close-pane').click();
    await waitForTermId(port, termId, false);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('confirmClose: never は waiting でも確認なしで閉じる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchConfirmApp(port, { confirmClose: 'never' });
  try {
    await waitForTermId(port, '1', true);
    const { termId, paneId } = await createWaitingPane(port);

    await win.locator(`.pane[data-id="${paneId}"] .btn-close`).click();
    await expect(win.locator('.confirm-overlay')).toHaveCount(0);
    await waitForTermId(port, termId, false);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
