'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInternalBrowser } = require('../utils/internalBrowser');
const { installBrowserLoad, flushBrowserLoads } = require('./helpers/browserLoad');
const { prepareLoadingPageNavigation, navigateFromLoadingPage } = require('./helpers/pageNavigation');

function setup({ failCommand, failAttach = false, bootstrap, createBrowser = createInternalBrowser } = {}) {
  const states = [];
  const messages = [];
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  session.webRequest = { onBeforeRequest() {}, onCompleted() {} };
  let contents;
  class View {
    constructor() {
      contents = new EventEmitter();
      installBrowserLoad(contents);
      if (bootstrap) {
        const loadURL = contents.loadURL;
        contents.loadURL = url => bootstrap(loadURL, url);
      }
      const sendCommand = contents.debugger.sendCommand;
      contents.debugger.sendCommand = (method, params) => method === failCommand
        ? Promise.reject(new Error('initialization failed')) : sendCommand(method, params);
      if (failAttach) contents.debugger.attach = () => { throw new Error('attach failed'); };
      contents.isLoading = () => false;
      contents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
      contents.setWindowOpenHandler = handler => { contents.openHandler = handler; };
      contents.close = () => {};
      this.webContents = contents;
    }
  }
  const browser = createBrowser({
    isDestroyed: () => false,
    webContents: { send(channel, state) { messages.push({ channel, state }); if (channel === 'internal-browser:state') states.push(state); } },
  }, { WebContentsView: View, session: { fromPartition: () => session }, dialog: { showMessageBoxSync: () => 1 } });
  browser.navigate('https://example.com/a', false, 1);
  return { browser, contents, session, states, messages };
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

test('空のWebContentsを初期化してから監視を有効化し、ローカルHTTPも実文書のloadで完了する', async () => {
  let release;
  const { browser, contents, states } = setup({ bootstrap: (loadURL, url) => new Promise(resolve => {
    assert.equal(url, 'about:blank');
    release = () => resolve(loadURL(url));
  }) });
  await flushBrowserLoads();
  assert.equal(contents.getURL(), '');
  assert.deepEqual(contents.commands, []);
  browser.navigate('http://127.0.0.1:12345/source', false, 2);
  release();
  await flushBrowserLoads();
  assert.deepEqual(contents.commands, ['Page.enable', 'Page.setLifecycleEventsEnabled', 'Network.enable', 'Page.getFrameTree', 'Page.navigate']);
  assert.equal(contents.loads.length, 1);
  const load = contents.loads[0];
  emitLoaderEvents(contents, 'initial', 'about:blank');
  contents.debugger.emit('message', {}, 'Page.loadEventFired', { timestamp: 1 });
  contents.debugger.emit('message', {}, 'Page.frameStoppedLoading', { frameId: 'main' });
  assert.equal(states.at(-1).navigationResult, null);
  load.resolve({ frameId: load.frameId, loaderId: load.loaderId });
  await flushBrowserLoads();
  assert.equal(states.at(-1).navigationResult, null);
  await contents.complete(load.url);
  assert.equal(contents.getURL(), load.url);
  assert.equal(states.at(-1).url, load.url);
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).navigationRequestId, 2);
  assert.equal(states.at(-1).pendingUrl, '');
});

for (const outcome of ['completed', 'replaced', 'failed', 'destroy', 'detach', 'destroyed']) {
  test(`初期化待ちの複数 reload は元の要求を保持する: ${outcome}`, async () => {
    let release;
    let rejectBootstrap;
    const { browser, contents, states } = setup({ bootstrap: (loadURL, url) => new Promise((resolve, reject) => {
      release = () => resolve(loadURL(url));
      rejectBootstrap = reject;
    }) });
    contents.reload = () => assert.fail('bootstrap must not be reloaded');
    for (let i = 0; i < 3; i++) assert.equal(browser.action('reload'), false);
    assert.equal(states.at(-1).pendingUrl, 'https://example.com/a');
    assert.equal(states.at(-1).navigationRequestId, 1);
    assert.equal(states.at(-1).navigationResult, null);
    let target = 'https://example.com/a';
    let requestId = 1;
    if (outcome === 'replaced') {
      target = 'https://example.com/replacement';
      requestId = 2;
      browser.navigate(target, false, requestId);
      assert.equal(browser.action('reload'), false);
      assert.ok(states.some(state => state.navigationRequestId === 1 && state.navigationResult === 'superseded'));
    }
    if (outcome === 'destroy') browser.destroy();
    if (outcome === 'detach') contents.debugger.emit('detach');
    if (outcome === 'destroyed') { contents.isDestroyed = () => true; contents.emit('destroyed'); }
    if (outcome === 'failed') rejectBootstrap(new Error('bootstrap failed'));
    else release();
    await flushBrowserLoads();
    emitLoaderEvents(contents, 'initial', 'about:blank');
    contents.emit('did-navigate-in-page', {}, 'about:blank', true);
    if (outcome === 'completed' || outcome === 'replaced') {
      assert.deepEqual(contents.loads.map(load => load.url), [target]);
      assert.equal(states.at(-1).pendingUrl, target);
      assert.equal(states.at(-1).navigationResult, null);
      await contents.complete(target);
      assert.equal(states.at(-1).url, target);
      assert.equal(states.at(-1).navigationRequestId, requestId);
      assert.equal(states.at(-1).navigationResult, 'completed');
    } else {
      assert.equal(contents.loads.length, 0);
      assert.deepEqual(contents.commands, []);
      if (outcome !== 'destroy') {
        assert.equal(states.at(-1).navigationResult, 'failed');
        assert.equal(states.at(-1).failedUrl, target);
      }
    }
    assert.ok(states.every(state => ![state.url, state.failedUrl, state.downloadUrl, state.pendingUrl].includes('about:blank')));
  });
}

