'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { createInternalBrowser } = require('../utils/internalBrowser');

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
  assert.match(source, /id="internal-browser-address-error"[^>]*role="alert"/);
  assert.doesNotMatch(source, /表示中の URL をコピー/);
  const handlers = {};
  const opened = [];
  const error = { id: 'internal-browser-address-error', hidden: true, textContent: '' };
  const external = { setAttribute() {} };
  const target = { hidden: true, textContent: '' };
  const address = { value: '', attributes: {}, addEventListener: (type, handler) => { handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } };
  const context = vm.createContext({
    internalBrowserSidebar: { querySelector: selector => ({ '.internal-browser-url': address, '.internal-browser-address-error': error,
      '.internal-browser-toolbar [data-action="external"]': external, '.internal-browser-external-target': target })[selector] },
    resolveBrowserAddress: require('../renderer/urlSafety').resolveBrowserAddress,
    VKIpc: { invoke: (_channel, url) => { opened.push(url); return Promise.resolve(); } },
    syncInternalBrowserLayout() {},
    URL,
  });
  vm.runInContext(`let internalBrowserUrl = 'https://old.example'; let internalBrowserDownloadUrl = ''; let internalBrowserPendingUrl = ''; let internalBrowserAddressHasDraft = false; let internalBrowserHasPage = false; ${addressHandlers}`, context);
  address.value = 'github.com/vektor-inc';
  handlers.input();
  assert.equal(target.textContent, '外部で開く: 表示中のページ old.example');
  assert.equal(vm.runInContext('internalBrowserAddressHasDraft', context), true);
  handlers.keydown({ key: 'ArrowRight' });
  assert.deepEqual(opened, []);
  handlers.keydown({ key: 'Enter', isComposing: true });
  assert.deepEqual(opened, []);
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.deepEqual(opened, ['https://github.com/vektor-inc']);
  assert.equal(address.value, opened[0]);
  assert.equal(target.hidden, false);
  assert.equal(vm.runInContext('internalBrowserAddressHasDraft', context), false);
  assert.equal(vm.runInContext('internalBrowserHasPage', context), true);
  assert.equal(vm.runInContext('internalBrowserPendingUrl', context), opened[0]);
  address.value = 'javascript:alert(1)';
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(opened[1], 'https://www.google.com/search?q=javascript%3Aalert(1)');
  address.value = '  ';
  handlers.input();
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(address.value, '  ');
  assert.equal(error.textContent, 'URL または検索語を入力してください。');
  assert.equal(address.attributes['aria-invalid'], 'true');
  assert.equal(address.attributes['aria-describedby'], error.id);
  address.value = 'https://example.com:99999/path';
  handlers.input();
  assert.equal(error.hidden, true);
  assert.equal(address.attributes['aria-invalid'], undefined);
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.match(error.textContent, /URL の形式/);
  address.value = `https://example.com:99999/${'あ'.repeat(300)}`;
  handlers.input();
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.match(error.textContent, /URL の形式/);
  address.value = 'あ'.repeat(700);
  handlers.input();
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.match(error.textContent, /長すぎます/);
  assert.equal(opened.length, 2);
  address.value = '例え.テスト';
  handlers.input();
  handlers.keydown({ key: 'Enter', preventDefault() {} });
  assert.equal(address.value, 'https://例え.テスト');
  assert.equal(error.hidden, true);
  assert.equal(address.attributes['aria-describedby'], undefined);
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
  const style = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  assert.match(source, /class="internal-browser-error"[^>]*>[\s\S]*?<button type="button" data-action="external">/);
  assert.match(style, /\.internal-browser-error \[data-action="external"\][^}]*max-width:[^;]+;[^}]*white-space: normal;[^}]*overflow-wrap: anywhere;/);
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
  const errorButtons = [{ disabled: true }, { disabled: true, textContent: '外部ブラウザで開く',
    getAttribute(name) { return this[name]; }, setAttribute(name, value) { this[name] = value; } }];
  const failedExternal = errorButtons[1];
  const errorView = { hidden: true, contains: element => element === errorReload,
    querySelector: selector => selector === '[data-action="external"]' ? failedExternal : message,
    querySelectorAll: () => errorButtons };
  const notice = { hidden: true, dataset: {}, contains: element => buttons.includes(element), replaceChildren() {}, append() {} };
  const display = { value: '', closest: () => null, focus() { focus(this); } };
  const controls = { disabled: false };
  const external = { disabled: false, setAttribute(name, value) { this[name] = value; } };
  const target = { hidden: true, textContent: '' };
  const reload = { disabled: false, closest: () => null, focus() { focus(this); } };
  const progress = { hidden: true };
  const sidebar = {
    addEventListener: (_type, handler) => { handlers.click = handler; },
    querySelector: selector => ({ '.internal-browser-error': errorView, '.internal-browser-notice': notice, '.internal-browser-url': display, '.internal-browser-toolbar [data-action="reload"]': reload, '.internal-browser-progress': progress, '.internal-browser-toolbar [data-action="external"]': external, '.internal-browser-external-target': target }[selector] || controls),
  };
  const context = {
    internalBrowserSidebar: sidebar,
    internalBrowserAddress: display,
    internalBrowserPendingUrl: '',
    internalBrowserAddressHasDraft: false,
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
  const targetHelpers = source.match(/function getInternalBrowserExternalTarget\(\) \{[\s\S]*?(?=function clearInternalBrowserAddressError\()/)?.[0];
  assert.ok(targetHelpers);
  vm.runInNewContext(`let internalBrowserUrl = 'https://example.com/confirmed'; let internalBrowserFailedUrl = ''; let internalBrowserDownloadUrl = ''; let internalBrowserHasPage = true; ${focusHelpers} ${targetHelpers} ${clickHandler} ${stateHandler}`, context);
  const state = (failedUrl, github404Url = '', loading = false, url = 'https://example.com/confirmed') => handlers['internal-browser:state']({ url, failedUrl, github404Url, loading });
  state('https://example.com/failed', '', false);
  assert.equal(display.value, 'https://example.com/failed');
  assert.equal(external.title, '確定済みの URL を外部ブラウザで開く: https://example.com/confirmed');
  assert.equal(target.textContent, '外部で開く: 表示中のページ example.com');
  assert.equal(target.hidden, false);
  assert.equal(failedExternal.textContent, '失敗したページを外部で開く: example.com');
  assert.equal(failedExternal.title, '失敗したページを外部で開く: https://example.com/failed');
  assert.equal(failedExternal['aria-label'], failedExternal.title);
  handlers['internal-browser:state']({ url: 'https://example.com/confirmed', pendingUrl: 'https://pending.example/loading', failedUrl: '' });
  assert.equal(display.value, 'https://pending.example/loading');
  assert.equal(target.textContent, '外部で開く: 表示中のページ example.com');
  assert.equal(external.title, '確定済みの URL を外部ブラウザで開く: https://example.com/confirmed');
  context.internalBrowserAddressHasDraft = true;
  display.value = '編集中の検索語';
  state('https://example.com/failed', '', false, 'https://example.com/next');
  assert.equal(display.value, '編集中の検索語');
  assert.equal(external['aria-label'], '確定済みの URL を外部ブラウザで開く: https://example.com/next');
  assert.equal(target.textContent, '外部で開く: 表示中のページ example.com');
  context.internalBrowserAddressHasDraft = false;
  state('', '', false, 'https://example.com/next');
  assert.equal(target.hidden, true);
  state('https://example.com/failed', '', false, 'https://example.com/next');
  assert.equal(display.value, 'https://example.com/failed');
  assert.equal(messageWrites, 5);
  state('https://example.com/failed', '', true);
  state('https://example.com/failed', '', false);
  assert.equal(messageWrites, 5);
  assert.equal(message.textContent, 'ページを表示できませんでした（example.com）');
  assert.equal(errorView.hidden, false);
  assert.equal(errorButtons.every(button => !button.disabled), true);
  activeElement = errorReload;
  state('', '', false);
  assert.equal(activeElement, display);
  assert.equal(message.textContent, '');
  assert.equal(errorView.hidden, true);
  assert.equal(failedExternal.textContent, '外部ブラウザで開く');
  assert.equal(failedExternal.title, '');
  assert.equal(messageWrites, 6);
  state('https://failed.example/failed', '', false);
  assert.equal(target.textContent, '外部で開く: 表示中のページ example.com');
  assert.equal(failedExternal.textContent, '失敗したページを外部で開く: failed.example');
  assert.equal(failedExternal.title, '失敗したページを外部で開く: https://failed.example/failed');
  assert.equal(message.textContent, 'ページを表示できませんでした（failed.example）');
  assert.equal(messageWrites, 7);
  state('invalid-url', '', false);
  assert.equal(message.textContent, 'ページを表示できませんでした');
  assert.equal(messageWrites, 8);
  state('https://failed.example/failed', '', false);
  const click = inError => handlers.click({ target: {
    closest: selector => selector === '[data-action]' ? { dataset: { action: 'external' } } : selector === '.internal-browser-error' && inError ? errorView : null,
  } });
  click(true);
  click(false);
  state('', '', false, '');
  handlers['internal-browser:state']({ url: '', downloadUrl: 'https://download.example/file' });
  assert.equal(external.disabled, false);
  assert.equal(external.title, 'ダウンロード先を外部ブラウザで開く: https://download.example/file');
  assert.equal(external['aria-label'], external.title);
  assert.equal(target.textContent, '外部で開く: ダウンロード先 download.example');
  click(false);
  state('');
  assert.equal(external.title, '確定済みの URL を外部ブラウザで開く: https://example.com/confirmed');
  assert.equal(external['aria-label'], external.title);
  state('', '', false, '');
  assert.equal(external.disabled, true);
  assert.equal(external.title, '外部ブラウザで開く（確定済みの URL なし）');
  assert.equal(target.hidden, true);
  assert.deepEqual(opened, ['https://failed.example/failed', 'https://example.com/confirmed', 'https://download.example/file']);
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

test('main の送信から失敗までの状態順でアドレスを保持し、修正して再入力できる', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const addressHandlers = source.match(/const internalBrowserAddress = internalBrowserSidebar\.querySelector\('\.internal-browser-url'\);[\s\S]*?(?=document\.getElementById\('internal-browser-toggle'\))/)?.[0];
  const stateHandler = source.match(/VKIpc\.on\('internal-browser:state', state => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(addressHandlers);
  assert.ok(stateHandler);

  for (const [confirmedUrl, failureCode] of [
    ['', -105], ['https://example.com/confirmed', -105],
    ['', -102], ['https://example.com/confirmed', -102],
  ]) {
    const handlers = {};
    const messages = [];
    const addressError = { id: 'internal-browser-address-error', hidden: true, textContent: '' };
    const address = { value: '', addEventListener(type, handler) { handlers[type] = handler; },
      setAttribute() {}, removeAttribute() {} };
    const message = { textContent: '' };
    const failedExternal = { getAttribute() {}, setAttribute() {} };
    const errorView = { hidden: true, querySelector: selector => selector === '[data-action="external"]' ? failedExternal : message, querySelectorAll: () => [] };
    const notice = { hidden: true, dataset: {}, replaceChildren() {}, contains: () => false };
    const external = { setAttribute() {} };
    const target = { hidden: true, textContent: '' };
    const elements = {
      '.internal-browser-url': address,
      '.internal-browser-address-error': addressError,
      '.internal-browser-error': errorView,
      '.internal-browser-notice': notice,
      '.internal-browser-toolbar [data-action="external"]': external,
      '.internal-browser-external-target': target,
      '.internal-browser-toolbar [data-action="reload"]': {},
      '[data-action="back"]': {}, '[data-action="forward"]': {},
      '.internal-browser-progress': {},
    };
    const sidebar = { querySelector: selector => elements[selector] };
    let browser;
    const context = vm.createContext({
      internalBrowserSidebar: sidebar,
      resolveBrowserAddress: require('../renderer/urlSafety').resolveBrowserAddress,
      VKIpc: {
        on: (channel, handler) => { handlers[channel] = handler; },
        invoke: (_channel, url) => { browser.navigate(url); return Promise.resolve(); },
      },
      hideInternalBrowserContent: element => { element.hidden = true; },
      syncInternalBrowserLayout() {},
      document: { activeElement: null }, URL,
    });
    vm.runInContext(`let internalBrowserUrl = ''; let internalBrowserPendingUrl = ''; let internalBrowserFailedUrl = ''; let internalBrowserDownloadUrl = ''; let internalBrowserAddressHasDraft = false; let internalBrowserHasPage = false; ${addressHandlers} ${stateHandler}`, context);

    // main の publish をそのまま renderer に渡し、実際の pendingUrl 消去順を確認する。
    const browserSession = new EventEmitter();
    browserSession.setPermissionRequestHandler = () => {};
    browserSession.setPermissionCheckHandler = () => {};
    browserSession.webRequest = { onBeforeRequest() {}, onCompleted() {} };
    let contents;
    class FakeView {
      constructor() {
        contents = new EventEmitter();
        contents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
        contents.isLoading = () => false;
        contents.loadURL = () => Promise.resolve();
        contents.setWindowOpenHandler = () => {};
        this.webContents = contents;
      }
    }
    browser = createInternalBrowser({
      isDestroyed: () => false,
      webContents: { send(channel, state) {
        if (channel !== 'internal-browser:state') return;
        messages.push({ ...state });
        handlers[channel](state);
      } },
    }, { WebContentsView: FakeView, session: { fromPartition: () => browserSession } });

    if (confirmedUrl) {
      browser.navigate(confirmedUrl);
      contents.emit('did-navigate', {}, confirmedUrl);
      assert.equal(address.value, confirmedUrl);
    }
    const failedUrl = 'https://unreachable.example/path';
    address.value = failedUrl;
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(messages.at(-1).pendingUrl, failedUrl);
    contents.emit('did-fail-load', {}, failureCode, 'load failed', failedUrl, true);
    assert.equal(messages.at(-1).pendingUrl, '');
    assert.equal(messages.at(-1).failedUrl, failedUrl);
    assert.equal(messages.at(-1).url, confirmedUrl);
    assert.equal(address.value, failedUrl);
    assert.equal(handlers.blur, undefined);
    handlers.blur?.();
    assert.equal(address.value, failedUrl);

    address.value = '  ';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(address.value, '  ');
    assert.equal(addressError.hidden, false);
    contents.emit('did-stop-loading');
    assert.equal(address.value, '  ');

    address.value = 'example.org/retry';
    handlers.input();
    handlers.blur?.();
    contents.emit('did-stop-loading');
    assert.equal(address.value, 'example.org/retry');
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(messages.at(-1).pendingUrl, 'https://example.org/retry');
    assert.equal(address.value, 'https://example.org/retry');
    contents.emit('did-navigate', {}, 'https://example.org/retry');
    assert.equal(address.value, 'https://example.org/retry');
  }
});
