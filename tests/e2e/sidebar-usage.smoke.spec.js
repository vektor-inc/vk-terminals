const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

async function launchSidebarUsageApp(port) {
  return await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-sidebar-usage-' });
}

test('デスクトップの Claude 使用量はサイドバー最上部に常時表示され、旧モーダル項目は無い', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchSidebarUsageApp(port);
  try {
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
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('使用量データが null のときサイドバー使用量カードは hidden になる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchSidebarUsageApp(port);
  try {
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
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('設定カードの見出し全体をクリックすると設定モーダルが開く', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchSidebarUsageApp(port);
  try {
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
      const headerStyle = getComputedStyle(element);
      const accent = getComputedStyle(element, '::before');
      const accentWidth = Number.parseFloat(accent.width);
      // 擬似要素には getBoundingClientRect() が無いため、先頭フレックス項目の実配置を
      // ヘッダーと同一行アイコンの実座標、および算出済みスタイルから復元する。
      // 絶対配置へ戻った場合も以前のずれを検知できるよう、その実配置で中心を求める。
      const accentLeft = headerRect.left + Number.parseFloat(headerStyle.paddingLeft);
      const accentCenterY = accent.position === 'absolute'
        ? headerRect.top + Number.parseFloat(accent.top) + Number.parseFloat(accent.height) / 2
        : iconRect.top + iconRect.height / 2;
      return {
        accentLeft,
        accentRight: accentLeft + accentWidth,
        centerDifference: Math.abs(accentCenterY - (labelRect.top + labelRect.height / 2)),
        iconLeft: iconRect.left,
      };
    });
    expect(positions.accentLeft).toBeLessThan(positions.iconLeft);
    expect(positions.accentRight).toBeLessThan(positions.iconLeft);
    expect(positions.centerDifference).toBeLessThanOrEqual(1);

    await header.click();
    await expect(win.locator('.settings-overlay')).toBeVisible();
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
