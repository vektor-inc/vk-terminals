'use strict';

// ウィンドウを閉じても作業ペインを残し、作り直したウィンドウへつなぎ直す判断（issue #649）を確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isCloseShortcut,
  planLivePaneReattach,
  applyTitleUpdateToLayout,
  applyEngineChangeToLayout,
  createOutputReplayBuffer,
} = require('../utils/windowLifecycle');
const { resolvePaneNote } = require('../renderer/statusPresentation');

const keyDown = (key, modifiers = {}) => ({ type: 'keyDown', key, meta: false, control: false, alt: false, shift: false, ...modifiers });

test('macOS の ⌘ + W だけを閉じるショートカットとして扱う', () => {
  assert.equal(isCloseShortcut(keyDown('w', { meta: true }), 'darwin'), true);
  assert.equal(isCloseShortcut(keyDown('W', { meta: true }), 'darwin'), true);
  // 離したとき・他の修飾キーとの組み合わせ・他のキーは対象外
  assert.equal(isCloseShortcut({ ...keyDown('w', { meta: true }), type: 'keyUp' }, 'darwin'), false);
  assert.equal(isCloseShortcut(keyDown('w', { meta: true, shift: true }), 'darwin'), false);
  assert.equal(isCloseShortcut(keyDown('w', { meta: true, alt: true }), 'darwin'), false);
  assert.equal(isCloseShortcut(keyDown('w', { meta: true, control: true }), 'darwin'), false);
  assert.equal(isCloseShortcut(keyDown('w'), 'darwin'), false);
  assert.equal(isCloseShortcut(keyDown('q', { meta: true }), 'darwin'), false);
  assert.equal(isCloseShortcut(null, 'darwin'), false);
});

test('Windows・Linux の Ctrl + W はターミナルの入力に残すため止めない', () => {
  assert.equal(isCloseShortcut(keyDown('w', { control: true }), 'win32'), false);
  assert.equal(isCloseShortcut(keyDown('w', { control: true }), 'linux'), false);
  assert.equal(isCloseShortcut(keyDown('w', { meta: true }), 'linux'), false);
});

test('保存した並びのとおりに、生きているペインを名前・状態ごと戻す', () => {
  const layout = {
    order: ['pane-2', 'pane-1'], stashOrder: ['pane-3'], focusedPaneId: 'pane-1',
    panes: [
      { paneId: 'pane-1', termId: '1', cwd: '/work/a', engine: 'codex', apiTitle: '#12 表記', apiPrUrl: 'https://github.com/o/r/pull/1', apiPrMerged: true, apiPaneNote: 'watching' },
      { paneId: 'pane-2', termId: '2', cwd: '/work/b', engine: 'claude', taskTitle: 'タスク' },
      { paneId: 'pane-3', termId: '3', cwd: '', engine: 'other' },
    ],
  };
  const plan = planLivePaneReattach({ liveIds: ['1', '2', '3'], layout, defaultCwd: '/home' });
  assert.deepEqual(plan.order, ['pane-2', 'pane-1']);
  assert.deepEqual(plan.stashOrder, ['pane-3']);
  assert.equal(plan.focusedPaneId, 'pane-1');
  assert.deepEqual(plan.panes, [
    { id: '1', paneId: 'pane-1', cwd: '/work/a', engine: 'codex', apiTitle: '#12 表記', apiPrUrl: 'https://github.com/o/r/pull/1', apiPaneNote: 'watching', apiPrMerged: true },
    { id: '2', paneId: 'pane-2', cwd: '/work/b', engine: 'claude', taskTitle: 'タスク' },
    // 作業フォルダが空なら既定のフォルダ、不明なエンジンは Claude Code にする
    { id: '3', paneId: 'pane-3', cwd: '/home', engine: 'claude' },
  ]);
});

test('閉じている間に終了したペインは戻さず、記録に無い生存ペインは重ならない名前で末尾へ足す', () => {
  const layout = {
    order: ['pane-1', 'pane-5'], stashOrder: [], focusedPaneId: 'pane-5',
    panes: [
      { paneId: 'pane-1', termId: '1', cwd: '/a' },
      { paneId: 'pane-5', termId: '5', cwd: '/b' },
      { paneId: 'pane-7', termId: '9', cwd: '/c' },
    ],
  };
  // termId 5 は終了済み、termId 7 と 8 は記録より後に増えた。termId 7 の既定名 pane-7 は使用済み。
  const plan = planLivePaneReattach({ liveIds: ['1', '9', '7', '8'], layout, defaultCwd: '/home' });
  assert.deepEqual(plan.panes.map(pane => [pane.id, pane.paneId]), [['1', 'pane-1'], ['9', 'pane-7'], ['7', 'pane-8'], ['8', 'pane-9']]);
  assert.deepEqual(plan.order, ['pane-1', 'pane-7', 'pane-8', 'pane-9']);
  // 選んでいたペインが終了していれば、選び直しは画面に任せる
  assert.equal(plan.focusedPaneId, null);
});

