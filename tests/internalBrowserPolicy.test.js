'use strict';
const { installBrowserLoad, flushBrowserLoads } = require('./helpers/browserLoad');
const test = require('node:test');
const assert = require('node:assert/strict');
const { PARTITION, clampBrowserWidth, validateBrowserBounds, isBrowserUrl, isNavigationUrl } = require('../utils/internalBrowserPolicy');
const { createInternalBrowser } = require('../utils/internalBrowser');
const { browserAvailableWidth, shouldFoldSetupPanel, browserWidthMax, shouldWrapToastPhrase } = require('../utils/internalBrowserLayout');

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
  assert.equal(browserWidthMax(360, 1, 600, 12), 348);
});

test('トーストを置ける幅が 200px 未満のときだけ語句を折り返す', () => {
  assert.equal(shouldWrapToastPhrase(600, 368), false);
  assert.equal(shouldWrapToastPhrase(600, 369), true);
  assert.equal(shouldWrapToastPhrase(450, clampBrowserWidth(750, 370, 1, 450)), true);
  assert.equal(shouldWrapToastPhrase(1400, clampBrowserWidth(750, 1400)), false);
});

test('パネルの最小幅とペイン幅を一度だけ確保する', () => {
  assert.equal(browserAvailableWidth(1400, 0), 1400);
  assert.equal(browserWidthMax(1400, 1, 1400, 320), 1080);
  assert.equal(clampBrowserWidth(NaN, 1400, 1, 1400, 320), 630);
  assert.equal(browserAvailableWidth(1000, 330, [240]), 430);
  assert.equal(shouldFoldSetupPanel(1000, 330, 320, 240), true);
  assert.equal(shouldFoldSetupPanel(1400, 0, 320, 240, 1, true), false);
  assert.equal(shouldFoldSetupPanel(1920, 330, 320, 240, 1, true), false);
  assert.equal(shouldFoldSetupPanel(600, 0, 320, 240, 1, true), true);
  assert.equal(shouldFoldSetupPanel(1920, 0, 320, 240, 1, true), false);
  assert.equal(shouldFoldSetupPanel(999, 0, 320, 240, 1, false), true);
  assert.equal(shouldFoldSetupPanel(1000, 0, 320, 240, 1, false), false);
  assert.equal(clampBrowserWidth(NaN, browserAvailableWidth(1000, 330), 1, 1000, 12), 360);
  assert.equal(clampBrowserWidth(NaN, browserAvailableWidth(600, 0), 1, 600, 12), 360);
  assert.equal(clampBrowserWidth(NaN, browserAvailableWidth(600, 330), 1, 600, 12), 258);
  assert.equal(clampBrowserWidth(NaN, browserAvailableWidth(1400, 0), 1, 1400, 12), 630);
  assert.equal(browserWidthMax(browserAvailableWidth(1400, 0), 1, 1400, 12), 1080);
});

