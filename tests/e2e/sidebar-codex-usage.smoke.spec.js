const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((err) => {
        if (err) { reject(err); return; }
        if (!port) { reject(new Error('failed to allocate a free port')); return; }
        resolve(port);
      });
    });
  });
}

async function launchApp(port) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-sidebar-codex-usage-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    apiHost: '127.0.0.1',
    initialCommand: '',
    agentroom: false,
    additionalPanes: [],
  }), 'utf8');

  const app = await _electron.launch({
    args: ['.', '--no-claude'],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      VK_TERMINALS_API_PORT: String(port),
    },
  });
  const win = await app.firstWindow();
  return { app, win, tmpRoot };
}

test('デスクトップの Codex 使用量は Claude 使用量の直下に表示される', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp(port);
  try {
    await win.waitForSelector('#sidebar', { state: 'attached' });

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
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('Codex 使用量データが null のときサイドバー使用量カードは hidden になる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp(port);
  try {
    await win.waitForSelector('#sidebar', { state: 'attached' });

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
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
