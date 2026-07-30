const { test, expect } = require('@playwright/test');
const path = require('path');
const builtinDescriptor = require('../../settings-schema.json');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// window.VKIpc.invoke（renderer 側の中継レイヤ／issue #268）を差し替え、組み込みスキーマには
// 存在しない password 型の項目を注入して .settings-reveal（表示切替ボタン）を描かせる。
// 保存はこのテストでは行わない。
async function installDescriptor(win, desc) {
  await win.evaluate((descriptor) => {
    const vkIpc = window.VKIpc;
    if (!window.__origInvoke) window.__origInvoke = vkIpc.invoke.bind(vkIpc);
    vkIpc.invoke = (channel, ...args) => {
      if (channel === 'settings:describe') return Promise.resolve(descriptor);
      if (channel === 'settings:save') return Promise.resolve({ ok: true });
      return window.__origInvoke(channel, ...args);
    };
  }, desc);
}

async function restoreInvoke(win) {
  await win.evaluate(() => {
    const vkIpc = window.VKIpc;
    if (!window.__origInvoke) return;
    vkIpc.invoke = window.__origInvoke;
    delete window.__origInvoke;
  });
}

function descriptorWithPassword(targetPath) {
  const descriptor = structuredClone(builtinDescriptor);
  descriptor.available = true;
  descriptor.targetPath = targetPath;
  descriptor.appVersion = '0.0.0-test';
  descriptor.values = {};
  const group = descriptor.groups?.[0];
  if (!group || !Array.isArray(group.fields)) throw new Error('settings-schema.json に fields を持つ groups が無い');
  // パスワード欄はグループ先頭に置き、スクロールしなくても操作できる位置に描かせる。
  group.fields.unshift({
    key: 'e2eSecret',
    label: 'テスト用パスワード',
    type: 'password',
    help: 'フォーカスリング確認用の項目。',
  });
  return descriptor;
}

// キーボード由来のフォーカスでないと :focus-visible は当たらない。
// 対象へ focus() したあと Tab で隣の停止位置へ抜け、Shift+Tab で戻すことで
// 「キーボードで選んだ状態」を作る（要素の並び順に依存せずどの停止位置でも成立する）。
async function focusByKeyboard(win, selector) {
  await win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} が見つからない`);
    el.scrollIntoView({ block: 'center' });
    el.focus();
  }, selector);
  await win.keyboard.press('Tab');
  await win.keyboard.press('Shift+Tab');
  // 戻り先が対象であること（= 以降の computed style がその要素のものであること）を確かめる。
  // コピーボタンのように同じクラスが複数ある場合に備え、evaluate 側の querySelector と
  // 同じ「先頭の 1 つ」を見る。
  await expect(win.locator(selector).first()).toBeFocused();
  expect(
    await win.evaluate((sel) => document.querySelector(sel).matches(':focus-visible'), selector),
    `${selector} が :focus-visible にならない`
  ).toBe(true);
}

// アプリ共通の自前フォーカスリング（.settings-tab / .settings-content-copy 等と同じ）。
const APP_FOCUS_RING = {
  color: 'rgb(88, 166, 255)',
  style: 'solid',
  width: '2px',
  offset: '2px',
};

// 実際に描かれているリングを読む。期待値との比較にも、既に揃っている要素との
// 突き合わせにも同じ読み取りを使い、見る項目が増えたときの直し漏れを防ぐ。
async function readRing(win, selector) {
  return await win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} が見つからない`);
    const s = getComputedStyle(el);
    return {
      color: s.outlineColor,
      style: s.outlineStyle,
      width: s.outlineWidth,
      offset: s.outlineOffset,
    };
  }, selector);
}

async function expectAppFocusRing(win, selector) {
  // OS 標準リングは outline-style が auto（macOS ではアンバー）になる。
  // 色・太さ・オフセットまで見て、アプリ共通の自前リングであることを主張する。
  expect(await readRing(win, selector), `${selector} のフォーカスリング`).toEqual(APP_FOCUS_RING);
}