test('ブラウザの開閉順と帯への切替後も同じ配置・幅に収束する', () => {
  const layout = (rootWidth, sidebarWidth, browserOpen, hasPanel, columns = 1) => {
    const fold = hasPanel && shouldFoldSetupPanel(rootWidth, sidebarWidth, 320, 240, columns, browserOpen);
    const available = browserAvailableWidth(rootWidth, sidebarWidth, fold || !hasPanel ? [] : [240]);
    return { fold, width: clampBrowserWidth(NaN, available, columns, rootWidth, fold ? 12 : 320) };
  };
  assert.deepEqual(layout(1000, 330, true, true), { fold: true, width: 360 });
  assert.deepEqual(layout(1000, 330, true, true), layout(1000, 330, true, true));
  assert.deepEqual(layout(600, 330, true, true), { fold: true, width: 258 });
  assert.deepEqual(layout(1400, 0, true, true), { fold: false, width: 522 });
  assert.equal(layout(1400, 0, false, true).fold, false);
  assert.equal(layout(999, 0, false, true).fold, true);
  assert.deepEqual(layout(1400, 0, true, false), { fold: false, width: 630 });
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

test('専用ビューの遷移と権限、ダウンロード、確定 URL を制御する', async () => {
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
      installBrowserLoad(contents);
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
  assert.equal(sent.at(-1)[1].navigationRequestId, null);
  assert.equal(sent.at(-1)[1].url, '');
  assert.equal(sent.at(-1)[1].navigationResult, null);
  await contents.complete('https://example.com/first');
  assert.equal(sent.at(-1)[1].url, 'https://example.com/first');
  assert.equal(sent.at(-1)[1].navigationResult, 'completed');
  contents.emit('did-navigate-in-page', {}, 'https://evil.example/', false);
  assert.equal(sent.at(-1)[1].url, 'https://example.com/first');
  contents.commitInPage('https://example.com/first#part');
  assert.equal(sent.at(-1)[1].url, 'https://example.com/first#part');
  assert.equal(sent.at(-1)[1].pendingUrl, '');
  assert.equal(sent.at(-1)[1].navigationResult, 'completed');
  const blocked = { url: 'file:///tmp/a', preventDefault() { this.blocked = true; } };
  contents.emit('will-navigate', blocked);
  assert.equal(blocked.blocked, true);
  contents.emit('will-redirect', blocked);
  assert.equal(blocked.blocked, true);
  assert.deepEqual(contents.openHandler({ url: 'file:///tmp/a' }), { action: 'deny' });
  assert.deepEqual(contents.openHandler({ url: 'https://example.com/failed' }), { action: 'deny' });
  await flushBrowserLoads();
  assert.equal(contents.requestedUrl, 'https://example.com/failed');
  assert.equal(sent.at(-1)[1].url, 'https://example.com/first#part');
  await contents.fail(-105, 'https://example.com/failed');
  assert.equal(sent.at(-1)[1].failedUrl, 'https://example.com/failed');
  assert.equal(sent.at(-1)[1].navigationResult, 'failed');
  assert.equal(browser.action('reload'), true);
  assert.equal(contents.requestedUrl, 'https://example.com/failed');
  await contents.fail(-105, 'https://example.com/failed');
  contents.emit('did-start-loading');
  assert.equal(sent.at(-1)[1].failedUrl, 'https://example.com/failed');
  contents.emit('will-navigate', { url: 'https://example.com/failed' });
  contents.startNative('https://example.com/failed', 'native-failed-retry');
  assert.equal(sent.at(-1)[1].failedUrl, '');
  assert.equal(sent.at(-1)[1].navigationResult, null);
  contents.commitDocument('https://example.com/failed', 'native-failed-retry');
  contents.loadDocument('native-failed-retry');
  assert.equal(sent.at(-1)[1].url, 'https://example.com/failed');
  assert.equal(sent.at(-1)[1].failedUrl, '');
  contents.emit('did-fail-load', {}, -3, 'aborted', 'https://example.com/failed', true);
  assert.equal(sent.at(-1)[1].failedUrl, '');
  contents.emit('will-navigate', { url: 'https://github.com/missing' });
  contents.startNative('https://github.com/missing', 'native-404');
  contents.respond('native-404', 'https://github.com/missing', 404);
  contents.commitDocument('https://github.com/missing', 'native-404');
  contents.loadDocument('native-404');
  assert.equal(sent.at(-1)[1].github404Url, 'https://github.com/missing');
  contents.emit('did-start-loading');
  assert.equal(sent.at(-1)[1].github404Url, 'https://github.com/missing');
  contents.emit('will-navigate', { url: 'https://github.com/next' });
  assert.equal(sent.at(-1)[1].github404Url, '');
  let allowed = false;
  contents.emit('will-prevent-unload', { preventDefault() { allowed = true; } });
  assert.equal(allowed, false);
  assert.equal(sent.at(-1)[1].navigationResult, 'cancelled');
  dialogChoice = 0;
  contents.emit('will-prevent-unload', { preventDefault() { allowed = true; } });
  assert.equal(allowed, true);
  let canceled = false;
  await flushBrowserLoads();
  browserSession.emit('will-download', { preventDefault() { canceled = true; } }, { cancel() { throw new Error('item.cancel should not be called'); } });
  assert.equal(canceled, true);
  assert.equal(sent.at(-1)[0], 'internal-browser:download-blocked');
  assert.deepEqual(sent.at(-1)[1], { canOpenFromToolbar: false });
  assert.equal(sent.at(-2)[1].downloadUrl, '');
  assert.equal(sent.at(-2)[1].navigationResult, 'cancelled');
  browser.navigate('https://example.com/download', false, 7);
  assert.equal(sent.at(-1)[1].navigationRequestId, 7);
  await flushBrowserLoads();
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/download'] });
  await contents.download();
  assert.equal(sent.at(-2)[0], 'internal-browser:download-blocked');
  assert.deepEqual(sent.at(-2)[1], { canOpenFromToolbar: false });
  assert.equal(sent.at(-1)[0], 'internal-browser:state');
  assert.equal(sent.at(-1)[1].downloadUrl, 'https://example.com/download');
  assert.equal(sent.at(-1)[1].navigationRequestId, 7);
  contents.emit('did-start-loading');
  assert.equal(sent.at(-1)[1].downloadUrl, 'https://example.com/download');
  contents.emit('did-start-navigation', {}, 'https://example.com/frame', false, false);
  assert.equal(sent.at(-1)[1].downloadUrl, 'https://example.com/download');
  contents.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
  assert.equal(sent.at(-1)[1].downloadUrl, 'https://example.com/download');
  assert.equal(sent.at(-1)[1].navigationRequestId, 7);
  browser.navigate('https://example.com/stale');
  const beforeUnrelatedDownload = sent.length;
  await flushBrowserLoads();
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/other'] });
  assert.equal(sent.length, beforeUnrelatedDownload + 1);
  assert.equal(sent.at(-1)[0], 'internal-browser:download-blocked');
  assert.deepEqual(sent.at(-1)[1], { canOpenFromToolbar: false });
  assert.equal(sent.at(-2)[1].pendingUrl, 'https://example.com/stale');
  assert.equal(sent.at(-2)[1].navigationResult, null);
  browser.navigate('https://example.com/normalized');
  await flushBrowserLoads();
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['HTTPS://EXAMPLE.COM/normalized'] });
  await contents.download();
  assert.equal(sent.at(-1)[1].downloadUrl, 'https://example.com/normalized');
  browser.navigate('https://example.com/bad');
  await flushBrowserLoads();
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['invalid'] });
  assert.equal(sent.at(-2)[1].pendingUrl, 'https://example.com/bad');
  assert.equal(sent.at(-2)[1].navigationResult, null);
  browser.navigate('https://example.com/reload');
  await flushBrowserLoads();
  browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/reload'] });
  await contents.download();
  contents.reload = () => contents.emit('did-start-navigation', {}, 'https://example.com/reload', false, true);
  browser.action('reload');
  assert.equal(sent.at(-1)[1].downloadUrl, '');
  for (const action of ['back', 'forward']) {
    browser.navigate(`https://example.com/${action}`);
    await flushBrowserLoads();
    browserSession.emit('will-download', { preventDefault() {} }, { getURLChain: () => [`https://example.com/${action}`] });
    await contents.download();
    history[`canGo${action[0].toUpperCase()}${action.slice(1)}`] = () => true;
    browser.action(action);
    assert.equal(sent.at(-1)[1].downloadUrl, '');
  }
  browser.navigate('https://example.com/next');
  assert.equal(sent.at(-1)[1].downloadUrl, '');
  const beforeInvalidOpen = sent.length;
  assert.equal(browser.navigate('file:///tmp/blocked', false, 9), false);
  assert.equal(browser.navigate('https://example.com/blocked', false, 0), false);
  assert.equal(sent.length, beforeInvalidOpen);
  browser.navigate('https://example.com/redirect', false, 8);
  contents.emit('did-start-navigation', {}, 'https://example.com/redirect', false, true);
  contents.emit('will-redirect', { url: 'https://example.com/redirected', preventDefault() { throw new Error('unexpected block'); } });
  contents.emit('did-start-navigation', {}, 'https://example.com/redirected', false, true);
  assert.equal(sent.at(-1)[1].navigationRequestId, 8);
  await contents.complete('https://example.com/redirected');
  assert.equal(sent.at(-1)[1].navigationRequestId, 8);
  assert.equal(sent.at(-1)[1].navigationResult, 'completed');
  contents.emit('will-navigate', { url: 'https://example.com/page-link' });
  contents.emit('did-start-navigation', {}, 'https://example.com/page-link', false, true);
  assert.equal(sent.at(-1)[1].navigationRequestId, null);

  // B の保留中に届いた A の終了イベントは、B の結果へ流用しない。
  contents.emit('did-navigate', {}, 'https://old.example/page');
  browser.navigate('https://bücher.example:443/next?q=1#part', false, 10);
  const pendingB = sent.at(-1)[1].pendingUrl;
  contents.emit('did-navigate-in-page', {}, 'https://old.example/page#changed', true);
  assert.equal(sent.at(-1)[1].url, 'https://example.com/redirected');
  assert.equal(sent.at(-1)[1].pendingUrl, pendingB);
  assert.equal(sent.at(-1)[1].navigationRequestId, 10);
  assert.equal(sent.at(-1)[1].navigationResult, null);
  contents.emit('did-fail-load', {}, -105, 'old failure', 'https://old.example/page', true);
  assert.equal(sent.at(-1)[1].pendingUrl, pendingB);
  assert.equal(sent.at(-1)[1].failedUrl, '');
  contents.emit('did-navigate', {}, 'https://old.example/page');
  assert.equal(sent.at(-1)[1].navigationResult, null);
  assert.equal(sent.at(-1)[1].navigationRequestId, 10);
  contents.emit('did-fail-load', {}, -105, 'bad url', 'invalid', true);
  assert.equal(sent.at(-1)[1].pendingUrl, pendingB);
  contents.emit('did-start-navigation', {}, 'https://xn--bcher-kva.example/next?q=1#part', false, true);
  await contents.complete('https://xn--bcher-kva.example/next?q=1#part');
  assert.equal(sent.at(-1)[1].navigationResult, 'completed');
  assert.equal(sent.at(-1)[1].navigationRequestId, 10);

  browser.navigate('https://example.com/source', false, 11);
  contents.emit('will-redirect', { url: 'https://old.example/redirect', isMainFrame: true, preventDefault() { throw new Error('unexpected block'); } });
  contents.emit('did-navigate', {}, 'https://old.example/redirect');
  assert.equal(sent.at(-1)[1].pendingUrl, 'https://example.com/source');
  assert.equal(sent.at(-1)[1].navigationResult, null);
  contents.emit('did-start-navigation', {}, 'https://example.com/source', false, true);
  contents.emit('will-redirect', { url: 'https://example.com/subframe', isMainFrame: false, preventDefault() { throw new Error('unexpected block'); } });
  contents.emit('did-navigate', {}, 'https://example.com/subframe');
  assert.equal(sent.at(-1)[1].navigationResult, null);
  contents.emit('will-redirect', { url: 'https://example.com/target?x=1', preventDefault() { throw new Error('unexpected block'); } });
  contents.emit('did-fail-load', {}, -105, 'old failure', 'https://old.example/page', true);
  assert.equal(sent.at(-1)[1].navigationResult, null);
  await contents.complete('https://example.com/target?x=1');
  assert.equal(sent.at(-1)[1].navigationResult, 'completed');
  assert.equal(sent.at(-1)[1].navigationRequestId, 11);
  browser.navigate('https://example.com/failing?q=2', false, 12);
  contents.emit('did-fail-load', {}, -105, 'old failure', 'https://old.example/page', true);
  assert.equal(sent.at(-1)[1].navigationResult, null);
  await contents.fail(-105, 'HTTPS://EXAMPLE.COM:443/failing?q=2');
  assert.equal(sent.at(-1)[1].navigationResult, 'failed');
  assert.equal(sent.at(-1)[1].navigationRequestId, 12);
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

