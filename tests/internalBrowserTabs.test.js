'use strict';
// アプリ内ブラウザをタブ単位に分けた作り（issue #643）の検証。
// タブの追加・選択、表示するページの付け替え、タブ番号つきの IPC 操作、
// タブ全体で通しの操作番号、ダウンロード案内のタブへの振り分けを確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInternalBrowser } = require('../utils/internalBrowser');
const { installBrowserLoad, flushBrowserLoads } = require('./helpers/browserLoad');

function setup({ fetchFavicon } = {}) {
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
      contents.setWindowOpenHandler = handler => { contents.openHandler = handler; };
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
    fetchFavicon: fetchFavicon || (async () => ''),
  });
  const states = () => sent.filter(entry => entry.channel === 'internal-browser:state').map(entry => entry.payload);
  const notices = () => sent.filter(entry => entry.channel === 'internal-browser:download-blocked').map(entry => entry.payload);
  const tabLists = () => sent.filter(entry => entry.channel === 'internal-browser:tabs').map(entry => entry.payload);
  return { browser, session, sent, calls, views, states, notices, tabLists };
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

// ─── タブの UI と動き（issue #644）─────────────────────────────────────────

test('「＋」の新しいタブは末尾に足して選び、タブの一覧を状態より先に送る', () => {
  const { browser, sent, tabLists } = setup();
  browser.navigate('https://example.com/a', false, 1);
  const before = sent.length;
  assert.equal(browser.newTab(), 2);
  assert.deepEqual(browser.getTabIds(), [1, 2]);
  assert.equal(browser.getActiveTabId(), 2);
  // 画面が表示するタブを切り替えてから状態を受け取れるよう、一覧 → 状態の順に届く
  const channels = sent.slice(before).map(entry => entry.channel);
  assert.ok(channels.lastIndexOf('internal-browser:tabs') < channels.lastIndexOf('internal-browser:state'));
  const list = tabLists().at(-1);
  assert.equal(list.activeTabId, 2);
  assert.equal(list.maxTabs, 10);
  assert.deepEqual(list.tabs.map(tab => [tab.id, tab.empty, tab.url]), [[1, false, 'https://example.com/a'], [2, true, '']]);
  assert.deepEqual(browser.getTabsState(), list);
});

test('タブは 10 個まで。上限では新しいタブを作らない', () => {
  const { browser } = setup();
  for (let index = 2; index <= 10; index++) assert.equal(browser.newTab(), index);
  assert.equal(browser.getTabIds().length, 10);
  assert.equal(browser.newTab(), null);
  assert.equal(browser.addTab(), null);
  assert.equal(browser.getTabIds().length, 10);
  assert.equal(browser.getActiveTabId(), 10);
});

test('選んでいるタブを閉じると右隣、右が無ければ左隣を選び、閉じたタブのページを破棄する', () => {
  const { browser, views } = setup();
  browser.navigate('https://example.com/1', false, 1);
  browser.newTab();
  browser.navigate('https://example.com/2', false, 2);
  browser.newTab();
  browser.navigate('https://example.com/3', false, 3);
  browser.selectTab(2);
  // 真ん中を閉じると右隣
  assert.deepEqual(browser.closeTab(2), { closedLast: false });
  assert.deepEqual([browser.getTabIds(), browser.getActiveTabId()], [[1, 3], 3]);
  assert.equal(views[1].webContents.closed, true);
  // 右端を閉じると左隣
  assert.deepEqual(browser.closeTab(3), { closedLast: false });
  assert.deepEqual([browser.getTabIds(), browser.getActiveTabId()], [[1], 1]);
  // 選んでいないタブを閉じても選択は変わらない
  browser.newTab();
  browser.selectTab(1);
  assert.deepEqual(browser.closeTab(4), { closedLast: false });
  assert.equal(browser.getActiveTabId(), 1);
  // 番号の無い・未知の番号は閉じない
  assert.equal(browser.closeTab(undefined), false);
  assert.equal(browser.closeTab(99), false);
});

