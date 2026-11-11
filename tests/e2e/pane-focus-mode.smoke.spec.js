const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

async function clippedPaneActionButtons(pane) {
  return pane.locator('.pane-header').evaluate((header) => {
    const right = Math.min(header.getBoundingClientRect().right, innerWidth);
    return Array.from(header.querySelectorAll('.pane-actions button'))
      .filter((button) => {
        const rect = button.getBoundingClientRect();
        return rect.width === 0 || rect.left < 0 || rect.right > right + 0.5;
      })
      .map((button) => button.className);
  });
}

test('ペインを広く表示して、今回格納したペインだけを戻す', async () => {
  const port = await getFreePort();
  const launched = await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-pane-focus-', config: { confirmClose: 'never' } });
  const { win } = launched;
  try {
    // 初期ペイン以外に3枚追加し、1枚をあらかじめ手動で格納する。
    const ids = await win.evaluate(async () => {
      const initial = tree.order[0];
      const a = await addPane(null, { noClaude: true });
      const b = await addPane(null, { noClaude: true });
      const c = await addPane(null, { noClaude: true });
      stashPane(c.paneId);
      return { initial, a: a.paneId, b: b.paneId, c: c.paneId };
    });
    const selected = win.locator(`.pane[data-id="${ids.a}"]`);
    const toggle = selected.locator('.btn-focus-mode');
    await expect(toggle).toHaveAttribute('aria-label', 'このペインを広く表示');
    await toggle.click();
    await expect(win.locator('.pane')).toHaveCount(1);
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
    expect(await clippedPaneActionButtons(selected)).toEqual([]);
    await expect(selected.locator('.btn-focus-mode')).toHaveAttribute('aria-label', '格納したペインを戻す');
    await expect(selected.locator('.btn-focus-mode')).toHaveAttribute('aria-pressed', 'true');

    // 切替中に格納したペインを手動で戻し、別のペインを閉じても解除は安全に進む。
    await win.locator(`.stash-item[data-id="${ids.b}"] .btn-stash-restore`).click();
    await win.evaluate((id) => closePane(id, { force: true }), ids.b);
    await selected.locator('.btn-focus-mode').click();
    await expect(win.locator(`.pane[data-id="${ids.initial}"]`)).toHaveCount(1);
    await expect(win.locator('.pane')).toHaveCount(2);
    await expect(win.locator(`.pane[data-id="${ids.c}"]`)).toHaveCount(0);
    await expect(win.locator(`.stash-item[data-id="${ids.c}"]`)).toHaveCount(1);
    await expect(win.locator(`.pane[data-id="${ids.a}"] .btn-focus-mode`)).toHaveAttribute('aria-pressed', 'false');
  } finally {
    await closeApp(launched);
  }
});

test('390px の単独表示ではサイドバーを閉じ、操作群と格納ペインを使える', async () => {
  const port = await getFreePort();
  const launched = await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-pane-focus-narrow-', config: { confirmClose: 'never' } });
  const { app, win } = launched;
  try {
    // テスト用ウィンドウだけ最小幅を下げ、報告された 390px を再現する。
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(390, 400);
      window.setContentSize(390, 720);
    });
    await expect.poll(() => win.evaluate(() => innerWidth)).toBe(390);
    const otherId = await win.evaluate(async () => (await addPane(null, { noClaude: true })).paneId);
    await win.evaluate(() => togglePaneFocusMode(tree.order[0]));
    await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
    await expect(win.locator('#menu-btn')).toHaveAttribute('aria-expanded', 'false');
    await expect(win.locator('.pane')).toHaveCount(1);

    // display 状態だけでなく、すべての操作ボタンがペインと画面の内側に収まることを測る。
    expect(await clippedPaneActionButtons(win.locator('.pane'))).toEqual([]);

    // 閉じたサイドバーは既存のトグルから開け、格納したペインを復元できる。
    await win.locator('#menu-btn').click();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
    await win.locator(`.stash-item[data-id="${otherId}"] .btn-stash-restore`).click();
    await expect(win.locator(`.pane[data-id="${otherId}"]`)).toHaveCount(1);
    await win.evaluate((id) => stashPane(id), otherId);
    await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
    await win.locator('#menu-btn').click();
    await win.locator(`.stash-item[data-id="${otherId}"] .btn-stash-restore`).click();
    await expect(win.locator(`.pane[data-id="${otherId}"]`)).toHaveCount(1);
  } finally {
    await closeApp(launched);
  }
});
