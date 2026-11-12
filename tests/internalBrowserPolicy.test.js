'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PARTITION, clampBrowserWidth, validateBrowserBounds, isBrowserUrl, isNavigationUrl } = require('../utils/internalBrowserPolicy');
const { createInternalBrowser } = require('../utils/internalBrowser');
const { browserWidthMax, shouldWrapToastPhrase } = require('../utils/internalBrowserLayout');

test('専用 persist パーティションと HTTP(S) URL の制限', () => {
  assert.equal(PARTITION, 'persist:vk-terminals-internal-browser');
  assert.equal(isBrowserUrl('https://github.com/login'), true);
  assert.equal(isBrowserUrl('http://example.com'), true);
  assert.equal(isBrowserUrl('file:///etc/passwd'), false);
  assert.equal(isBrowserUrl('javascript:alert(1)'), false);
});

test('アプリから開く URL だけ長さを制限する', () => {
  const longUrl = `https://example.com/${'a'.repeat(2048)}`;
  assert.equal(isBrowserUrl(longUrl), false);
  assert.equal(isNavigationUrl(longUrl), true);
  assert.equal(isNavigationUrl('file:///tmp/test'), false);
});

test('幅は既定値とペイン残幅でクランプする', () => {
  assert.equal(clampBrowserWidth(NaN, 1400), 630);
  assert.equal(clampBrowserWidth(100, 1400), 360);
  assert.equal(clampBrowserWidth(1500, 800), 480);
});

test('ペインの列数に応じて見出しの操作幅を確保する', () => {
  assert.equal(browserWidthMax(1400, 2), 856);
  assert.equal(clampBrowserWidth(750, 1100, 2), 556);
  assert.equal(clampBrowserWidth(750, 1100, 3), 360);
  assert.equal(clampBrowserWidth(750, 800, 3), 360);
});

test('ウィンドウ全体からトースト用の 96px を残す', () => {
  assert.equal(browserWidthMax(1400, 2, 1400), 856);
  assert.equal(browserWidthMax(600, 1, 600), 360);
  assert.equal(browserWidthMax(570, 1, 600), 360);
  assert.equal(browserWidthMax(370, 1, 450), 354);
  assert.equal(clampBrowserWidth(750, 370, 1, 450), 354);
  assert.equal(browserWidthMax(455, 1, 455), 359);
  assert.equal(browserWidthMax(456, 1, 456), 360);
});

test('トーストを置ける幅が 200px 未満のときだけ語句を折り返す', () => {
  assert.equal(shouldWrapToastPhrase(600, 368), false);
  assert.equal(shouldWrapToastPhrase(600, 369), true);
  assert.equal(shouldWrapToastPhrase(450, clampBrowserWidth(750, 370, 1, 450)), true);
  assert.equal(shouldWrapToastPhrase(1400, clampBrowserWidth(750, 1400)), false);
});

test('WebContentsView の座標は有限なウィンドウ内の矩形だけを受け入れる', () => {
  const windowBounds = { width: 800, height: 600 };
  assert.deepEqual(validateBrowserBounds({ x: 400, y: 40, width: 400, height: 560 }, windowBounds), { x: 400, y: 40, width: 400, height: 560 });
  assert.equal(validateBrowserBounds({ x: 400, y: 40, width: 402, height: 560 }, windowBounds), null);
  assert.equal(validateBrowserBounds({ x: NaN, y: 40, width: 400, height: 560 }, windowBounds), null);
  assert.equal(validateBrowserBounds({ x: -1, y: 40, width: 400, height: 560 }, windowBounds), null);
  assert.equal(validateBrowserBounds({ x: 799, y: 599, width: 3, height: 1 }, windowBounds), null);
  assert.equal(validateBrowserBounds({ x: 1, y: 1, width: -1, height: 1 }, windowBounds), null);
  assert.equal(validateBrowserBounds({ x: 1, y: 1, width: Infinity, height: 1 }, windowBounds), null);
  assert.equal(validateBrowserBounds({ x: 1, y: 1, width: 1, height: 1 }, { width: NaN, height: 600 }), null);
});

