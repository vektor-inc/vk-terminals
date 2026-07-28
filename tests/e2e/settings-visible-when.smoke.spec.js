const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// renderer の window.VKIpc.invoke（renderer 側の中継レイヤ／issue #268）を差し替え、visibleWhen 付き descriptor を返させる。
// 制御フィールド confirmClose（select）を never にすると、依存フィールド
// initialCommand（text, visibleWhen hide:true）が隠れる、という PR の代表例を再現する。
// あわせて pattern 付きの依存フィールド depPattern も置き、非表示時に検証が
// スキップされる（保存を妨げない）ことも確認する。
async function installMockDescriptor(win) {
  await win.evaluate(() => {
    const vkIpc = window.VKIpc;
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
    vkIpc.invoke = (channel, payload) => {
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
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-visible-when-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
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