test('空文書の commit/load は一致する loader でも完了 URL にしない', async () => {
  const { contents, states } = setup();
  await flushBrowserLoads();
  const load = contents.loads[0];
  load.resolve({ frameId: load.frameId, loaderId: load.loaderId });
  await flushBrowserLoads();
  emitLoaderEvents(contents, load.loaderId, 'about:blank');
  assert.equal(states.at(-1).url, '');
  assert.equal(states.at(-1).navigationResult, null);
  assert.equal(states.at(-1).pendingUrl, load.url);
  await contents.complete(load.url);
  assert.equal(states.at(-1).url, load.url);
  assert.equal(states.at(-1).navigationResult, 'completed');
});

test('空文書の初期化失敗を要求の失敗として公開し、対象URLを開かない', async () => {
  const { contents, states } = setup({ bootstrap: () => Promise.reject(new Error('bootstrap failed')) });
  await flushBrowserLoads();
  assert.equal(states.at(-1).navigationResult, 'failed');
  assert.equal(states.at(-1).failedUrl, 'https://example.com/a');
  assert.deepEqual(contents.commands, []);
});

for (const end of ['destroy', 'detach', 'destroyed']) {
  test(`空文書の応答待ち中の${end}後はCDPを開始しない`, async () => {
    let release;
    const { browser, contents, states } = setup({ bootstrap: (loadURL, url) => new Promise(resolve => {
      release = () => resolve(loadURL(url));
    }) });
    if (end === 'destroy') browser.destroy();
    else if (end === 'detach') contents.debugger.emit('detach');
    else { contents.isDestroyed = () => true; contents.emit('destroyed'); }
    release();
    await flushBrowserLoads();
    assert.deepEqual(contents.commands, []);
    assert.equal(contents.loads.length, 0);
    if (end !== 'destroy') assert.equal(states.at(-1).navigationResult, 'failed');
  });
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
  assert.equal(states.at(-1).navigationResult, 'download-blocked');
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

test('旧CDP中止応答がwill-navigateより先なら旧要求をcancelledで一度だけ終了する', async () => {
  const { browser, contents, states } = setup();
  await contents.complete('https://example.com/a');
  browser.navigate('https://example.com/slow', false, 2);
  await flushBrowserLoads();
  const old = contents.loads.at(-1);
  const pending = states.at(-1);
  assert.equal(pending.navigationRequestId, 2);
  assert.equal(pending.pendingUrl, old.url);
  assert.equal(pending.navigationResult, null);
  // 実CDPはページ起点の置換をwill-navigateより先にERR_ABORTEDで返せる。
  // 応答を保留しないテストでは、この順序をsupersededと同一視しない。
  old.resolve({ frameId: 'main', errorText: 'net::ERR_ABORTED' });
  await flushBrowserLoads();
  assert.equal(states.at(-1).navigationResult, 'cancelled');
  assert.equal(states.at(-1).navigationRequestId, 2);
  contents.stop = () => assert.fail('ページ起点の新遷移を止めない');
  const url = 'https://example.com/destination';
  contents.emit('will-navigate', { url });
  contents.startNative(url, 'native-after-abort');
  contents.emit('did-start-loading');
  assert.equal(states.at(-1).navigationOperationId, pending.navigationOperationId + 1);
  assert.equal(states.at(-1).navigationRequestId, null);
  assert.equal(states.at(-1).navigationResult, null);
  emitLoaderEvents(contents, old.loaderId, old.url);
  assert.equal(states.at(-1).navigationResult, null);
  contents.commitDocument(url, 'native-after-abort');
  contents.loadDocument('native-after-abort');
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).url, url);
  assert.equal(states.at(-1).navigationRequestId, null);
  assert.deepEqual(states.filter(state => state.navigationOperationId === pending.navigationOperationId
    && state.navigationResult !== null).map(state => state.navigationResult), ['cancelled']);
});

