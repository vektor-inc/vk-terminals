const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

async function launchSidebarUsageApp(port) {
  return await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-sidebar-usage-' });
}

// issue #348: 3 テストとも env/config の指定なしで launchAppAndWait を呼んでいるため、
// 起動を 1 回に共有する。各テストは window.renderSidebarUsage(...) を直接呼ぶか
// 設定モーダルを開くだけで、いずれも win.reload() で初期状態へ戻る
// （renderSidebarUsage の描画結果は DOM 上の表示だけで、reload すれば新規ロードの
// app.js が再実行され、既定の hidden 状態から始まる）。
test.describe.serial('デスクトップのサイドバー使用量カード（issue #348 で起動共有）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchSidebarUsageApp(port));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  test('デスクトップの Claude 使用量はサイドバー最上部に常時表示され、旧モーダル項目は無い', async () => {
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
    });

    // issue #169 以降は起動直後からサイドバーが開くため、開状態のまま表示を確認する。
    await win.waitForFunction(() => document.getElementById('root').classList.contains('sidebar-open'));

    const usage = win.locator('#sidebar-usage');
    await expect(usage).toBeVisible();
    await expect(usage.locator('.sidebar-section-label')).not.toHaveAttribute('title', /.+/);
    await expect(usage.locator('.sidebar-usage-body')).toHaveAttribute('aria-live', 'polite');
    await expect(usage).toContainText('Claude使用量');
    await expect(usage.locator('.usage-section-title').nth(0)).toHaveText('セッション');
    await expect(usage.locator('.usage-section-title').nth(0)).toHaveAttribute('title', '現在のセッション');
    await expect(usage.locator('.usage-section-title').nth(1)).toHaveText('週間');
    await expect(usage.locator('.usage-section-title').nth(1)).toHaveAttribute('title', '週間制限（すべてのモデル）');
    const resetLabels = await usage.locator('.usage-reset').evaluateAll((els) => els.map((el) => ({
      text: el.textContent,
      title: el.getAttribute('title'),
    })));
    expect(resetLabels.every(({ text, title }) => text === title)).toBe(true);

    const sidebarOrder = await win.evaluate(() => {
      const sidebar = document.getElementById('sidebar');
      return Array.from(sidebar.children).map((el) => el.id || el.className);
    });
    expect(sidebarOrder.slice(0, 3)).toEqual(['sidebar-usage', 'sidebar-codex-usage', 'sidebar-menu']);

    await expect(win.locator('[data-menu-action="open-usage"]')).toHaveCount(0);
    await expect(win.locator('.usage-overlay, .usage-modal')).toHaveCount(0);
  });

  test('使用量データが null のときサイドバー使用量カードは hidden になる', async () => {
    await win.evaluate(() => {
      window.renderSidebarUsage({
        source: 'transcript',
        tokensText: '1,234',
        percentText: '42%',
        resetText: '18:59',
        remainingText: '2時間',
        peakNote: '直近の履歴から推定しています',
      });
    });
    const usage = win.locator('#sidebar-usage');
    await expect(usage).toBeVisible();
    await expect(usage.locator('.usage-reset')).toHaveAttribute('title', 'リセット 18:59（残り2時間）');
    await expect(usage.locator('.usage-note')).toHaveAttribute('title', '直近の履歴から推定しています');

    await win.evaluate(() => {
      window.renderSidebarUsage(null);
    });

    await expect(usage).toHaveAttribute('hidden', '');
    await expect(usage).toBeHidden();
    await expect(win.locator('#sidebar-codex-usage')).toBeHidden();

    // 使用量カードが両方 hidden でも、固定領域とスクロール領域の境界線は nav 上端に残り、
    // サイドバー上端へ接するため途中で宙に浮かない。
    const boundary = await win.locator('.sidebar-menu').evaluate((element) => {
      const sidebarRect = element.parentElement.getBoundingClientRect();
      const menuRect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        borderTopStyle: style.borderTopStyle,
        borderTopWidth: style.borderTopWidth,
        menuTop: menuRect.top,
        sidebarTop: sidebarRect.top,
      };
    });
    expect(boundary.borderTopStyle).toBe('solid');
    expect(boundary.borderTopWidth).toBe('1px');
    expect(boundary.menuTop).toBe(boundary.sidebarTop);
  });

  test('設定カードの見出し全体をクリックすると設定モーダルが開く', async () => {
    const card = win.locator('#sidebar-settings');
    const header = card.locator('button.sidebar-section-header');
    await expect(header).toContainText('設定');
    await expect(header.locator('.sidebar-menu-icon')).toHaveText('⚙');
    await expect(header.locator('.sidebar-section-label')).toHaveText('設定');
    expect(await card.evaluate((element) => ({
      previous: element.previousElementSibling?.className,
      next: element.nextElementSibling?.id,
    }))).toEqual({ previous: 'sidebar-menu-inner', next: 'task-list' });

    const positions = await header.evaluate((element) => {
      const headerRect = element.getBoundingClientRect();
      const iconRect = element.querySelector('.sidebar-menu-icon').getBoundingClientRect();
      const labelRect = element.querySelector('.sidebar-section-label').getBoundingClientRect();
      return {
        // 見出しの先頭に飾りを足すと、アイコンがカード内容の左端から下がって
        // 他のカードと縦に揃わなくなるため、擬似要素が描かれていないことを確かめる。
        accentContent: getComputedStyle(element, '::before').content,
        iconIndent: iconRect.left - headerRect.left,
        centerDifference: Math.abs(
          (iconRect.top + iconRect.height / 2) - (labelRect.top + labelRect.height / 2)
        ),
      };
    });
    expect(positions.accentContent).toBe('none');
    expect(positions.iconIndent).toBeLessThanOrEqual(1);
    expect(positions.centerDifference).toBeLessThanOrEqual(1);

    await header.click();
    // 設定モーダルはディスクリプタを読んで描画するため、既定の expect タイムアウト
    // （5 秒）では全件実行のような高負荷時に足りず、単独実行では通るのに全件実行では
    // 落ちる不安定さの原因になっていた（issue #347）。他ファイルの同種の描画確認
    // （app-title-override.smoke.spec.js 等）に合わせて明示的に延ばす。
    await expect(win.locator('.settings-overlay')).toBeVisible({ timeout: 15_000 });
  });
});
