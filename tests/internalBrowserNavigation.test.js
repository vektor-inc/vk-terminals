'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInternalBrowser } = require('../utils/internalBrowser');
const { installBrowserLoad, flushBrowserLoads } = require('./helpers/browserLoad');

function setup({ failCommand, failAttach = false, createBrowser = createInternalBrowser } = {}) {
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

for (const trigger of ['link', 'location.replace']) {
  test(`${trigger} による置換で新しい実遷移を stop せず完了する`, async () => {
    const { browser, contents, states } = setup();
    await flushBrowserLoads();
    let stopped = 0;
    contents.stop = () => { stopped++; };
    const old = contents.loads[0];
    contents.emit('will-navigate', { url: 'https://example.com/page' });
    const operation = states.at(-1).navigationOperationId;
    assert.equal(stopped, 0);
    assert.equal(states.at(-1).navigationRequestId, null);
    assert.ok(states.some(state => state.navigationRequestId === 1 && state.navigationResult === 'superseded'));
    contents.startNative('https://example.com/page', 'native-page');
    emitLoaderEvents(contents, old.loaderId, old.url);
    contents.respond(old.loaderId, 'https://github.com/old', 404);
    assert.equal(states.at(-1).navigationResult, null);
    contents.commitDocument('https://example.com/page', 'native-page');
    contents.loadDocument('native-page');
    assert.equal(states.at(-1).navigationResult, 'completed');
    assert.equal(states.at(-1).url, 'https://example.com/page');
    assert.equal(states.at(-1).github404Url, '');
    assert.equal(states.at(-1).navigationOperationId, operation);
    browser.publish();
    assert.equal(stopped, 0);
  });
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
      const { contents, session, states } = setup();
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
      assert.equal(states.at(-1).downloadUrl, 'https://example.com/download');
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
    require: name => name === './internalBrowserPolicy' ? require('../utils/internalBrowserPolicy') : require(name),
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
