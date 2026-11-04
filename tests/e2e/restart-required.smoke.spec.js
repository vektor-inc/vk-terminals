const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// @title 再起動案内を開き、確認ダイアログをキャンセルできる
// @step 状態ファイルを置いて起動し、サイドバーの「設定を確認」を押す
// @check 対象タブの先頭に案内が出て、キャンセル後もアプリが動作する
// Electron の native dialog は renderer の DOM 外なので showMessageBox を本体側で観測する。
test('再起動が必要な設定への案内とキャンセル', async () => {
  const port = await getFreePort();
  const launched = await launchAppAndWait({
    port,
    prefix: 'vk-restart-required-e2e-',
    seedHome: ({ configDir }) => fs.writeFileSync(path.join(configDir, 'restart-required.json'), JSON.stringify({ restartRequired: true, tabs: ['mobile'] })),
  });
  try {
    const { app, win } = launched;
    await expect(win.locator('#sidebar-restart-required')).toBeVisible();
    expect(await win.locator('#sidebar-menu').evaluate((nav) => nav.firstElementChild.id)).toBe('sidebar-restart-required');
    await win.locator('#sidebar-restart-required button').click();
    await expect(win.locator('#settings-panel-1')).toBeVisible();
    await expect(win.locator('#settings-panel-1 .settings-restart-notice')).toBeVisible();
    await expect(win.locator('.settings-modal')).toHaveAttribute('aria-describedby', 'settings-tab-1 settings-restart-mobile');
    expect(await win.locator('.settings-view-config').evaluate((el) => el.scrollTop)).toBe(0);
    await app.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) => {
        globalThis.__restartDialogOptions = args.at(-1);
        return { response: 0 };
      };
      globalThis.__restoreRestartDialog = () => { dialog.showMessageBox = original; };
    });
    await win.locator('#settings-panel-1 .settings-restart-button').click();
    await expect.poll(() => app.evaluate(() => globalThis.__restartDialogOptions?.title)).toBe('アプリを再起動しますか？');
    expect(await app.evaluate(() => globalThis.__restartDialogOptions.defaultId)).toBe(0);
    expect(await app.evaluate(() => globalThis.__restartDialogOptions.cancelId)).toBe(0);
    await expect(win.locator('#settings-panel-1')).toBeVisible();
    // 確認を保留している間の連打でも、ネイティブダイアログは一つに保つ。
    await app.evaluate(({ dialog }) => {
      globalThis.__restartDialogCount = 0;
      dialog.showMessageBox = () => {
        globalThis.__restartDialogCount += 1;
        return new Promise((resolve) => { globalThis.__cancelRestartDialog = () => resolve({ response: 0 }); });
      };
    });
    await win.locator('#settings-panel-1 .settings-restart-button').click();
    await expect.poll(() => app.evaluate(() => globalThis.__restartDialogCount)).toBe(1);
    await win.locator('#settings-panel-1 .settings-restart-button').click();
    expect(await app.evaluate(() => globalThis.__restartDialogCount)).toBe(1);
    await app.evaluate(() => globalThis.__cancelRestartDialog());
    await app.evaluate(() => globalThis.__restoreRestartDialog());
    await win.locator('#settings-panel-1 .settings-restart-button').focus();
    fs.writeFileSync(path.join(launched.tmpHome, '.vk-terminals', 'restart-required.json'), JSON.stringify({ restartRequired: false, tabs: [] }));
    await expect(win.locator('#sidebar-restart-required')).toBeHidden({ timeout: 10000 });
    await expect(win.locator('#settings-tab-1')).toBeFocused();
    await expect(win.locator('#settings-panel-1 .settings-restart-notice')).toBeHidden();
    // 開いた起点の案内が消えても、閉じた後は常設の設定ボタンへ戻す。
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#sidebar-settings button')).toBeFocused();
  } finally {
    await closeApp(launched);
  }
});
