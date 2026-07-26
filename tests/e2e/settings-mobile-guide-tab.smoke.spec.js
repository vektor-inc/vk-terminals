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
// VK_TERMINALS_SETTINGS を空にして、組み込みスキーマ（settings-schema.json）を
// そのまま描画させる。このテストは組み込みスキーマの tabs 定義自体も検証対象にする。
async function launchApp(port) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-mobile-guide-'));
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

const TAB_GENERAL = '#settings-tab-0';   // 設定
const TAB_MOBILE = '#settings-tab-1';    // 外出先から確認
const PANEL_GENERAL = '#settings-panel-0';
const PANEL_MOBILE = '#settings-panel-1';

test.describe.serial('設定パネルの説明タブ「外出先から確認」（issue #245）', () => {
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

  test.beforeEach(async () => {
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    await win.waitForSelector('.settings-tabs', { state: 'visible' });
  });

  test.afterEach(async () => {
    const closeBtn = win.locator('.settings-close');
    if (await closeBtn.count()) {
      await closeBtn.click().catch(() => {});
    }
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
  });

  test('組み込みスキーマに「設定」「外出先から確認」の 2 タブが出る', async () => {
    await expect(win.locator('.settings-tab')).toHaveCount(2);
    await expect(win.locator(TAB_GENERAL)).toContainText('設定');
    await expect(win.locator(TAB_MOBILE)).toContainText('外出先から確認');
    // 既定は「設定」タブ（既存の設定項目が従来どおり見える）。
    await expect(win.locator(TAB_GENERAL)).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(`${PANEL_GENERAL} label[for="set-field-0"]`)).toHaveText('API ホスト');
  });

  test('説明タブに手順・リンク・コード例・注意書きが表示される', async () => {
    await win.locator(TAB_MOBILE).click();
    await expect(win.locator(PANEL_MOBILE)).toBeVisible();

    // 見出しは h3（モーダルの h2 の下位）で、情報設計どおりの順に並ぶ。
    const headings = win.locator(`${PANEL_MOBILE} h3.settings-content-heading`);
    await expect(headings.nth(0)).toHaveText('スマートフォンから確認できます');
    await expect(headings.nth(1)).toHaveText('Tailscale とは');
    await expect(headings.last()).toHaveText('セキュリティ上の注意');

    // Tailscale の説明（アプリのインストール不要 / 同じ Wi-Fi でなくてよい）。
    await expect(win.locator(PANEL_MOBILE))
      .toContainText('スマートフォン側にアプリをインストールする必要はありません');
    await expect(win.locator(PANEL_MOBILE)).toContainText('tailnet');

    // 準備手順は番号付きリスト。
    await expect(win.locator(`${PANEL_MOBILE} ol.settings-content-list li`)).toHaveCount(4);

    // 開く URL 例と tailscale serve のコマンド例がコードブロックで出る。
    const codes = win.locator(`${PANEL_MOBILE} .settings-content-code`);
    await expect(codes.nth(0)).toHaveText('http://<Tailscale IP>:13847/');
    await expect(codes.nth(1)).toHaveText('tailscale serve --bg 13847');

    // 注意書きは role="note" + 「注意」の文字（色だけに依存しない）で伝える。
    const callout = win.locator(`${PANEL_MOBILE} .settings-content-callout`);
    await expect(callout).toHaveAttribute('role', 'note');
    await expect(callout).toHaveAttribute('data-tone', 'warning');
    await expect(callout.locator('.settings-content-callout-label')).toHaveText('注意');
    await expect(callout).toContainText('認証がありません');

    // 保存対象が無いタブなので「保存後、次回の起動から反映されます。」は継承しない。
    await expect(win.locator(`${PANEL_MOBILE} .settings-tab-note`)).toHaveCount(0);
    // パネル自身がフォーカス可能（入力欄が無いのでキーボードで読めるようにする）。
    await expect(win.locator(PANEL_MOBILE)).toHaveAttribute('tabindex', '0');
  });

  test('外部リンクは href="#" のまま data 属性に http(s) URL を持つ', async () => {
    await win.locator(TAB_MOBILE).click();
    const links = win.locator(`${PANEL_MOBILE} .settings-content-link`);
    await expect(links).toHaveCount(2);
    // Electron の renderer 内で外部サイトが開かないよう href は "#"。
    await expect(links.nth(0)).toHaveAttribute('href', '#');
    await expect(links.nth(0)).toHaveAttribute(
      'data-external-url',
      'https://tailscale.com/docs/how-to/quickstart'
    );
    await expect(links.nth(1)).toHaveAttribute('data-external-url', 'https://tailscale.com/download');
    // スクリーンリーダー向けに外部ブラウザで開くことを伝える。
    await expect(links.nth(0)).toHaveAttribute('aria-label', /外部ブラウザで開く/);
    // キーボードでフォーカスできる。
    await links.nth(0).focus();
    const focusedUrl = await win.evaluate(
      () => document.activeElement && document.activeElement.dataset.externalUrl
    );
    expect(focusedUrl).toBe('https://tailscale.com/docs/how-to/quickstart');
  });

  test('説明タブには入力欄が 1 つも無く、保存ボタンが隠れる', async () => {
    await win.locator(TAB_MOBILE).click();
    await expect(win.locator(`${PANEL_MOBILE} input, ${PANEL_MOBILE} select, ${PANEL_MOBILE} textarea`))
      .toHaveCount(0);
    // 保存対象が無いので「保存」と保存ヒントを隠し、残す操作は「閉じる」だけにする。
    await expect(win.locator('.settings-save')).toBeHidden();
    await expect(win.locator('.settings-save-hint')).toBeHidden();
    await expect(win.locator('.settings-cancel')).toHaveText('閉じる');

    // 「設定」タブへ戻すと元に戻る。
    await win.locator(TAB_GENERAL).click();
    await expect(win.locator('.settings-save')).toBeVisible();
    await expect(win.locator('.settings-save-hint')).toBeVisible();
    await expect(win.locator('.settings-cancel')).toHaveText('キャンセル');
  });

  test('「設定」タブを開くボタンで設定タブへ移動できる', async () => {
    await win.locator(TAB_MOBILE).click();
    const tabLink = win.locator(`${PANEL_MOBILE} .settings-content-tablink`);
    await expect(tabLink).toHaveText('「設定」タブを開く');
    await tabLink.click();

    // 「設定」タブがアクティブになり、API ホストの入力欄が見える。
    await expect(win.locator(TAB_GENERAL)).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(PANEL_GENERAL)).toBeVisible();
    await expect(win.locator('#set-field-0')).toBeVisible();
    // フォーカスも移動先タブへ移る（キーボード操作でも流れが途切れない）。
    const focusedId = await win.evaluate(() => document.activeElement && document.activeElement.id);
    expect(focusedId).toBe('settings-tab-0');
  });

  test('未保存の変更がある場合は説明タブでも保存ボタンを隠さない', async () => {
    // 「設定」タブで API ホストを編集して未保存状態にする。
    await win.locator('#set-field-0').fill('100.100.100.100');
    await expect(win.locator(TAB_GENERAL)).toHaveClass(/is-dirty/);

    // 説明タブへ移動しても、変更を保存する手段（保存ボタン）は残る。
    await win.locator(TAB_MOBILE).click();
    await expect(win.locator('.settings-save')).toBeVisible();
    await expect(win.locator('.settings-cancel')).toHaveText('キャンセル');
  });
});
