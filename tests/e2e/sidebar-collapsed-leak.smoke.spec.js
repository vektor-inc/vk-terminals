const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

async function launchCollapsedLeakApp(port) {
  return await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-sidebar-collapsed-leak-' });
}

test('閉じたサイドバーの使用量カードはビューポートへ漏れず、開くと表示される', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchCollapsedLeakApp(port);
  try {
    // issue #169 以降は起動直後にサイドバーが開くため、閉状態の漏れ確認では明示的に閉じる。
    await win.evaluate(() => window.setSidebarOpen(false, { focusFirst: false }));
    await win.waitForFunction(() => !document.getElementById('root').classList.contains('sidebar-open'));

    // 閉状態のまま使用量カードを描画して、ビューポートへ漏れないことを検証する。
    await win.evaluate(() => {
      window.renderSidebarUsage({
        source: 'oauth',
        session: {
          percent: 81,
          resetAtMs: Date.now() + 2 * 60 * 60 * 1000,
        },
        weekly: {
          percent: 40,
          resetAtMs: Date.now() + 3 * 24 * 60 * 60 * 1000,
        },
      });
    });

    const usage = win.locator('#sidebar-usage');
    await expect(usage).not.toBeInViewport();

    // サイドバーを開いたときは、同じ使用量カードが通常どおり見えることも担保する。
    await win.locator('#menu-btn').click();
    await win.waitForFunction(() => document.getElementById('root').classList.contains('sidebar-open'));
    await expect(usage).toBeInViewport();
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
