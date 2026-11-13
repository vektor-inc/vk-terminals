'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('左サイドバーの開閉完了後にブラウザとトーストの配置を再同期する', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const setter = source.match(/function setSidebarOpen\(open, options = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(setter);
  const calls = [];
  const classes = new Set();
  let transitionEnd;
  const aside = {
    addEventListener(_type, handler) { transitionEnd = handler; },
    removeEventListener() {},
  };
  const root = { classList: { toggle(name, value) { if (value) classes.add(name); else classes.delete(name); } } };
  const context = {
    document: { getElementById(id) { return id === 'root' ? root : { setAttribute() {} }; } },
    ensureSidebar() { return aside; },
    syncInternalBrowserLayout() { calls.push('sync'); },
    fitAll() { calls.push('fit'); },
    isReducedMotion() { return false; },
    setTimeout() { return 1; }, clearTimeout() {},
    focusFirstSidebarItem() {}, sidebarOpen: false, sidebarTransitionCleanup: null,
  };
  vm.runInNewContext(`${setter}\nsetSidebarOpen(true, { focusFirst: false })`, context);
  assert.deepEqual(calls, ['sync']);
  transitionEnd({ target: aside, propertyName: 'transform' });
  assert.deepEqual(calls, ['sync', 'sync', 'fit']);
  vm.runInNewContext('setSidebarOpen(false)', context);
  transitionEnd({ target: aside, propertyName: 'transform' });
  assert.deepEqual(calls.slice(-3), ['sync', 'sync', 'fit']);
  assert.equal(classes.has('sidebar-open'), false);
});

test('初期化時は操作列の閉じるだけを無効化せず、失敗表示にも触れない', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const initialization = source.match(/for \(const button of internalBrowserSidebar\.querySelectorAll\('[^']+'\)\) button\.disabled = true;/)?.[0];
  assert.ok(initialization);
  const toolbarButtons = ['back', 'forward', 'reload', 'external', 'close']
    .map(action => ({ action, disabled: false }));
  const errorButtons = [{ disabled: false }, { disabled: false }];
  const sidebar = {
    querySelectorAll(selector) {
      assert.equal(selector, '.internal-browser-toolbar button:not([data-action="close"])');
      return toolbarButtons.filter(button => button.action !== 'close');
    },
  };
  vm.runInNewContext(initialization, { internalBrowserSidebar: sidebar });
  assert.deepEqual(toolbarButtons.map(button => button.disabled), [true, true, true, true, false]);
  assert.deepEqual(errorButtons.map(button => button.disabled), [false, false]);
});

test('アドレス欄は編集中の通知を保持し、Enter のみで正規化した先へ移動する', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const addressHandlers = source.match(/const internalBrowserAddress = internalBrowserSidebar\.querySelector\('\.internal-browser-url'\);[\s\S]*?(?=document\.getElementById\('internal-browser-toggle'\))/)?.[0];
  assert.ok(addressHandlers);
  assert.match(source, /<input type="text" class="internal-browser-url" aria-label="URL または検索語を入力"/);
  assert.doesNotMatch(source, /表示中の URL をコピー/);
  const handlers = {};
  const opened = [];
  const address = { value: '', addEventListener: (type, handler) => { handlers[type] = handler; } };
  const context = vm.createContext({
    internalBrowserSidebar: { querySelector: () => address },
    normalizeBrowserAddress: require('../renderer/urlSafety').normalizeBrowserAddress,
    VKIpc: { invoke: (_channel, url) => { opened.push(url); return Promise.resolve(); } },
  });
  vm.runInContext(`let internalBrowserUrl = 'https://old.example'; let internalBrowserPendingUrl = ''; let internalBrowserUrlEditing = false; let internalBrowserHasPage = false; ${addressHandlers}`, context);
  address.value = 'github.com/vektor-inc';
  handlers.input();
  assert.equal(vm.runInContext('internalBrowserUrlEditing', context), true);
  handlers.keydown({ key: 'ArrowRight' });
  assert.deepEqual(opened, []);
  handlers.keydown({ key: 'Enter', isComposing: true });
  assert.deepEqual(opened, []);
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(opened, ['https://github.com/vektor-inc']);
  assert.equal(address.value, opened[0]);
  assert.equal(vm.runInContext('internalBrowserUrlEditing', context), false);
  assert.equal(vm.runInContext('internalBrowserHasPage', context), true);
  assert.equal(vm.runInContext('internalBrowserPendingUrl', context), opened[0]);
  address.value = 'javascript:alert(1)';
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(opened[1], 'https://www.google.com/search?q=javascript%3Aalert(1)');
  handlers.blur();
  assert.equal(address.value, opened[1]);
});