test('右端と下端の 1px 以下のはみ出しだけをウィンドウ内へ収める', () => {
  const windowBounds = { width: 1200, height: 800 };
  assert.deepEqual(validateBrowserBounds({ x: 840.6, y: 440.6, width: 359.6, height: 359.6 }, windowBounds),
    { x: 841, y: 441, width: 359, height: 359 });
  assert.equal(validateBrowserBounds({ x: 840.6, y: 440.6, width: 360.9, height: 359.6 }, windowBounds), null);
  assert.equal(validateBrowserBounds({ x: 840.6, y: 440.6, width: 359.6, height: 360.9 }, windowBounds), null);
});

test('拡大表示で右端と下端に接する小数の矩形をウィンドウ内へ収める', () => {
  const windowBounds = { width: 800, height: 600 };
  const zoom = 1.1;
  const rect = {
    x: 455 * zoom, y: 455 * zoom,
    width: (windowBounds.width / zoom - 455) * zoom,
    height: (windowBounds.height / zoom - 455) * zoom,
  };
  assert.deepEqual(validateBrowserBounds(rect, windowBounds), { x: 501, y: 501, width: 299, height: 99 });
});

test('専用ビューの遷移と権限、ダウンロード、確定 URL を制御する', () => {
  const { EventEmitter } = require('node:events');
  const sent = [];
  const browserSession = new EventEmitter();
  browserSession.webRequest = {
    onBeforeRequest(handler) { browserSession.request = handler; },
    onCompleted(handler) { browserSession.completed = handler; },
  };
  browserSession.setPermissionRequestHandler = handler => { browserSession.permissionRequest = handler; };
  browserSession.setPermissionCheckHandler = handler => { browserSession.permissionCheck = handler; };
  const history = { canGoBack: () => false, canGoForward: () => false, goBack() { contents.emit('did-start-navigation', {}, 'https://example.com/back', false, true); }, goForward() { contents.emit('did-start-navigation', {}, 'https://example.com/forward', false, true); } };
  let contents;
  class FakeView {
    constructor(options) {
      assert.equal(options.webPreferences.sandbox, true);
      contents = new EventEmitter();
      contents.id = 42;
      contents.navigationHistory = history;
      contents.isLoading = () => false;
      contents.loadURL = url => { contents.requestedUrl = url; return Promise.resolve(); };
      contents.setWindowOpenHandler = handler => { contents.openHandler = handler; };
      contents.close = () => {};
      this.webContents = contents;
    }
    setBounds() {}
  }
  const win = {
    isDestroyed: () => false,
    webContents: { send: (...args) => sent.push(args) },
    contentView: { addChildView() {}, removeChildView() {} },
    getContentBounds: () => ({ width: 1000, height: 800 }),
  };
  let dialogChoice = 1;
  const browser = createInternalBrowser(win, {
    WebContentsView: FakeView,
    session: { fromPartition: () => browserSession },
    dialog: { showMessageBoxSync(parent, options) { assert.equal(parent, win); assert.equal(options.defaultId, 1); assert.equal(options.cancelId, 1); assert.equal(options.message, 'このページを離れますか？'); assert.equal(options.detail, '入力中の内容は保存されない可能性があります。'); return dialogChoice; } },
  });
  browserSession.permissionRequest(null, 'camera', allowed => assert.equal(allowed, false));
  assert.equal(browserSession.permissionCheck(), false);
  browserSession.request({ resourceType: 'mainFrame', url: 'file:///tmp/a' }, result => assert.deepEqual(result, { cancel: true }));
  browserSession.request({ resourceType: 'mainFrame', url: 'https://example.com' }, result => assert.deepEqual(result, { cancel: false }));
  assert.equal(browser.navigate('https://example.com/first'), true);
  assert.equal(sent.at(-1)[1].url, '');
  contents.emit('did-navigate', {}, 'https://example.com/first');
  assert.equal(sent.at(-1)[1].url, 'https://example.com/first');
  contents.emit('did-navigate-in-page', {}, 'https://evil.example/', false);
  assert.equal(sent.at(-1)[1].url, 'https://example.com/first');
  contents.emit('did-navigate-in-page', {}, 'https://example.com/first#part', true);
  assert.equal(sent.at(-1)[1].url, 'https://example.com/first#part');
  const blocked = { url: 'file:///tmp/a', preventDefault() { this.blocked = true; } };
  contents.emit('will-navigate', blocked);
  assert.equal(blocked.blocked, true);
  contents.emit('will-redirect', blocked);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(contents.openHandler({ url: 'file:///tmp/a' }), { action: 'deny' });
  assert.deepEqual(contents.openHandler({ url: 'https://example.com/second' }), { action: 'deny' });
  assert.equal(contents.requestedUrl, 'https://example.com/second');
  assert.equal(sent.at(-1)[1].url, 'https://example.com/first#part');
  contents.emit('did-fail-load', {}, -105, 'failed', 'https://example.com/failed', true);
  assert.equal(sent.at(-1)[1].failedUrl, 'https://example.com/failed');
  assert.equal(browser.action('reload'), true);
  assert.equal(contents.requestedUrl, 'https://example.com/failed');
  contents.emit('did-fail-load', {}, -105, 'failed', 'https://example.com/failed', true);
  contents.emit('did-start-loading');
  assert.equal(sent.at(-1)[1].failedUrl, 'https://example.com/failed');
  contents.emit('did-start-navigation', {}, 'https://example.com/failed', false, true);
  assert.equal(sent.at(-1)[1].failedUrl, '');
  contents.emit('did-navigate', {}, 'https://example.com/failed');
  assert.equal(sent.at(-1)[1].url, 'https://example.com/failed');
  assert.equal(sent.at(-1)[1].failedUrl, '');
  contents.emit('did-fail-load', {}, -3, 'aborted', 'https://example.com/failed', true);
  assert.equal(sent.at(-1)[1].failedUrl, '');
  contents.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
  assert.equal(sent.at(-1)[1].failedUrl, '');
  browserSession.completed({ webContentsId: 42, resourceType: 'mainFrame', statusCode: 404, url: 'https://github.com/missing' });
  assert.equal(sent.at(-1)[1].github404Url, 'https://github.com/missing');
  contents.emit('did-start-loading');
  assert.equal(sent.at(-1)[1].github404Url, 'https://github.com/missing');
  contents.emit('did-start-navigation', {}, 'https://github.com/next', false, true);
  assert.equal(sent.at(-1)[1].github404Url, '');
  let allowed = false;
  contents.emit('will-prevent-unload', { preventDefault() { allowed = true; } });
  assert.equal(allowed, false);
  dialogChoice = 0;
  contents.emit('will-prevent-unload', { preventDefault() { allowed = true; } });
  assert.equal(allowed, true);
  let canceled = false;
  browserSession.emit('will-download', { preventDefault() { canceled = true; } }, { cancel() { throw new Error('item.cancel should not be called'); } });
  assert.equal(canceled, true);
  assert.equal(sent.at(-1)[0], 'internal-browser:download-blocked');
  assert.equal(sent.at(-2)[1].downloadUrl, '');
  browser.navigate('https://example.com/download');
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/download'] });
  assert.equal(sent.at(-2)[1].downloadUrl, 'https://example.com/download');
  contents.emit('did-start-loading');
  assert.equal(sent.at(-1)[1].downloadUrl, 'https://example.com/download');
  contents.emit('did-start-navigation', {}, 'https://example.com/frame', false, false);
  assert.equal(sent.at(-1)[1].downloadUrl, 'https://example.com/download');
  contents.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
  assert.equal(sent.at(-1)[1].downloadUrl, '');
  browser.navigate('https://example.com/stale');
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/other'] });
  assert.equal(sent.at(-2)[1].downloadUrl, '');
  browser.navigate('https://example.com/normalized');
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['HTTPS://EXAMPLE.COM/normalized'] });
  assert.equal(sent.at(-2)[1].downloadUrl, 'https://example.com/normalized');
  browser.navigate('https://example.com/bad');
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['invalid'] });
  assert.equal(sent.at(-2)[1].downloadUrl, '');
  browser.navigate('https://example.com/reload');
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/reload'] });
  contents.reload = () => contents.emit('did-start-navigation', {}, 'https://example.com/reload', false, true);
  browser.action('reload');
  assert.equal(sent.at(-1)[1].downloadUrl, '');
  for (const action of ['back', 'forward']) {
    browser.navigate(`https://example.com/${action}`);
    browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => [`https://example.com/${action}`] });
    history[`canGo${action[0].toUpperCase()}${action.slice(1)}`] = () => true;
    browser.action(action);
    assert.equal(sent.at(-1)[1].downloadUrl, '');
  }
  browser.navigate('https://example.com/next');
  assert.equal(sent.at(-1)[1].downloadUrl, '');
});