for (const trigger of ['link', 'location.replace']) {
  for (const oldResponseFirst of [false, true]) {
    test(`${trigger} による保留ロードの置換を完了する: 旧応答先行=${oldResponseFirst}`, async () => {
      const { browser, contents, states } = setup();
      await contents.complete('https://example.com/a');
      let loading = false;
      let navigationCount = 0;
      let stopped = 0;
      let focused = false;
      const handlers = new Set();
      const inputs = [];
      const steps = [];
      contents.isLoading = () => loading;
      const startNavigation = (relative, actualTrigger) => {
        assert.equal(loading, true, '発火は保留ロード中だけ');
        assert.equal(actualTrigger, trigger);
        navigationCount++;
        assert.equal(relative, '/destination');
        const url = new URL(relative, contents.getURL()).href;
        contents.emit('will-navigate', { url });
        contents.startNative(url, 'native-page');
      };
      const renderer = {
        window: {
          addEventListener(type, handler, capture) {
            assert.equal(type, 'keydown');
            assert.equal(capture, true);
            handlers.add(handler);
          },
          removeEventListener(type, handler, capture) {
            assert.equal(type, 'keydown');
            assert.equal(capture, true);
            assert.equal(handlers.delete(handler), true);
          },
        },
        document: { getElementById(id) {
          assert.equal(id, 'link');
          return { click: () => startNavigation('/destination', 'link') };
        } },
        location: { replace: relative => startNavigation(relative, 'location.replace') },
      };
      contents.executeJavaScript = async expression => {
        assert.equal(loading, false, 'ロード中の executeJavaScript を禁止');
        steps.push('prepare');
        return require('node:vm').runInNewContext(expression, renderer);
      };
      const dispatch = code => {
        for (const handler of [...handlers]) handler({ code, preventDefault() {} });
      };
      await prepareLoadingPageNavigation(contents, trigger);
      assert.equal(handlers.size, 1);
      dispatch('F7');
      assert.equal(handlers.size, 1, '別キーでは一回限りの操作を消費しない');
      assert.equal(navigationCount, 0);
      browser.navigate('https://example.com/slow', false, 2);
      await flushBrowserLoads();
      loading = true;
      steps.push('loading');
      contents.stop = () => { stopped++; };
      const old = contents.loads.at(-1);
      contents.focus = () => {
        assert.equal(loading, true);
        focused = true;
        steps.push('focus');
      };
      const sendCommand = contents.debugger.sendCommand;
      contents.debugger.sendCommand = (method, params) => {
        assert.notEqual(method, 'Runtime.evaluate', 'ロード中の Runtime 評価を禁止');
        if (method !== 'Input.dispatchKeyEvent') return sendCommand(method, params);
        assert.equal(loading, true);
        assert.equal(focused, true);
        assert.deepEqual(params, {
          type: inputs.length === 0 ? 'keyDown' : 'keyUp',
          key: 'F8', code: 'F8', windowsVirtualKeyCode: 119,
        });
        inputs.push(params.type);
        steps.push(params.type);
        if (params.type === 'keyDown') dispatch(params.code);
        return Promise.resolve({});
      };
      const abortOld = async () => {
        old.resolve({ frameId: 'main', loaderId: old.loaderId, errorText: 'net::ERR_ABORTED' });
        await flushBrowserLoads();
      };
      assert.equal(states.at(-1).navigationRequestId, 2);
      assert.equal(states.at(-1).navigationResult, null);
      const pendingOperation = states.at(-1).navigationOperationId;
      await navigateFromLoadingPage(contents);
      assert.deepEqual(steps, ['prepare', 'loading', 'focus', 'keyDown', 'keyUp']);
      assert.equal(navigationCount, 1);
      assert.equal(handlers.size, 0, '遷移開始前にハンドラーを解除する');
      dispatch('F8');
      assert.equal(navigationCount, 1, '繰り返し入力でも発火は一回だけ');
      const operation = states.at(-1).navigationOperationId;
      assert.equal(stopped, 0);
      assert.equal(states.at(-1).navigationRequestId, null);
      assert.equal(operation, pendingOperation + 1);
      assert.deepEqual(states.filter(state => state.navigationOperationId === pendingOperation
        && state.navigationResult !== null).map(state => ({
        requestId: state.navigationRequestId, pendingUrl: state.pendingUrl,
        url: state.url, result: state.navigationResult,
      })), [{
        requestId: 2, pendingUrl: old.url, url: 'https://example.com/a', result: 'superseded',
      }]);
      if (oldResponseFirst) await abortOld();
      emitLoaderEvents(contents, old.loaderId, old.url);
      contents.respond(old.loaderId, 'https://github.com/old', 404);
      assert.equal(states.at(-1).navigationResult, null);
      contents.commitDocument('https://example.com/destination', 'native-page');
      contents.loadDocument('native-page');
      loading = false;
      contents.emit('did-stop-loading');
      if (!oldResponseFirst) await abortOld();
      assert.equal(states.at(-1).navigationResult, 'completed');
      assert.equal(states.at(-1).url, 'https://example.com/destination');
      assert.equal(states.at(-1).github404Url, '');
      assert.equal(states.at(-1).navigationOperationId, operation);
      browser.publish();
      assert.equal(stopped, 0);
    });
  }
}

for (const canonical of ['https://example.com/canonical', 'https://example.com/a#hash']) {
  for (const responseFirst of [true, false]) {
    test(`load 前の canonical 更新を確定する: ${canonical}, 応答先行=${responseFirst}`, async () => {
      const { contents, states } = setup();
      await flushBrowserLoads();
      const load = contents.loads[0];
      if (responseFirst) {
        load.resolve({ loaderId: load.loaderId, frameId: 'main' });
        await flushBrowserLoads();
      }
      contents.commitDocument(load.url, load.loaderId);
      contents.commitInPage(canonical);
      // 旧 URL の Electron / CDP 同一文書通知は現在 URL を巻き戻さない。
      contents.emit('did-navigate-in-page', {}, 'https://example.com/old', true);
      contents.debugger.emit('message', {}, 'Page.navigatedWithinDocument', { frameId: 'main', url: load.url });
      assert.equal(states.at(-1).navigationResult, null);
      contents.loadDocument(load.loaderId);
      load.resolve({ loaderId: load.loaderId, frameId: 'main' });
      await flushBrowserLoads();
      assert.equal(states.at(-1).navigationResult, 'completed');
      assert.equal(states.at(-1).url, canonical);
    });
  }
}

for (const via of ['window.open', 'target=_blank']) {
  for (const noticeFirst of [true, false]) {
    test(`${via} download は isDownload と通知の到着順によらず終了: 通知先行=${noticeFirst}`, async () => {
      const { contents, session, states, messages } = setup();
      await contents.complete('https://example.com/a');
      await flushBrowserLoads();
      contents.openHandler({ url: 'https://example.com/download' });
      const operation = states.at(-1).navigationOperationId;
      assert.equal(states.at(-1).pendingUrl, '');
      await flushBrowserLoads();
      const notice = () => session.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/download'] });
      if (noticeFirst) notice();
      await contents.download();
      if (!noticeFirst) notice();
      assert.equal(states.at(-1).navigationResult, 'download-blocked');
      assert.equal(states.at(-1).downloadUrl, '');
      assert.equal(states.at(-1).url, 'https://example.com/a');
      assert.deepEqual(notices(messages).map(message => message.state), [{ canOpenFromToolbar: false }]);
      assert.equal(states.at(-1).navigationOperationId, operation);
      assert.equal(states.at(-1).navigationRequestId, null);
    });
  }
}

test('同一URLの旧download通知・旧isDownload応答は新しい世代を終了しない', async () => {
  const { contents, states, session } = setup();
  await flushBrowserLoads();
  const old = contents.loads[0];
  contents.stop = () => {};
  contents.openHandler({ url: old.url });
  await flushBrowserLoads();
  const operation = states.at(-1).navigationOperationId;
  session.emit('will-download', { preventDefault() {} }, { getURLChain: () => [old.url] });
  old.resolve({ frameId: 'main', isDownload: true });
  await flushBrowserLoads();
  assert.equal(states.at(-1).navigationResult, null);
  assert.equal(states.at(-1).downloadUrl, '');
  await contents.complete(old.url);
  assert.equal(states.at(-1).navigationOperationId, operation);
  assert.equal(states.at(-1).navigationResult, 'completed');
});

