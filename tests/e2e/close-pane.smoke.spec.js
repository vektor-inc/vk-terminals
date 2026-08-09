const { test, expect, chromium } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #100 / PR #101: モバイル Web UI から HTTP API 経由でデスクトップ側の
// ペイン（ターミナル）を終了（kill）できるようにした変更の end-to-end 確認。
//   POST /api/new-pane で作成 → GET /api/states で termId 確認 →
//   POST /api/close-pane { termId } → /api/states から当該 termId が消える、を実機 Electron で検証する。

// GET /api/states を叩き、terminals（paneId -> state）を返す。
async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return json.terminals || {};
}

// states 内に存在する termId の一覧（文字列）を返す。
function termIdsOf(states) {
  return Object.values(states)
    .map((t) => (t && t.termId != null ? String(t.termId) : null))
    .filter(Boolean);
}

// 指定 termId が states に現れる / 消えるまで短くリトライして待つ。
// report-states は renderer 側で 2 秒ごとに送られるため、猶予を持って待機する。
async function waitForTermId(port, termId, shouldExist, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      const ids = termIdsOf(states);
      lastSeen = ids;
      const exists = ids.includes(String(termId));
      if (exists === shouldExist) return ids;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じループで吸収する。
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
  try { body = await res.json(); } catch (_e) { /* 非 JSON 応答も診断のため許容 */ }
  return { status: res.status, body };
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
// 実ユーザーの ~/.vk-terminals/config.json に依存しないよう、HOME の一時化はヘルパーが行う。
async function launchClosePaneApp(port) {
  return await launchApp({ port, prefix: 'vk-terminals-e2e-close-' });
}

// issue #348: 3 テストとも env/config の指定なしで launchApp を呼んでいるため、
// 起動を 1 回に共有する。各テストは自分で作った新規ペインを最終的に閉じて終わる
// （テスト2は新規ペイン自体を作らない異常系のみ）ため、テスト終了時点で常に
// 「最初のペイン（termId '1'）だけが残る」状態に戻り、順序に依存しない。
test.describe.serial('POST /api/close-pane によるペイン終了（issue #100 / PR #101）', () => {
  let app;
  let tmpRoot;
  let port;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, tmpRoot } = await launchClosePaneApp(port));
    // 起動直後の最初のペイン（termId "1"）が登録されるまで待つ。
    await waitForTermId(port, '1', true);
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test('POST /api/close-pane で作成したペインが終了し /api/states から消える', async () => {
    // 追加ペインを作成する（claude を起動しない素のシェル）。
    const created = await postJson(port, '/api/new-pane', { noClaude: true });
    expect(created.status).toBe(200);
    expect(created.body).toBeTruthy();
    expect(created.body.ok).toBe(true);
    const newTermId = String(created.body.termId);
    expect(newTermId).toBeTruthy();

    // states に新規 termId が現れることを確認する。
    await waitForTermId(port, newTermId, true);

    // 本命: close-pane で新規ペインを終了する。200 と ok:true が返る。
    const closed = await postJson(port, '/api/close-pane', { termId: newTermId });
    expect(closed.status).toBe(200);
    expect(closed.body).toBeTruthy();
    expect(closed.body.ok).toBe(true);
    expect(String(closed.body.termId)).toBe(newTermId);

    // states から当該 termId が消えることを確認する（レンダラ closePane → report-states 反映）。
    const remaining = await waitForTermId(port, newTermId, false);
    // 最初のペイン（"1"）は残っていること = 対象だけをピンポイントで閉じられている。
    expect(remaining).toContain('1');
  });

  test('POST /api/close-pane の異常系（存在しない termId は 404 / termId 欠落は 400）', async () => {
    // 存在しない termId → 404。誤って別ペインを閉じないための境界確認。
    const notFound = await postJson(port, '/api/close-pane', { termId: '999999' });
    expect(notFound.status).toBe(404);
    expect(notFound.body && notFound.body.error).toBeTruthy();

    // termId 欠落 → 400。
    const missing = await postJson(port, '/api/close-pane', {});
    expect(missing.status).toBe(400);
    expect(missing.body && missing.body.error).toBeTruthy();

    // 異常系リクエスト後も最初のペインは無事に残っていること。
    const states = await getStates(port);
    expect(termIdsOf(states)).toContain('1');
  });

  test('モバイルページ: 終了ボタンと確認ダイアログ（却下でペイン残存 / 承認で終了）', async () => {
    const browser = await chromium.launch();
    try {
      // 終了対象の追加ペインを作成する（termId は 2 以降の連番）。
      const created = await postJson(port, '/api/new-pane', { noClaude: true });
      expect(created.status).toBe(200);
      const targetId = String(created.body.termId);
      await waitForTermId(port, targetId, true);

      // モバイル Web UI（mobile.html）を実ブラウザで開く。ページは同一オリジンで /api/* を叩く。
      const page = await browser.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      // 対象ペインのカード（タイトル未設定なので "Terminal <id>" 表示）内の終了ボタンを特定する。
      const targetCard = page.locator('.card', { hasText: `Terminal ${targetId}` });
      const killBtn = targetCard.locator('button.kill');
      await expect(killBtn).toBeVisible({ timeout: 10_000 });
      await expect(killBtn).toHaveText('✕ ターミナルを終了');

      // (1) 確認ダイアログを「却下」する → close-pane は呼ばれず、ペインは残る。
      page.once('dialog', (dialog) => dialog.dismiss());
      await killBtn.click();
      // 却下直後は API を叩いていないはず。念のため少し待ってから states を確認する。
      await page.waitForTimeout(1500);
      expect(termIdsOf(await getStates(port))).toContain(targetId);

      // (2) 確認ダイアログを「承認」する → close-pane が呼ばれ、ペインが終了する。
      page.once('dialog', (dialog) => dialog.accept());
      await killBtn.click();
      // states から消えることを確認する（API → renderer closePane → report-states 反映）。
      await waitForTermId(port, targetId, false);
      // UI 側でも該当カードが消える（ポーリング再描画で除去）。
      await expect(targetCard).toHaveCount(0, { timeout: 10_000 });
      // 最初のペインのカードは残っていること。
      await expect(page.locator('.card', { hasText: 'Terminal 1' })).toBeVisible();
    } finally {
      await browser.close();
    }
  });
});
