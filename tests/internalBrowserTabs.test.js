'use strict';
// アプリ内ブラウザをタブ単位に分けた作り（issue #643）の検証。
// タブの追加・選択、表示するページの付け替え、タブ番号つきの IPC 操作、
// タブ全体で通しの操作番号、ダウンロード案内のタブへの振り分けを確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInternalBrowser } = require('../utils/internalBrowser');
const { installBrowserLoad, flushBrowserLoads } = require('./helpers/browserLoad');

function setup() {
  const sent = [];
  const calls = [];
  const views = [];
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  session.webRequest = { onBeforeRequest() {}, onCompleted() {} };
  class View {
    constructor() {
      const contents = new EventEmitter();
      installBrowserLoad(contents);
      contents.isLoading = () => false;
      contents.isFocused = () => false;
      contents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
      contents.setWindowOpenHandler = () => {};
      contents.closed = false;
      contents.close = () => { contents.closed = true; };
      this.webContents = contents;
      views.push(this);
    }
    setBounds(rect) { calls.push(['bounds', this, rect]); }
  }
  const win = {
    isDestroyed: () => false,
    isFocused: () => true,
    getContentBounds: () => ({ width: 1000, height: 800 }),
    webContents: { send(channel, payload) { sent.push({ channel, payload }); }, focus() {} },
    contentView: {
      addChildView(view) { calls.push(['add', view]); },
      removeChildView(view) { calls.push(['remove', view]); },
    },
  };
  const browser = createInternalBrowser(win, {
    WebContentsView: View, session: { fromPartition: () => session }, dialog: { showMessageBoxSync: () => 1 },
  });
  const states = () => sent.filter(entry => entry.channel === 'internal-browser:state').map(entry => entry.payload);
  const notices = () => sent.filter(entry => entry.channel === 'internal-browser:download-blocked').map(entry => entry.payload);
  return { browser, session, sent, calls, views, states, notices };
}

test('作成時はタブ 1 つを選んだ状態で始まり、状態にタブ番号と選択中かを載せる', () => {
  const { browser, states } = setup();
  // 作成直後のタブ一覧と選んでいるタブ
  assert.deepEqual(browser.getTabIds(), [1]);
  assert.equal(browser.getActiveTabId(), 1);
  // tabId を省略した遷移は選んでいるタブに入る
  assert.equal(browser.navigate('https://example.com/a', false, 1), true);
  assert.equal(states().at(-1).tabId, 1);
  assert.equal(states().at(-1).active, true);
});

test('タブを足しても選択は変わらず、選び直すと表示するページを付け替えて状態を送り直す', async () => {
  const { browser, calls, views, states } = setup();
  browser.setBounds({ x: 500, y: 40, width: 480, height: 700 });
  browser.setVisible(true);
  browser.navigate('https://example.com/first', false, 1);
  const [firstView] = views;
  assert.deepEqual(calls.filter(call => call[0] === 'add'), [['add', firstView]]);

  // 足したタブは末尾に並び、選ばれない
  const secondId = browser.addTab();
  assert.equal(secondId, 2);
  assert.deepEqual(browser.getTabIds(), [1, 2]);
  assert.equal(browser.getActiveTabId(), 1);

  // 選んでいないタブで開いたページは画面に付けず、状態は選択外として送る
  assert.equal(browser.navigate('https://example.com/second', false, 2, { tabId: secondId }), true);
  await flushBrowserLoads();
  const secondView = views[1];
  assert.ok(secondView);
  assert.equal(calls.some(call => call[0] === 'add' && call[1] === secondView), false);
  assert.deepEqual([states().at(-1).tabId, states().at(-1).active], [2, false]);

  // 選び直すと前のページを外して新しいページを付け、選んだタブの状態を送る
  const before = calls.length;
  assert.equal(browser.selectTab(secondId), true);
  assert.deepEqual(calls.slice(before).map(call => [call[0], call[1]]), [
    ['remove', firstView], ['bounds', secondView], ['add', secondView],
  ]);
  assert.equal(browser.getActiveTabId(), 2);
  assert.deepEqual([states().at(-1).tabId, states().at(-1).active, states().at(-1).pendingUrl],
    [2, true, 'https://example.com/second']);

  // 選んでいるタブを選び直しても何もしない
  const unchanged = calls.length;
  assert.equal(browser.selectTab(secondId), true);
  assert.equal(calls.length, unchanged);

  // 元のタブへ戻すと元のページを付け直す
  assert.equal(browser.selectTab(1), true);
  assert.deepEqual(calls.slice(unchanged).map(call => [call[0], call[1]]), [
    ['remove', secondView], ['bounds', firstView], ['add', firstView],
  ]);
});

