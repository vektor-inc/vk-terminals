const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

// 空きポートを取得する（他の e2e と同様、API サーバ用に固定ポート衝突を避ける）。
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

// Electron アプリを起動する（--no-claude でターミナル起動を抑止）。
// settings-pattern-validation.smoke.spec.js の起動方式に倣う。
async function launchApp(port) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-settings-multitarget-'));
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
      // 実環境の VK_TERMINALS_APP_TITLE / VK_TERMINALS_SETTINGS の影響を受けないよう明示的に無効化する。
      VK_TERMINALS_APP_TITLE: '',
      VK_TERMINALS_SETTINGS: '',
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      VK_TERMINALS_API_PORT: String(port),
    },
  });
  const win = await app.firstWindow();
  return { app, win, tmpRoot };
}

// renderer の ipcRenderer.invoke を差し替え、settings:describe の応答を注入する。
// これは main.js の settings:describe が返す形（group ごとに targetPaths を持ち、
// hasMultipleTargets / targetPath / targetPaths を含む）を模したもの。
// describeTargetPaths / describeSettingsValues のユニットテストは別途担保されているため、
// ここでは「describe の応答を renderer がどう表示するか」に絞って検証する。
async function installMultiTargetDescriptor(win) {
  await win.evaluate(() => {
    const { ipcRenderer } = require('electron');
    const desc = {
      available: true,
      title: 'マルチターゲット設定',
      note: '',
      // マルチターゲット時はトップレベル targetPath は空（各 group が別ファイル）。
      targetPath: '',
      appVersion: '0.0.0-test',
      hasMultipleTargets: true,
      targetPaths: ['/tmp/group-a.json', '/tmp/group-b.json'],
      groups: [
        {
          label: 'グループA',
          targetPaths: ['/tmp/group-a.json'],
          fields: [{ key: 'aValue', label: 'A の値', type: 'text' }],
        },
        {
          label: 'グループB',
          targetPaths: ['/tmp/group-b.json'],
          fields: [{ key: 'bValue', label: 'B の値', type: 'text' }],
        },
      ],
      values: { aValue: '', bValue: '' },
    };
    ipcRenderer.invoke = (channel) => {
      if (channel === 'settings:describe') return Promise.resolve(desc);
      if (channel === 'settings:save') return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    };
  });
}

// 単一ターゲット（従来 descriptor）の describe 応答を注入する。
async function installSingleTargetDescriptor(win) {
  await win.evaluate(() => {
    const { ipcRenderer } = require('electron');
    const desc = {
      available: true,
      title: '単一ターゲット設定',
      note: '',
      targetPath: '/tmp/single-config.json',
      appVersion: '0.0.0-test',
      hasMultipleTargets: false,
      targetPaths: ['/tmp/single-config.json'],
      groups: [
        {
          label: 'グループA',
          // 単一ターゲット時も describe は group ごとの targetPaths を返しうるが、
          // hasMultipleTargets が false なので renderer は group 別表示を出さない。
          targetPaths: ['/tmp/single-config.json'],
          fields: [{ key: 'aValue', label: 'A の値', type: 'text' }],
        },
      ],
      values: { aValue: '' },
    };
    ipcRenderer.invoke = (channel) => {
      if (channel === 'settings:describe') return Promise.resolve(desc);
      if (channel === 'settings:save') return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    };
  });
}

test.describe.serial('設定モーダルのマルチターゲット表示（PR #160）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp(port));
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  test.afterAll(async () => {
    if (app) await app.close();
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  // 各テストの後に閉じるボタンでモーダルを閉じる（modalOpen フラグが確実に false に戻り、
  // 次テストで再オープンできるようにする。Escape でも閉じるが、閉じ処理を確定させるため
  // 閉じるボタンを明示クリックし、DOM から detach されるまで待つ）。
  test.afterEach(async () => {
    const closeBtn = win.locator('.settings-close');
    if (await closeBtn.count()) {
      await closeBtn.click().catch(() => {});
    } else {
      await win.keyboard.press('Escape');
    }
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
  });

  test('マルチターゲット: ヘッダー下に案内、各 fieldset 直下に group 別保存先が表示される', async () => {
    // 前テストのモーダルが残っていないことを保証してから開く。
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    await installMultiTargetDescriptor(win);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });

    // ヘッダー下の案内文（単一パスではなくグループごとに異なる旨）。
    const targetNotice = win.locator('.settings-target');
    await expect(targetNotice).toHaveText('保存先: グループごとに異なります（各グループの下に表示）');

    // 各 group（fieldset）直下に保存先パス表示（.settings-group-target）が出る。
    const groupTargets = win.locator('.settings-group-target');
    await expect(groupTargets).toHaveCount(2);
    await expect(groupTargets.nth(0)).toContainText('/tmp/group-a.json');
    await expect(groupTargets.nth(1)).toContainText('/tmp/group-b.json');

    // 保存先パスは fieldset.settings-group の中（legend 直後）にある。
    const firstGroupTargetInFieldset = win.locator('fieldset.settings-group', { has: win.locator('.settings-group-target') });
    await expect(firstGroupTargetInFieldset).toHaveCount(2);

    // ヘッダー案内が単一パス表示（code 要素）を含まないこと。
    await expect(win.locator('.settings-target code')).toHaveCount(0);
  });

  test('単一ターゲット: 従来どおり単一パス表示、group 別保存先は出ない（挙動不変）', async () => {
    // 前テストのモーダルが残っていないことを保証してから開く。
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    await installSingleTargetDescriptor(win);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    // 単一ターゲットのモーダルが描画され切るまで待つ（前テストの残骸ではないことを確認）。
    await expect(win.locator('.settings-modal h2')).toContainText('単一ターゲット設定');

    // ヘッダー下は単一パスを code で表示。
    const targetNotice = win.locator('.settings-target');
    await expect(targetNotice).toContainText('保存先:');
    await expect(win.locator('.settings-target code')).toHaveText('/tmp/single-config.json');

    // 「グループごとに異なります」の案内は出ない。
    await expect(targetNotice).not.toContainText('グループごとに異なります');

    // group 別保存先表示は 1 つも出ない。
    await expect(win.locator('.settings-group-target')).toHaveCount(0);
  });
});
