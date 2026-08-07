const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// 環境変数 VK_TERMINALS_APP_TITLE によるアプリ名上書きの end-to-end 確認。
//   - デスクトップ（renderer/index.html）のヘッダー .app-title が上書き名になる。
//   - GET /api/states のレスポンス JSON に appTitle（= 上書き名）が含まれる。
//   - モバイルページ（renderer/mobile.html）の <h1> とバージョンフッターが上書き名になる。
// 呼び出し元（例: vk-orchestrator）が 'VK Orchestrator' を渡すユースケースの回帰を守る。

const OVERRIDE_TITLE = 'VK Orchestrator';
const repoRoot = path.resolve(__dirname, '..', '..');
const pkgVersion = require(path.join(repoRoot, 'package.json')).version;

// /api/states が appTitle を返し始めるまで短くリトライして待つ。
//
// issue #347: fetch は既定でレスポンス待ちに上限を持たない。以前は 1 回の
// fetch にタイムアウトを与えていなかったため、サーバー側が応答を返せない
// 状態になると、この await から戻らずループの deadline 判定（Date.now() <
// deadline）に一度も到達できなかった。これが「1 回目は timeout（120 秒）を
// 使い切り、やり直しは 5 秒で成功する」という不安定さの原因だった。
// 1 回あたりの上限は 1〜5 秒の範囲に収め、リトライのたびに deadline 判定へ
// 必ず戻れるようにする（Math.max(1000, ...) があるため、deadline までの残りが
// 1000ms 未満でも最低 1000ms は待つ。その場合 deadline を数百 ms 超えることが
// あるが、無期限に戻らなくなることは無い）。
async function waitForStatesWithAppTitle(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastJson = null;
  let lastError = null;
  while (Date.now() < deadline) {
    const remainingMs = deadline - Date.now();
    const perRequestTimeoutMs = Math.max(1000, Math.min(5_000, remainingMs));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/states`, {
        signal: AbortSignal.timeout(perRequestTimeoutMs),
      });
      if (res.status === 200) {
        const json = await res.json();
        lastJson = json;
        if (typeof json.appTitle === 'string' && json.appTitle) return json;
      }
    } catch (e) {
      // 起動前の接続失敗・1 回分のタイムアウトは同じループで吸収する。
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `/api/states did not return appTitle in time (${timeoutMs}ms). `
      + `last json: ${JSON.stringify(lastJson)}`
      + (lastError ? ` last error: ${lastError.message}` : ''),
  );
}

// 一時 HOME を用意し、VK_TERMINALS_APP_TITLE を付与して Electron を起動する。
// ヘルパーは既定でこの変数を空文字へ中和するため、上書き名は env で明示的に opt-in する。
async function launchTitleOverrideApp(port) {
  return await launchApp({
    port,
    prefix: 'vk-terminals-e2e-title-',
    env: { VK_TERMINALS_APP_TITLE: OVERRIDE_TITLE },
  });
}

// ─── デスクトップのヘッダー .app-title が上書き名になり、/api/states にも反映される ───
test('デスクトップ: VK_TERMINALS_APP_TITLE でヘッダーと /api/states の appTitle が上書きされる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchTitleOverrideApp(port);
  try {
    const json = await waitForStatesWithAppTitle(port);
    expect(json.appTitle).toBe(OVERRIDE_TITLE);

    const titleEl = win.locator('.app-title');
    await expect(titleEl).toHaveText(OVERRIDE_TITLE, { timeout: 15_000 });
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

// ─── モバイルページの <h1> とバージョンフッターが上書き名になる ───
//
// issue #347: この spec 単体で待ちの最悪値を合計すると既定の 120 秒
// （playwright.config.js の timeout）を超える。起動予算（launchApp の
// BOOT_TOTAL_BUDGET_MS = 60 秒。実測 ~7 秒の 8.5 倍に取った上限で、期待消費では
// ない）に加えて、Electron と Chromium の 2 つを起動するため chromium.launch() /
// page.goto() の待ちも積む。式の最大項（起動予算）を膨らませたまま実在する操作
// （Chromium のコールドスタート等）側の上限を削って辻褄を合わせるのは、削る側を
// 間違える（Electron を並べた高負荷下では Chromium の新規コールドスタートに
// Playwright の既定 30 秒すら余裕が無いことがある）。上限を明示すること自体は
// 必要な修正（無制限の待ちが本当の欠陥）だが、値は現実的な水準に保ち、この spec
// だけ test.setTimeout() で枠を広げる。
test('モバイル: <h1> とフッターが VK_TERMINALS_APP_TITLE の上書き名になる', async () => {
  // この spec だけは Electron と Chromium の 2 つを起動するため、既定の 120 秒では
  // 待ちの最悪値の合計が収まらない。枠に合わせて各操作を削るのではなく、枠を広げる。
  test.setTimeout(180_000);

  const port = await getFreePort();
  const { app, tmpRoot } = await launchTitleOverrideApp(port);
  try {
    // chromium.launch() が try の外・Electron 起動後にあり、chromium の起動に
    // 失敗すると Electron と一時 HOME が漏れる問題があった。closeApp を必ず通す
    // 外側の try/finally と、browser.close() を必ず通す内側の try/finally に分け、
    // どちらで失敗しても両方解放されるようにする。
    const browser = await chromium.launch({ timeout: 30_000 });
    try {
      // デスクトップ側（20 秒）と同じ上限に揃える（同じ関数を同じファイル内で
      // 違う上限で呼ぶと、どちらが本来の想定かが読み手に伝わらない）。
      await waitForStatesWithAppTitle(port, 20_000);

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`, { timeout: 15_000 });

      const heading = page.locator('header h1');
      await expect(heading).toHaveText(OVERRIDE_TITLE, { timeout: 15_000 });

      const footer = page.locator('#app-version-footer');
      await expect(footer).toBeVisible({ timeout: 15_000 });
      await expect(footer).toHaveText(`${OVERRIDE_TITLE} v${pkgVersion}`, { timeout: 15_000 });
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