for (const responseFirst of [true, false]) {
  test(`同一URLの連続要求で404を文書loaderへ限定する: 応答先行=${responseFirst}`, async () => {
    const { browser, contents, states } = setup();
    browser.navigate('https://github.com/missing', false, 2);
    await flushBrowserLoads();
    const old = contents.loads.at(-1);
    await contents.complete(old.url);
    browser.navigate(old.url, false, 3);
    await flushBrowserLoads();
    const next = contents.loads.at(-1);
    next.resolve({ frameId: 'main', loaderId: next.loaderId });
    await flushBrowserLoads();
    contents.respond(old.loaderId, old.url, 404);
    assert.equal(states.at(-1).github404Url, '');
    if (responseFirst) contents.respond(next.loaderId, next.url, 404);
    contents.commitDocument(next.url, next.loaderId);
    contents.loadDocument(next.loaderId);
    if (!responseFirst) contents.respond(next.loaderId, next.url, 404);
    assert.equal(states.at(-1).github404Url, next.url);
    contents.respond(old.loaderId, old.url, 200);
    contents.respond(next.loaderId, 'https://github.com/subframe', 404, 'subframe');
    assert.equal(states.at(-1).github404Url, next.url);
    browser.navigate(next.url, false, 4);
    await contents.complete(next.url);
    contents.respond(old.loaderId, old.url, 404);
    contents.respond(next.loaderId, next.url, 404);
    assert.equal(states.at(-1).github404Url, '');
  });
}

for (const action of ['back', 'forward', 'reload', 'page', 'url-only']) {
  for (const result of ['completed', 'cancelled', 'failed']) {
    test(`${action} の新世代は開始と ${result} を公開する`, async () => {
      const { browser, contents, states } = setup();
      await contents.complete('https://example.com/a');
      const previous = states.at(-1).navigationOperationId;
      const target = 'https://example.com/next';
      if (action === 'url-only') browser.navigate(target);
      else if (action === 'page') contents.emit('will-navigate', { url: target });
      else {
        contents.navigationHistory.canGoBack = contents.navigationHistory.canGoForward = () => true;
        contents.navigationHistory.goBack = contents.navigationHistory.goForward = () => {};
        contents.reload = () => {};
        browser.action(action);
      }
      const operation = states.at(-1).navigationOperationId;
      assert.ok(operation > previous);
      assert.equal(states.at(-1).navigationRequestId, null);
      assert.equal(states.at(-1).navigationResult, null);
      if (action === 'url-only') {
        if (result === 'completed') await contents.complete(target);
        else await contents.fail(result === 'cancelled' ? -3 : -105, target);
      } else {
        contents.startNative(target, 'native-result');
        if (result === 'completed') {
          contents.commitDocument(target, 'native-result');
          contents.loadDocument('native-result');
        } else contents.debugger.emit('message', {}, 'Network.loadingFailed', {
          requestId: 'request-native-result', type: 'Document', canceled: result === 'cancelled', errorText: 'net::ERR_NAME_NOT_RESOLVED',
        });
      }
      assert.equal(states.at(-1).navigationOperationId, operation);
      assert.equal(states.at(-1).navigationResult, result);
      if (result === 'failed') assert.equal(states.at(-1).failedUrl, target);
    });
  }
}

test('同一文書の戻る操作とBFCache復元も操作世代を終了する', async () => {
  const { browser, contents, states } = setup();
  await contents.complete('https://example.com/a');
  const document = contents.loads[0];
  contents.navigationHistory.canGoBack = () => true;
  contents.navigationHistory.goBack = () => {};
  browser.action('back');
  contents.debugger.emit('message', {}, 'Page.frameStartedNavigating', {
    frameId: 'main', loaderId: document.loaderId, url: 'https://example.com/a#back', navigationType: 'historySameDocument',
  });
  contents.commitInPage('https://example.com/a#back');
  assert.equal(states.at(-1).navigationResult, 'completed');
  browser.action('back');
  contents.startNative(document.url, document.loaderId);
  contents.commitDocument(document.url, document.loaderId, 'BackForwardCacheRestore');
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).url, document.url);
});

test('履歴復帰でCDPのloadイベントが欠けてもdid-navigateで操作を完了する', async () => {
  const { browser, contents, states } = setup();
  await contents.complete('https://example.com/a');
  contents.navigationHistory.canGoBack = () => true;
  contents.navigationHistory.goBack = () => {
    contents.setDocumentUrl('https://example.com/previous');
    contents.emit('did-navigate', {}, contents.getURL());
  };

  assert.equal(browser.action('back'), true);
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).url, 'https://example.com/previous');
  assert.equal(states.at(-1).pendingUrl, '');
});

test('案内からの履歴復帰でdid-navigateも欠けた場合はdid-stop-loadingで完了する', async () => {
  const { browser, contents, states } = setup();
  await contents.complete('https://example.com/a');
  let staleStopResult;
  contents.navigationHistory.canGoBack = () => true;
  contents.navigationHistory.getActiveIndex = () => 1;
  contents.navigationHistory.getAllEntries = () => [
    { url: 'https://example.com/previous' },
    { url: 'vk-terminals-help://guide/' },
  ];
  contents.navigationHistory.goBack = () => {
    contents.emit('did-stop-loading');
    staleStopResult = states.at(-1).navigationResult;
    contents.setDocumentUrl('https://example.com/previous');
    contents.emit('did-stop-loading');
  };

  assert.equal(browser.action('back'), true);
  assert.equal(staleStopResult, null);
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).url, 'https://example.com/previous');
});