test('ブラウザ IPC はメインウィンドウのメインフレームだけを受け付ける', () => {
  const { isInternalBrowserSender } = require('../utils/internalBrowserSender');
  const frame = {};
  const contents = { mainFrame: frame };
  const win = { isDestroyed: () => false, webContents: contents };
  assert.equal(isInternalBrowserSender({ sender: contents, senderFrame: frame }, win), true);
  assert.equal(isInternalBrowserSender({ sender: contents, senderFrame: {} }, win), false);
  assert.equal(isInternalBrowserSender({ sender: {}, senderFrame: frame }, win), false);
  assert.equal(isInternalBrowserSender({ sender: contents, senderFrame: frame }, null), false);
  assert.equal(isInternalBrowserSender({ sender: contents, senderFrame: frame }, { ...win, isDestroyed: () => true }), false);
});

test('開き先メニューは単一の通常クリックだけを受け付ける', () => {
  const { shouldShowBrowserChoice } = require('../renderer/internalBrowserChoicePolicy');
  assert.equal(shouldShowBrowserChoice({ button: 0, detail: 1 }, false), true);
  for (const event of [{ button: 1, detail: 1 }, { button: 2, detail: 1 }, { button: 0, detail: 2 }]) {
    assert.equal(shouldShowBrowserChoice(event, false), false);
  }
  assert.equal(shouldShowBrowserChoice({ button: 0, detail: 1 }, true), false);
});

