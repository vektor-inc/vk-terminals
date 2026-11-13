'use strict';
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');

// 実アプリの設定・PTYを使わず、実CSSと開閉・レイアウト関数をDOMへ載せる。
test.beforeEach(async ({ page }) => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../renderer/app.js'), 'utf8');
  const toolbar = source.match(/internalBrowserSidebar.innerHTML = `([^`]+)`;/)[1];
  const functions = ['syncInternalBrowserLayout', 'setInternalBrowserOpen', 'focusInternalBrowserToolbar', 'setSidebarOpen']
    .map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))[0]).join('\n');
  await page.setViewportSize({ width: 600, height: 800 });
  await page.setContent(`<button id="menu-btn">メニュー</button><button id="internal-browser-toggle">ブラウザ</button>
    <div id="root"><aside id="sidebar" class="sidebar" style="--vktm-sidebar-width:300px"><button id="left-item">項目</button></aside>
    <main class="grid"><button id="terminal">ターミナル</button></main>
    <aside id="internal-browser-sidebar" class="internal-browser-sidebar" hidden>${toolbar}</aside></div>`);
  await page.addStyleTag({ path: path.resolve(__dirname, '../../renderer/style.css') });
  await page.addScriptTag({ path: path.resolve(__dirname, '../../utils/internalBrowserLayout.js') });
  await page.addScriptTag({ content: `
    const internalBrowserSidebar = document.getElementById('internal-browser-sidebar');
    let internalBrowserOpen = false, internalBrowserHasPage = false, sidebarOpen = false;
    let sidebarTransitionCleanup = null, previousInternalBrowserLayout = null;
    let preferredInternalBrowserWidth = 520, displayedInternalBrowserWidth = 0;
    const setupPanel = null;
    const gridDims = () => ({ cols: 1 });
    const getSidebarWidth = () => 300;
    const ensureSidebar = () => document.getElementById('sidebar');
    const focusFirstSidebarItem = () => document.getElementById('left-item').focus();
    const fitAll = () => {};
    const debouncedFitAll = () => {};
    const isReducedMotion = () => false;
    const VKIpc = { send() {} };
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