test('開き先メニュー表示中は別リンクのツールチップを出さない', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const tooltip = source.match(/function showTermLinkTooltip\(event, url\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(tooltip);
  let created = 0;
  const element = { hidden: true, style: {}, offsetWidth: 40, offsetHeight: 20 };
  const context = {
    internalBrowserChoice: {}, internalBrowserOpen: false,
    ensureTermLinkTooltip() { created++; return element; },
    termLinkTooltipMessage: () => 'リンク',
    window: { innerWidth: 800, innerHeight: 600 },
  };
  vm.runInNewContext(`${tooltip}\nshowTermLinkTooltip({ clientX: 10, clientY: 10 }, 'https://example.com')`, context);
  assert.equal(created, 0);
  context.internalBrowserChoice = null;
  vm.runInNewContext('showTermLinkTooltip({ clientX: 10, clientY: 10 }, "https://example.com")', context);
  assert.equal(created, 1);
  assert.equal(element.hidden, false);
});

test('幅キーは表示中の幅を起点にし、開き先メニューはツールチップを隠す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const keyHandler = source.match(/internalBrowserResizer\.addEventListener\('keydown', event => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(keyHandler);
  const handlers = {};
  const saved = [];
  const context = { internalBrowserResizer: { addEventListener: (_event, handler) => { handlers.keydown = handler; } },
    preferredInternalBrowserWidth: 0, displayedInternalBrowserWidth: 482,
    syncInternalBrowserLayout() { context.displayedInternalBrowserWidth = context.preferredInternalBrowserWidth; },
    localStorage: { setItem: (_key, value) => saved.push(value) } };
  vm.runInNewContext(keyHandler, context);
  handlers.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(context.preferredInternalBrowserWidth, 498);
  handlers.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(context.preferredInternalBrowserWidth, 482);
  assert.deepEqual(saved, ['498', '482']);
  const choice = source.match(/function showInternalBrowserChoice\([\s\S]*?\n\}/)?.[0];
  assert.match(choice, /closeInternalBrowserChoice\(\);\s*hideTermLinkTooltip\(\);/);
});

