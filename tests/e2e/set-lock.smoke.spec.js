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

// issue #348: 2 テストとも env/config の指定なしで launchApp を呼んでいるため、
// 起動を 1 回に共有する。いずれのテストも自分で作った新規ペインを最終的に消して
// 終わる（テスト1は /api/close-pane、テスト2は exit 送信での自然終了）ため、
// テスト終了時点で常に「最初に作った新規ペインが消え、reload 直後にあった 1 枚だけが
// 残る」状態に戻る。ただし win.reload() のたびに main.js の nextId は進むため、
// 残るペインの termId は '1' 固定ではなく '2'、'3' … と変わっていく（安藤のレビュー
// 指摘）。このファイルは termId を固定値で参照せず、常に /api/new-pane の応答から
// 得た termId を使っているため、この点自体はテストの正しさに影響しない。
// win 側は closeBtn の属性を局所更新するだけで、次テストの beforeEach で
// win.reload() すれば初期状態に戻る。
test.describe.serial('close ロック（issue #173）', () => {
  let app;
  let win;
  let tmpRoot;
  let port;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp({ port, prefix: 'vk-terminals-e2e-lock-' }));
    await waitForTermId(port, '1', true);
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
    // #sidebar は setupSidebarMenu() が initApp() より前（renderer/app.js のスクリプト
    // 評価時点、load イベントより前）に付けるため、初期化完了の指標にならない
    // （安藤のレビュー指摘）。initApp() は app:get-config の IPC 往復と
    // terminal:create（node-pty の spawn）を待つため、load 後もしばらく未完了で、
    // その間 tree は null のまま。ここで /api/new-pane を叩くと、
    // VKIpc.on('terminal:request-new-pane', ...) はモジュール評価時に登録済みなので
    // 受け付けてしまい、targetPaneId が取れず { error: 'no pane available' } を返す。
    // ペインが実際に描画されるまで待ってから次のテストへ進む。
    await expect(win.locator('.pane .xterm-screen').first()).toBeVisible({ timeout: 30_000 });
  });

  test('close ロック中のペインは UI で閉じられず、/api/close-pane では閉じられる', async () => {
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
  });

  test('close ロック中のペインもプロセス自然終了時はクリーンアップされる', async () => {
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
  });
});