test('非表示とモーダル中はビューを外し、再表示では同じビューを戻す', () => {
  const { EventEmitter } = require('node:events');
  const browserSession = new EventEmitter();
  browserSession.webRequest = { onBeforeRequest() {}, onCompleted() {} };
  browserSession.setPermissionRequestHandler = () => {};
  browserSession.setPermissionCheckHandler = () => {};
  const calls = [];
  let focused = true;
  let windowFocused = true;
  class FakeView {
    constructor() {
      this.webContents = new EventEmitter();
      this.webContents.loadURL = () => Promise.resolve();
      this.webContents.isLoading = () => false;
      this.webContents.isFocused = () => focused;
      this.webContents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.close = () => {};
    }
    setBounds(rect) { calls.push(['bounds', rect]); }
  }
  const win = { isDestroyed: () => false, isFocused: () => windowFocused, webContents: { send() {}, focus() { calls.push(['focus']); } }, getContentBounds: () => ({ width: 1000, height: 800 }), contentView: {
    addChildView(view) { calls.push(['add', view]); }, removeChildView(view) { calls.push(['remove', view]); },
  } };
  const browser = createInternalBrowser(win, { WebContentsView: FakeView, session: { fromPartition: () => browserSession } });
  browser.setBounds({ x: 500, y: 40, width: 480, height: 700 });
  browser.setVisible(true);
  browser.navigate('https://example.com');
  const view = calls.find(call => call[0] === 'add')[1];
  browser.setVisible(false);
  assert.deepEqual(calls.slice(-2), [['remove', view], ['focus']]);
  focused = true;
  windowFocused = false;
  browser.setVisible(true);
  browser.setVisible(false);
  assert.deepEqual(calls.at(-1), ['remove', view]);
  focused = false;
  browser.setVisible(true);
  assert.deepEqual(calls.at(-1), ['add', view]);
  browser.setModalCount(1);
  assert.deepEqual(calls.at(-1), ['remove', view]);
  browser.setModalCount(0);
  assert.deepEqual(calls.at(-1), ['add', view]);
  assert.deepEqual(calls.at(-2), ['bounds', { x: 500, y: 40, width: 480, height: 700 }]);
});
