const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

async function launchSidebarCodexApp(port) {
  return await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-sidebar-codex-usage-' });
}

// issue #348: 2 テストとも env/config の指定なしで launchAppAndWait を呼んでいるため、
// 起動を 1 回に共有する（sidebar-usage.smoke.spec.js と同じ考え方）。
// window.renderSidebarUsage / renderSidebarCodexUsage の直接呼び出しは DOM 上の
// 表示だけなので win.reload() で初期状態へ戻る。
test.describe.serial('デスクトップのサイドバー Codex 使用量カード（issue #348 で起動共有）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchSidebarCodexApp(port));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  test('デスクトップの Codex 使用量は Claude 使用量の直下に表示される', async () => {
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
      window.renderSidebarCodexUsage({
        source: 'codex',
        session: {
          percent: 61,
          resetAtMs: Date.now() + 90 * 60 * 1000,
        },
        weekly: {
          percent: 12,
          resetAtMs: Date.now() + 4 * 24 * 60 * 60 * 1000,
        },
        tokens: {
          todayText: '12k',
          weeklyText: '345k',
        },
      });
    });

    // issue #169 以降は起動直後からサイドバーが開くため、開状態のまま表示を確認する。
    await win.waitForFunction(() => document.getElementById('root').classList.contains('sidebar-open'));

    const usage = win.locator('#sidebar-codex-usage');
    await expect(usage).toBeVisible();
    await expect(usage.locator('.sidebar-usage-body')).toHaveAttribute('aria-live', 'polite');
    await expect(usage).toContainText('Codex使用量');
    await expect(usage.locator('.usage-section-title').nth(0)).toHaveText('セッション');
    await expect(usage.locator('.usage-section-title').nth(0)).toHaveAttribute('title', '現在のセッション');
    await expect(usage.locator('.usage-section-title').nth(1)).toHaveText('週間');
    await expect(usage.locator('.usage-section-title').nth(1)).toHaveAttribute('title', '週間制限');
    await expect(usage).toContainText('今日 12k');
    await expect(usage).toContainText('今週 345k トークン');

    const sidebarOrder = await win.evaluate(() => {
      const sidebar = document.getElementById('sidebar');
      return Array.from(sidebar.children).map((el) => el.id || el.className);
    });
    expect(sidebarOrder.slice(0, 3)).toEqual(['sidebar-usage', 'sidebar-codex-usage', 'sidebar-menu']);
  });

  test('Codex 使用量データが null のときサイドバー使用量カードは hidden になる', async () => {
    await win.evaluate(() => {
      window.renderSidebarCodexUsage({
        source: 'codex',
        tokens: {
          todayText: '1k',
          weeklyText: '9k',
        },
      });
    });
    const usage = win.locator('#sidebar-codex-usage');
    await expect(usage).toBeVisible();
    await expect(usage.locator('.usage-reset')).toHaveAttribute('title', '今週 9k トークン');

    await win.evaluate(() => {
      window.renderSidebarCodexUsage(null);
    });

    await expect(usage).toHaveAttribute('hidden', '');
    await expect(usage).toBeHidden();
  });

  // issue #399: リセット時刻を過ぎても再取得で確認できない区分（session だけ expired、
  // weekly は通常表示）を「未確認」表示にする。バー幅 0%・level-unknown・aria-valuenow 無し・
  // aria-valuetext あり・リセット行が案内文になることを確認する。
  test('Codex のセッションが期限切れ（未確認）のとき、値・バー・リセット行が案内表示になる', async () => {
    await win.evaluate(() => {
      window.renderSidebarCodexUsage({
        source: 'codex',
        session: {
          percent: 100,
          resetAtMs: Date.now() - 60 * 1000,
          expired: true,
        },
        weekly: {
          percent: 12,
          resetAtMs: Date.now() + 4 * 24 * 60 * 60 * 1000,
        },
      });
    });

    const usage = win.locator('#sidebar-codex-usage');
    await expect(usage).toBeVisible();

    const sessionValue = usage.locator('.usage-value').nth(0);
    await expect(sessionValue).toHaveText('未確認');
    await expect(sessionValue).toHaveAttribute('title', '未確認');

    const sessionTrack = usage.locator('.usage-bar-track').nth(0);
    await expect(sessionTrack).not.toHaveAttribute('aria-valuenow', /.+/);
    await expect(sessionTrack).toHaveAttribute('aria-valuetext', '未確認（リセット時刻を過ぎたため確認できていません）');
    const sessionFill = sessionTrack.locator('.usage-bar-fill');
    await expect(sessionFill).toHaveClass(/level-unknown/);
    await expect(sessionFill).not.toHaveClass(/level-warn|level-crit/);
    await expect(sessionFill).toHaveCSS('width', '0px');

    const sessionReset = usage.locator('.usage-reset').nth(0);
    await expect(sessionReset).toHaveText('次に使うと最新の状態に更新されます');

    // weekly は通常表示のまま（expired が独立して効くことの確認）。
    const weeklyValue = usage.locator('.usage-value').nth(1);
    await expect(weeklyValue).toHaveText('12% 使用済み');
    const weeklyTrack = usage.locator('.usage-bar-track').nth(1);
    await expect(weeklyTrack).toHaveAttribute('aria-valuenow', '12');
  });

  // issue #399 レビュー指摘（MEDIUM）: 期限切れ（未確認）区分の古い percent を
  // ☰メニューボタンの警告バッジ判定に使ってしまうと、実際には確認できていない
  // 100% 等で誤って警告が出る。usageAlertMaxPercent は expired な区分を除外する。
  test('usageAlertMaxPercent: expired な区分の percent は警告バッジの判定に使わない', async () => {
    const max = await win.evaluate(() => {
      return window.usageAlertMaxPercent(
        {
          source: 'oauth',
          session: { percent: 42, resetAtMs: Date.now() + 60 * 60 * 1000 },
          weekly: null,
        },
        {
          source: 'codex',
          // session は期限切れの古い 100%（実態不明）→ 判定対象から除外されるはず
          session: { percent: 100, resetAtMs: Date.now() - 1000, expired: true },
          weekly: { percent: 30, resetAtMs: Date.now() + 60 * 60 * 1000 },
        },
      );
    });
    // expired な 100% を含めれば 100 になってしまうが、除外されるので
    // 有効な値（oauth session 42 / codex weekly 30）の最大である 42 になる。
    expect(max).toBe(42);

    // 全区分が expired なら判定材料が無いので null（バッジは表示されない）。
    const allExpired = await win.evaluate(() => {
      return window.usageAlertMaxPercent(null, {
        source: 'codex',
        session: { percent: 99, resetAtMs: Date.now() - 1000, expired: true },
        weekly: { percent: 99, resetAtMs: Date.now() - 1000, expired: true },
      });
    });
    expect(allExpired).toBe(null);
  });
});
