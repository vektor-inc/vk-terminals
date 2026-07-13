const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

// 空きポートを取得する（他の e2e と同様、API サーバ用の固定ポート衝突を避ける）。
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

// 指定した config で Electron アプリを起動する（--no-claude で claude 自動起動を抑止）。
// tmpHome を HOME に割り当て、その下の .vk-terminals/config.json に設定を書き込む。
// これにより settings:describe は組み込みディスクリプタ（VK Terminals 自身の設定）を返す。
async function launchApp(port, config) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-newpane-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config), 'utf8');

  // 親環境（vk-orchestrator 等）の VK_TERMINALS_SETTINGS が漏れ込むと外部ディスクリプタが
  // 使われてしまうため、明示的に外して VK Terminals 自身の組み込みディスクリプタを使わせる。
  const childEnv = {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    VK_TERMINALS_API_PORT: String(port),
  };
  delete childEnv.VK_TERMINALS_SETTINGS;

  const app = await _electron.launch({
    args: ['.', '--no-claude'],
    cwd: repoRoot,
    env: childEnv,
  });
  const win = await app.firstWindow();
  return { app, win, tmpRoot, tmpHome };
}

// 最小構成の config。個別テストで必要なキーだけ上書きする。
const BASE_CONFIG = { apiHost: '127.0.0.1', initialCommand: '', agentroom: false, additionalPanes: [] };

