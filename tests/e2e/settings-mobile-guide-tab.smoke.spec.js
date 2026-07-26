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
    // API ホストの説明から説明タブへ戻れるよう、タブ名を明記する。
    await expect(win.locator('#set-field-0-help')).toContainText('「外出先から確認」タブ');
    // ダイアログ名が読み上げられるよう、見出しと関連付ける。
    await expect(win.locator('.settings-modal')).toHaveAttribute('aria-labelledby', 'settings-modal-title');
    await expect(win.locator('#settings-modal-title')).toContainText('VK Terminals 設定');
  });

  test('説明タブに手順・リンク・コード例・注意書きが表示される', async () => {
    await win.locator(TAB_MOBILE).click();
    await expect(win.locator(PANEL_MOBILE)).toBeVisible();

    // 見出しは h3（モーダルの h2 の下位）で、実行順に並ぶ。
    // 前提（Tailscale 接続 → IP 取得 → vk-terminals 側の設定）を踏んでからアドレスを
    // 開く順序になっていないと、指示どおり進めた人が必ず接続に失敗する。
    const headings = win.locator(`${PANEL_MOBILE} h3.settings-content-heading`);
    await expect(headings).toHaveText([
      'スマートフォンから確認できます',
      'Tailscale とは',
      '準備: 両方の端末を Tailscale に接続する',
      'パソコンの Tailscale IP を調べる',
      '外出先から開く 2 つの方法',
      '方法 1: vk-terminals の API ホストを変更する',
      '方法 2: tailscale serve で公開する',
      'セキュリティ上の注意',
    ]);

    // Tailscale の説明（アプリのインストール不要 / 同じ Wi-Fi でなくてよい）。
    await expect(win.locator(PANEL_MOBILE))
      .toContainText('スマートフォン側にアプリをインストールする必要はありません');
    await expect(win.locator(PANEL_MOBILE)).toContainText('tailnet');

    // 準備手順は番号付きリスト。
    await expect(win.locator(`${PANEL_MOBILE} ol.settings-content-list li`)).toHaveCount(4);

    // コードブロックは「IP の調べ方 → 開くアドレス → tailscale serve」の順。
    const codes = win.locator(`${PANEL_MOBILE} .settings-content-code`);
    await expect(codes).toHaveText([
      'tailscale ip -4',
      'http://<Tailscale IP>:13847/',
      'tailscale serve --bg 13847',
    ]);
    // --bg は版によって使えないため、対応バージョンを添えて詰まらないようにする。
    await expect(win.locator(PANEL_MOBILE)).toContainText('Tailscale 1.54 以降の書式');
    // 山括弧ごとコピーされないよう実例を併記する。
    await expect(win.locator(PANEL_MOBILE)).toContainText('http://100.101.102.103:13847/');
    // アドレスの節は再起動を受けた文にする（前工程を踏ませる）。
    await expect(win.locator(PANEL_MOBILE)).toContainText('再起動したら');
    // 2 つの方法の選び分けを添える。
    await expect(win.locator(PANEL_MOBILE)).toContainText('どちらか一方を行えば開けます');

    // 注意書きは role="note" + トーンを表す語（色だけに依存しない）で伝える。
    const callouts = win.locator(`${PANEL_MOBILE} .settings-content-callout`);
    await expect(callouts).toHaveCount(2);
    // 方法 1 には、Tailscale 未接続時に 127.0.0.1 へ黙ってフォールバックする旨の補足。
    const infoCallout = win.locator(`${PANEL_MOBILE} .settings-content-callout[data-tone="info"]`);
    await expect(infoCallout).toHaveAttribute('role', 'note');
    await expect(infoCallout.locator('.settings-content-callout-label')).toHaveText('補足');
    await expect(infoCallout).toContainText('127.0.0.1 で待ち受けます');
    // 末尾は無認証についての警告。
    const warningCallout = win.locator(`${PANEL_MOBILE} .settings-content-callout[data-tone="warning"]`);
    await expect(warningCallout).toHaveAttribute('role', 'note');
    await expect(warningCallout.locator('.settings-content-callout-label')).toHaveText('注意');
    await expect(warningCallout).toContainText('認証がありません');

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

  test('移動ボタンは設定タブの API ホスト欄まで運ぶ（表示領域内・フォーカス済み）', async () => {
    await win.locator(TAB_MOBILE).click();
    const tabLink = win.locator(`${PANEL_MOBILE} .settings-content-tablink`);
    await expect(tabLink).toHaveText('API ホストの設定へ移動');
    // 説明タブを読み進めた状態（スクロール済み）から押しても着地点は変わらない。
    await win.locator(PANEL_MOBILE).evaluate((el) => {
      el.closest('.settings-view-config').scrollTop = 600;
    });
    await tabLink.click();

    // 「設定」タブがアクティブになる。
    await expect(win.locator(TAB_GENERAL)).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(PANEL_GENERAL)).toBeVisible();
    // API ホスト欄そのものにフォーカスが乗る（タブを開いただけで終わらせない）。
    const focusedId = await win.evaluate(() => document.activeElement && document.activeElement.id);
    expect(focusedId).toBe('set-field-0');
    // かつスクロールコンテナの表示領域内に収まっている。
    const visible = await win.locator('#set-field-0').evaluate((el) => {
      const view = el.closest('.settings-view-config').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return box.top >= view.top && box.bottom <= view.bottom;
    });
    expect(visible).toBe(true);
  });

  test('タブを切り替えるとスクロール位置が先頭に戻る', async () => {
    // 設定タブを下までスクロールしてから説明タブへ移ると、導入から読み始められる。
    await win.locator(PANEL_GENERAL).evaluate((el) => {
      el.closest('.settings-view-config').scrollTop = 99999;
    });
    const scrolled = await win.locator(PANEL_GENERAL).evaluate(
      (el) => el.closest('.settings-view-config').scrollTop
    );
    expect(scrolled).toBeGreaterThan(0);

    await win.locator(TAB_MOBILE).click();
    const afterSwitch = await win.locator(PANEL_MOBILE).evaluate(
      (el) => el.closest('.settings-view-config').scrollTop
    );
    expect(afterSwitch).toBe(0);
    // 説明タブの先頭（導入の見出し）が見えている。
    await expect(win.locator(`${PANEL_MOBILE} h3.settings-content-heading`).first()).toBeInViewport();
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
