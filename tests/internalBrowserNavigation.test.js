'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInternalBrowser } = require('../utils/internalBrowser');
const { installBrowserLoad, flushBrowserLoads } = require('./helpers/browserLoad');

function setup() {
  const states = [];
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  session.webRequest = { onBeforeRequest() {}, onCompleted() {} };
  let contents;
  class View {
    constructor() {
      contents = new EventEmitter();
      installBrowserLoad(contents);
      contents.isLoading = () => false;
      contents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
      contents.setWindowOpenHandler = () => {};
      contents.close = () => {};
      this.webContents = contents;
    }
  }
  const browser = createInternalBrowser({
    isDestroyed: () => false,
    webContents: { send(channel, state) { if (channel === 'internal-browser:state') states.push(state); } },
  }, { WebContentsView: View, session: { fromPartition: () => session }, dialog: { showMessageBoxSync: () => 1 } });
  browser.navigate('https://example.com/a', false, 1);
  return { browser, contents, session, states };
}

function emitLoaderEvents(contents, loaderId, url, frameId = 'main') {
  contents.debugger.emit('message', {}, 'Page.frameNavigated', { frame: { id: frameId, loaderId, url } });
  contents.debugger.emit('message', {}, 'Page.lifecycleEvent', { name: 'load', loaderId, frameId });
}

function emitOldEvents(contents, url) {
  contents.emit('did-start-navigation', {}, url, false, true, 12, 34);
  contents.emit('will-redirect', { url, isMainFrame: true, preventDefault() { assert.fail('HTTP redirect is allowed'); } });
  contents.emit('did-fail-load', {}, -105, 'old failure', url, true, 12, 34);
  contents.emit('did-navigate', {}, url);
  contents.emit('did-navigate-in-page', {}, `${url}#old`, true, 12, 34);
}

for (const result of ['completed', 'cancelled', 'download-blocked', 'failed']) {
  test(`${result} の終了後も旧イベントと旧コマンド応答が要求結果を変更しない`, async () => {
    const { browser, contents, session, states } = setup();
    await flushBrowserLoads();
    const old = contents.loads[0];
    browser.navigate('https://example.com/b', false, 2);
    await flushBrowserLoads();
    const current = contents.loads[1];
    if (result === 'completed') await contents.complete('https://example.com/b');
    else if (result === 'failed') await contents.fail(-105, 'https://example.com/b');
    else if (result === 'cancelled') contents.emit('will-prevent-unload', { preventDefault() { assert.fail('stay on page'); } });
    else {
      session.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['HTTPS://EXAMPLE.COM:443/b'] });
      await contents.download();
    }
    const expected = { ...states.at(-1) };
    assert.equal(expected.navigationResult, result);
    assert.equal(expected.navigationRequestId, 2);
    // 別 URL と同じ URL のイベントを、終了後にも繰り返し配送する。
    emitOldEvents(contents, 'https://example.com/a');
    emitOldEvents(contents, 'https://example.com/b');
    emitLoaderEvents(contents, old.loaderId, old.url);
    contents.emit('will-prevent-unload', { preventDefault() {} });
    old.resolve({ frameId: 'main', loaderId: old.loaderId });
    current.reject(Object.assign(new Error('late failure'), { errno: -105 }));
    await flushBrowserLoads();
    browser.publish();
    assert.deepEqual(states.at(-1), expected);
  });
}

for (const oldResult of ['resolve', 'reject']) {
  test(`同一 URL の連続 Enter は旧コマンドの ${oldResult} と旧イベントで終了しない`, async () => {
    const { browser, contents, states } = setup();
    await flushBrowserLoads();
    const old = contents.loads[0];
    let stops = 0;
    // 旧コマンドの応答が遅れても、新要求は異なる loader で追跡する。
    contents.stop = () => { stops++; };
    browser.navigate('https://example.com/a', false, 2);
    assert.equal(stops, 1);
    await flushBrowserLoads();
    assert.equal(contents.loads.length, 2);
    emitOldEvents(contents, 'https://example.com/a');
    emitLoaderEvents(contents, old.loaderId, old.url);
    assert.equal(states.at(-1).navigationResult, null);
    assert.equal(states.at(-1).navigationRequestId, 2);
    old[oldResult](oldResult === 'resolve' ? { frameId: 'main', loaderId: old.loaderId } : new Error('old failure'));
    await flushBrowserLoads();
    assert.equal(contents.loads.length, 2);
    emitOldEvents(contents, 'https://example.com/a');
    emitLoaderEvents(contents, old.loaderId, old.url);
    assert.equal(states.at(-1).navigationResult, null);
    assert.equal(states.at(-1).failedUrl, '');
    await contents.complete('https://example.com/a');
    assert.equal(states.at(-1).navigationResult, 'completed');
    assert.equal(states.at(-1).navigationRequestId, 2);
    assert.equal(states.filter(state => state.navigationRequestId === 1 && state.navigationResult === 'superseded').length, 1);
  });
}