test('最後のタブを閉じると、空の新しいタブ 1 つに置き換えて closedLast を返す', () => {
  const { browser, views, tabLists } = setup();
  browser.navigate('https://example.com/a', false, 1);
  assert.deepEqual(browser.closeTab(1), { closedLast: true });
  assert.equal(views[0].webContents.closed, true);
  assert.deepEqual(browser.getTabIds(), [2]);
  assert.equal(browser.getActiveTabId(), 2);
  assert.deepEqual(tabLists().at(-1).tabs.map(tab => [tab.id, tab.empty]), [[2, true]]);
});

test('「アプリ内で開く」は同じページのタブへ切り替え（読み込み直さない）、末尾の / と # 以降は無視する', async () => {
  const { browser, views } = setup();
  browser.navigate('https://github.com/vektor-inc/vk-terminals/pull/1/', false, 1);
  await flushBrowserLoads();
  await views[0].webContents.complete('https://github.com/vektor-inc/vk-terminals/pull/1/');
  browser.newTab();
  const commands = views[0].webContents.commands.length;
  assert.deepEqual(browser.openUrl('https://github.com/vektor-inc/vk-terminals/pull/1#discussion'), { result: 'switched', tabId: 1 });
  assert.equal(browser.getActiveTabId(), 1);
  assert.equal(views[0].webContents.commands.length, commands);
  // 検索条件が違えば別のページとして扱う
  const opened = browser.openUrl('https://github.com/vektor-inc/vk-terminals/pull/1?tab=files');
  assert.equal(opened.result, 'opened');
  assert.equal(opened.tabId, 3);
  // HTTP(S) 以外は受け付けない
  assert.equal(browser.openUrl('file:///etc/passwd'), false);
  assert.equal(browser.openUrl('javascript:alert(1)'), false);
});

test('「アプリ内で開く」は選んでいるタブが空の新規タブならそのタブに、そうでなければ末尾の新しいタブに開く', () => {
  const { browser, states } = setup();
  // 起動直後の空のタブにはそのまま開く
  assert.deepEqual(browser.openUrl('https://example.com/a'), { result: 'opened', tabId: 1 });
  assert.deepEqual(browser.getTabIds(), [1]);
  assert.equal(states().at(-1).pendingUrl, 'https://example.com/a');
  // 表示中のページがあれば、末尾に新しいタブを開いて前に出す
  browser.newTab();
  browser.navigate('https://example.com/b', false, 2);
  browser.selectTab(1);
  assert.deepEqual(browser.openUrl('https://example.com/c'), { result: 'opened', tabId: 3 });
  assert.deepEqual([browser.getTabIds(), browser.getActiveTabId()], [[1, 2, 3], 3]);
  assert.deepEqual([states().at(-1).tabId, states().at(-1).active, states().at(-1).pendingUrl], [3, true, 'https://example.com/c']);
});

test('「アプリ内で開く」は上限では開かず、選んでいるタブを limit として返す', () => {
  const { browser } = setup();
  browser.navigate('https://example.com/0', false, 1);
  for (let index = 1; index < 10; index++) {
    browser.newTab();
    browser.navigate(`https://example.com/${index}`, false, 1);
  }
  browser.selectTab(4);
  assert.deepEqual(browser.openUrl('https://example.com/new'), { result: 'limit', tabId: 4 });
  assert.equal(browser.getTabIds().length, 10);
  // 上限でも、同じページのタブへの切り替えはできる
  assert.deepEqual(browser.openUrl('https://example.com/7/'), { result: 'switched', tabId: 8 });
});

test('ページの target="_blank"・window.open は押したタブのすぐ右に開き、Cmd を押しながらのクリックだけ後ろに開く', async () => {
  const { browser, views, states } = setup();
  browser.navigate('https://example.com/a', false, 1);
  browser.newTab();
  browser.navigate('https://example.com/b', false, 2);
  browser.selectTab(1);
  const source = views[0].webContents;
  // 前に出す（通常のクリック）
  assert.deepEqual(source.openHandler({ url: 'https://example.com/front', disposition: 'foreground-tab' }), { action: 'deny' });
  assert.deepEqual([browser.getTabIds(), browser.getActiveTabId()], [[1, 3, 2], 3]);
  assert.deepEqual([states().at(-1).tabId, states().at(-1).pendingUrl], [3, 'https://example.com/front']);
  // window.open も新しいタブで開く
  browser.selectTab(1);
  source.openHandler({ url: 'https://example.com/popup', disposition: 'new-window' });
  assert.deepEqual([browser.getTabIds(), browser.getActiveTabId()], [[1, 4, 3, 2], 4]);
  // 後ろに開く（Cmd / Ctrl を押しながらのクリック）
  browser.selectTab(1);
  source.openHandler({ url: 'https://example.com/back', disposition: 'background-tab' });
  assert.deepEqual([browser.getTabIds(), browser.getActiveTabId()], [[1, 5, 4, 3, 2], 1]);
  // HTTP(S)・案内ページ以外は開かない
  assert.deepEqual(source.openHandler({ url: 'file:///tmp/a', disposition: 'foreground-tab' }), { action: 'deny' });
  assert.equal(browser.getTabIds().length, 5);
  await flushBrowserLoads();
});

