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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-sidebar-usage-'));
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

test('デスクトップの Claude 使用量はサイドバー最上部に常時表示され、旧モーダル項目は無い', async () => {
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
    });

    await win.locator('#menu-btn').click();

    const usage = win.locator('#sidebar-usage');
    await expect(usage).toBeVisible();
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
    expect(sidebarOrder.slice(0, 2)).toEqual(['sidebar-usage', 'sidebar-menu']);

    await expect(win.locator('[data-menu-action="open-usage"]')).toHaveCount(0);
    await expect(win.locator('.usage-overlay, .usage-modal')).toHaveCount(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('使用量データが null のときサイドバー使用量カードは hidden になる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp(port);
  try {
    await win.waitForSelector('#sidebar', { state: 'attached' });

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
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
