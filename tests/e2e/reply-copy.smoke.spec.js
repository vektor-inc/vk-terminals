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
    await expect(bar.locator('.reply-bar-shortcut')).toContainText('でコピーへ・Esc で戻る');

    // 端末から競合の少ない専用キーでバーへ移り、バー内だけを巡回して端末へ戻れる。
    const screen = win.locator('.pane .xterm-screen').first();
    await screen.click();
    await win.keyboard.press('Alt+Shift+C');
    const copyButton = bar.getByRole('button', { name: '返信文をコピー（ペイン 1）' });
    const closeButton = bar.getByRole('button', { name: '返信文バーを閉じる（ペイン 1）' });
    await expect(copyButton).toBeFocused();
    await win.keyboard.press('Tab');
    await expect(closeButton).toBeFocused();
    await win.keyboard.press('Shift+Tab');
    await expect(copyButton).toBeFocused();
    await win.keyboard.press('Escape');
    await expect(win.locator('.pane .xterm-helper-textarea').first()).toBeFocused();
    await expect(bar).toBeVisible();

    await copyButton.click();
    await expect(bar.locator('.reply-bar-status')).toHaveText('コピーしました');
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toBe(
      '[ユーザー返信用]\nvk-terminals と vk-agents をリリースしました。#748 を進めてください。',
    );

    // 240px 程度のペインでも操作を欠けさせず、結果行の高さも確保する。
    const narrowLayout = await bar.evaluate((element) => {
      element.style.width = '240px';
      const close = element.querySelector('.reply-bar-close').getBoundingClientRect();
      const status = element.querySelector('.reply-bar-status').getBoundingClientRect();
      const bounds = element.getBoundingClientRect();
      return {
        closeFits: close.right <= bounds.right && close.left >= bounds.left,
        statusHeight: status.height,
      };
    });
    expect(narrowLayout.closeFits).toBe(true);
    expect(narrowLayout.statusHeight).toBeGreaterThan(0);

    await screen.click();
    await win.keyboard.type('x');
    await expect(bar).toBeHidden();
    await win.keyboard.press('Control+C');
    await win.keyboard.type('echo $((40+2))');
    await win.keyboard.press('Enter');
    await expect(screen).toContainText('42');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
