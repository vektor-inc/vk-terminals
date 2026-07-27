const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// renderer の ipcRenderer.invoke を差し替え、tabs 付き descriptor を返させる。
// main.js の settings:describe が tabs を含めて返す形（PR の変更）を模したもの。
// groups には tab キーで所属タブを指定し、group ごとに targetPaths（保存先）を持たせる。
async function installTabbedDescriptor(win) {
  await win.evaluate(() => {
    const { ipcRenderer } = require('electron');
    const desc = {
      available: true,
      title: 'タブ設定',
      note: 'すべてのタブの内容は保存時にまとめて反映されます。',
      targetPath: '',
      appVersion: '0.0.0-test',
      hasMultipleTargets: true,
      // タブ定義（PR の新機能）。
      tabs: [
        { id: 'general', label: '基本' },
        { id: 'tokens', label: 'トークン' },
      ],
      targetPaths: ['/tmp/general.json', '/tmp/tokens.json'],
      groups: [
        {
          label: 'API 設定',
          tab: 'general',
          targetPaths: ['/tmp/general.json'],
          fields: [{ key: 'host', label: 'API ホスト', type: 'text' }],
        },
        {
          label: 'トークン設定',
          tab: 'tokens',
          targetPaths: ['/tmp/tokens.json'],
          fields: [
            {
              key: 'limit',
              label: 'トークン上限',
              type: 'text',
              // 数字のみ許容する pattern（非アクティブタブの不正値→保存時自動切替の検証用）。
              pattern: '^[0-9]+$',
              invalidMessage: '数字のみで入力してください',
            },
          ],
        },
      ],
      values: { host: '', limit: '' },
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

// group が tab 順にグルーピングされるため、フィールド id は general(host)=0 → tokens(limit)=1。
const HOST_ID = '#set-field-0';
const LIMIT_ID = '#set-field-1';
const TAB0 = '#settings-tab-0'; // 基本
const TAB1 = '#settings-tab-1'; // トークン

test.describe.serial('設定モーダルのタブ UI（issue #167）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-tabs-',
      // 実環境の VK_TERMINALS_* の影響を受けないよう明示的に無効化する。
      env: { VK_TERMINALS_APP_TITLE: '', VK_TERMINALS_SETTINGS: '' },
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  // 各テストの前にモックを入れ直し、モーダルを開き直す（DOM を毎回まっさらに）。
  test.beforeEach(async () => {
    await installTabbedDescriptor(win);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    await win.waitForSelector('.settings-tabs', { state: 'visible' });
  });

  // 各テストの後に閉じるボタンでモーダルを閉じる（次テストで再オープンできるように）。
  test.afterEach(async () => {
    const closeBtn = win.locator('.settings-close');
    if (await closeBtn.count()) {
      await closeBtn.click().catch(() => {});
    }
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
  });

  test('ARIA 構造: tablist/tab/tabpanel と roving tabindex が正しい', async () => {
    // tablist ロール。
    await expect(win.locator('.settings-tabs')).toHaveAttribute('role', 'tablist');
    // タブは 2 つ、role=tab。
    const tabs = win.locator('.settings-tab');
    await expect(tabs).toHaveCount(2);
    // 先頭タブが選択済み（aria-selected=true / tabindex=0）、2 番目は未選択（-1）。
    await expect(win.locator(TAB0)).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(TAB0)).toHaveAttribute('tabindex', '0');
    await expect(win.locator(TAB1)).toHaveAttribute('aria-selected', 'false');
    await expect(win.locator(TAB1)).toHaveAttribute('tabindex', '-1');
    // aria-controls が対応する tabpanel を指す。
    await expect(win.locator(TAB0)).toHaveAttribute('aria-controls', 'settings-panel-0');
    // tabpanel は role=tabpanel / aria-labelledby でタブと関連付く。
    await expect(win.locator('#settings-panel-0')).toHaveAttribute('role', 'tabpanel');
    await expect(win.locator('#settings-panel-0')).toHaveAttribute('aria-labelledby', 'settings-tab-0');
    await expect(win.locator('#settings-panel-0')).toHaveAttribute('tabindex', '0');
    // 先頭パネルのみ可視、2 番目は hidden。
    await expect(win.locator('#settings-panel-0')).toBeVisible();
    await expect(win.locator('#settings-panel-1')).toBeHidden();
  });

  test('各タブ先頭に保存先が表示される', async () => {
    // 基本タブのパネル先頭に general.json の保存先。
    await expect(win.locator('#settings-panel-0 .settings-tab-target')).toContainText('/tmp/general.json');
    // トークンタブに切り替えると tokens.json の保存先。
    await win.locator(TAB1).click();
    await expect(win.locator('#settings-panel-1 .settings-tab-target')).toContainText('/tmp/tokens.json');
    // タブ UI 時はヘッダー下の従来型保存先案内（.settings-target）は出ない。
    await expect(win.locator('.settings-target')).toHaveCount(0);
  });

  test('タブ切替で他タブの入力値が保持される', async () => {
    // 基本タブで host を入力。
    await win.locator(HOST_ID).fill('example.com');
    // トークンタブへ切替 → limit を入力。
    await win.locator(TAB1).click();
    await expect(win.locator('#settings-panel-1')).toBeVisible();
    await win.locator(LIMIT_ID).fill('100');
    // 基本タブへ戻ると host の入力が保持されている。
    await win.locator(TAB0).click();
    await expect(win.locator(HOST_ID)).toHaveValue('example.com');
    // 再度トークンタブへ戻っても limit が保持されている。
    await win.locator(TAB1).click();
    await expect(win.locator(LIMIT_ID)).toHaveValue('100');
  });

  test('キーボード操作: ←/→/Home/End でタブ移動できる', async () => {
    // 先頭タブへフォーカスを当ててから矢印操作。
    await win.locator(TAB0).focus();
    // → で次のタブへ（自動選択）。
    await win.keyboard.press('ArrowRight');
    await expect(win.locator(TAB1)).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(TAB1)).toHaveAttribute('tabindex', '0');
    await expect(win.locator(TAB0)).toHaveAttribute('tabindex', '-1');
    await expect(win.locator('#settings-panel-1')).toBeVisible();
    // ← で前のタブへ戻る。
    await win.keyboard.press('ArrowLeft');
    await expect(win.locator(TAB0)).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator('#settings-panel-0')).toBeVisible();
    // End で最後のタブへ。
    await win.keyboard.press('End');
    await expect(win.locator(TAB1)).toHaveAttribute('aria-selected', 'true');
    // Home で先頭のタブへ。
    await win.keyboard.press('Home');
    await expect(win.locator(TAB0)).toHaveAttribute('aria-selected', 'true');
    // フォーカスが移動先タブに乗っている（roving）。
    const focusedId = await win.evaluate(() => document.activeElement && document.activeElement.id);
    expect(focusedId).toBe('settings-tab-0');
  });

  test('編集したタブに未保存インジケータと SR 向け aria-label が付く', async () => {
    // 初期はどのタブも dirty ではない。
    await expect(win.locator(TAB0)).not.toHaveClass(/is-dirty/);
    // 基本タブの host を編集する。
    await win.locator(HOST_ID).fill('changed.example');
    // 基本タブに is-dirty が付き、未保存ドットが可視になる。
    await expect(win.locator(TAB0)).toHaveClass(/is-dirty/);
    const dotOpacity = await win.locator(`${TAB0} .settings-tab-dirty`).evaluate(
      (el) => getComputedStyle(el).opacity
    );
    expect(dotOpacity).toBe('1');
    // スクリーンリーダー向けに「未保存の変更あり」を含む aria-label が付く。
    await expect(win.locator(TAB0)).toHaveAttribute('aria-label', /未保存の変更あり/);
    // 編集していないトークンタブには付かない。
    await expect(win.locator(TAB1)).not.toHaveClass(/is-dirty/);
  });

  test('非アクティブタブの pattern 不正値は保存時に該当タブへ自動切替＋フォーカス', async () => {
    // トークンタブへ切替 → limit に不正値（数字以外）を入力。
    await win.locator(TAB1).click();
    await win.locator(LIMIT_ID).fill('abc');
    // 基本タブへ戻し、トークンタブを非アクティブ（hidden）にする。
    await win.locator(TAB0).click();
    await expect(win.locator('#settings-panel-1')).toBeHidden();

    // 保存を押す。
    await win.locator('.settings-save').click();

    // 保存は中断される（settings:save は呼ばれない）。
    const saved = await win.evaluate(() => window.__savedPayloads.length);
    expect(saved).toBe(0);
    // 不正値のあるトークンタブへ自動で切り替わり、パネルが可視になる。
    await expect(win.locator(TAB1)).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator('#settings-panel-1')).toBeVisible();
    // 最初の不正欄（limit）へフォーカスが移動する。
    const focusedId = await win.evaluate(() => document.activeElement && document.activeElement.id);
    expect(focusedId).toBe('set-field-1');
    // 総括メッセージも表示される。
    await expect(win.locator('.settings-msg')).toHaveText('入力内容に問題があります');
  });

  test('全タブ正常値で保存すると成功し、未保存インジケータが解除される', async () => {
    // 基本タブ host を編集（dirty 化）。
    await win.locator(HOST_ID).fill('ok.example');
    await expect(win.locator(TAB0)).toHaveClass(/is-dirty/);
    // トークンタブへ切替 → 正常な数字を入力（dirty 化）。
    await win.locator(TAB1).click();
    await win.locator(LIMIT_ID).fill('200');
    await expect(win.locator(TAB1)).toHaveClass(/is-dirty/);

    // 保存する。
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');
    // 両タブの値がまとめて保存される。
    const payload = await win.evaluate(() => window.__savedPayloads[window.__savedPayloads.length - 1]);
    expect(payload.host).toBe('ok.example');
    expect(payload.limit).toBe('200');
    // 保存成功で未保存インジケータが両タブとも解除される。
    await expect(win.locator(TAB0)).not.toHaveClass(/is-dirty/);
    await expect(win.locator(TAB1)).not.toHaveClass(/is-dirty/);
  });
});
