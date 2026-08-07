const { test, expect, chromium } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// PR #221 / issue #217: モバイル版の「ペインを追加」ボタンの検証。
//
// モバイルページ（renderer/mobile.html）のペイン一覧（#list）の直後に
// 全幅の「＋ ペインを追加」ボタン（#add-pane-btn）を追加した。タップで
// POST /api/new-pane（body { useDefaults: true }）を呼び、新規ペインを開く。
//
// 検証手法は既存の mobile 系 spec（mobile-preview-order-scroll.smoke.spec.js 等）を
// 踏襲する。一時 HOME + `--no-claude` で Electron を起動し、VK_TERMINALS_API_PORT で
// 空きポートを指定 → chromium で mobile.html を HTTP で開いて実描画・実操作を検証する。
// config で newPaneAutoLaunchClaude:false としているため、ボタン押下（useDefaults:true）
// でも新ペインは素のシェル（noClaude:true）で開き、claude 実バイナリは起動しない。

// /api/states を node 側から直接取得してペイン数を数える（ページのポーリングとは別経路）。
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

// 指定した最小ペイン数に達するまで /api/states をポーリングして待つ。
async function waitForPaneCount(port, expectedCount, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const ids = termIdsOf(await getStates(port));
      lastSeen = ids;
      if (ids.length >= expectedCount) return ids;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`pane count did not reach ${expectedCount} in time. last: ${JSON.stringify(lastSeen)}`);
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
// newPaneAutoLaunchClaude:false により、ボタン経由の新ペインも素のシェルで開く。
// 親環境（vk-orchestrator 等）の VK_TERMINALS_SETTINGS の中和はヘルパーが既定で行う。
async function launchAddPaneApp(port) {
  return await launchApp({
    port,
    prefix: 'vk-terminals-e2e-addpane-',
    config: { newPaneAutoLaunchClaude: false },
  });
}

