const { test, expect, chromium } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// PR #153: モバイル版のインライン CSS を renderer/mobile.css へ分離した変更の
// end-to-end 確認（外部 CSS 化のデグレを検知するための回帰スペック）。
//   - GET /mobile.css / /shared.css が HTTP 200 かつ Content-Type: text/css で返る。
//   - mobile.html は外部 CSS の <link rel="stylesheet"> を持ち、
//     実ブラウザで開いたときに外部 CSS が実際に適用される（無スタイル=真っ白ではない）。

// HTTP サーバーが起きて / が 200 を返せるようになるまで待つ。
async function waitForServer(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 200) return;
    } catch (_e) { /* 起動前の失敗は吸収 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('HTTP server did not become ready in time');
}

async function launchCssApp(port) {
  return await launchApp({ port, prefix: 'vk-terminals-e2e-css-' });
}

// ─── GET /mobile.css が 200 / text/css で配信される ───
test('GET /mobile.css が HTTP 200 かつ Content-Type: text/css で返る', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchCssApp(port);
  try {
    await waitForServer(port);

    const res = await fetch(`http://127.0.0.1:${port}/mobile.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);

    const body = await res.text();
    // 移設された CSS の中身が実際に配信されていること（代表的なセレクタ）。
    expect(body).toContain('.card');
    expect(body.length).toBeGreaterThan(1000);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

// ─── GET /shared.css が 200 / text/css で配信される ───
test('GET /shared.css が HTTP 200 かつ Content-Type: text/css で返る', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchCssApp(port);
  try {
    await waitForServer(port);

    const res = await fetch(`http://127.0.0.1:${port}/shared.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);

    const body = await res.text();
    // PC / モバイル共通の tone トークン定義が実際に配信されていること。
    expect(body).toContain('.task-list [data-tone="warning"]');
    expect(body).toContain('--wtone-fg');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

// ─── 実ブラウザで開いたとき外部 CSS が適用される（無スタイルで崩れていない）───
test('モバイルページを実ブラウザで開くと外部 CSS が適用される', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchCssApp(port);
  const browser = await chromium.launch();
  try {
    await waitForServer(port);

    const context = await browser.newContext();
    const page = await context.newPage();

    // mobile.css のレスポンスを傍受して 200 を確認する。
    const cssResponses = [];
    page.on('response', (r) => {
      if (r.url().endsWith('/mobile.css')) cssResponses.push(r.status());
    });

    await page.goto(`http://127.0.0.1:${port}/`);
    await page.waitForLoadState('networkidle');

    // 1) mobile.css が 404 ではなく 200 で読み込まれた。
    expect(cssResponses.length).toBeGreaterThan(0);
    expect(cssResponses).toContain(200);

    // 2) CSS 変数由来のダーク背景（--bg: #14171c → rgb(20, 23, 28)）が body に適用されている。
    //    外部 CSS が 404 なら真っ白（rgba(0,0,0,0) 等）になり、この検証が落ちる。
    const bodyBg = await page.locator('body').evaluate(
      (el) => getComputedStyle(el).backgroundColor
    );
    expect(bodyBg).toBe('rgb(20, 23, 28)');

    // 3) header が sticky 配置（CSS 適用の証跡）であること。
    const headerPosition = await page.locator('header').evaluate(
      (el) => getComputedStyle(el).position
    );
    expect(headerPosition).toBe('sticky');
  } finally {
    await browser.close();
    await closeApp({ app, tmpRoot });
  }
});