test('並びの記録が無くても（保存前・壊れた記録）、生きているペインをすべて戻す', () => {
  for (const layout of [null, {}, { panes: 'x', order: 'y' }, { panes: [null, { termId: '1', paneId: '../x' }] }]) {
    const plan = planLivePaneReattach({ liveIds: ['1', '2'], layout, defaultCwd: '/home' });
    assert.deepEqual(plan.panes.map(pane => pane.paneId), ['pane-1', 'pane-2']);
    assert.deepEqual(plan.order, ['pane-1', 'pane-2']);
    assert.deepEqual(plan.stashOrder, []);
  }
  assert.deepEqual(planLivePaneReattach({ liveIds: [], layout: null, defaultCwd: '/home' }).panes, []);
});

test('ウィンドウが無い間のタイトル・PR の更新を並びの記録へ反映する', () => {
  const layout = { order: ['pane-1'], panes: [{ paneId: 'pane-1', termId: '4', apiTitle: '#1 旧', apiUrl: 'https://a', apiPaneNote: 'watching' }] };
  const merged = applyTitleUpdateToLayout(layout, '4', {
    title: '#1 旧', url: undefined, prUrl: 'https://github.com/o/r/pull/9', prMerged: true, waitingMerge: false,
    paneNoteUpdate: { provided: false },
  }, resolvePaneNote);
  assert.deepEqual(merged.panes[0], {
    paneId: 'pane-1', termId: '4', apiTitle: '#1 旧', apiUrl: 'https://a', apiPaneNote: 'watching',
    apiPrUrl: 'https://github.com/o/r/pull/9', apiPrMerged: true, apiWaitingMerge: false,
  });
  // 元の記録は書き換えない
  assert.equal(layout.panes[0].apiPrMerged, undefined);
  // タイトルが変わると、送られていない paneNote は消える（画面の terminal:title と同じ）
  const renamed = applyTitleUpdateToLayout(layout, '4', { title: '#2 新', paneNoteUpdate: { provided: false } }, resolvePaneNote);
  assert.equal(renamed.panes[0].apiTitle, '#2 新');
  assert.equal(renamed.panes[0].apiPaneNote, null);
  // 記録に無いペインと記録が無い場合はそのまま
  assert.equal(applyTitleUpdateToLayout(layout, '5', { title: 'x' }, resolvePaneNote), layout);
  assert.equal(applyTitleUpdateToLayout(null, '4', { title: 'x' }, resolvePaneNote), null);
});

test('ウィンドウが無い間のエンジンの入れ替えを並びの記録へ反映する', () => {
  const layout = { panes: [{ paneId: 'pane-1', termId: '4', engine: 'claude' }, { paneId: 'pane-2', termId: '5', engine: 'claude' }] };
  const changed = applyEngineChangeToLayout(layout, '4', 'codex');
  assert.deepEqual(changed.panes.map(pane => pane.engine), ['codex', 'claude']);
});

test('保持役を使わないペインの出力を上限つきで覚え、流し終えるまで画面へ送らせない', () => {
  const buffer = createOutputReplayBuffer({ maxChars: 20 });
  buffer.append('1', 'line-a\n');
  buffer.append('1', 'line-b\n');
  assert.equal(buffer.read('1'), 'line-a\nline-b\n');
  // 上限を超えたら古い出力から捨て、途中で切った先頭は次の改行まで落とす
  buffer.append('1', 'line-c\nline-d\n');
  assert.equal(buffer.read('1'), 'line-c\nline-d\n');
  buffer.append('1', 'x'.repeat(30));
  assert.equal(buffer.read('1'), 'x'.repeat(20));
  assert.equal(buffer.read('2'), '');

  assert.equal(buffer.isHeld('1'), false);
  buffer.hold('1');
  assert.equal(buffer.isHeld('1'), true);
  buffer.release('1');
  assert.equal(buffer.isHeld('1'), false);
  buffer.hold('1');
  buffer.delete('1');
  assert.equal(buffer.isHeld('1'), false);
  assert.equal(buffer.read('1'), '');
});