// issue #348: 4 テストとも同じ config（newPaneAutoLaunchClaude:false）で launchApp を
// 呼んでいるため、起動を 1 回に共有する（describe → describe.serial）。
// 「タップするとペインが1つ増える」だけがペイン数を変えるテストで、絶対値（1→2）
// ではなく直前の件数からの相対値（+1）で検証しているため、このテストが何回・どの
// 順番で実行されても「他にペインを増やすテストが無い」という前提に依存しない
// （安藤のレビュー指摘。以前は絶対値だったため、この前提が厳密には言い過ぎだった）。
// 他の 3 テストはいずれもペイン数を見ない（#list .card を first() で見る／page.route で
// /api/states 自体を差し替える）ため、実行順に関わらず影響しない。chromium の
// browser/context/page は各テストで新規作成しており、ブラウザ側の状態は共有しない。
test.describe.serial('モバイル版「ペインを追加」ボタン（issue #217 / PR #221）', () => {
  let app;
  let tmpRoot;
  let port;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, tmpRoot } = await launchAddPaneApp(port));
    await waitForPaneCount(port, 1);
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  // ── (1) ボタンの存在・配置 ──────────────────────────────────────────────
  // #list の直後の兄弟として #add-pane-btn が表示され、ラベル・アイコンが正しいこと。
  test('#list の直後に「ペインを追加」ボタンが表示される', async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      // 初期ペインのカードが描画されるのを待つ。
      await expect(page.locator('#list .card').first()).toBeVisible({ timeout: 15_000 });

      // ボタンが存在し表示されている。
      const btn = page.locator('#add-pane-btn');
      await expect(btn).toBeVisible();
      // ラベルとアイコン。
      await expect(btn.locator('.add-pane-label')).toHaveText('ペインを追加');
      await expect(btn.locator('.add-pane-icon')).toHaveText('＋');
      await expect(btn).toHaveAttribute('aria-label', 'ペインを追加');

      // #list の「直後の兄弟」であること（#list の外側に静的配置されている）。
      const isNextSibling = await page.evaluate(() => {
        const list = document.getElementById('list');
        const next = list && list.nextElementSibling;
        return !!(next && next.id === 'add-pane-btn');
      });
      expect(isNextSibling).toBe(true);
    } finally {
      await browser.close();
    }
  });

  // ── (2) タップでペインが1つ増える ────────────────────────────────────────
  // ボタンクリックで POST /api/new-pane が呼ばれ、terminals が1件増え、
  // #list の新カードが出現する。
  test('タップするとペインが1つ増える', async () => {
    const browser = await chromium.launch();
    try {
      // 絶対値（1件）ではなく、タップ前の件数からの相対値（+1）で検証する
      // （安藤のレビュー指摘。他にペインを増やすテストが無いという前提を置かずに済む）。
      const before = termIdsOf(await getStates(port));

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);
      await expect(page.locator('#list .card')).toHaveCount(before.length, { timeout: 15_000 });

      // ボタンをタップ。
      await page.locator('#add-pane-btn').click();

      // node 側 /api/states でペインが 1 件増えるまで待つ（POST /api/new-pane が効いた証拠）。
      const after = await waitForPaneCount(port, before.length + 1);
      expect(after.length).toBe(before.length + 1);

      // ページの #list カードも 1 枚増える（ポーリング再描画で反映）。
      await expect(page.locator('#list .card')).toHaveCount(before.length + 1, { timeout: 15_000 });

      // ボタンは操作後、通常状態（有効）に戻っている。
      await expect(page.locator('#add-pane-btn')).toBeEnabled();
      await expect(page.locator('#add-pane-btn')).not.toHaveAttribute('aria-busy', 'true');
    } finally {
      await browser.close();
    }
  });

  // ── (3) 送信中は disabled + aria-busy + 「追加中…」 ─────────────────────────
  // POST /api/new-pane 応答を page.route で意図的に遅延させ、送信中の状態遷移を
  // 決定的に観測する。遅延中は disabled / aria-busy=true / ラベル「追加中…」、
  // 応答後は解除されて「ペインを追加」に戻る。
  test('送信中はボタンが disabled + aria-busy になり「追加中…」表示、完了後に解除される', async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      // /api/new-pane の応答を約1.5秒遅延させ、擬似成功レスポンスを返す。
      // （実ペインは作らないが、送信中→完了の状態遷移の観測が目的）
      await page.route(`http://127.0.0.1:${port}/api/new-pane`, async (route) => {
        await new Promise((r) => setTimeout(r, 1500));
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ ok: true, termId: '999' }),
        });
      });

      await page.goto(`http://127.0.0.1:${port}/`);
      await expect(page.locator('#list .card').first()).toBeVisible({ timeout: 15_000 });

      const btn = page.locator('#add-pane-btn');
      // クリック（応答は遅延中）。
      await btn.click();

      // 送信中: disabled + aria-busy=true + ラベル「追加中…」+ アイコン非表示。
      await expect(btn).toBeDisabled();
      await expect(btn).toHaveAttribute('aria-busy', 'true');
      await expect(btn.locator('.add-pane-label')).toHaveText('追加中…');
      await expect(btn.locator('.add-pane-icon')).toBeHidden();

      // 応答到達後: 解除されて通常表示に戻る。
      await expect(btn).toBeEnabled({ timeout: 10_000 });
      await expect(btn).not.toHaveAttribute('aria-busy', 'true');
      await expect(btn.locator('.add-pane-label')).toHaveText('ペインを追加');
      await expect(btn.locator('.add-pane-icon')).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  // ── (4) 空状態でもボタンが表示される ─────────────────────────────────────
  // /api/states を空（terminals:{}）に差し替え、「稼働中のターミナルがありません」
  // 表示時でも #add-pane-btn が残ること（再びペインを開く唯一の導線）を確認する。
  test('ペイン0件の空状態でもボタンが表示される', async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext();
      const page = await context.newPage();

      // /api/states を空応答に差し替える（/api/widgets は素通しで実応答を使う）。
      await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ terminals: {}, updatedAt: Date.now() }),
        });
      });

      await page.goto(`http://127.0.0.1:${port}/`);

      // 空状態メッセージが表示される。
      await expect(page.locator('#empty')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#empty')).toHaveText('稼働中のターミナルがありません');
      // カードは0枚。
      await expect(page.locator('#list .card')).toHaveCount(0);
      // それでもボタンは表示され続ける。
      await expect(page.locator('#add-pane-btn')).toBeVisible();
      await expect(page.locator('#add-pane-btn .add-pane-label')).toHaveText('ペインを追加');
    } finally {
      await browser.close();
    }
  });
});