for (const failCommand of ['Page.enable', 'Page.setLifecycleEventsEnabled', 'Network.enable', 'Page.getFrameTree']) {
  test(`${failCommand} の初期化失敗も操作を失敗として終了する`, async () => {
    const { browser, contents, states } = setup({ failCommand });
    await flushBrowserLoads();
    assert.equal(states.at(-1).navigationResult, 'failed');
    assert.equal(contents.loads.length, 0);
    browser.navigate('https://example.com/retry', false, 2);
    await flushBrowserLoads();
    assert.equal(states.at(-1).navigationResult, 'failed');
  });
}

test('attach失敗・destroy・detach後の操作を未完了のままにしない', async () => {
  const failed = setup({ failAttach: true });
  await flushBrowserLoads();
  assert.equal(failed.states.at(-1).navigationResult, 'failed');
  const { browser, contents, states } = setup();
  await flushBrowserLoads();
  contents.debugger.emit('detach');
  browser.navigate('https://example.com/retry', false, 2);
  await flushBrowserLoads();
  assert.equal(states.at(-1).navigationResult, 'failed');
  const live = setup();
  live.browser.destroy();
  await flushBrowserLoads();
  assert.equal(live.contents.loads.length, 0);
});

test('GitHub 404の現在文書はhash更新後も維持し、subframeの応答を採用しない', async () => {
  const { browser, contents, states } = setup();
  browser.navigate('https://github.com/missing');
  await flushBrowserLoads();
  const load = contents.loads.at(-1);
  contents.respond(load.loaderId, load.url, 404);
  contents.respond(load.loaderId, 'https://github.com/subframe', 200, 'subframe');
  await contents.complete(load.url);
  assert.equal(states.at(-1).github404Url, load.url);
  contents.commitInPage(`${load.url}#hash`);
  assert.equal(states.at(-1).github404Url, load.url);
  contents.respond('old-loader', load.url, 404);
  assert.equal(states.at(-1).url, `${load.url}#hash`);
  assert.equal(states.at(-1).github404Url, load.url);
});

test('WebContents破棄時は破棄済みAPIを呼ばず失敗結果を公開する', async () => {
  const { browser, contents, states } = setup();
  await flushBrowserLoads();
  contents.isDestroyed = () => true;
  contents.isLoading = () => { throw new Error('Object has been destroyed'); };
  contents.emit('destroyed');
  assert.equal(states.at(-1).navigationResult, 'failed');
  assert.equal(states.at(-1).loading, false);
  assert.equal(browser.action('reload'), false);
});

// 通知は実際の DownloadItem に相当する同じオブジェクトで配送する。
function downloadNotice(session, url, contents) {
  const item = { getURLChain: () => [url] };
  const emit = () => session.emit('will-download', { preventDefault() {} }, item, contents);
  emit();
  return emit;
}
const notices = messages => messages.filter(message => message.channel === 'internal-browser:download-blocked');

for (const noticeFirst of [true, false]) {
  test(`現在操作の通知はstate公開後にtrueを一度だけ送る: 通知先行=${noticeFirst}`, async () => {
    const { browser, contents, session, states, messages } = setup();
    await flushBrowserLoads();
    let repeat;
    if (noticeFirst) {
      repeat = downloadNotice(session, 'HTTPS://EXAMPLE.COM:443/a', contents);
      assert.equal(notices(messages).length, 0);
      assert.equal(states.at(-1).navigationResult, null);
    }
    await contents.download();
    if (!noticeFirst) repeat = downloadNotice(session, 'https://example.com/a', contents);
    assert.deepEqual(notices(messages).map(message => message.state), [{ canOpenFromToolbar: true }]);
    const toastIndex = messages.findIndex(message => message.channel === 'internal-browser:download-blocked');
    assert.equal(messages[toastIndex - 1].state.navigationResult, 'download-blocked');
    assert.equal(messages[toastIndex - 1].state.downloadUrl, 'https://example.com/a');
    repeat();
    browser.publish();
    assert.equal(notices(messages).length, 1);
  });
}

for (const result of ['superseded', 'completed', 'failed', 'cancelled', 'detached', 'destroyed']) {
  test(`未確定の保留通知を${result}でfalseとして一度だけ解放する`, async () => {
    const { browser, contents, session, messages } = setup();
    await flushBrowserLoads();
    const repeat = downloadNotice(session, 'https://example.com/a', contents);
    assert.equal(notices(messages).length, 0);
    if (result === 'superseded') browser.navigate('https://example.com/b', false, 2);
    else if (result === 'completed') await contents.complete('https://example.com/a');
    else if (result === 'failed') await contents.fail(-105, 'https://example.com/a');
    else if (result === 'cancelled') await contents.fail(-3, 'https://example.com/a');
    else if (result === 'detached') contents.debugger.emit('detach');
    else browser.destroy();
    repeat();
    assert.deepEqual(notices(messages).map(message => message.state), [{ canOpenFromToolbar: false }]);
  });
}

for (const oldResponseFirst of [true, false]) {
  test(`同一URLの旧downloadは新世代に帰属しない: 旧応答先行=${oldResponseFirst}`, async () => {
    const { browser, contents, session, states, messages } = setup();
    await flushBrowserLoads();
    const old = contents.loads[0];
    contents.stop = () => {};
    browser.navigate(old.url, false, 2);
    await flushBrowserLoads();
    if (oldResponseFirst) {
      old.resolve({ frameId: 'main', isDownload: true });
      await flushBrowserLoads();
    }
    downloadNotice(session, old.url, contents);
    if (!oldResponseFirst) {
      old.resolve({ frameId: 'main', isDownload: true });
      await flushBrowserLoads();
    }
    assert.equal(states.at(-1).downloadUrl, '');
    assert.equal(states.at(-1).navigationResult, null);
    assert.deepEqual(notices(messages).map(message => message.state), [{ canOpenFromToolbar: false }]);
    await contents.complete(old.url);
    assert.equal(states.at(-1).navigationResult, 'completed');
    assert.equal(notices(messages).length, 1);
  });
}

