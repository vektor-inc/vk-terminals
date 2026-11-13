'use strict';
const { installBrowserLoad, flushBrowserLoads } = require('./helpers/browserLoad');
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

test('外部ボタンの可視URLは同一ホストのパスと検索条件まで区別し、狭幅で折り返す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(__dirname, '../renderer/style.css'), 'utf8');
  const helper = source.match(/function formatInternalBrowserDestination\(url\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(helper);
  const format = vm.runInNewContext(`${helper}\nformatInternalBrowserDestination`, { URL });
  assert.equal(format('https://example.com/confirmed?q=1#top'), 'example.com/confirmed?q=1#top');
  assert.equal(format('https://example.com/failed?q=2#bottom'), 'example.com/failed?q=2#bottom');
  assert.equal(format('https://example.com/' + 'a'.repeat(400)), 'example.com/' + 'a'.repeat(400));
  assert.equal(format('invalid-url'), '');
  assert.match(css, /\.internal-browser-external-target\s*\{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.internal-browser-error \[data-action="external"\]\s*\{[^}]*overflow-wrap: anywhere/);
  assert.match(source, /internal-browser-navigation-status" role="status" aria-live="polite"/);
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
  const navigationStatus = { textContent: '' };
  const address = { value: '', attributes: {}, addEventListener: (type, handler) => { handlers[type] = handler; },
    setAttribute(name, value) { this.attributes[name] = value; }, removeAttribute(name) { delete this.attributes[name]; } };
  const context = vm.createContext({
    internalBrowserSidebar: { querySelector: selector => ({ '.internal-browser-url': address, '.internal-browser-address-error': error,
      '.internal-browser-toolbar [data-action="external"]': external, '.internal-browser-external-target': target, '.internal-browser-navigation-status': navigationStatus })[selector] },
    resolveBrowserAddress: require('../renderer/urlSafety').resolveBrowserAddress,
    VKIpc: { invoke: (_channel, url) => { opened.push(url); return Promise.resolve(); } },
    syncInternalBrowserLayout() {},
    URL,
  });
  vm.runInContext(`let internalBrowserUrl = 'https://old.example'; let internalBrowserDownloadUrl = ''; let internalBrowserPendingUrl = ''; let internalBrowserAddressHasDraft = false; let internalBrowserHasPage = false; ${addressHandlers}`, context);
  address.value = 'github.com/vektor-inc';
  handlers.input();
  assert.equal(target.textContent, '外部で開く: 表示中のページ old.example/');
  assert.equal(navigationStatus.textContent, '');
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
  assert.equal(navigationStatus.textContent, 'ページを読み込み中');
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
  const navigationStatus = { textContent: '' };
  const reload = { disabled: false, closest: () => null, focus() { focus(this); } };
  const progress = { hidden: true };
  const sidebar = {
    addEventListener: (_type, handler) => { handlers.click = handler; },
    querySelector: selector => ({ '.internal-browser-error': errorView, '.internal-browser-notice': notice, '.internal-browser-url': display, '.internal-browser-toolbar [data-action="reload"]': reload, '.internal-browser-progress': progress, '.internal-browser-toolbar [data-action="external"]': external, '.internal-browser-external-target': target, '.internal-browser-navigation-status': navigationStatus }[selector] || controls),
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
  const formattingHelper = source.match(/function formatInternalBrowserDestination\(url\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(formattingHelper);
  const targetHelpers = source.match(/function getInternalBrowserExternalTarget\(\) \{[\s\S]*?(?=function clearInternalBrowserAddressError\()/)?.[0];
  assert.ok(targetHelpers);
  vm.runInNewContext(`let internalBrowserUrl = 'https://example.com/confirmed'; let internalBrowserFailedUrl = ''; let internalBrowserDownloadUrl = ''; let internalBrowserHasPage = true; let internalBrowserNavigationActive = false; ${formattingHelper} ${focusHelpers} ${targetHelpers} ${clickHandler} ${stateHandler}`, context);
  const state = (failedUrl, github404Url = '', loading = false, url = 'https://example.com/confirmed') => handlers['internal-browser:state']({ url, failedUrl, github404Url, loading });
  state('https://example.com/failed', '', false);
  assert.equal(display.value, 'https://example.com/failed');
  assert.equal(external.title, '確定済みの URL を外部ブラウザで開く: https://example.com/confirmed');
  assert.equal(target.textContent, '外部で開く: 表示中のページ example.com/confirmed');
  assert.equal(target.hidden, false);
  assert.equal(failedExternal.textContent, '失敗したページを外部で開く: example.com/failed');
  assert.equal(failedExternal.title, '失敗したページを外部で開く: https://example.com/failed');
  assert.equal(failedExternal['aria-label'], `${failedExternal.textContent}（https://example.com/failed）`);
  handlers['internal-browser:state']({ url: 'https://example.com/confirmed', pendingUrl: 'https://pending.example/loading', failedUrl: '' });
  assert.equal(display.value, 'https://pending.example/loading');
  assert.equal(target.textContent, '外部で開く: 表示中のページ example.com/confirmed');
  assert.equal(external.title, '確定済みの URL を外部ブラウザで開く: https://example.com/confirmed');
  context.internalBrowserAddressHasDraft = true;
  display.value = '編集中の検索語';
  state('https://example.com/failed', '', false, 'https://example.com/next');
  assert.equal(display.value, '編集中の検索語');
  assert.equal(external['aria-label'], '確定済みの URL を外部ブラウザで開く: https://example.com/next');
  assert.equal(target.textContent, '外部で開く: 表示中のページ example.com/next');
  context.internalBrowserAddressHasDraft = false;
  state('', '', false, 'https://example.com/next');
  assert.equal(target.hidden, true);
  state('https://example.com/failed', '', false, 'https://example.com/next');
  assert.equal(display.value, 'https://example.com/failed');
  assert.equal(messageWrites, 5);
  state('https://example.com/failed', '', true);
  assert.equal(progress.hidden, false);
  state('https://example.com/failed', '', false);
  assert.equal(progress.hidden, true);
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
  assert.equal(failedExternal['aria-label'], '外部ブラウザで開く');
  assert.equal(messageWrites, 6);
  state('https://failed.example/failed', '', false);
  assert.equal(target.textContent, '外部で開く: 表示中のページ example.com/confirmed');
  assert.equal(failedExternal.textContent, '失敗したページを外部で開く: failed.example/failed');
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
  assert.equal(target.textContent, '外部で開く: ダウンロード先 download.example/file');
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
  // 同じホストでも両ボタンの実際の開き先をパスと検索条件で区別する。
  const confirmed = 'https://example.com/confirmed?version=1#top';
  const failed = 'https://example.com/failed?version=2#bottom';
  state(failed, '', false, confirmed);
  assert.equal(target.textContent, '外部で開く: 表示中のページ example.com/confirmed?version=1#top');
  assert.equal(failedExternal.textContent, '失敗したページを外部で開く: example.com/failed?version=2#bottom');
  assert.ok(failedExternal['aria-label'].startsWith(failedExternal.textContent));
  assert.equal(failedExternal.title, `失敗したページを外部で開く: ${failed}`);
  click(true);
  click(false);
  assert.deepEqual(opened.slice(-2), [failed, confirmed]);
});

test('main の遷移結果を順に受け、失敗・成功・中止・置換・ダウンロード阻止を通知する', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const addressHandlers = source.match(/const internalBrowserAddress = internalBrowserSidebar\.querySelector\('\.internal-browser-url'\);[\s\S]*?(?=document\.getElementById\('internal-browser-toggle'\))/)?.[0];
  const stateHandler = source.match(/VKIpc\.on\('internal-browser:state', state => \{[\s\S]*?\n\}\);/)?.[0];
  const downloadHandler = source.match(/VKIpc\.on\('internal-browser:download-blocked',[\s\S]*?\n\}\);/)?.[0];
  assert.ok(addressHandlers);
  assert.ok(stateHandler);
  assert.ok(downloadHandler);
  assert.match(source, /class="internal-browser-error" role="status"/);
  assert.match(source, /class="internal-browser-navigation-status" role="status"/);

  for (const [confirmedUrl, failureCode] of [
    ['', -105], ['https://example.com/confirmed', -105],
    ['', -102], ['https://example.com/confirmed', -102],
  ]) {
    const handlers = {};
    const messages = [];
    const channels = [];
    const downloadEvents = [];
    const addressError = { id: 'internal-browser-address-error', hidden: true, textContent: '' };
    const address = { value: '', addEventListener(type, handler) { handlers[type] = handler; },
      setAttribute() {}, removeAttribute() {} };
    let errorWrites = 0;
    const message = { value: '', get textContent() { return this.value; },
      set textContent(value) { this.value = value; errorWrites++; } };
    const failedExternal = { getAttribute() {}, setAttribute() {} };
    const errorView = { hidden: true, querySelector: selector => selector === '[data-action="external"]' ? failedExternal : message, querySelectorAll: () => [] };
    const notice = { hidden: true, dataset: {}, replaceChildren() {}, contains: () => false };
    const external = { setAttribute() {} };
    const target = { hidden: true, textContent: '' };
    const toastMessages = [];
    const toastBody = { replaceChildren() {}, append() {} };
    let navigationWrites = 0;
    const navigationStatus = { value: '', get textContent() { return this.value; },
      set textContent(value) { this.value = value; navigationWrites++; } };
    const elements = {
      '.internal-browser-url': address,
      '.internal-browser-address-error': addressError,
      '.internal-browser-error': errorView,
      '.internal-browser-notice': notice,
      '.internal-browser-toolbar [data-action="external"]': external,
      '.internal-browser-external-target': target,
      '.internal-browser-navigation-status': navigationStatus,
      '.internal-browser-toolbar [data-action="reload"]': {},
      '[data-action="back"]': {}, '[data-action="forward"]': {},
      '.internal-browser-progress': {},
    };
    const sidebar = { querySelector: selector => elements[selector] };
    let browser;
    let deferNextOpen = false;
    let deferredOpen = null;
    const context = vm.createContext({
      internalBrowserSidebar: sidebar,
      resolveBrowserAddress: require('../renderer/urlSafety').resolveBrowserAddress,
      VKIpc: {
        on: (channel, handler) => { handlers[channel] = handler; },
        invoke: (_channel, url, requestId) => {
          if (deferNextOpen) { deferredOpen = () => browser.navigate(url, false, requestId); deferNextOpen = false; }
          else browser.navigate(url, false, requestId);
          return Promise.resolve();
        },
      },
      showGenericToast(message) { toastMessages.push(message); return true; },
      externalUrlToastEl: { querySelector: () => toastBody },
      hideInternalBrowserContent: element => { element.hidden = true; },
      syncInternalBrowserLayout() {},
      document: { activeElement: null, createElement: () => ({}) }, URL,
    });
    vm.runInContext(`let internalBrowserUrl = ''; let internalBrowserPendingUrl = ''; let internalBrowserFailedUrl = ''; let internalBrowserDownloadUrl = ''; let internalBrowserAddressHasDraft = false; let internalBrowserHasPage = false; ${addressHandlers} ${stateHandler} ${downloadHandler}`, context);

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
        installBrowserLoad(contents);
        contents.setWindowOpenHandler = handler => { contents.openHandler = handler; };
        this.webContents = contents;
      }
    }
    browser = createInternalBrowser({
      isDestroyed: () => false,
      webContents: { send(channel, state) {
        channels.push(channel);
        if (channel === 'internal-browser:download-blocked') {
          downloadEvents.push(state);
          handlers[channel](state);
          return;
        }
        if (channel !== 'internal-browser:state') return;
        messages.push({ ...state });
        handlers[channel](state);
      } },
    }, { WebContentsView: FakeView, session: { fromPartition: () => browserSession },
      dialog: { showMessageBoxSync: () => 1 } });

    if (confirmedUrl) {
      browser.navigate(confirmedUrl);
      await contents.complete(confirmedUrl);
      assert.equal(address.value, confirmedUrl);
    }
    navigationWrites = 0;
    const failedUrl = 'https://unreachable.example/path';
    address.value = failedUrl;
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, 1);
    assert.equal(messages.at(-1).pendingUrl, failedUrl);
    assert.equal(messages.at(-1).navigationResult, null);
    assert.equal(messages.at(-1).navigationRequestId, 1);
    await contents.fail(failureCode, failedUrl);
    assert.equal(messages.at(-1).navigationResult, 'failed');
    assert.equal(messages.at(-1).navigationRequestId, 1);
    assert.equal(navigationStatus.textContent, '');
    assert.equal(navigationWrites, 2);
    assert.equal(errorView.hidden, false);
    assert.equal(message.textContent, 'ページを表示できませんでした（unreachable.example）');
    assert.equal(errorWrites, 1);
    browser.publish();
    assert.equal(navigationWrites, 2);
    assert.equal(errorWrites, 1);
    contents.emit('did-stop-loading');
    assert.equal(navigationWrites, 2);
    assert.equal(errorWrites, 1);
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
    deferNextOpen = true;
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, 3);
    // 新しい invoke が main に届く前の古い失敗 state は今回の追跡を終えない。
    browser.publish();
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, 3);
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), 2);
    deferredOpen();
    assert.equal(messages.at(-1).pendingUrl, 'https://example.org/retry');
    assert.equal(messages.at(-1).navigationRequestId, 2);
    assert.equal(address.value, 'https://example.org/retry');
    await contents.complete('https://example.org/retry');
    assert.equal(messages.at(-1).navigationResult, 'completed');
    assert.equal(messages.at(-1).navigationRequestId, 2);
    assert.equal(address.value, 'https://example.org/retry');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(navigationWrites, 4);
    contents.emit('did-stop-loading');
    assert.equal(navigationWrites, 4);

    // 完了後の旧イベントはアドレス表示と通知を巻き戻さない。
    contents.emit('did-fail-load', {}, -105, 'old failure', failedUrl, true);
    contents.emit('did-navigate', {}, failedUrl);
    contents.emit('did-navigate-in-page', {}, `${failedUrl}#old`, true);
    browser.publish();
    assert.equal(address.value, 'https://example.org/retry');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(navigationWrites, 4);

    // beforeunload でとどまる場合は pendingUrl が消えても完了にはしない。
    address.value = 'https://example.org/cancelled';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(messages.at(-1).navigationResult, null);
    await flushBrowserLoads();
    contents.emit('will-prevent-unload', { preventDefault() { throw new Error('unexpected leave'); } });
    assert.equal(messages.at(-1).navigationResult, 'cancelled');
    assert.equal(messages.at(-1).navigationRequestId, 3);
    assert.equal(messages.at(-1).pendingUrl, '');
    assert.equal(navigationStatus.textContent, 'ページの移動を中止しました');
    assert.equal(navigationWrites, 6);
    contents.emit('did-stop-loading');
    assert.equal(navigationWrites, 6);

    contents.emit('did-fail-load', {}, -105, 'old failure', failedUrl, true);
    contents.emit('did-navigate', {}, failedUrl);
    contents.emit('did-navigate-in-page', {}, `${failedUrl}#old`, true);
    assert.equal(messages.at(-1).navigationResult, 'cancelled');
    assert.equal(navigationWrites, 6);

    // ダウンロード阻止も専用結果で終え、既存トースト用 IPC は維持する。
    address.value = 'https://example.org/download';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(messages.at(-1).navigationResult, null);
    // 無関係なダウンロードは pending URL と読み込み中の案内を残す。
    await flushBrowserLoads();
    browserSession.emit('will-download', { preventDefault() {} },
      { getURLChain: () => ['https://example.org/other'] });
    assert.deepEqual(downloadEvents.at(-1), { canOpenFromToolbar: false });
    assert.equal(toastMessages.at(-1), 'ダウンロードはできません。外部ブラウザでダウンロードしてください。');
    assert.equal(target.textContent.includes('ダウンロード先'), false);
    assert.equal(messages.at(-1).pendingUrl, 'https://example.org/download');
    assert.equal(messages.at(-1).navigationResult, null);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    let blockedToast = 0;
    await flushBrowserLoads();
    browserSession.emit('will-download', { preventDefault() { blockedToast++; } },
      { getURLChain: () => ['https://example.org/download'] });
    await contents.download();
    assert.equal(blockedToast, 1);
    assert.equal(channels.at(-1), 'internal-browser:state');
    assert.equal(channels.at(-2), 'internal-browser:download-blocked');
    assert.deepEqual(downloadEvents.at(-1), { canOpenFromToolbar: false });
    assert.equal(toastMessages.at(-1), 'ダウンロードはできません。外部ブラウザでダウンロードしてください。');
    assert.equal(toastMessages.length, 2);
    assert.equal(target.textContent, '外部で開く: ダウンロード先 example.org/download');
    assert.equal(messages.at(-1).navigationResult, 'download-blocked');
    assert.equal(messages.at(-1).navigationRequestId, 4);
    assert.equal(messages.at(-1).pendingUrl, '');
    assert.equal(navigationStatus.textContent, '');
    assert.equal(navigationWrites, 8);
    browser.publish();
    assert.equal(navigationWrites, 8);
    assert.equal(toastMessages.length, 2);
    contents.emit('did-stop-loading');
    assert.equal(navigationWrites, 8);

    contents.emit('did-fail-load', {}, -105, 'old failure', failedUrl, true);
    contents.emit('did-navigate', {}, failedUrl);
    contents.emit('did-navigate-in-page', {}, `${failedUrl}#old`, true);
    assert.equal(messages.at(-1).navigationResult, 'download-blocked');
    assert.equal(target.textContent, '外部で開く: ダウンロード先 example.org/download');
    assert.equal(navigationWrites, 8);

    // 再読み込みも独立した世代で開始と完了を通知する。
    contents.reload = () => contents.startNative('https://example.org/retry', 'reload-initial');
    browser.action('reload');
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    contents.commitDocument('https://example.org/retry', 'reload-initial');
    contents.loadDocument('reload-initial');
    assert.equal(messages.at(-1).navigationRequestId, null);
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(navigationWrites, 10);
    // 相関のない旧失敗を現在の文書へ流用しない。
    contents.emit('did-fail-load', {}, -105, 'reload failed', 'https://example.org/retry', true);
    assert.equal(errorView.hidden, true);
    // Enter で始めたページ内遷移も、pending を残さず完了する。
    address.value = 'https://example.org/retry#next';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(messages.at(-1).pendingUrl, 'https://example.org/retry#next');
    await contents.complete('https://example.org/retry#next');
    assert.equal(messages.at(-1).pendingUrl, '');
    assert.equal(messages.at(-1).navigationResult, 'completed');
    assert.equal(messages.at(-1).navigationRequestId, 5);
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(navigationWrites, 12);
    // 完了 state の再送も、次の Enter の結果としては消費しない。
    address.value = 'https://example.org/last';
    handlers.input();
    deferNextOpen = true;
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    const latestRequestId = vm.runInContext('internalBrowserActiveRequestId', context);
    browser.publish();
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), latestRequestId);
    deferredOpen();
    assert.equal(messages.at(-1).navigationRequestId, latestRequestId);
    await contents.complete('https://example.org/last');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), null);
    // 連続 Enter では後の要求だけを追跡する。
    address.value = 'https://example.org/first-again';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    const firstRequestId = vm.runInContext('internalBrowserActiveRequestId', context);
    const writesBeforeSecondEnter = navigationWrites;
    address.value = 'https://example.org/second-again';
    handlers.input();
    handlers.keydown({ key: 'Enter', preventDefault() {} });
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), firstRequestId + 1);
    assert.ok(messages.some(state => state.navigationRequestId === firstRequestId && state.navigationResult === 'superseded'));
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, writesBeforeSecondEnter);
    assert.equal(messages.at(-1).navigationRequestId, firstRequestId + 1);
    // 旧要求の置換結果が遅れて再送されても、後続要求の読み込み通知を保持する。
    const supersededState = messages.find(state => state.navigationRequestId === firstRequestId && state.navigationResult === 'superseded');
    handlers['internal-browser:state'](supersededState);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    assert.equal(navigationWrites, writesBeforeSecondEnter);
    assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), firstRequestId + 1);
    await contents.complete('https://example.org/second-again');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');

    // 各操作は旧要求を終了し、新しい世代の開始と結果を単一 live 経路へ送る。
    const startPending = suffix => {
      address.value = `https://example.org/${suffix}`;
      handlers.input();
      handlers.keydown({ key: 'Enter', preventDefault() {} });
      assert.equal(navigationStatus.textContent, 'ページを読み込み中');
      return vm.runInContext('internalBrowserActiveRequestId', context);
    };
    const assertSuperseded = requestId => {
      assert.ok(messages.some(state => state.navigationRequestId === requestId && state.navigationResult === 'superseded'));
      assert.equal(navigationStatus.textContent, 'ページを読み込み中');
      assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), null);
      const writesAfterSupersede = navigationWrites;
      browser.publish();
      assert.equal(navigationStatus.textContent, 'ページを読み込み中');
      assert.equal(navigationWrites, writesAfterSupersede);
    };
    for (const action of ['back', 'forward', 'reload']) {
      const requestId = startPending(`pending-${action}`);
      contents.navigationHistory[`canGo${action[0].toUpperCase()}${action.slice(1)}`] = () => true;
      contents.navigationHistory[action === 'back' ? 'goBack' : 'goForward'] = () => {};
      if (action === 'reload') contents.reload = () => {};
      browser.action(action);
      assertSuperseded(requestId);
    }
    let requestId = startPending('pending-page-link');
    let blockedPageNavigation = false;
    contents.emit('will-navigate', { url: 'file:///tmp/blocked', preventDefault() { blockedPageNavigation = true; } });
    assert.equal(blockedPageNavigation, true);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    contents.emit('will-navigate', { url: 'https://example.org/page-link', preventDefault() { throw new Error('unexpected block'); } });
    assertSuperseded(requestId);
    contents.emit('did-start-navigation', {}, 'https://example.org/page-link', false, true);
    assert.equal(messages.at(-1).navigationRequestId, null);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');

    requestId = startPending('pending-window-open');
    contents.openHandler({ url: 'https://example.org/from-page' });
    assertSuperseded(requestId);
    assert.equal(messages.at(-1).navigationRequestId, null);
    await contents.complete('https://example.org/from-page');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');

    requestId = startPending('pending-url-only');
    browser.navigate('https://example.org/url-only');
    assertSuperseded(requestId);
    assert.equal(messages.at(-1).navigationRequestId, null);
    await contents.complete('https://example.org/url-only');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');

    // 戻る・進む・再読み込み・ページ起点・URL-onlyの開始と全終了結果を renderer まで検証する。
    for (const action of ['back', 'forward', 'reload', 'page', 'url-only']) {
      for (const result of ['completed', 'cancelled', 'failed']) {
        const requestId = startPending(`matrix-${action}-${result}`);
        await flushBrowserLoads();
        const writesBeforeReplacement = navigationWrites;
        const previousState = { ...messages.at(-1) };
        const targetUrl = `https://matrix.example/${action}/${result}`;
        if (action === 'url-only') browser.navigate(targetUrl);
        else if (action === 'page') contents.emit('will-navigate', { url: targetUrl });
        else browser.action(action);
        assert.ok(messages.some(state => state.navigationRequestId === requestId && state.navigationResult === 'superseded'));
        assert.equal(navigationStatus.textContent, 'ページを読み込み中');
        assert.equal(navigationWrites, writesBeforeReplacement + 2);
        const operation = messages.at(-1).navigationOperationId;
        assert.equal(messages.at(-1).navigationRequestId, null);
        if (action === 'url-only') {
          if (result === 'completed') await contents.complete(targetUrl);
          else await contents.fail(result === 'cancelled' ? -3 : -105, targetUrl);
        } else {
          contents.startNative(targetUrl, `matrix-${action}-${result}`);
          if (result === 'completed') {
            contents.commitDocument(targetUrl, `matrix-${action}-${result}`);
            contents.loadDocument(`matrix-${action}-${result}`);
          } else contents.debugger.emit('message', {}, 'Network.loadingFailed', {
            requestId: `request-matrix-${action}-${result}`, type: 'Document', canceled: result === 'cancelled', errorText: 'net::ERR_NAME_NOT_RESOLVED',
          });
        }
        assert.equal(messages.at(-1).navigationOperationId, operation);
        assert.equal(messages.at(-1).navigationResult, result);
        const expectedMessage = result === 'completed' ? 'ページの読み込みが完了しました'
          : result === 'cancelled' ? 'ページの移動を中止しました' : '';
        assert.equal(navigationStatus.textContent, expectedMessage);
        assert.equal(navigationWrites, writesBeforeReplacement + 3);
        if (result === 'failed') {
          assert.equal(errorView.hidden, false);
          assert.equal(message.textContent, 'ページを表示できませんでした（matrix.example）');
        }
        // 完了後の旧世代通知と同じ世代の再送は読み上げを増やさない。
        const writesAfterResult = navigationWrites;
        const errorWritesAfterResult = errorWrites;
        const finalAddress = address.value;
        handlers['internal-browser:state']({ ...previousState, navigationResult: 'failed', failedUrl: 'https://stale.example/failed' });
        browser.publish();
        assert.equal(navigationWrites, writesAfterResult);
        assert.equal(errorWrites, errorWritesAfterResult);
        assert.equal(address.value, finalAddress);
        assert.equal(navigationStatus.textContent, expectedMessage);
      }
    }

    // redirect の開始イベントだけでは同一 Enter 要求を置き換えない。
    requestId = startPending('redirect-source');
    contents.emit('did-start-navigation', {}, 'https://example.org/redirect-source', false, true);
    contents.emit('will-redirect', { url: 'https://example.org/redirect-target', preventDefault() { throw new Error('unexpected block'); } });
    contents.emit('did-start-navigation', {}, 'https://example.org/redirect-target', false, true);
    assert.equal(messages.at(-1).navigationRequestId, requestId);
    assert.equal(navigationStatus.textContent, 'ページを読み込み中');
    await contents.complete('https://example.org/redirect-target');
    assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');

    // 失敗 URL の再読み込みは request ID なしで始まる。
    contents.emit('will-navigate', { url: 'https://example.org/failed-reload' });
    contents.emit('did-fail-load', {}, -105, 'failed', 'https://example.org/failed-reload', true);
    browser.action('reload');
    assert.equal(messages.at(-1).navigationRequestId, null);
    assert.equal(messages.at(-1).navigationResult, null);

    // main 受理前に古い結果や保留状態が再送されても、B の送信値を保持して再 Enter する。
    for (const [name, staleState] of [
      ['failed', { failedUrl: 'https://old.example/failed', navigationResult: 'failed' }],
      ['completed', { url: 'https://old.example/done', navigationResult: 'completed' }],
      ['superseded', { url: 'https://old.example/replaced', navigationResult: 'superseded' }],
      ['pending', { pendingUrl: 'https://old.example/pending', navigationResult: null }],
    ]) {
      const nextUrl = `https://new.example/${name}`;
      address.value = nextUrl;
      handlers.input();
      deferNextOpen = true;
      handlers.keydown({ key: 'Enter', preventDefault() {} });
      const firstId = vm.runInContext('internalBrowserActiveRequestId', context);
      handlers['internal-browser:state']({ url: 'https://old.example/', pendingUrl: '', failedUrl: '',
        downloadUrl: '', navigationRequestId: firstId - 1, loading: false, canGoBack: false, canGoForward: false,
        ...staleState });
      assert.equal(address.value, nextUrl);
      assert.equal(navigationStatus.textContent, 'ページを読み込み中');
      assert.equal(vm.runInContext('internalBrowserActiveRequestId', context), firstId);
      handlers.keydown({ key: 'Enter', preventDefault() {} });
      assert.equal(messages.at(-1).pendingUrl, nextUrl);
      assert.equal(messages.at(-1).navigationRequestId, firstId + 1);
      await contents.complete(nextUrl);
      assert.equal(navigationStatus.textContent, 'ページの読み込みが完了しました');
    }
  }
});
