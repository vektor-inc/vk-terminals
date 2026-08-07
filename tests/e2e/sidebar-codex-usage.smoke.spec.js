const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

async function launchSidebarCodexApp(port) {
  return await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-sidebar-codex-usage-' });
}

// issue #348: 2 テストとも env/config の指定なしで launchAppAndWait を呼んでいるため、
// 起動を 1 回に共有する（sidebar-usage.smoke.spec.js と同じ考え方）。
// window.renderSidebarUsage / renderSidebarCodexUsage の直接呼び出しは DOM 上の
// 表示だけなので win.reload() で初期状態へ戻る。
test.describe.serial('デスクトップのサイドバー Codex 使用量カード（issue #348 で起動共有）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchSidebarCodexApp(port));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  test('デスクトップの Codex 使用量は Claude 使用量の直下に表示される', async () => {
    await win.evaluate(() => {
      window.renderSidebarUsage({
        source: 'oauth',
        session: {
          percent: 42,
          resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        },
        weekly: {
          percent: 76,
          resetAtMs: Date.now() + 3 * 24 * 60 * 60 * 1000,
        },
      });
      window.renderSidebarCodexUsage({
        source: 'codex',
        session: {
          percent: 61,
          resetAtMs: Date.now() + 90 * 60 * 1000,
        },
        weekly: {
          percent: 12,
          resetAtMs: Date.now() + 4 * 24 * 60 * 60 * 1000,
        },
        tokens: {
          todayText: '12k',
          weeklyText: '345k',
        },
      });
    });

    // issue #169 以降は起動直後からサイドバーが開くため、開状態のまま表示を確認する。
    await win.waitForFunction(() => document.getElementById('root').classList.contains('sidebar-open'));

    const usage = win.locator('#sidebar-codex-usage');
    await expect(usage).toBeVisible();
    await expect(usage.locator('.sidebar-usage-body')).toHaveAttribute('aria-live', 'polite');
    await expect(usage).toContainText('Codex使用量');
    await expect(usage.locator('.usage-section-title').nth(0)).toHaveText('セッション');
    await expect(usage.locator('.usage-section-title').nth(0)).toHaveAttribute('title', '現在のセッション');
    await expect(usage.locator('.usage-section-title').nth(1)).toHaveText('週間');
    await expect(usage.locator('.usage-section-title').nth(1)).toHaveAttribute('title', '週間制限');
    await expect(usage).toContainText('今日 12k');
    await expect(usage).toContainText('今週 345k トークン');

    const sidebarOrder = await win.evaluate(() => {
      const sidebar = document.getElementById('sidebar');
      return Array.from(sidebar.children).map((el) => el.id || el.className);
    });
    expect(sidebarOrder.slice(0, 3)).toEqual(['sidebar-usage', 'sidebar-codex-usage', 'sidebar-menu']);
  });

  test('Codex 使用量データが null のときサイドバー使用量カードは hidden になる', async () => {
    await win.evaluate(() => {
      window.renderSidebarCodexUsage({
        source: 'codex',
        tokens: {
          todayText: '1k',
          weeklyText: '9k',
        },
      });
    });
    const usage = win.locator('#sidebar-codex-usage');
    await expect(usage).toBeVisible();
    await expect(usage.locator('.usage-reset')).toHaveAttribute('title', '今週 9k トークン');

    await win.evaluate(() => {
      window.renderSidebarCodexUsage(null);
    });

    await expect(usage).toHaveAttribute('hidden', '');
    await expect(usage).toBeHidden();
  });
});