test('存在しない・不正なタブ番号の操作は受け付けない', () => {
  const { browser, views } = setup();
  for (const tabId of [0, -1, 1.5, '1', null, 99, Number.MAX_SAFE_INTEGER + 1, NaN]) {
    assert.equal(browser.navigate('https://example.com', false, 1, { tabId }), false);
    assert.equal(browser.action('reload', { tabId }), false);
    assert.equal(browser.externalUrl('current', { tabId }), null);
    assert.equal(browser.openHelp({ tabId }), false);
    assert.equal(browser.selectTab(tabId), false);
  }
  assert.equal(views.length, 0);
  assert.equal(browser.getActiveTabId(), 1);
});

test('古い通知を捨てる操作番号は、タブをまたいで 1 つの通し番号になる', async () => {
  const { browser, states } = setup();
  const secondId = browser.addTab();
  browser.navigate('https://example.com/a', false, 1);
  const first = states().at(-1).navigationOperationId;
  browser.navigate('https://example.com/b', false, 2, { tabId: secondId });
  const second = states().at(-1).navigationOperationId;
  browser.navigate('https://example.com/c', false, 3);
  const third = states().at(-1).navigationOperationId;
  assert.deepEqual([second - first, third - second], [1, 1]);
  await flushBrowserLoads();
});

test('ダウンロード案内は、ダウンロードを起こしたページのタブへ振り分ける', async () => {
  const { browser, session, views, notices } = setup();
  const secondId = browser.addTab();
  browser.navigate('https://example.com/page', false, 1);
  browser.navigate('https://example.com/file.zip', false, 2, { tabId: secondId });
  await flushBrowserLoads();
  const [firstContents, secondContents] = views.map(view => view.webContents);

  // 配送元のページが分かるときは、そのページのタブの操作として扱う
  session.emit('will-download', { preventDefault() {} },
    { getURLChain: () => ['https://example.com/file.zip'] }, secondContents);
  await secondContents.download();
  assert.deepEqual(notices().at(-1), { canOpenFromToolbar: true, tabId: secondId, active: false });

  // どのタブのページでもない配送は、選んでいるタブに一般案内として出す
  session.emit('will-download', { preventDefault() {} },
    { getURLChain: () => ['https://example.com/page'] }, new EventEmitter());
  assert.deepEqual(notices().at(-1), { canOpenFromToolbar: false, tabId: 1, active: true });

  // 配送元のページが分からないときは、URL が一致する操作を持つタブへ振り分ける
  browser.navigate('https://example.com/other.zip', false, 3, { tabId: secondId });
  await flushBrowserLoads();
  session.emit('will-download', { preventDefault() {} }, { getURLChain: () => ['https://example.com/other.zip'] });
  await secondContents.download();
  assert.deepEqual(notices().at(-1), { canOpenFromToolbar: true, tabId: secondId, active: false });
  assert.equal(firstContents.closed, false);
});

test('破棄するとすべてのタブのページを閉じ、ダウンロードの検査を外す', () => {
  const { browser, session, views } = setup();
  const secondId = browser.addTab();
  browser.navigate('https://example.com/a', false, 1);
  browser.navigate('https://example.com/b', false, 2, { tabId: secondId });
  assert.equal(session.listenerCount('will-download'), 1);
  browser.destroy();
  assert.deepEqual(views.map(view => view.webContents.closed), [true, true]);
  assert.equal(session.listenerCount('will-download'), 0);
});
