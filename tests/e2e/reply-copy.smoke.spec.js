const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

async function typeAndEnter(win, text) {
  const screen = win.locator('.pane .xterm-screen').first();
  await expect(screen).toBeVisible();
  await screen.click();
  await win.keyboard.type(text);
  await win.keyboard.press('Enter');
}

test('返信文バーから整形済み文字列をコピーし、入力で閉じる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp({
    port,
    prefix: 'vk-terminals-e2e-reply-copy-',
  });
  try {
    await typeAndEnter(
      win,
      `printf '\n  [ユーザー返信用]\n  vk-terminals と vk-agents をリリースしました。#748 を進めてください。\n\n'`,
    );

    const bar = win.locator('.pane .reply-bar').first();
    await expect(bar).toBeVisible();
    await expect(bar.locator('.reply-bar-preview')).toHaveText(
      'vk-terminals と vk-agents をリリースしました。#748 を進めてください。',
    );

    await bar.getByRole('button', { name: '返信文をコピー（ペイン 1）' }).click();
    await expect(bar.getByRole('status')).toHaveText('コピーしました');
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toBe(
      '[ユーザー返信用]\nvk-terminals と vk-agents をリリースしました。#748 を進めてください。',
    );

    await typeAndEnter(win, 'x');
    await expect(bar).toBeHidden();
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
