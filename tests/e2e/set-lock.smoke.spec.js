const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #173: オーケストレーター専用ペインを誤操作で閉じないための
// close ロックを、HTTP API → IPC → renderer UI → closePane 防御まで統合確認する。

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

function findPaneIdByTermId(states, termId) {
  return Object.keys(states).find((paneId) => String(states[paneId]?.termId) === String(termId)) || null;
}

async function waitForTermId(port, termId, shouldExist, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      const ids = termIdsOf(states);
      lastSeen = ids;
      const exists = ids.includes(String(termId));
      if (exists === shouldExist) return states;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じ待機ループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `termId ${termId} did not reach exists=${shouldExist} in time. last states: ${JSON.stringify(lastSeen)}`
  );
}

async function postJson(port, pathname, payload) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch (_e) { /* 非 JSON 応答も診断用に許容 */ }
  return { status: res.status, body };
}

async function launchLockApp(port) {
  return await launchApp({ port, prefix: 'vk-terminals-e2e-lock-' });
}

test('close ロック中のペインは UI で閉じられず、/api/close-pane では閉じられる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchLockApp(port);

  try {
    // 起動直後の最初のペインが登録されるまで待ってから、検証対象の追加ペインを作る。
    await waitForTermId(port, '1', true);
    const created = await postJson(port, '/api/new-pane', { noClaude: true });
    expect(created.status).toBe(200);
    expect(created.body && created.body.ok).toBe(true);
    const targetTermId = String(created.body.termId);

    const statesWithTarget = await waitForTermId(port, targetTermId, true);
    const targetPaneId = findPaneIdByTermId(statesWithTarget, targetTermId);
    expect(targetPaneId).toBeTruthy();

    const pane = win.locator(`.pane[data-id="${targetPaneId}"]`);
    const closeBtn = pane.locator('.btn-close');
    await expect(closeBtn).toBeVisible({ timeout: 10_000 });

    // HTTP API で close ロックを入れる。renderer は IPC 受信後にボタン属性を局所更新する。
    const locked = await postJson(port, '/api/set-lock', { termId: targetTermId, lock: { close: false } });
    expect(locked.status).toBe(200);
    expect(locked.body && locked.body.ok).toBe(true);

    await expect(closeBtn).toHaveAttribute('aria-disabled', 'true');
    await expect(closeBtn).toHaveClass(/\bis-locked\b/);
    await expect(closeBtn).toHaveAttribute('aria-label', 'このペインは保護されています（閉じられません）');

    // UI クリックは JS ハンドラと closePane の二重防御で無視され、対象ペインは残る。
    await closeBtn.click({ force: true });
    await win.waitForTimeout(1500);
    await expect(pane).toHaveCount(1);
    expect(termIdsOf(await getStates(port))).toContain(targetTermId);

    // 一方で HTTP API からの明示的 close は force 経路なので、ロック中でも閉じられる。
    const closed = await postJson(port, '/api/close-pane', { termId: targetTermId });
    expect(closed.status).toBe(200);
    expect(closed.body && closed.body.ok).toBe(true);
    await waitForTermId(port, targetTermId, false);
    await expect(pane).toHaveCount(0);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('close ロック中のペインもプロセス自然終了時はクリーンアップされる', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchLockApp(port);

  try {
    await waitForTermId(port, '1', true);
    const created = await postJson(port, '/api/new-pane', { noClaude: true });
    expect(created.status).toBe(200);
    expect(created.body && created.body.ok).toBe(true);
    const targetTermId = String(created.body.termId);

    await waitForTermId(port, targetTermId, true);

    const locked = await postJson(port, '/api/set-lock', { termId: targetTermId, lock: { close: false } });
    expect(locked.status).toBe(200);
    expect(locked.body && locked.body.ok).toBe(true);

    const sent = await postJson(port, '/api/send', { termId: targetTermId, input: 'exit\n' });
    expect(sent.status).toBe(200);
    expect(sent.body && sent.body.ok).toBe(true);

    await waitForTermId(port, targetTermId, false);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
