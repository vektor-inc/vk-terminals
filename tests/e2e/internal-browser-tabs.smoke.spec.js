'use strict';

const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
const { PARTITION } = require('../../utils/internalBrowserPolicy');

// アプリ内ブラウザのタブ（issue #644）を、実アプリの画面・IPC・WebContentsView で確かめる。
// ページは専用セッションの https をアプリ内で応答して用意し、外部の通信には頼らない。

// 1x1 の PNG（ファビコン）。
const FAVICON_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

async function start(prefix) {
  const port = await getFreePort();
  const launched = await launchAppAndWait({ port, prefix, config: { confirmClose: 'never', openInitialPane: false } });
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 800));
  await expect.poll(() => launched.win.evaluate(() => innerWidth)).toBe(1400);
  // 専用セッションの https をアプリ内で応答する。/a は別タブで開くリンクとファビコンを持つ。
  await launched.app.evaluate(({ session }, { partition, favicon }) => {
    globalThis.faviconRequests = 0;
    session.fromPartition(partition).protocol.handle('https', request => {
      const { pathname } = new URL(request.url);
      if (pathname === '/icon.png') {
        globalThis.faviconRequests++;
        return new Response(Buffer.from(favicon, 'base64'), { headers: { 'Content-Type': 'image/png' } });
      }
      const titles = { '/a': 'ページ A', '/b': 'ページ B', '/c': 'ページ C' };
      const body = `<!doctype html><title>${titles[pathname] || 'その他'}</title><link rel="icon" href="/icon.png">`
        + '<a id="blank" href="/b" target="_blank">別タブで開く</a>';
      return new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    });
  }, { partition: PARTITION, favicon: FAVICON_BASE64 });
  return launched;
}

const tabs = win => win.getByRole('tablist', { name: 'アプリ内ブラウザのタブ' }).getByRole('tab');
const address = win => win.locator('.internal-browser-toolbar').getByRole('textbox', { name: 'URL または検索語を入力' });

async function openAddress(win, url) {
  await address(win).fill(url);
  await address(win).press('Enter');
}

