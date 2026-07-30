const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
// launchAppAndWait が初回描画（#root に #sidebar が配置されるまで）を明示タイムアウト付きで待つ。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

async function launchSidebarOpenApp(port) {
  return await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-sidebar-open-on-launch-' });
}

test('新規起動時はサイドバーが開いた状態で aria-expanded も true になる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchSidebarOpenApp(port);
  try {
    // 起動直後からサイドバー用クラスが付いていることを回帰確認する。
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // 初期 HTML と描画後の状態が揃い、メニューボタンも展開状態を示す。
    await expect(win.locator('#menu-btn')).toHaveAttribute('aria-expanded', 'true');

    // 起動時に setSidebarOpen() を呼ばない方針なので、フォーカスはサイドバーへ移さずターミナルに残す。
    const activeElement = await win.evaluate(() => {
      const el = document.activeElement;
      return {
        insideSidebar: !!el?.closest?.('#sidebar'),
        insideXterm: !!el?.closest?.('.xterm'),
      };
    });
    expect(activeElement).toEqual({ insideSidebar: false, insideXterm: true });
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
