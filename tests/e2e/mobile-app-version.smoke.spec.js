const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #135 / PR #136: モバイル版の最下部に VK Terminals のバージョンを表示する変更の
// end-to-end 確認。
//   - GET /api/states のレスポンス JSON に version（= package.json の version）が含まれる。
//   - モバイルページを開くと最下部の #app-version-footer に
//     「VK Terminals v<version>」が表示され、.show クラスが付いて可視になる。
//   - 既存フィールド（terminals / usage / updatedAt）がデグレせず従来どおり返る（回帰確認）。

const repoRoot = path.resolve(__dirname, '..', '..');
// package.json の version を真実源として読む（main.js も同じ値を返す想定）。
const pkgVersion = require(path.join(repoRoot, 'package.json')).version;

// GET /api/states を叩き、レスポンス JSON をそのまま返す。
async function fetchStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  return await res.json();
}

// /api/states が version を返し始めるまで短くリトライして待つ。
// HTTP サーバー起動直後は fetch が失敗するため、猶予を持って待機する。
async function waitForStatesWithVersion(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastJson = null;
  while (Date.now() < deadline) {
    try {
      const json = await fetchStates(port);
      lastJson = json;
      if (typeof json.version === 'string' && json.version) return json;
    } catch (_e) {
      // 起動前の fetch 失敗は同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`/api/states did not return version in time. last json: ${JSON.stringify(lastJson)}`);
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
// 実ユーザーの config.json への依存を切る HOME の一時化と、フッター表示名を左右する
// VK_TERMINALS_APP_TITLE の中和（既定 'VK Terminals' を使わせる）はヘルパーが行う。
async function launchVersionApp(port) {
  return await launchApp({ port, prefix: 'vk-terminals-e2e-version-' });
}

// ─── GET /api/states のレスポンスに version（= package.json の version）が含まれ、
//     既存フィールドもデグレしていない（回帰確認）───
test('GET /api/states のレスポンスに version が含まれ、既存フィールドも維持されている', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchVersionApp(port);
  try {
    const json = await waitForStatesWithVersion(port);

    // version が package.json と一致すること（本 PR の追加フィールド）。
    expect(json.version).toBe(pkgVersion);

    // 既存フィールドが従来どおり存在すること（回帰確認）。
    expect(json).toHaveProperty('updatedAt');
    expect(typeof json.updatedAt).toBe('string');
    expect(json).toHaveProperty('terminals');
    expect(json.terminals && typeof json.terminals).toBe('object');
    expect(json).toHaveProperty('usage');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

// ─── モバイルページ最下部の #app-version-footer に「VK Terminals v<version>」が
//     表示され、.show が付いて可視になる ───
test('モバイル: 最下部の #app-version-footer に VK Terminals v<version> が表示され可視になる', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchVersionApp(port);
  const browser = await chromium.launch();
  try {
    // /api/states が version を返せる状態になってからページを開く。
    await waitForStatesWithVersion(port);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    // フッターがポーリング反映で .show 付与＝可視になるのを待つ。
    const footer = page.locator('#app-version-footer');
    await expect(footer).toBeVisible({ timeout: 15_000 });
    await expect(footer).toHaveClass(/\bshow\b/, { timeout: 15_000 });

    // 表示テキストが「VK Terminals v<package.json の version>」であること。
    await expect(footer).toHaveText(`VK Terminals v${pkgVersion}`);

    // 中央寄せの CSS（design-rules 観点の副次テキスト表現）が適用されていること。
    await expect(footer).toHaveCSS('text-align', 'center');

    // <footer> が list より後ろ（=最下部側）に配置されていること。
    const listBottom = await page.locator('#list').evaluate((el) => el.getBoundingClientRect().bottom);
    const footerTop = await footer.evaluate((el) => el.getBoundingClientRect().top);
    expect(footerTop).toBeGreaterThanOrEqual(listBottom - 1);
  } finally {
    await browser.close();
    await closeApp({ app, tmpRoot });
  }
});
