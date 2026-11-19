'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// 実アプリの設定・PTYを使わず、実CSSと開閉・レイアウト関数をDOMへ載せる。
test.beforeEach(async ({ page }) => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../renderer/app.js'), 'utf8');
  const toolbar = source.match(/internalBrowserSidebar.innerHTML = `([^`]+)`;/)[1];
  const functions = [
    'syncInternalBrowserLayout', 'syncInternalBrowserWideToggle', 'setInternalBrowserOpen', 'focusInternalBrowserToolbar', 'setSidebarOpen',
    'setInternalBrowserHomeNotice',
    // 空の新規タブの案内（issue #644）。
    'syncInternalBrowserEmptyView', 'hideInternalBrowserContent',
    // トーストは実装と実 CSS のまま載せ、全面表示でのページ領域との関係を確かめる。
    'internalBrowserToastReserve', 'ensureExternalUrlToast', 'showExternalUrlOpenFailedToast', 'hideExternalUrlToast',
    'clearExternalUrlToastTimer', 'externalUrlToastShouldHoldOpen', 'reconsiderExternalUrlToastTimer',
    'setExternalUrlToastMessage', 'setExternalUrlToastInteractive',
  ].map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
  await page.setViewportSize({ width: 600, height: 800 });
  await page.setContent(`<button id="menu-btn">メニュー</button><button id="internal-browser-toggle">ブラウザ</button>
    <div id="root"><aside id="sidebar" class="sidebar" style="--vktm-sidebar-width:300px"><button id="left-item">項目</button></aside>
    <main class="grid"><button id="terminal">ターミナル</button></main>
    <aside id="internal-browser-sidebar" class="internal-browser-sidebar" hidden>${toolbar}</aside></div>`);
  await page.addStyleTag({ path: path.resolve(__dirname, '../../renderer/shared.css') });
  await page.addStyleTag({ path: path.resolve(__dirname, '../../renderer/style.css') });
  await page.addScriptTag({ path: path.resolve(__dirname, '../../utils/internalBrowserLayout.js') });
  await page.addScriptTag({ path: path.resolve(__dirname, '../../renderer/focusTrap.js') });
  await page.addScriptTag({ content: `
    const internalBrowserSidebar = document.getElementById('internal-browser-sidebar');
    let internalBrowserOpen = false, internalBrowserHasPage = false, sidebarOpen = false;
    let internalBrowserPendingUrl = '', internalBrowserEmptyHomeGeneration = 0, internalBrowserHomeRequestGeneration = 0;
    // 広く表示（issue #613）はこの spec では使わない。
    let internalBrowserWide = null;
    // レイアウト切り替えのアニメーション（issue #629）はこの spec では使わない。
    let layoutTransition = null;
    let sidebarTransitionCleanup = null, previousInternalBrowserLayout = null;
    let preferredInternalBrowserWidth = 520, displayedInternalBrowserWidth = 0;
    let internalBrowserOverlayFocusOrigin = null;
    let externalUrlToastLayerEl = null, externalUrlToastEl = null, externalUrlToastDismissTimer = null;
    let externalUrlToastCopyUrl = '', externalUrlToastHovered = false, externalUrlToastFocusWithin = false;
    // 自動消去の経路を待ち時間なしで通すため、実装の 5 秒だけ短くする。
    const EXTERNAL_URL_TOAST_AUTO_DISMISS_MS = 300;
    const EXTERNAL_URL_TOAST_FAILED_MESSAGE = 'ブラウザを開けませんでした';
    const EXTERNAL_URL_TOAST_COPY_LABEL = 'URLをコピー';
    const EXTERNAL_URL_TOAST_COPY_ARIA_LABEL = '開けなかったURLをコピー';
    const VKClipboard = { writeText: async () => true };
    const setupPanel = null;
    const gridDims = () => ({ cols: 1 });
    const getSidebarWidth = () => 300;
    const ensureSidebar = () => document.getElementById('sidebar');
    const focusFirstSidebarItem = () => document.getElementById('left-item').focus();
    const fitAll = () => {};
    const debouncedFitAll = () => {};
    const isReducedMotion = () => false;
    // main へ送ったページ領域を記録し、実際の配置と突き合わせる。
    const sentBounds = [];
    const VKIpc = {
      send(channel, payload) { if (channel === 'internal-browser:bounds') sentBounds.push(payload); },
      // 空の新規タブの「ホームを開く」は、ホームが無い扱いにする。
      invoke: async () => false,
    };
    const focusTraps = VKFocusTrap.createFocusTrapStack(document);
    ${functions}
    document.getElementById('menu-btn').onclick = () => setSidebarOpen(!sidebarOpen);
    document.getElementById('internal-browser-toggle').onclick = () => setInternalBrowserOpen(!internalBrowserOpen);
    window.addEventListener('resize', syncInternalBrowserLayout);
  ` });
});

async function terminalWidth(page, minimum = 320) {
  await expect.poll(() => page.locator('.grid').evaluate(el => el.getBoundingClientRect().width)).toBeGreaterThanOrEqual(minimum);
}

test('600pxで左右を切り替えても中央320pxとURL・検索の伝達性を確保する', async ({ page }) => {
  await page.getByRole('button', { name: 'メニュー', exact: true }).click();
  await expect(page.locator('#left-item')).toBeFocused();
  await page.getByRole('button', { name: 'ブラウザ', exact: true }).click();
  await expect(page.locator('#menu-btn')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#root')).not.toHaveClass(/sidebar-open/);
  await terminalWidth(page);
  const address = page.getByRole('textbox', { name: 'URL または検索語を入力' });
  await expect(address).toBeFocused();
  await expect(address).toHaveAttribute('placeholder', 'URL / 検索');
  // 文字幅を実フォントで測り、placeholderが欄の内幅に収まることを保証する。
  expect(await address.evaluate(el => {
    const style = getComputedStyle(el);
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    context.font = style.font;
    return context.measureText(el.placeholder).width <= el.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  })).toBe(true);
  await address.fill('入力途中 example.com');
  await address.evaluate(el => el.setSelectionRange(2, 5));
  // DOMを再生成せず、入力と選択範囲を維持して相互に開閉する。
  await page.evaluate(() => setSidebarOpen(true));
  await expect(page.locator('#internal-browser-sidebar')).toBeHidden();
  await expect(page.locator('#internal-browser-toggle')).toBeFocused();
  await page.evaluate(() => setInternalBrowserOpen(true));
  await terminalWidth(page);
  await expect(address).toHaveValue('入力途中 example.com');
  expect(await address.evaluate(el => [el.selectionStart, el.selectionEnd])).toEqual([2, 5]);
  await page.locator('#terminal').click();
  await expect(page.locator('#terminal')).toBeFocused();
});

// 対象: ホーム追加後も、横並びの下限でナビゲーション操作とアドレス欄を使える。
test('ブラウザ幅240pxでホームとアドレス欄が操作列に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await page.evaluate(() => setInternalBrowserOpen(true));
  const toolbar = page.locator('.internal-browser-toolbar');
  const home = toolbar.getByRole('button', { name: 'ホーム', exact: true });
  const address = toolbar.getByRole('textbox', { name: 'URL または検索語を入力' });
  const close = toolbar.getByRole('button', { name: 'アプリ内ブラウザを閉じる', exact: true });
  await expect(home).toHaveAttribute('title', 'ホーム');
  await expect(address).toHaveAttribute('placeholder', 'URL');
  const addressBox = await address.boundingBox();
  expect(addressBox.width).toBeGreaterThanOrEqual(24);
  const closeBox = await close.boundingBox();
  expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(560);
  await page.keyboard.press('Shift+Tab');
  await expect(home).toBeFocused();
});

// 対象: 最小幅で案内の文言・ボタン・キーボードフォーカスが案内領域に収まる。
test('ブラウザ幅240pxでホーム未設定案内のボタンが同じ幅で縦に収まる', async ({ page }) => {
  await page.setViewportSize({ width: 560, height: 800 });
  await page.evaluate(() => { setInternalBrowserOpen(true); setInternalBrowserHomeNotice(true); });
  await expect(page.locator('#internal-browser-sidebar')).toHaveCSS('width', '240px');
  const notice = page.locator('.internal-browser-home-notice');
  await expect(notice.getByRole('status')).toHaveText('ホームページが設定されていません。');
  const homeError = notice.getByRole('alert');
  await expect(homeError).toHaveAttribute('aria-live', 'assertive');
  await expect(homeError).toBeEmpty();
  const configure = notice.getByRole('button', { name: 'ホームページ URL を設定' });
  const dismiss = notice.getByRole('button', { name: '案内を閉じる' });
  const first = await configure.boundingBox();
  const second = await dismiss.boundingBox();
  expect(second.x).toBe(first.x);
  expect(second.width).toBe(first.width);
  expect(second.y).toBeGreaterThan(first.y + first.height);

  // 実 CSS のリングを出し、文字と外向きのリングを含めて境界を測る。
  await configure.focus();
  await page.keyboard.press('Tab');
  await expect(dismiss).toBeFocused();
  await expectNoticeButtonFits(dismiss);
  await page.keyboard.press('Shift+Tab');
  await expect(configure).toBeFocused();
  await expectNoticeButtonFits(configure);
});

async function expectNoticeButtonFits(button) {
  expect(await button.evaluate((el) => {
    const style = getComputedStyle(el);
    const ring = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
    const box = el.getBoundingClientRect();
    const notice = el.closest('.internal-browser-home-notice').getBoundingClientRect();
    const text = document.createRange();
    text.selectNodeContents(el);
    const label = text.getBoundingClientRect();
    return style.outlineStyle !== 'none' && ring > 0
      && box.left - ring >= notice.left && box.right + ring <= notice.right
      && box.top - ring >= notice.top && box.bottom + ring <= notice.bottom
      && label.left >= box.left && label.right <= box.right
      && label.top >= box.top && label.bottom <= box.bottom;
  })).toBe(true);
}

test('1280pxの横並びと保存幅を維持し、縮小時は左側を閉じてフォーカスを戻す', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.evaluate(() => { setSidebarOpen(true); setInternalBrowserOpen(true, { focus: 'preserve' }); });
  await expect(page.locator('#left-item')).toBeFocused();
  await expect(page.locator('#root')).toHaveClass(/sidebar-open/);
  await expect(page.locator('#internal-browser-sidebar')).toHaveCSS('width', '520px');
  await terminalWidth(page, 460);
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(page.locator('#menu-btn')).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#menu-btn')).toBeFocused();
  await terminalWidth(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await expect(page.locator('#internal-browser-sidebar')).toHaveCSS('width', '520px');
  await expect(page.locator('.internal-browser-url')).toHaveAttribute('placeholder', 'URL または検索語');
  await page.evaluate(() => setSidebarOpen(true));
  await expect(page.locator('#internal-browser-sidebar')).toBeVisible();
  await terminalWidth(page, 460);
});

// 送信済みのページ領域が、いま描画されているページ領域と一致するかを返す。
function sentBoundsMatchPage(page) {
  return page.evaluate(() => {
    const rect = document.querySelector('.internal-browser-page').getBoundingClientRect();
    const sent = sentBounds.at(-1);
    return ['x', 'y', 'width', 'height'].every(key => sent[key] === rect[key]);
  });
}

test('500pxの全面表示ではトーストを読める幅で出し、表示中だけページ領域を詰める', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await page.evaluate(() => setInternalBrowserOpen(true));
  await expect(page.locator('#root')).toHaveClass(/internal-browser-overlay/);
  // トーストは画面全体の幅を使えるため、語句の折り返し保護（nowrap）を外さない。
  await expect(page.locator('#root')).not.toHaveClass(/toast-phrase-wrap/);
  const pageArea = page.locator('.internal-browser-page');
  const fullHeight = (await pageArea.boundingBox()).height;

  await page.evaluate(() => showExternalUrlOpenFailedToast('https://example.com/'));
  const toast = page.locator('.vk-toast');
  await expect(toast).toBeVisible();
  // 本文とボタンが画面内に収まり、横並び用の左寄せ（幅 0）を持ち込まない。
  const toastBox = await toast.boundingBox();
  expect(await toast.evaluate(el => el.clientWidth > 0 && el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(toastBox.x).toBeGreaterThanOrEqual(16);
  expect(toastBox.x + toastBox.width).toBeLessThanOrEqual(500 - 16);
  await expect(toast.getByText('ブラウザを開けませんでした')).toBeVisible();
  await expect(toast.getByRole('button', { name: '開けなかったURLをコピー' })).toBeVisible();
  // ページ（WebContentsView）はトーストの上で終わり、その領域を main へ送っている。
  await expect.poll(async () => {
    const box = await pageArea.boundingBox();
    return box.y + box.height;
  }).toBeLessThanOrEqual(toastBox.y - 16);
  await expect.poll(() => sentBoundsMatchPage(page)).toBe(true);

  // 本文の差し替えで高さが変わっても追従する。
  await page.evaluate(() => setExternalUrlToastMessage('長い案内文。'.repeat(30)));
  await expect.poll(async () => (await toast.boundingBox()).height).toBeGreaterThan(toastBox.height);
  await expect.poll(async () => {
    const [box, grown] = [await pageArea.boundingBox(), await toast.boundingBox()];
    return grown.y - (box.y + box.height);
  }).toBeGreaterThanOrEqual(16);
  await expect.poll(() => sentBoundsMatchPage(page)).toBe(true);

  // 自動消去のあとは余白を残さず、ページ領域を元の高さへ戻す。
  await expect(toast).toBeHidden();
  await expect.poll(async () => (await pageArea.boundingBox()).height).toBe(fullHeight);
  await expect.poll(() => sentBoundsMatchPage(page)).toBe(true);
});

test('全面表示中にモーダルを開いても、トーストは操作でき読み上げ対象に残る', async ({ page }) => {
  await page.setViewportSize({ width: 500, height: 800 });
  await page.evaluate(() => {
    setInternalBrowserOpen(true);
    showExternalUrlOpenFailedToast('https://example.com/');
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';
    overlay.innerHTML = '<button id="modal-close">閉じる</button>';
    document.body.appendChild(overlay);
    focusTraps.activate(overlay);
  });
  const layer = page.locator('.vk-toast-layer');
  // モーダルの背後として無効化されるのは #root で、body 直下のトーストは対象外。
  expect(await page.locator('#root').evaluate(el => el.inert)).toBe(true);
  expect(await layer.evaluate(el => el.parentElement === document.body && !el.closest('[inert]'))).toBe(true);
  const copy = page.getByRole('button', { name: '開けなかったURLをコピー' });
  await copy.click();
  await expect(page.locator('.vk-toast-message')).toHaveText('URLをコピーしました');
});