test('B 開始後の旧 redirect と終了を取り込まず、B 自身の正常 redirect を完了する', async () => {
  const { browser, contents, states } = setup();
  await flushBrowserLoads();
  const old = contents.loads[0];
  browser.navigate('https://bücher.example:443/start', false, 2);
  await flushBrowserLoads();
  contents.emit('did-start-navigation', { url: 'https://xn--bcher-kva.example/start', isMainFrame: true }, 'https://xn--bcher-kva.example/start', false, true);
  emitOldEvents(contents, 'https://old.example/redirect');
  emitLoaderEvents(contents, old.loaderId, 'https://old.example/redirect');
  old.resolve({ frameId: 'main', loaderId: old.loaderId });
  assert.equal(states.at(-1).pendingUrl, 'https://bücher.example:443/start');
  assert.equal(states.at(-1).url, '');
  assert.equal(states.at(-1).failedUrl, '');
  contents.emit('will-redirect', { url: 'https://bücher.example:443/final', isMainFrame: true });
  await contents.complete('https://bücher.example:443/final');
  assert.equal(states.at(-1).url, 'https://xn--bcher-kva.example/final');
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).navigationRequestId, 2);
});

test('待機中の B を C が置き換えた場合も B を開始せず、superseded の記録を保持する', async () => {
  const { browser, contents, states } = setup();
  await flushBrowserLoads();
  const old = contents.loads[0];
  contents.stop = () => {};
  browser.navigate('https://example.com/b', false, 2);
  browser.navigate('https://example.com/c', false, 3);
  const superseded = states.find(state => state.navigationRequestId === 2 && state.navigationResult === 'superseded');
  assert.ok(superseded);
  old.reject(new Error('stopped'));
  await flushBrowserLoads();
  assert.deepEqual(contents.loads.map(load => load.url), ['https://example.com/a', 'https://example.com/c']);
  emitOldEvents(contents, 'https://example.com/b');
  assert.equal(states.at(-1).navigationResult, null);
  assert.equal(states.at(-1).navigationRequestId, 3);
  assert.equal(states.filter(state => state.navigationRequestId === 2 && state.navigationResult === 'superseded').length, 1);
  await contents.complete('https://example.com/c');
  assert.equal(states.at(-1).url, 'https://example.com/c');
});

test('Enter 完了後の本物の hash/pushState は現在の文書から反映し、旧イベントでは巻き戻さない', async () => {
  const { browser, contents, states } = setup();
  await contents.complete('https://example.com/a');
  contents.commitInPage('https://example.com/a#new');
  assert.equal(states.at(-1).url, 'https://example.com/a#new');
  emitOldEvents(contents, 'https://example.com/a');
  browser.publish();
  assert.equal(states.at(-1).url, 'https://example.com/a#new');
  assert.equal(states.at(-1).navigationResult, 'completed');
});

test('CDP 応答後に届く同一フレームの旧 loader の完了も新要求へ帰属しない', async () => {
  const { browser, contents, states } = setup();
  await flushBrowserLoads();
  const old = contents.loads[0];
  browser.navigate(old.url, false, 2);
  await flushBrowserLoads();
  const current = contents.loads[1];
  current.resolve({ frameId: 'main', loaderId: current.loaderId });
  await flushBrowserLoads();
  emitLoaderEvents(contents, old.loaderId, old.url);
  contents.emit('did-fail-load', {}, -105, 'old failure', old.url, true);
  assert.equal(states.at(-1).navigationResult, null);
  // loader が一致しても、別フレームの完了は採用しない。
  emitLoaderEvents(contents, current.loaderId, current.url, 'subframe');
  assert.equal(states.at(-1).navigationResult, null);
  emitLoaderEvents(contents, current.loaderId, current.url);
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).navigationRequestId, 2);
});

test('CDP が loaderId を返さない同一文書遷移もコマンド応答で一度だけ終了する', async () => {
  const { browser, contents, states } = setup();
  await contents.complete('https://example.com/a');
  browser.navigate('https://example.com/a#next', false, 2);
  await flushBrowserLoads();
  contents.commitInPage('https://example.com/a#next');
  assert.equal(states.at(-1).navigationResult, null);
  contents.loads.at(-1).resolve({ frameId: 'main' });
  await flushBrowserLoads();
  assert.equal(states.at(-1).url, 'https://example.com/a#next');
  assert.equal(states.at(-1).navigationResult, 'completed');
});

test('ダウンロード応答と debugger の切断を明示的に処理する', async () => {
  const { browser, contents, session, states } = setup();
  await flushBrowserLoads();
  contents.loads[0].resolve({ frameId: 'main', isDownload: true });
  await flushBrowserLoads();
  assert.equal(states.at(-1).navigationResult, null);
  session.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/a'] });
  assert.equal(states.at(-1).navigationResult, 'download-blocked');
  browser.navigate('https://example.com/b', false, 2);
  await flushBrowserLoads();
  contents.debugger.emit('detach', {}, 'target closed');
  assert.equal(states.at(-1).navigationResult, 'failed');
  assert.equal(states.at(-1).navigationRequestId, 2);
});

test('同一 URL の旧 download は現在のコマンドが download を返すまで要求を終了しない', async () => {
  const { browser, contents, session, states } = setup();
  await flushBrowserLoads();
  browser.navigate('https://example.com/a', false, 2);
  await flushBrowserLoads();
  session.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/a'] });
  assert.equal(states.at(-1).navigationResult, null);
  assert.equal(states.at(-1).downloadUrl, '');
  await contents.complete('https://example.com/a');
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).navigationRequestId, 2);
});