// @title タブを足して切り替え、閉じる。最後のタブを閉じるとサイドバーごと閉じる
test('タブを足して切り替え、閉じる。最後のタブを閉じるとサイドバーごと閉じる', async () => {
  const launched = await start('vk-terminals-e2e-browser-tabs-');
  const { win } = launched;
  try {
    // @step タイトルバーの切り替えボタンでアプリ内ブラウザを開く
    await win.locator('#internal-browser-toggle').click();
    // @check タブが 1 つ（新しいタブ）だけあり、入力の案内が出て、URL 欄にフォーカスがある
    await expect(tabs(win)).toHaveCount(1);
    await expect(tabs(win).first()).toHaveAttribute('aria-selected', 'true');
    await expect(tabs(win).first()).toHaveAccessibleName('新しいタブ');
    await expect(win.locator('.internal-browser-empty')).toBeVisible();
    await expect(address(win)).toBeFocused();
    // @check 操作列の ✕ の名前は「アプリ内ブラウザを閉じる」
    await expect(win.locator('.internal-browser-toolbar [data-action="close"]')).toHaveAccessibleName('アプリ内ブラウザを閉じる');
    // @check タブの行は高さ 32px で、操作列の上にある
    const [tabbar, toolbar] = await Promise.all(['.internal-browser-tabbar', '.internal-browser-toolbar']
      .map(selector => win.locator(selector).boundingBox()));
    expect(Math.round(tabbar.height)).toBe(32);
    expect(tabbar.y + tabbar.height).toBeLessThanOrEqual(toolbar.y + 0.5);

    // @step URL 欄に 1 つめのページを入れて開く
    await openAddress(win, 'https://tabs.test/a');
    // @check タブにページタイトルとファビコン（画像データ）が出て、入力の案内が消える
    await expect(tabs(win).first()).toHaveAccessibleName('ページ A');
    await expect(tabs(win).first().locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
    await expect(win.locator('.internal-browser-empty')).toBeHidden();

    // @step 「＋」（新しいタブ）を押し、2 つめのページを開く
    await win.getByRole('button', { name: '新しいタブ', exact: true }).click();
    // @check 新しいタブが右に増えて選ばれ、URL 欄が空でフォーカスがある
    await expect(tabs(win)).toHaveCount(2);
    await expect(tabs(win).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(address(win)).toBeFocused();
    await expect(address(win)).toHaveValue('');
    await expect(win.locator('.internal-browser-tab-status')).toHaveText('新しいタブを開きました');
    await openAddress(win, 'https://tabs.test/c');
    await expect(tabs(win).nth(1)).toHaveAccessibleName('ページ C');

    // @step 1 つめのタブを押す
    await tabs(win).first().click();
    // @check URL 欄と戻る / 進むが 1 つめのタブのものに入れ替わる
    await expect(tabs(win).first()).toHaveAttribute('aria-selected', 'true');
    await expect(address(win)).toHaveValue('https://tabs.test/a');
    // @check Tab キーで止まるのは選んでいるタブだけ
    await expect(tabs(win).first()).toHaveAttribute('tabindex', '0');
    await expect(tabs(win).nth(1)).toHaveAttribute('tabindex', '-1');

    // @step ページ内の「新しいタブで開く」リンクを押す
    await launched.app.evaluate(({ webContents }) => webContents.getAllWebContents()
      .find(contents => contents.getURL() === 'https://tabs.test/a')
      .executeJavaScript("document.getElementById('blank').click()", true));
    // @check 押したタブのすぐ右に新しいタブが開いて前に出る
    await expect(tabs(win)).toHaveCount(3);
    await expect(tabs(win).nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs(win).nth(1)).toHaveAccessibleName('ページ B');
    await expect(tabs(win).nth(2)).toHaveAccessibleName('ページ C');
    await expect(address(win)).toHaveValue('https://tabs.test/b');
    // @check 同じファビコンは取得し直さない
    expect(await launched.app.evaluate(() => globalThis.faviconRequests)).toBe(1);

    // @step 選んでいるタブにフォーカスを置き、→ と Enter で右のタブへ切り替える
    await tabs(win).nth(1).focus();
    await win.keyboard.press('ArrowRight');
    await expect(tabs(win).nth(2)).toBeFocused();
    await win.keyboard.press('Enter');
    // @check 右のタブが選ばれ、URL 欄がそのタブのものになる
    await expect(tabs(win).nth(2)).toHaveAttribute('aria-selected', 'true');
    await expect(address(win)).toHaveValue('https://tabs.test/c');
    // @step Home で先頭のタブへ移り、Delete で閉じる
    await win.keyboard.press('Home');
    await expect(tabs(win).first()).toBeFocused();
    await win.keyboard.press('Delete');
    // @check タブが閉じ、閉じたことを読み上げる
    await expect(tabs(win)).toHaveCount(2);
    await expect(win.locator('.internal-browser-tab-status')).toHaveText('タブを閉じました');
    await expect(tabs(win).nth(1)).toHaveAttribute('aria-selected', 'true');

    // @step 選んでいないタブを中クリックする
    await tabs(win).first().click({ button: 'middle' });
    // @check 中クリックしたタブが閉じ、選んでいるタブはそのまま
    await expect(tabs(win)).toHaveCount(1);
    await expect(tabs(win).first()).toHaveAccessibleName('ページ C');

    // @step 操作列の「アプリ内ブラウザを閉じる」で閉じてから、もう一度開く
    await win.locator('.internal-browser-toolbar [data-action="close"]').click();
    await expect(win.locator('#internal-browser-sidebar')).toBeHidden();
    await win.locator('#internal-browser-toggle').click();
    // @check 隠すだけなので、タブとページは残っている
    await expect(tabs(win)).toHaveCount(1);
    await expect(tabs(win).first()).toHaveAccessibleName('ページ C');

    // @step 最後のタブの × を押す
    await tabs(win).first().hover();
    await tabs(win).first().locator('.internal-browser-tab-close').click();
    // @check サイドバーごと閉じ、フォーカスがツールバーのアプリ内ブラウザ切り替えボタンに戻る
    await expect(win.locator('#internal-browser-sidebar')).toBeHidden();
    await expect(win.locator('#internal-browser-toggle')).toBeFocused();
    // @step もう一度開く
    await win.locator('#internal-browser-toggle').click();
    // @check 空の新しいタブ 1 つから始まり、URL 欄にフォーカスがある
    await expect(tabs(win)).toHaveCount(1);
    await expect(tabs(win).first()).toHaveAccessibleName('新しいタブ');
    await expect(win.locator('.internal-browser-empty')).toBeVisible();
    await expect(address(win)).toBeFocused();
  } finally {
    await closeApp(launched);
  }
});

// @title 「アプリ内で開く」は同じページのタブへ切り替え、上限 10 個では案内を出す
test('「アプリ内で開く」は同じページのタブへ切り替え、上限 10 個では案内を出す', async () => {
  const launched = await start('vk-terminals-e2e-browser-tab-limit-');
  const { win } = launched;
  // ペインのリンクを押したときと同じ開き先メニューを出し、「アプリ内で開く」を選ぶ。
  const openFromPane = async url => {
    await win.evaluate(target => showInternalBrowserChoice(target, { clientX: 40, clientY: 80, detail: 1, button: 0 }), url);
    await win.getByRole('menuitem', { name: 'アプリ内で開く' }).click();
  };
  try {
    // @step ペインのリンクから 1 つめのページを「アプリ内で開く」
    await openFromPane('https://tabs.test/a');
    // @check 起動直後の空のタブにそのまま開く
    await expect(tabs(win)).toHaveCount(1);
    await expect(tabs(win).first()).toHaveAccessibleName('ページ A');

    // @step 別のページを「アプリ内で開く」
    await openFromPane('https://tabs.test/c');
    // @check 新しいタブを開いて前に出す
    await expect(tabs(win)).toHaveCount(2);
    await expect(tabs(win).nth(1)).toHaveAttribute('aria-selected', 'true');

    // @step 1 つめと同じページ（末尾の / と # 以降だけが違う）を「アプリ内で開く」
    await openFromPane('https://tabs.test/a/#section');
    // @check 新しいタブを開かず、1 つめのタブへ切り替える
    await expect(tabs(win)).toHaveCount(2);
    await expect(tabs(win).first()).toHaveAttribute('aria-selected', 'true');
    await expect(address(win)).toHaveValue('https://tabs.test/a');

    // @step 「＋」でタブを 10 個まで増やす
    const newTab = win.locator('.internal-browser-tab-new');
    for (let count = 3; count <= 10; count++) {
      await newTab.click();
      await expect(tabs(win)).toHaveCount(count);
    }
    // @check 10 個では「＋」を押せない
    await expect(newTab).toBeDisabled();
    await expect(newTab).toHaveAttribute('title', '新しいタブ（タブは 10 個まで開けます）');

    // @step 1 つめのタブに戻り、まだ開いていないページを「アプリ内で開く」
    await tabs(win).first().click();
    await openFromPane('https://tabs.test/new');
    // @check タブは増えず、お知らせ欄に上限の案内と「外部ブラウザで開く」が出て、読み上げる
    await expect(tabs(win)).toHaveCount(10);
    const limit = win.locator('.internal-browser-tab-limit');
    await expect(limit).toBeVisible();
    await expect(limit).toContainText('タブは 10 個まで開けます。使わないタブを閉じてから、もう一度開いてください。');
    await expect(limit.getByRole('button', { name: '外部ブラウザで開く' })).toBeVisible();
    await expect(win.locator('.internal-browser-tab-status')).toHaveText('タブは 10 個まで開けます。使わないタブを閉じてから、もう一度開いてください。');
    // @check タブの行は横スクロールでき、どのタブも 36px 以上・180px 以下
    const widths = await tabs(win).evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
    for (const width of widths) {
      expect(width).toBeGreaterThanOrEqual(36);
      expect(width).toBeLessThanOrEqual(180);
    }

    // @step タブを 1 つ閉じる
    await tabs(win).nth(9).click({ button: 'middle' });
    // @check 上限の案内が消え、「＋」を押せるようになる
    await expect(limit).toBeHidden();
    await expect(newTab).toBeEnabled();
  } finally {
    await closeApp(launched);
  }
});
