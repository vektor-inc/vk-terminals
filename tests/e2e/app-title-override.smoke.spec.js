const { test, expect, _electron, chromium } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// 環境変数 VK_TERMINALS_APP_TITLE によるアプリ名上書きの end-to-end 確認。
//   - デスクトップ（renderer/index.html）のヘッダー .app-title が上書き名になる。
//   - GET /api/states のレスポンス JSON に appTitle（= 上書き名）が含まれる。
//   - モバイルページ（renderer/mobile.html）の <h1> とバージョンフッターが上書き名になる。
// 呼び出し元（例: vk-orchestrator）が 'VK Orchestrator' を渡すユースケースの回帰を守る。

const OVERRIDE_TITLE = 'VK Orchestrator';
const repoRoot = path.resolve(__dirname, '..', '..');
const pkgVersion = require(path.join(repoRoot, 'package.json')).version;

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

// /api/states が appTitle を返し始めるまで短くリトライして待つ。
async function waitForStatesWithAppTitle(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastJson = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/states`);
      if (res.status === 200) {
        const json = await res.json();
        lastJson = json;
        if (typeof json.appTitle === 'string' && json.appTitle) return json;
      }
    } catch (_e) {
      // 起動前の fetch 失敗は同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`/api/states did not return appTitle in time. last json: ${JSON.stringify(lastJson)}`);
}

// 一時 HOME を用意し、VK_TERMINALS_APP_TITLE を付与して Electron を起動する。
async function launchApp(port) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-title-'));
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
      VK_TERMINALS_APP_TITLE: OVERRIDE_TITLE,
    },
  });
  await app.firstWindow();
  return { app, tmpRoot };
}

// ─── デスクトップのヘッダー .app-title が上書き名になり、/api/states にも反映される ───
test('デスクトップ: VK_TERMINALS_APP_TITLE でヘッダーと /api/states の appTitle が上書きされる', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  try {
    const json = await waitForStatesWithAppTitle(port);
    expect(json.appTitle).toBe(OVERRIDE_TITLE);

    const win = await app.firstWindow();
    const titleEl = win.locator('.app-title');
    await expect(titleEl).toHaveText(OVERRIDE_TITLE, { timeout: 15_000 });
  } finally {
    await app.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── モバイルページの <h1> とバージョンフッターが上書き名になる ───
test('モバイル: <h1> とフッターが VK_TERMINALS_APP_TITLE の上書き名になる', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  const browser = await chromium.launch();
  try {
    await waitForStatesWithAppTitle(port);

    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    const heading = page.locator('header h1');
    await expect(heading).toHaveText(OVERRIDE_TITLE, { timeout: 15_000 });

    const footer = page.locator('#app-version-footer');
    await expect(footer).toBeVisible({ timeout: 15_000 });
    await expect(footer).toHaveText(`${OVERRIDE_TITLE} v${pkgVersion}`, { timeout: 15_000 });
  } finally {
    await browser.close().catch(() => {});
    await app.close().catch(() => {});
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