test.describe('新規ペイン起動設定（issue #143 / PR #144）', () => {
  // ── (1) 設定パネルに新規ペイン設定が表示される ──────────────────────────────
  // 組み込みディスクリプタの描画順は apiHost=0 / newPaneStartupDir=1 /
  // newPaneAutoLaunchClaude=2 / initialCommand=3。field id は描画順採番なので、
  // 「API ホストの直下」に 2 項目が並ぶことを id の連番で担保する。
  test('設定パネルに新規ペイン設定が API ホストの直下に表示される', async () => {
    const port = await getFreePort();
    const { app, win, tmpRoot } = await launchApp(port, BASE_CONFIG);
    try {
      await win.waitForSelector('#sidebar', { state: 'attached' });
      // 設定モーダルを開く（組み込みディスクリプタで描画される）。
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.waitForSelector('#set-field-1', { state: 'visible' });

      // 直上が API ホスト（field-0）であること（＝「API ホストの直下」に並ぶ）。
      await expect(win.locator('label[for="set-field-0"]')).toHaveText('API ホスト');

      // (1) 新規ペイン初期ディレクトリ（text）: ラベル・placeholder・help を確認。
      const dirInput = win.locator('#set-field-1');
      await expect(dirInput).toBeVisible();
      await expect(dirInput).toHaveAttribute('type', 'text');
      await expect(dirInput).toHaveAttribute('placeholder', '/path/to/project');
      await expect(win.locator('label[for="set-field-1"]'))
        .toHaveText('新規ペインを開く時の初期ディレクトリ');
      // help に「未入力／存在しないパスはホームで起動」の旨が含まれること。
      await expect(win.locator('#set-field-1-help')).toContainText('ホームディレクトリで起動');

      // (2) Claude 自動起動（boolean → checkbox）: ラベル・型・既定オフ・help を確認。
      const claudeCheck = win.locator('#set-field-2');
      await expect(claudeCheck).toBeVisible();
      await expect(claudeCheck).toHaveAttribute('type', 'checkbox');
      // boolean は <label class="settings-check"> 内の <span class="settings-label"> がラベル。
      await expect(
        win.locator('label.settings-check', { has: win.locator('#set-field-2') })
          .locator('.settings-label')
      ).toHaveText('Claude Code を自動的に起動する');
      // 既定 false（default:false）で未チェック表示。
      await expect(claudeCheck).not.toBeChecked();
      await expect(win.locator('#set-field-2-help')).toContainText('素のターミナル');

      // (3) その下に初期コマンド（field-3）が続く（＝2 項目が API ホストと初期コマンドの間に入る）。
      await expect(win.locator('label[for="set-field-3"]')).toHaveText('初期コマンド');
    } finally {
      await app.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  // ── (2) terminal:create の cwd 解決（PR で追加した実在チェック） ──────────────
  test('terminal:create は実在ディレクトリを使い、不正パスは HOME にフォールバックする', async () => {
    const port = await getFreePort();
    const { app, win, tmpRoot, tmpHome } = await launchApp(port, BASE_CONFIG);
    // 実在する一時ディレクトリ（cwd として渡す）。
    const existDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-exist-'));
    try {
      await win.waitForSelector('#sidebar', { state: 'attached' });

      // (A) 実在ディレクトリを渡すと、resolvedCwd はそのパスのまま返る。
      const okCwd = await win.evaluate(async (dir) => {
        const { ipcRenderer } = require('electron');
        const r = await ipcRenderer.invoke('terminal:create', dir, { noClaude: true });
        return r && r.cwd;
      }, existDir);
      expect(okCwd).toBe(existDir);

      // (B) 存在しないパスを渡すと HOME(tmpHome) にフォールバックし、起動は失敗しない。
      const fbCwd = await win.evaluate(async (badPath) => {
        const { ipcRenderer } = require('electron');
        const r = await ipcRenderer.invoke('terminal:create', badPath, { noClaude: true });
        return r && r.cwd;
      }, path.join(existDir, 'no', 'such', 'dir-xyz'));
      expect(fbCwd).toBe(tmpHome);
    } finally {
      await app.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(existDir, { recursive: true, force: true });
    }
  });

  // ── (3) ＋ボタンが config を反映する（自動起動オフ → noClaude:true） ───────────
  test('ヘッダの＋ボタンは newPaneStartupDir と noClaude:true(自動起動オフ) を渡す', async () => {
    const port = await getFreePort();
    const startupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-startup-'));
    const { app, win, tmpRoot } = await launchApp(port, {
      ...BASE_CONFIG,
      newPaneStartupDir: startupDir,
      newPaneAutoLaunchClaude: false,
    });
    try {
      await win.waitForSelector('#sidebar', { state: 'attached' });
      // 起動時に生成される既定ペインのヘッダ＋ボタンを待つ。
      await win.waitForSelector('.pane-header .btn-split', { state: 'visible' });

      // ipcRenderer.invoke を包んで terminal:create の引数を記録（元処理には委譲）。
      await win.evaluate(() => {
        const { ipcRenderer } = require('electron');
        window.__termCreateCalls = [];
        const orig = ipcRenderer.invoke.bind(ipcRenderer);
        ipcRenderer.invoke = (channel, ...args) => {
          if (channel === 'terminal:create') {
            window.__termCreateCalls.push({ cwd: args[0], options: args[1] });
          }
          return orig(channel, ...args);
        };
      });

      // ＋ボタン → addPane(newPaneStartupDir, { noClaude: !newPaneAutoLaunchClaude })
      await win.locator('.pane-header .btn-split').first().click();

      await expect
        .poll(async () => await win.evaluate(() => window.__termCreateCalls.length))
        .toBeGreaterThan(0);

      const call = await win.evaluate(
        () => window.__termCreateCalls[window.__termCreateCalls.length - 1]
      );
      // 設定した初期ディレクトリが渡る。
      expect(call.cwd).toBe(startupDir);
      // 自動起動オフ → noClaude:true（素のターミナル）。
      expect(call.options && call.options.noClaude).toBe(true);
    } finally {
      await app.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(startupDir, { recursive: true, force: true });
    }
  });

  // ── (4) ＋ボタンが config を反映する（自動起動オン → noClaude:false） ──────────
  // claude 実バイナリの起動を避けるため、terminal:create はスタブ応答にして記録のみ行う
  // （他チャンネルは元処理へ委譲）。noClaude の値がトグルに正しく連動することを確認する。
  test('ヘッダの＋ボタンは noClaude:false(自動起動オン) を渡す', async () => {
    const port = await getFreePort();
    const startupDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-startup-on-'));
    const { app, win, tmpRoot } = await launchApp(port, {
      ...BASE_CONFIG,
      newPaneStartupDir: startupDir,
      newPaneAutoLaunchClaude: true,
    });
    try {
      await win.waitForSelector('#sidebar', { state: 'attached' });
      await win.waitForSelector('.pane-header .btn-split', { state: 'visible' });

      await win.evaluate(() => {
        const { ipcRenderer } = require('electron');
        window.__termCreateCalls = [];
        let n = 1000;
        const orig = ipcRenderer.invoke.bind(ipcRenderer);
        ipcRenderer.invoke = (channel, ...args) => {
          if (channel === 'terminal:create') {
            window.__termCreateCalls.push({ cwd: args[0], options: args[1] });
            // claude を起こさないようスタブ応答（PTY を実生成しない）。
            return Promise.resolve({ id: 'spy-' + (n++), cwd: args[0] || '' });
          }
          return orig(channel, ...args);
        };
      });

      await win.locator('.pane-header .btn-split').first().click();

      await expect
        .poll(async () => await win.evaluate(() => window.__termCreateCalls.length))
        .toBeGreaterThan(0);

      const call = await win.evaluate(
        () => window.__termCreateCalls[window.__termCreateCalls.length - 1]
      );
      expect(call.cwd).toBe(startupDir);
      // 自動起動オン → noClaude:false（claude 起動）。
      expect(call.options && call.options.noClaude).toBe(false);
    } finally {
      await app.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
      fs.rmSync(startupDir, { recursive: true, force: true });
    }
  });
});