const TAB_GENERAL = '#settings-tab-0';
// tabpanel は全タブ分が DOM に存在し、非アクティブなものは hidden で隠れている。
// hidden の要素はフォーカスできないため、常に「表示中のパネル」を指すセレクタを使う。
const ACTIVE_TAB_PANEL = '.settings-tab-panel:not([hidden])';

test.describe.serial('設定パネルのフォーカスリングの統一（issue #280）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-focus-ring-',
      env: { VK_TERMINALS_APP_TITLE: '', VK_TERMINALS_SETTINGS: '' },
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    // 起動ヘルパーが spec ごとに作成・後片付けする一時領域内だけを保存先として示す。
    await installDescriptor(win, descriptorWithPassword(path.join(tmpRoot, 'settings.json')));
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    await win.locator(TAB_GENERAL).click();
  });

  test.afterEach(async () => {
    const closeButton = win.locator('.settings-close');
    if ((await closeButton.count()) > 0 && await closeButton.isVisible()) {
      await closeButton.click().catch(() => {});
    }
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    await restoreInvoke(win).catch(() => {});
  });

  test('ヘッダーの閉じるボタンにアプリ共通のフォーカスリングが当たる', async () => {
    await expect(win.locator('.settings-close')).toBeVisible();
    await focusByKeyboard(win, '.settings-close');
    await expectAppFocusRing(win, '.settings-close');
  });

  test('パスワードの表示切替ボタンにアプリ共通のフォーカスリングが当たる', async () => {
    await expect(win.locator('.settings-reveal')).toBeVisible();
    await focusByKeyboard(win, '.settings-reveal');
    await expectAppFocusRing(win, '.settings-reveal');
  });

  test('フッターの保存・キャンセルにアプリ共通のフォーカスリングが当たる', async () => {
    // .settings-footer button は共通ルール。面の色が違う 2 バリアントの両方で確認する
    // （リングは面の外側に出るため、緑の保存でもグレーのキャンセルでも同じ指定になる）。
    for (const selector of ['.settings-save', '.settings-cancel']) {
      await expect(win.locator(selector)).toBeVisible();
      await focusByKeyboard(win, selector);
      await expectAppFocusRing(win, selector);
    }
  });

  test('タブの内容領域にアプリ共通のフォーカスリングが当たる', async () => {
    // tabindex="0" を持つ内容領域は Tab 順（タブボタンの直後）に止まる。
    // 全幅・全高に枠が出るぶん、ここが OS 標準リングのままだとパネル内で最も目立つ。
    await expect(win.locator(ACTIVE_TAB_PANEL)).toHaveAttribute('tabindex', '0');
    await focusByKeyboard(win, ACTIVE_TAB_PANEL);
    await expectAppFocusRing(win, ACTIVE_TAB_PANEL);
  });

  test('同じパネル内のコピーボタンとフッターのボタン・内容領域でフォーカスリングが揃う', async () => {
    // issue #280 の本題は「同じパネル内で見え方が違う」こと。既に自前リングを持つ
    // コピーボタンを基準に取り、今回そろえた要素が同じ値になることを直接比べる
    // （対象が増えても書き換えずに済むよう、ここに個数は書かない）。
    await win.locator('#settings-tab-1').click();
    await expect(win.locator('.settings-content-copy').first()).toBeVisible();
    await focusByKeyboard(win, '.settings-content-copy');
    const baseline = await readRing(win, '.settings-content-copy');

    for (const selector of ['.settings-close', '.settings-cancel', ACTIVE_TAB_PANEL]) {
      await focusByKeyboard(win, selector);
      expect(
        await readRing(win, selector),
        `${selector} とコピーボタンでフォーカスリングが揃わない`
      ).toEqual(baseline);
    }
  });
});