test('ページの新しいタブ要求が上限に当たったら、開かずに要求したタブへ上限の案内を送る', () => {
  const { browser, views, sent } = setup();
  browser.navigate('https://example.com/a', false, 1);
  for (let index = 2; index <= 10; index++) browser.newTab();
  browser.selectTab(1);
  views[0].webContents.openHandler({ url: 'https://example.com/over', disposition: 'foreground-tab' });
  assert.equal(browser.getTabIds().length, 10);
  assert.equal(browser.getActiveTabId(), 1);
  assert.deepEqual(sent.at(-1), { channel: 'internal-browser:tab-limit', payload: { tabId: 1, url: 'https://example.com/over', active: true } });
});

test('ページタイトルとファビコンをタブの一覧に載せ、ファビコンは画像データにしてから渡す', async () => {
  const requested = [];
  const pending = new Map();
  const fetchFavicon = url => {
    requested.push(url);
    return new Promise(resolve => pending.set(url, resolve));
  };
  const { browser, views, tabLists } = setup({ fetchFavicon });
  browser.navigate('https://example.com/a', false, 1);
  const contents = views[0].webContents;
  const tab = () => tabLists().at(-1).tabs[0];
  contents.emit('page-title-updated', {}, 'ページ A');
  assert.equal(tab().title, 'ページ A');
  // HTTP(S) の先頭の候補だけを取得する
  contents.emit('page-favicon-updated', {}, ['data:image/png;base64,AAAA', 'https://example.com/a.ico', 'https://example.com/b.ico']);
  assert.deepEqual(requested, ['https://example.com/a.ico']);
  assert.equal(tab().favicon, '');
  // 取得中に別のアイコンへ替わったら、古い取得結果は使わない
  contents.emit('page-favicon-updated', {}, ['https://example.com/c.png']);
  pending.get('https://example.com/a.ico')('data:image/x-icon;base64,b2xk');
  await flushBrowserLoads();
  assert.equal(tab().favicon, '');
  pending.get('https://example.com/c.png')('data:image/png;base64,bmV3');
  await flushBrowserLoads();
  assert.equal(tab().favicon, 'data:image/png;base64,bmV3');
  // 同じアイコンは取得し直さない
  contents.emit('page-favicon-updated', {}, ['https://example.com/c.png']);
  assert.deepEqual(requested, ['https://example.com/a.ico', 'https://example.com/c.png']);
  // 別の文書へ移ったら、前のページのタイトルとファビコンを消す
  contents.emit('did-navigate', {}, 'https://example.com/next');
  assert.deepEqual([tab().title, tab().favicon], ['', '']);
});

test('取得に失敗したファビコンは覚えず、次に知らされたときに取り直す', async () => {
  const requested = [];
  const { browser, views, tabLists } = setup({ fetchFavicon: async url => { requested.push(url); return ''; } });
  browser.navigate('https://example.com/a', false, 1);
  const contents = views[0].webContents;
  contents.emit('page-favicon-updated', {}, ['https://example.com/a.ico']);
  await flushBrowserLoads();
  contents.emit('did-navigate', {}, 'https://example.com/b');
  contents.emit('page-favicon-updated', {}, ['https://example.com/a.ico']);
  await flushBrowserLoads();
  assert.deepEqual(requested, ['https://example.com/a.ico', 'https://example.com/a.ico']);
  assert.equal(tabLists().at(-1).tabs[0].favicon, '');
});
