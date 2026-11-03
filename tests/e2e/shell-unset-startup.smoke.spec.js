const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

test('SHELL が未設定でも起動して最初のペインを作成できる', async () => {
  const port = await getFreePort();
  const launched = await launchAppAndWait({
    port,
    prefix: 'vk-terminals-e2e-shell-unset-',
    unsetEnv: ['SHELL'],
  });
  try {
    // macOS では未設定時の /bin/zsh 経路を確認し、Linux の候補選択は単体テストで担保する。
    await expect(launched.win.locator('.term-container')).toHaveCount(1);
    await expect(launched.win.locator('.xterm')).toHaveCount(1);
  } finally {
    await closeApp(launched);
  }
});
