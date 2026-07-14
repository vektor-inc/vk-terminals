const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

async function getFreePort() {
  // OS に空きポートを割り当てさせ、取得後に閉じて Electron 側で再利用する。
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-sidebar-open-on-launch-'));
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

test('新規起動時はサイドバーが開いた状態で aria-expanded も true になる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp(port);
  try {
    // 初回描画が完了し、#root にサイドバーが配置されるまで待つ。
    await win.waitForSelector('#sidebar', { state: 'attached' });

    // 起動直後からサイドバー用クラスが付いていることを回帰確認する。
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // 初期 HTML と描画後の状態が揃い、メニューボタンも展開状態を示す。
    await expect(win.locator('#menu-btn')).toHaveAttribute('aria-expanded', 'true');

    // 起動時に setSidebarOpen() を呼ばない方針なので、フォーカスはサイドバーへ移さずターミナルに残す。
    const activeElement = await win.evaluate(() => {
      const el = document.activeElement;
      return {
        insideSidebar: !!el?.closest?.('#sidebar'),
        insideXterm: !!el?.closest?.('.xterm'),
      };
    });
    expect(activeElement).toEqual({ insideSidebar: false, insideXterm: true });
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