test('ウィンドウを閉じても作業ペインへ終了の合図を送らず、Dock から作り直す', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const closed = main.slice(main.indexOf("app.on('window-all-closed'"), main.indexOf("app.on('activate'"));
  assert.ok(closed.length > 0);
  // 以前は macOS で各ペインへ kill を送り、保持役（tmux）のペインまで kill-pane で消していた
  assert.doesNotMatch(closed, /\.kill\(\)/);
  assert.match(main, /app\.on\('activate', \(\) => \{ reopenWindowIfClosed\(\); \}\);/);
  // ⌘ + W はウィンドウと、アプリ内ブラウザのページの両方で止める
  assert.match(main, /win\.webContents\.on\('before-input-event'[^]*?isCloseShortcut\(input\)[^]*?event\.preventDefault\(\)/);
  const browser = fs.readFileSync(path.join(__dirname, '..', 'utils', 'internalBrowser.js'), 'utf8');
  assert.match(browser, /contents\.on\('before-input-event'[^]*?isCloseShortcut\(input\)[^]*?event\.preventDefault\(\)/);
});

test('ページで ⌘ + W を押してタブを閉じたときだけ、次に選んだタブのページへフォーカスを移す', () => {
  const { EventEmitter } = require('node:events');
  const { createInternalBrowser } = require('../utils/internalBrowser');
  const { installBrowserLoad } = require('./helpers/browserLoad');
  const views = [];
  const sent = [];
  // 単体テスト用のページ（WebContentsView）。フォーカスの有無と focus() の呼び出しを記録する。
  class View {
    constructor() {
      const contents = new EventEmitter();
      installBrowserLoad(contents);
      contents.isLoading = () => false;
      contents.focused = false;
      contents.focusCalls = 0;
      contents.isFocused = () => contents.focused;
      contents.focus = () => { contents.focusCalls += 1; };
      contents.navigationHistory = { canGoBack: () => false, canGoForward: () => false };
      contents.setWindowOpenHandler = () => {};
      contents.close = () => {};
      this.webContents = contents;
      views.push(this);
    }
    setBounds() {}
  }
  const session = new EventEmitter();
  session.setPermissionRequestHandler = () => {};
  session.setPermissionCheckHandler = () => {};
  session.webRequest = { onBeforeRequest() {}, onCompleted() {} };
  const win = {
    isDestroyed: () => false, isFocused: () => true,
    getContentBounds: () => ({ width: 1000, height: 800 }),
    webContents: { send(channel, payload) { sent.push({ channel, payload }); }, focus() {} },
    contentView: { addChildView() {}, removeChildView() {} },
  };
  const browser = createInternalBrowser(win, {
    WebContentsView: View, session: { fromPartition: () => session }, dialog: { showMessageBoxSync: () => 1 },
    fetchFavicon: async () => '',
  });
  // 3 つのタブにページを開いて表示する
  browser.setBounds({ x: 500, y: 40, width: 480, height: 700 });
  browser.setVisible(true);
  browser.navigate('https://example.com/a', false, 1);
  const second = browser.newTab();
  browser.navigate('https://example.com/b', false, 2, { tabId: second });
  const third = browser.newTab();
  browser.navigate('https://example.com/c', false, 3, { tabId: third });
  const [viewA, viewB, viewC] = views;

  // ページで ⌘ + W を押すと、止めたうえでそのタブの番号を画面へ知らせる（閉じる処理は画面に任せる）
  const event = { prevented: false, preventDefault() { this.prevented = true; } };
  viewC.webContents.emit('before-input-event', event, { type: 'keyDown', key: 'w', meta: true });
  const notices = sent.filter(entry => entry.channel === 'app:close-shortcut').map(entry => entry.payload);
  assert.equal(event.prevented, process.platform === 'darwin');
  assert.deepEqual(notices, process.platform === 'darwin' ? [{ tabId: third }] : []);

  // ページにフォーカスがあったタブを閉じると、次に選んだタブのページへフォーカスを移す
  viewC.webContents.focused = true;
  browser.closeTab(third);
  assert.equal(browser.getActiveTabId(), second);
  assert.equal(viewB.webContents.focusCalls, 1);
  // タブの × など、ページにフォーカスが無いときは移さない
  browser.closeTab(second);
  assert.equal(browser.getActiveTabId(), 1);
  assert.equal(viewA.webContents.focusCalls, 0);
});
