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
async function launchApp(port) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-visible-when-'));
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

// renderer の ipcRenderer.invoke を差し替え、visibleWhen 付き descriptor を返させる。
// 制御フィールド confirmClose（select）を never にすると、依存フィールド
// initialCommand（text, visibleWhen hide:true）が隠れる、という PR の代表例を再現する。
// あわせて pattern 付きの依存フィールド depPattern も置き、非表示時に検証が
// スキップされる（保存を妨げない）ことも確認する。
async function installMockDescriptor(win) {
  await win.evaluate(() => {
    const { ipcRenderer } = require('electron');
    const desc = {
      available: true,
      title: 'テスト設定',
      note: '',
      targetPath: '/tmp/mock-settings.json',
      appVersion: '0.0.0-test',
      groups: [{
        label: '基本',
        fields: [
          // 制御フィールド（select）。この値に応じて依存行の表示が切り替わる。
          {
            key: 'confirmClose',
            label: 'ペインを閉じる時の確認ダイアログ',
            type: 'select',
            options: [
              { value: 'busy', label: '実行中・入力待ちの場合は表示（既定）' },
              { value: 'always', label: '常に表示' },
              { value: 'never', label: '確認なし' },
            ],
          },
          // 依存フィールド1（text）。confirmClose が never のとき隠れる。
          {
            key: 'initialCommand',
            label: '初期コマンド',
            type: 'text',
            visibleWhen: { key: 'confirmClose', value: 'never', hide: true },
          },
          // 依存フィールド2（pattern 付き text）。confirmClose が never のとき隠れる。
          // 非表示時は pattern 検証がスキップされることの確認用。
          {
            key: 'depPattern',
            label: 'owner/repo 形式',
            type: 'text',
            pattern: '^[^/\\s]+/[^/\\s]+$',
            invalidMessage: 'owner/repo の形式で入力してください',
            visibleWhen: { key: 'confirmClose', value: 'never', hide: true },
          },
        ],
      }],
      values: { confirmClose: 'busy', initialCommand: '', depPattern: '' },
    };
    window.__savedPayloads = [];
    ipcRenderer.invoke = (channel, payload) => {
      if (channel === 'settings:describe') return Promise.resolve(desc);
      if (channel === 'settings:save') {
        window.__savedPayloads.push(payload);
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    };
  });
}

// フィールド id は描画順採番（confirmClose=0, initialCommand=1, depPattern=2）。
const CONFIRM_ID = '#set-field-0';
const INITIAL_ID = '#set-field-1';
const DEP_PATTERN_ID = '#set-field-2';

// 指定入力の属する .settings-row 要素を取得する。
function rowOf(win, inputSelector) {
  return win.locator(inputSelector).locator('xpath=ancestor::*[contains(@class,"settings-row")][1]');
}

test.describe.serial('設定ダイアログの visibleWhen 表示切替（issue #213）', () => {
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

  // 各テストの前にモックを入れ直し、設定モーダルを開き直す（DOM を毎回まっさらに）。
  test.beforeEach(async () => {
    await installMockDescriptor(win);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    await win.waitForSelector(CONFIRM_ID, { state: 'visible' });
  });

  // 各テストの後にキャンセルボタンで確実に閉じる（次テストで再オープンできるように）。
  // ※ Escape は <select> にフォーカスがあると select 側に飲み込まれて閉じないことが
  //    あるため、ボタンクリックで閉じる。
  test.afterEach(async () => {
    await win.locator('.settings-cancel').click().catch(() => {});
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
  });

  test('1: 初期状態（busy）では依存行が表示されている', async () => {
    // 初期値 busy では visibleWhen(hide:true) の条件に一致しないので表示。
    await expect(win.locator(INITIAL_ID)).toBeVisible();
    await expect(rowOf(win, INITIAL_ID)).toBeVisible();
  });

  test('2: never に切り替えると依存行がその場で消える（display も none）', async () => {
    const initialRow = rowOf(win, INITIAL_ID);
    // never に切替 → その場で非表示（再読み込み不要）。
    await win.locator(CONFIRM_ID).selectOption('never');

    // Playwright 的に hidden（＝レイアウトから除外されている）。
    await expect(initialRow).toBeHidden();
    await expect(win.locator(INITIAL_ID)).toBeHidden();

    // hidden 属性が付いている。
    await expect(initialRow).toHaveAttribute('hidden', /.*/);

    // computed display が none（style.css の .settings-row[hidden]{display:none} が効いている）。
    const display = await initialRow.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe('none');
  });

  test('3: never→busy に戻すと依存行が再表示され、入力値が保持される', async () => {
    // まず値を入れてから非表示にする。
    await win.locator(INITIAL_ID).fill('claude --resume');
    await win.locator(CONFIRM_ID).selectOption('never');
    await expect(rowOf(win, INITIAL_ID)).toBeHidden();

    // busy に戻すと再表示。
    await win.locator(CONFIRM_ID).selectOption('busy');
    await expect(rowOf(win, INITIAL_ID)).toBeVisible();

    // 入力値が保持されている。
    await expect(win.locator(INITIAL_ID)).toHaveValue('claude --resume');
  });

  test('4: 非表示中の pattern 不正値は保存を妨げない（検証スキップ）', async () => {
    // depPattern に pattern 不正な値を入れる（表示中なので後で赤枠が付く状態）。
    await win.locator(DEP_PATTERN_ID).fill('invalid value with spaces');

    // never に切替 → depPattern 行が非表示になる。
    await win.locator(CONFIRM_ID).selectOption('never');
    await expect(rowOf(win, DEP_PATTERN_ID)).toBeHidden();

    // この状態で保存 → 非表示項目は検証対象外なので保存が通る。
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');

    const saved = await win.evaluate(() => window.__savedPayloads.length);
    expect(saved).toBe(1);
    // 非表示でも値自体は保持され、保存 payload に含まれる。
    const payload = await win.evaluate(() => window.__savedPayloads[0]);
    expect(payload.depPattern).toBe('invalid value with spaces');
    expect(payload.confirmClose).toBe('never');
  });

  test('5: 表示中の pattern 不正値は従来どおり保存を止める（回帰確認）', async () => {
    // busy のまま（depPattern 表示中）で不正値を入れて保存 → 止まる。
    await win.locator(DEP_PATTERN_ID).fill('invalid value with spaces');
    await win.locator('.settings-save').click();

    // 保存されない。
    const saved = await win.evaluate(() => window.__savedPayloads.length);
    expect(saved).toBe(0);
    await expect(win.locator('.settings-msg')).toHaveText('入力内容に問題があります');
    await expect(win.locator(DEP_PATTERN_ID)).toHaveAttribute('aria-invalid', 'true');
  });
});
