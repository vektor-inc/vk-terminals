const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

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