test('失敗表示は失敗 URL、操作列は確定 URL を安全な外部オープン経路へ渡す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const clickHandler = source.match(/internalBrowserSidebar\.addEventListener\('click', event => \{[\s\S]*?\n\}\);/)?.[0];
  const stateHandler = source.match(/VKIpc\.on\('internal-browser:state', state => \{[\s\S]*?\n\}\);/)?.[0];
  const focusHelpers = source.match(/function focusInternalBrowserToolbar\(\) \{[\s\S]*?\n\}\n\nfunction hideInternalBrowserContent\(element\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(clickHandler);
  assert.ok(stateHandler);
  assert.ok(focusHelpers);
  const handlers = {};
  const buttons = [];
  let layoutSyncs = 0;
  const opened = [];
  let messageWrites = 0;
  let messageText = '';
  const message = {
    get textContent() { return messageText; },
    set textContent(value) { messageWrites++; messageText = value; },
  };
  let activeElement = null;
  const focus = element => { activeElement = element; };
  const errorReload = {};
  const errorButtons = [{ disabled: true }, { disabled: true }];
  const errorView = { hidden: true, contains: element => element === errorReload, querySelector: () => message, querySelectorAll: () => errorButtons };
  const notice = { hidden: true, dataset: {}, contains: element => buttons.includes(element), replaceChildren() {}, append() {} };
  const display = { value: '', closest: () => null, focus() { focus(this); } };
  const controls = { disabled: false };
  const external = { disabled: false, setAttribute(name, value) { this[name] = value; } };
  const reload = { disabled: false, closest: () => null, focus() { focus(this); } };
  const progress = { hidden: true };
  const sidebar = {
    addEventListener: (_type, handler) => { handlers.click = handler; },
    querySelector: selector => ({ '.internal-browser-error': errorView, '.internal-browser-notice': notice, '.internal-browser-url': display, '.internal-browser-toolbar [data-action="reload"]': reload, '.internal-browser-progress': progress, '.internal-browser-toolbar [data-action="external"]': external }[selector] || controls),
  };
  const context = {
    internalBrowserSidebar: sidebar,
    internalBrowserAddress: display,
    internalBrowserPendingUrl: '',
    internalBrowserUrlEditing: false,
    VKIpc: { on: (name, handler) => { handlers[name] = handler; } },
    openExternalUrlSafe: url => opened.push(url),
    syncInternalBrowserLayout() { layoutSyncs++; },
    URL,
    document: { get activeElement() { return activeElement; }, createElement: () => {
      const button = { textContent: '', append() {}, addEventListener(_type, handler) { this.click = handler; } };
      buttons.push(button);
      return button;
    } },
  };
  vm.runInNewContext(`let internalBrowserUrl = 'https://example.com/confirmed'; let internalBrowserFailedUrl = ''; let internalBrowserDownloadUrl = ''; let internalBrowserHasPage = true; ${focusHelpers} ${clickHandler} ${stateHandler}`, context);
  const state = (failedUrl, github404Url = '', loading = false, url = 'https://example.com/confirmed') => handlers['internal-browser:state']({ url, failedUrl, github404Url, loading });
  state('https://example.com/failed', '', false);
  assert.equal(display.value, 'https://example.com/confirmed');
  handlers['internal-browser:state']({ url: 'https://example.com/confirmed', pendingUrl: 'https://example.com/loading', failedUrl: 'https://example.com/failed' });
  assert.equal(display.value, 'https://example.com/loading');
  context.internalBrowserUrlEditing = true;
  display.value = '編集中の検索語';
  state('https://example.com/failed', '', false, 'https://example.com/next');
  assert.equal(display.value, '編集中の検索語');
  context.internalBrowserUrlEditing = false;
  state('https://example.com/failed', '', false, 'https://example.com/next');
  assert.equal(display.value, 'https://example.com/next');
  assert.equal(messageWrites, 1);
  state('https://example.com/failed', '', true);
  state('https://example.com/failed', '', false);
  assert.equal(messageWrites, 1);
  assert.equal(message.textContent, 'ページを表示できませんでした（example.com）');
  assert.equal(errorView.hidden, false);
  assert.equal(errorButtons.every(button => !button.disabled), true);
  activeElement = errorReload;
  state('', '', false);
  assert.equal(activeElement, display);
  assert.equal(message.textContent, '');
  assert.equal(errorView.hidden, true);
  assert.equal(messageWrites, 2);
  state('https://example.com/failed', '', false);
  assert.equal(message.textContent, 'ページを表示できませんでした（example.com）');
  assert.equal(messageWrites, 3);
  state('invalid-url', '', false);
  assert.equal(message.textContent, 'ページを表示できませんでした');
  assert.equal(messageWrites, 4);
  state('https://example.com/failed', '', false);
  const click = inError => handlers.click({ target: {
    closest: selector => selector === '[data-action]' ? { dataset: { action: 'external' } } : selector === '.internal-browser-error' && inError ? errorView : null,
  } });
  click(true);
  click(false);
  state('', '', false, '');
  handlers['internal-browser:state']({ url: '', downloadUrl: 'https://example.com/download' });
  assert.equal(external.disabled, false);
  assert.equal(external.title, '外部ブラウザで開く: https://example.com/download');
  assert.equal(external['aria-label'], external.title);
  click(false);
  state('');
  assert.equal(external.title, '外部ブラウザで開く');
  assert.equal(external['aria-label'], external.title);
  assert.deepEqual(opened, ['https://example.com/failed', 'https://example.com/confirmed', 'https://example.com/download']);
  activeElement = controls;
  state('');
  assert.equal(activeElement, controls);
  state('', 'https://github.com/missing', false);
  state('', 'https://github.com/missing', true);
  assert.equal(notice.hidden, false);
  state('', 'https://github.com/missing', false);
  assert.equal(notice.hidden, false);
  const beforeDismiss = layoutSyncs;
  const closeNotice = buttons.find(button => button.textContent === '案内を閉じる');
  activeElement = closeNotice;
  closeNotice.click();
  assert.equal(notice.hidden, true);
  assert.equal(activeElement, display);
  assert.equal(layoutSyncs, beforeDismiss + 1);
  state('', 'https://github.com/missing', false);
  assert.equal(notice.hidden, true);
  state('', '', false);
  assert.equal(notice.hidden, true);
  state('', 'https://github.com/another');
  activeElement = buttons.find(button => button.textContent === '案内を閉じる' && button !== closeNotice);
  state('', 'https://github.com/another', false, '');
  activeElement.click();
  assert.equal(activeElement, display);
});
