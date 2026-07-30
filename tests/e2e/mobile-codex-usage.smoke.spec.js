const { test, expect, chromium } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #218: モバイル版に Codex CLI の使用量カードを表示する変更の end-to-end 確認。
//   - /api/states に codexUsage を additive に載せ、mobile.html の renderCodexUsage が
//     セッション% / 週間% の 2 バーとトークン数（今日 / 今週）を描画する。
//   - codexUsage が null / empty のときはカードごと非表示（Codex 未使用ユーザー）になる。
// /api/states を route で差し替え、renderer 側の描画だけを検証する（PC 版サイドバー
// smoke（sidebar-codex-usage.smoke.spec.js）とモバイルで対称の確認）。

// HTTP サーバー（/api/states）が応答するまで node 側 fetch で待つ。
// page.route はブラウザ内リクエストのみ差し替えるため、この node fetch は実サーバーに届く。
async function waitForServer(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/states`);
      if (res.status === 200) return;
    } catch (_e) {
      // 起動前は fetch が失敗する。同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server on port ${port} did not become ready in time`);
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
async function launchCodexUsageApp(port) {
  return await launchApp({ port, prefix: 'vk-terminals-e2e-mobile-codex-' });
}

test('モバイル: codexUsage があると Codex 使用量カードにセッション/週間バーとトークン数が表示される', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchCodexUsageApp(port);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    // /api/states を差し替え、codexUsage を注入する。poll（2 秒間隔）が毎回この値で
    // renderCodexUsage を呼ぶため、カードは表示され続ける。
    await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
      const injected = {
        updatedAt: new Date().toISOString(),
        terminals: {},
        usage: null,
        codexUsage: {
          source: 'codex',
          session: { percent: 61, resetAtMs: Date.now() + 90 * 60 * 1000 },
          weekly: { percent: 12, resetAtMs: Date.now() + 4 * 24 * 60 * 60 * 1000 },
          tokens: { todayText: '12k', weeklyText: '345k' },
        },
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(injected),
      });
    });

    await waitForServer(port);
    await page.goto(`http://127.0.0.1:${port}/`);

    const card = page.locator('#codex-usage-card');
    await expect(card).toHaveClass(/\bshow\b/, { timeout: 15_000 });
    // 見出しは role=group + aria-labelledby で紐付ける（PC 版と対称）。
    await expect(card).toHaveAttribute('role', 'group');
    await expect(card).toHaveAttribute('aria-labelledby', 'codex-usage-card-title');
    await expect(page.locator('#codex-usage-card-title')).toHaveText('Codex使用量');

    // セッション / 週間バーの % 表示。
    await expect(page.locator('#co-session-pct')).toHaveText('61% 使用済み');
    await expect(page.locator('#co-weekly-pct')).toHaveText('12% 使用済み');

    // progressbar の aria-valuenow が実測値に追従する。
    await expect(page.locator('#co-session-track')).toHaveAttribute('aria-valuenow', '61');
    await expect(page.locator('#co-weekly-track')).toHaveAttribute('aria-valuenow', '12');

    // 閾値カラー（61% は青＝level クラス無し）。
    await expect(page.locator('#co-session-fill')).toHaveClass('u-fill');

    // トークン数（今日 / 今週）。PC 版と同じ表記。
    await expect(page.locator('#co-tokens-today')).toHaveText('今日 12k');
    await expect(page.locator('#co-tokens-weekly')).toHaveText('今週 345k トークン');
  } finally {
    await browser.close();
    await closeApp({ app, tmpRoot });
  }
});

test('モバイル: codexUsage が empty / null のとき Codex 使用量カードは非表示になる', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchCodexUsageApp(port);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();

    // empty スナップショット（Codex 未使用）を注入する。カードは show クラスを持たない。
    await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
      const injected = {
        updatedAt: new Date().toISOString(),
        terminals: {},
        usage: null,
        codexUsage: { source: 'codex', session: null, weekly: null, tokens: null, empty: true },
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(injected),
      });
    });

    await waitForServer(port);
    await page.goto(`http://127.0.0.1:${port}/`);

    const card = page.locator('#codex-usage-card');
    // 数回の poll を待っても show が付かない（＝カードは display:none のまま）。
    await page.waitForTimeout(500);
    await expect(card).not.toHaveClass(/\bshow\b/);
    await expect(card).toBeHidden();

    // codexUsage を直接 null にしても隠れたままであること（renderCodexUsage の falsy 分岐）。
    await page.evaluate(() => window.renderCodexUsage(null));
    await expect(card).not.toHaveClass(/\bshow\b/);
    await expect(card).toBeHidden();
  } finally {
    await browser.close();
    await closeApp({ app, tmpRoot });
  }
});