test('無関係・別contents・完了後のdownloadはfalseで操作を変更しない', async () => {
  const { contents, session, states, messages } = setup();
  await flushBrowserLoads();
  downloadNotice(session, 'https://example.com/other', contents);
  downloadNotice(session, 'https://example.com/a', {});
  assert.equal(states.at(-1).downloadUrl, '');
  assert.equal(states.at(-1).navigationResult, null);
  await contents.complete('https://example.com/a');
  downloadNotice(session, 'https://example.com/a', contents);
  assert.deepEqual(notices(messages).map(message => message.state), Array(3).fill({ canOpenFromToolbar: false }));
});

test('nativeのdownloadWillBeginだけではloader世代を確定せず一般案内を送る', async () => {
  const { contents, session, states, messages } = setup();
  await contents.complete('https://example.com/a');
  contents.emit('will-navigate', { url: 'https://example.com/native' });
  contents.startNative('https://example.com/native', 'native-download');
  contents.debugger.emit('message', {}, 'Page.downloadWillBegin', {
    frameId: 'main', guid: 'download-guid', url: 'https://example.com/native', suggestedFilename: 'file.zip',
  });
  downloadNotice(session, 'https://example.com/native', contents);
  assert.equal(states.at(-1).navigationResult, null);
  assert.equal(states.at(-1).downloadUrl, '');
  contents.debugger.emit('message', {}, 'Network.loadingFailed', {
    requestId: 'request-native-download', canceled: true, errorText: 'net::ERR_ABORTED',
  });
  assert.equal(states.at(-1).navigationResult, 'cancelled');
  assert.deepEqual(notices(messages).map(message => message.state), [{ canOpenFromToolbar: false }]);
});

test('配送済みdownloadの後に同一URLを再要求しても新しい通知を相関できる', async () => {
  const { browser, contents, session, messages } = setup();
  await flushBrowserLoads();
  downloadNotice(session, 'https://example.com/a', contents);
  await contents.download();
  browser.navigate('https://example.com/a', false, 2);
  await flushBrowserLoads();
  await contents.download();
  downloadNotice(session, 'https://example.com/a', contents);
  assert.deepEqual(notices(messages).map(message => message.state), Array(2).fill({ canOpenFromToolbar: true }));
});

// 終了した要求と現在文書を分離し、二つのイベント順序も両方確認する。
for (const result of ['completed', 'cancelled', 'failed', 'download-blocked', 'superseded']) {
  for (const electronFirst of [false, true]) {
    test(`${result}後の現在文書のhash/history更新を一世代だけ反映: Electron先行=${electronFirst}`, async () => {
      const { browser, contents, states } = setup();
      await contents.complete('https://example.com/a');
      if (result !== 'completed') {
        browser.navigate('https://example.com/b', false, 2);
        await flushBrowserLoads();
        if (result === 'download-blocked') await contents.download();
        else if (result === 'superseded') {
          browser.navigate('https://example.com/c', false, 3);
          await flushBrowserLoads();
          assert.ok(states.some(state => state.navigationResult === 'superseded'));
          await contents.fail(-3, 'https://example.com/c');
        } else await contents.fail(result === 'cancelled' ? -3 : -105, 'https://example.com/b');
      }
      for (const url of ['https://example.com/a#changed', 'https://example.com/history?push=1', 'https://example.com/a#changed']) {
        const operationId = states.at(-1).navigationOperationId;
        contents.setDocumentUrl(url);
        const cdp = () => contents.debugger.emit('message', {}, 'Page.navigatedWithinDocument', { frameId: 'main', url: 'https://stale.example/' });
        const electron = () => contents.emit('did-navigate-in-page', {}, 'https://stale.example/', true);
        if (electronFirst) { electron(); cdp(); } else { cdp(); electron(); }
        assert.equal(states.at(-1).url, url);
        assert.equal(states.at(-1).navigationOperationId, operationId + 1);
        assert.equal(states.at(-1).navigationResult, 'completed');
        assert.equal(states.at(-1).navigationRequestId, null);
        assert.equal(states.at(-1).downloadUrl, '');
        assert.equal(states.at(-1).failedUrl, '');
      }
    });
  }
}

for (const oldResponseFirst of [false, true]) {
  test(`複数同一URL候補の別itemを消費し三回目を汚染しない: 旧応答先行=${oldResponseFirst}`, async () => {
    const { browser, contents, session, states, messages } = setup();
    await flushBrowserLoads();
    const old = contents.loads[0];
    contents.stop = () => {};
    if (oldResponseFirst) await contents.download();
    browser.navigate(old.url, false, 2);
    await flushBrowserLoads();
    await contents.download();
    if (!oldResponseFirst) { old.resolve({ isDownload: true }); await flushBrowserLoads(); }
    const operationId = states.at(-1).navigationOperationId;
    downloadNotice(session, old.url, contents);
    downloadNotice(session, old.url, contents);
    assert.deepEqual(notices(messages).map(message => message.state), Array(2).fill({ canOpenFromToolbar: false }));
    assert.equal(states.at(-1).navigationOperationId, operationId);
    browser.navigate(old.url, false, 3);
    await flushBrowserLoads();
    downloadNotice(session, old.url, contents);
    await contents.download();
    assert.equal(notices(messages).at(-1).state.canOpenFromToolbar, true);
  });
}

test('通知欠落でも終了・置換した操作をSetに保持しない', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const sets = [];
  class ObservedSet extends Set { constructor(...args) { super(...args); sets.push(this); } }
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../utils/internalBrowser'), 'utf8'), {
    module, Set: ObservedSet, URL,
    require: name => name.startsWith('./') ? require(`../utils/${name.slice(2)}`) : require(name),
  });
  const { browser, contents } = setup({ createBrowser: module.exports.createInternalBrowser });
  await flushBrowserLoads();
  const retainedOperations = () => sets.flatMap(set => [...set]).filter(entry => entry && typeof entry === 'object' && 'commits' in entry);
  assert.equal(retainedOperations().length, 1);
  await contents.download();
  assert.equal(retainedOperations().length, 0);
  for (let id = 2; id < 10; id++) {
    browser.navigate('https://example.com/a', false, id);
    await flushBrowserLoads();
    assert.equal(retainedOperations().length, 1);
    await contents.download();
    assert.equal(retainedOperations().length, 0);
  }
  browser.navigate('https://example.com/b', false, 10);
  await flushBrowserLoads();
  contents.stop = () => {};
  browser.navigate('https://example.com/c', false, 11);
  assert.equal(retainedOperations().length, 0);
  await flushBrowserLoads();
  assert.equal(retainedOperations().length, 1);
  await contents.fail(-105, 'https://example.com/c');
  assert.equal(retainedOperations().length, 0);
  browser.destroy();
  assert.equal(retainedOperations().length, 0);
});