test('open IPC は sender と正の安全な request ID を検証し、URL-only を許可する', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../main.js'), 'utf8');
  const handlerSource = source.match(/ipcMain\.handle\('internal-browser:open',[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handlerSource);
  let handler;
  const calls = [];
  require('node:vm').runInNewContext(handlerSource, {
    ipcMain: { handle(_channel, callback) { handler = callback; } },
    isInternalBrowserSender: event => event.allowed === true,
    internalBrowser: { navigate(...args) { calls.push(args); return true; } },
    Number,
  });
  assert.equal(handler({ allowed: false }, 'https://example.com', 1), false);
  for (const id of [null, 0, -1, 1.5, '1', Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    assert.equal(handler({ allowed: true }, 'https://example.com', id), false);
  }
  assert.equal(calls.length, 0);
  assert.equal(handler({ allowed: true }, 'https://example.com'), true);
  assert.equal(handler({ allowed: true }, 'https://example.com', 1), true);
  assert.equal(handler({ allowed: true }, 'https://example.com', Number.MAX_SAFE_INTEGER), true);
  assert.deepEqual(calls, [
    ['https://example.com', false, undefined],
    ['https://example.com', false, 1],
    ['https://example.com', false, Number.MAX_SAFE_INTEGER],
  ]);
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
      installBrowserLoad(this.webContents);
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
