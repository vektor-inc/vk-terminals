const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

test('設定モーダルの Escape は背後のサイドバーを閉じず、遅延フォーカスも起こさない', async () => {
  const port = await getFreePort();
  const launched = await launchAppAndWait({
    port,
    prefix: 'vk-terminals-e2e-escape-modal-layer-',
  });
  const { app, win, tmpRoot } = launched;

  try {
    // 起動時設定に左右されないよう、サイドバーを開いた状態へ揃える。
    const sidebarOpen = await win.locator('#root').evaluate(
      (root) => root.classList.contains('sidebar-open')
    );
    if (!sidebarOpen) await win.locator('#menu-btn').click();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // 実際の設定ボタンからモーダルを開く。開いた後はモーダル内へフォーカスを移し、
    // 閉じたときに操作元の設定ボタンまで戻れることを確かめる。
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('.settings-close').focus();

    await win.keyboard.press('Escape');

    // Escape が閉じるのは最前面の設定モーダルだけ。
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // サイドバーが誤って閉じた場合の遅延フォーカス時間（約 220ms）を越えても、
    // 開いた操作元の設定ボタンへフォーカスが戻ったままであることを確かめる。
    await win.waitForTimeout(400);
    const activeElementId = await win.evaluate(
      () => (document.activeElement && document.activeElement.id) || ''
    );
    expect(activeElementId).toBe('settings-btn');

    // モーダルを閉じた時点でレイヤー登録は解除される。続けて Escape を押した場合は、
    // 従来どおりサイドバーが閉じ、アニメーション後に ☰ へフォーカスが戻る。
    await win.keyboard.press('Escape');
    await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
    await expect
      .poll(() => win.evaluate(() => (document.activeElement && document.activeElement.id) || ''))
      .toBe('menu-btn');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