// redirectResponse.url は A、request.url は失敗した最終遷移先 B。
for (const order of ['network-first', 'page-first', 'failure-before-response', 'error-response-first']) {
  for (const native of [false, true]) {
    test(`リダイレクト失敗は現在loaderの最終URLを使う: ${order}, native=${native}`, async () => {
      const { browser, contents, states } = setup();
      await contents.complete('https://example.com/a');
      const old = contents.loads[0];
      const source = 'https://source.example/start';
      const target = 'https://failed.example/final';
      if (native) contents.emit('will-navigate', { url: source });
      else browser.navigate(source, false, 2);
      await flushBrowserLoads();
      const command = contents.loads.at(-1);
      const loaderId = native ? 'native-redirect' : command.loaderId;
      const documentRequestId = native ? 'redirect-request' : command.requestId;
      const message = (method, params) => contents.debugger.emit('message', {}, method, params);
      const request = (url, loader = loaderId, frameId = 'main', requestId = documentRequestId) => message('Network.requestWillBeSent', {
        type: 'Document', loaderId: loader, frameId, requestId, request: { url },
        redirectResponse: { url: source, status: 302 },
      });
      const page = () => {
        if (native) message('Page.frameStartedNavigating', { frameId: 'main', loaderId, url: source, navigationType: 'differentDocument' });
        else command.resolve({ frameId: 'main', loaderId });
      };
      if (order === 'page-first') { page(); await flushBrowserLoads(); }
      request(source);
      request(target);
      // 同じloaderのsubframeと旧世代の最終URLは採用しない。
      request('https://subframe.example/', loaderId, 'subframe', 'subframe-request');
      request('https://stale.example/', old.loaderId, 'main', old.requestId);
      if (order === 'network-first') { page(); await flushBrowserLoads(); }
      if (order === 'error-response-first' && !native) {
        command.resolve({ frameId: 'main', loaderId, errorText: 'net::ERR_NAME_NOT_RESOLVED' });
        await flushBrowserLoads();
      }
      message('Network.loadingFailed', { requestId: documentRequestId, errorText: 'net::ERR_NAME_NOT_RESOLVED' });
      if (order === 'failure-before-response') {
        if (native) page();
        else command.resolve({ frameId: 'main', loaderId, errorText: 'net::ERR_NAME_NOT_RESOLVED' });
        await flushBrowserLoads();
      }
      assert.equal(states.at(-1).navigationResult, 'failed');
      assert.equal(states.at(-1).failedUrl, target);
      assert.equal(states.at(-1).url, old.url);
      browser.action('reload');
      await flushBrowserLoads();
      assert.equal(contents.loads.at(-1).url, target);
    });
  }
}

for (const fromPage of [false, true]) {
  for (const noticeFirst of [false, true]) {
    test(`requestIdなしdownloadは確定URLと一般案内を維持: fromPage=${fromPage}, 通知先行=${noticeFirst}`, async () => {
      const { browser, contents, session, states, messages } = setup();
      await contents.complete('https://example.com/a');
      const url = 'https://example.com/file';
      browser.navigate(url, fromPage);
      await flushBrowserLoads();
      if (noticeFirst) downloadNotice(session, url, contents);
      await contents.download();
      if (!noticeFirst) downloadNotice(session, url, contents);
      assert.equal(states.at(-1).downloadUrl, '');
      assert.equal(states.at(-1).url, 'https://example.com/a');
      assert.equal(states.at(-1).navigationResult, 'download-blocked');
      assert.deepEqual(notices(messages).map(message => message.state), [{ canOpenFromToolbar: false }]);
    });
  }
}

test('リダイレクト先追跡はdownloadの送信元照合を変更しない', async () => {
  const { contents, session, states, messages } = setup();
  await flushBrowserLoads();
  const load = contents.loads[0];
  contents.debugger.emit('message', {}, 'Network.requestWillBeSent', {
    type: 'Document', frameId: 'main', loaderId: load.loaderId, requestId: load.requestId,
    request: { url: 'https://cdn.example/file' }, redirectResponse: { url: load.url, status: 302 },
  });
  session.emit('will-download', { preventDefault() {} }, { getURLChain: () => [load.url, 'https://cdn.example/file'] }, contents);
  await contents.download();
  assert.equal(states.at(-1).downloadUrl, load.url);
  assert.deepEqual(notices(messages).map(message => message.state), [{ canOpenFromToolbar: true }]);
});

test('download応答前のNetwork中止を失敗として確定しない', async () => {
  const { contents, session, states, messages } = setup();
  await flushBrowserLoads();
  const load = contents.loads[0];
  contents.debugger.emit('message', {}, 'Network.loadingFailed', {
    requestId: load.requestId, canceled: true, errorText: 'net::ERR_ABORTED',
  });
  assert.equal(states.at(-1).navigationResult, null);
  downloadNotice(session, load.url, contents);
  await contents.download();
  assert.equal(states.at(-1).navigationResult, 'download-blocked');
  assert.equal(states.at(-1).downloadUrl, load.url);
  assert.deepEqual(notices(messages).map(message => message.state), [{ canOpenFromToolbar: true }]);
});

test('HTTP操作から案内へ切り替え、失敗・再読込・HTTP復帰を別操作として追跡する', async () => {
  const { HELP_URL } = require('../utils/internalBrowserPolicy');
  const { browser, contents, states } = setup();
  await flushBrowserLoads();
  const old = contents.loads[0];
  const guideLoads = [];
  contents.loadURL = url => {
    assert.ok(url.startsWith(HELP_URL));
    guideLoads.push(url);
    return Promise.resolve();
  };
  const guide = browser.openHelp();
  assert.equal(states.at(-1).navigationRequestId, null);
  assert.equal(states.at(-1).pendingUrl, HELP_URL);
  old.resolve({ frameId: old.frameId, loaderId: old.loaderId });
  emitLoaderEvents(contents, old.loaderId, old.url);
  contents.emit('did-fail-load', {}, -105, 'old HTTP failure', old.url, true);
  await flushBrowserLoads();
  assert.equal(states.at(-1).navigationResult, null);
  assert.equal(states.at(-1).failedUrl, '');
  contents.setDocumentUrl(`${HELP_URL}#section`);
  contents.emit('did-navigate', {}, contents.getURL());
  contents.emit('did-finish-load');
  assert.equal(await guide, true);
  assert.equal(states.at(-1).url, `${HELP_URL}#section`);
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).pendingUrl, '');
  const commands = contents.commands.length;
  assert.equal(browser.action('reload'), true);
  contents.emit('did-fail-load', {}, -105, 'guide failure', HELP_URL, true);
  await flushBrowserLoads();
  assert.equal(states.at(-1).navigationResult, 'failed');
  assert.equal(states.at(-1).failedUrl, `${HELP_URL}#section`);
  assert.equal(browser.action('reload'), true);
  contents.emit('did-finish-load');
  await flushBrowserLoads();
  assert.equal(states.at(-1).failedUrl, '');
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.deepEqual(guideLoads, [HELP_URL, `${HELP_URL}#section`, `${HELP_URL}#section`]);
  assert.equal(contents.commands.length, commands);
  assert.equal(browser.navigate('https://example.org/return', false, 2), true);
  await contents.complete('https://example.org/return');
  assert.equal(states.at(-1).navigationRequestId, 2);
  assert.equal(states.at(-1).url, 'https://example.org/return');
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(contents.commands.at(-1), 'Page.navigate');
  browser.destroy();
});

test('初期about:blankの準備中に案内を開いてもCDP初期化を中断しない', async () => {
  const { HELP_URL } = require('../utils/internalBrowserPolicy');
  let release;
  const { browser, contents, states } = setup({ bootstrap: (loadURL, url) => new Promise(resolve => {
    release = () => resolve(loadURL(url));
  }) });
  const guideLoads = [];
  contents.loadURL = url => { guideLoads.push(url); return Promise.resolve(); };
  const guide = browser.openHelp();
  let settled = false;
  guide.then(() => { settled = true; }, () => { settled = true; });
  assert.deepEqual(guideLoads, []);
  release();
  assert.equal(contents.getURL(), 'about:blank');
  contents.emit('did-finish-load');
  contents.emit('did-stop-loading');
  await flushBrowserLoads();
  assert.deepEqual(guideLoads, [HELP_URL]);
  assert.equal(contents.loads.length, 0);
  assert.equal(settled, false);
  assert.equal(states.at(-1).navigationResult, null);
  assert.equal(states.at(-1).pendingUrl, HELP_URL);
  contents.setDocumentUrl(HELP_URL);
  contents.emit('did-finish-load');
  assert.equal(await guide, true);
  browser.navigate('https://example.org/return', false, 2);
  await contents.complete('https://example.org/return');
  assert.equal(states.at(-1).navigationResult, 'completed');
  assert.equal(states.at(-1).navigationRequestId, 2);
  browser.destroy();
});

for (const event of ['did-finish-load', 'did-fail-load', 'did-stop-loading']) {
  test(`案内開始前の${event}は案内URLでも完了・失敗にしない`, async () => {
    const { HELP_URL } = require('../utils/internalBrowserPolicy');
    let release;
    const { browser, contents, states } = setup({ bootstrap: (loadURL, url) => new Promise(resolve => {
      release = () => resolve(loadURL(url));
    }) });
    const guideLoads = [];
    contents.loadURL = url => { guideLoads.push(url); return Promise.resolve(); };
    const guide = browser.openHelp();
    let settled = false;
    guide.then(() => { settled = true; }, () => { settled = true; });
    contents.setDocumentUrl(HELP_URL);
    contents.emit(event, {}, -105, 'previous load failure', HELP_URL, true);
    await flushBrowserLoads();
    assert.equal(settled, false);
    assert.equal(states.at(-1).navigationResult, null);
    assert.equal(states.at(-1).pendingUrl, HELP_URL);
    assert.deepEqual(guideLoads, []);
    release();
    await flushBrowserLoads();
    assert.deepEqual(guideLoads, [HELP_URL]);
    assert.equal(settled, false);
    contents.setDocumentUrl(HELP_URL);
    contents.emit('did-finish-load');
    assert.equal(await guide, true);
    assert.equal(states.at(-1).navigationResult, 'completed');
    browser.destroy();
  });
}

test('案内を確定した後に前のGitHub文書の404案内を復元しない', async () => {
  const { HELP_URL } = require('../utils/internalBrowserPolicy');
  const { browser, contents, states } = setup();
  await flushBrowserLoads();
  const load = contents.loads[0];
  contents.respond(load.loaderId, 'https://github.com/missing', 404);
  await contents.complete('https://github.com/missing');
  assert.equal(states.at(-1).github404Url, 'https://github.com/missing');
  contents.loadURL = () => Promise.resolve();
  const guide = browser.openHelp();
  contents.setDocumentUrl(HELP_URL);
  contents.emit('did-finish-load');
  await guide;
  assert.equal(states.at(-1).url, HELP_URL);
  assert.equal(states.at(-1).github404Url, '');
  assert.equal(browser.action('reload'), true);
  contents.emit('did-finish-load');
  assert.equal(states.at(-1).github404Url, '');
  browser.destroy();
});
