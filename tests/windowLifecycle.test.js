'use strict';

// ウィンドウを閉じても作業ペインを残し、作り直したウィンドウへつなぎ直す判断（issue #649）を確かめる。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  isCloseShortcut,
  releasePendingPaneRestores,
  planLivePaneReattach,
  applyTitleUpdateToLayout,
  applyEngineChangeToLayout,
  applyPaneStateToLayout,
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
      { paneId: 'pane-1', termId: '1', cwd: '/work/a', engine: 'codex', createdByAutomation: true, apiTitle: '#12 表記', apiPrUrl: 'https://github.com/o/r/pull/1', apiPrMerged: true, apiPaneNote: 'watching' },
      { paneId: 'pane-2', termId: '2', cwd: '/work/b', engine: 'claude', taskTitle: 'タスク' },
      { paneId: 'pane-3', termId: '3', cwd: '', engine: 'other' },
    ],
  };
  const plan = planLivePaneReattach({ liveIds: ['1', '2', '3'], layout, defaultCwd: '/home' });
  assert.deepEqual(plan.order, ['pane-2', 'pane-1']);
  assert.deepEqual(plan.stashOrder, ['pane-3']);
  assert.equal(plan.focusedPaneId, 'pane-1');
  assert.deepEqual(plan.panes, [
    { id: '1', paneId: 'pane-1', cwd: '/work/a', engine: 'codex', apiTitle: '#12 表記', apiPrUrl: 'https://github.com/o/r/pull/1', apiPaneNote: 'watching', apiPrMerged: true, createdByAutomation: true },
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

test('閉じる保護と外部からの入力待ちも、作り直したウィンドウへ戻す', () => {
  const layout = {
    order: ['pane-1', 'pane-2', 'pane-3'],
    panes: [
      { paneId: 'pane-1', termId: '1', lock: { close: false }, externalWaiting: true },
      { paneId: 'pane-2', termId: '2', lock: { close: 'no', extra: 1 }, externalWaiting: 'yes' },
      { paneId: 'pane-3', termId: '3', lock: null },
    ],
  };
  const plan = planLivePaneReattach({ liveIds: ['1', '2', '3'], layout, defaultCwd: '/home' });
  assert.deepEqual(plan.panes[0].lock, { close: false });
  assert.equal(plan.panes[0].externalWaiting, true);
  // 形の合わない値は保護なし・項目なしにする
  assert.equal(plan.panes[1].lock, null);
  assert.equal(Object.hasOwn(plan.panes[1], 'externalWaiting'), false);
  assert.equal(plan.panes[2].lock, null);
});

test('ウィンドウが無い間の閉じる保護・入力待ちの更新を並びの記録へ反映する', () => {
  const layout = { panes: [{ paneId: 'pane-1', termId: '4', lock: null }] };
  const locked = applyPaneStateToLayout(layout, '4', { lock: { close: false } });
  assert.deepEqual(locked.panes[0].lock, { close: false });
  const waiting = applyPaneStateToLayout(locked, '4', { externalWaiting: true });
  assert.deepEqual(waiting.panes[0], { paneId: 'pane-1', termId: '4', lock: { close: false }, externalWaiting: true });
  assert.equal(applyPaneStateToLayout(layout, '9', { lock: null }), layout);
});

test('作業フォルダの通知は最後のものを採り、チャンクの境界で切れた通知も読む', () => {
  const { createCwdReportReader } = require('../renderer/terminalDisplay');
  const report = dir => `\x1b]7;file://host${dir}\x07`;
  // 覚えておいた出力をまとめて流したとき（/a から /b へ移動した履歴）は /b
  assert.equal(createCwdReportReader().feed(`$ ${report('/a')}cd b\r\n${report('/b')}$ `), '/b');
  // ESC \ で終わる通知・URL エンコードされたパス
  assert.equal(createCwdReportReader().feed('\x1b]7;file://h/tmp/%E4%BD%9C%E6%A5%AD\x1b\\'), '/tmp/作業');
  // 通知が無い・壊れた通知は null
  assert.equal(createCwdReportReader().feed('plain output'), null);
  assert.equal(createCwdReportReader().feed('\x1b]7;file://h/%E0%A4%A\x07'), null);
  // 境界で切れた通知（始まりの途中・本文の途中）は次の出力と合わせて読む
  const whole = `out${report('/work/c')}after`;
  for (const cut of [4, 5, 6, 7, 15, 21]) {
    const reader = createCwdReportReader();
    assert.equal(reader.feed(whole.slice(0, cut)), null, `cut ${cut}`);
    assert.equal(reader.feed(whole.slice(cut)), '/work/c', `cut ${cut}`);
  }
  // 持ち越した後に完結した通知を読んだら、持ち越しは消える
  const reader = createCwdReportReader();
  assert.equal(reader.feed('\x1b]7;file://h/x'), null);
  assert.equal(reader.feed('\x07'), '/x');
  assert.equal(reader.feed('next'), null);
});

test('履歴の取得待ちの途中でウィンドウを作り直しても、古い取得の完了で新しい復元を終わらせない', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.on('terminal:restore-ready',");
  const end = source.indexOf("ipcMain.on('terminal:save-layout',", start);
  assert.ok(start !== -1 && end > start);
  // 取得の完了を外から決められる tmux の代役
  const captures = [];
  const tmuxHolder = {
    command() {},
    capturePaneWithMode() {
      return new Promise(resolve => captures.push(history => resolve({ history, modeOutput: '' })));
    },
  };
  const finished = [];
  const pane = {
    isTmuxPane: true, paneId: '%1', windowId: '@1', replay: null, pendingReplay: null,
    beginReplay() { this.replay = { phase: 'capturing' }; },
    endCapture() {},
    finishReplay(history) { finished.push(history); this.replay = null; },
  };
  const firstWindow = { isDestroyed: () => false, webContents: { id: 'first' } };
  const secondWindow = { isDestroyed: () => false, webContents: { id: 'second' } };
  let handler;
  const context = {
    ipcMain: { on: (_name, callback) => { handler = callback; } },
    ptys: new Map([['1', pane]]), tmuxHolder, win: firstWindow,
    outputReplay: { isHeld: () => false }, finishOutputReplay() {},
    buildInputModeSequence: () => '', MODE_FORMAT: '', LOG_PREFIX: 'test', console: { warn() {} },
    lastPaneLayout: null, saveHolderLayout() {},
  };
  vm.runInNewContext(source.slice(start, end), context);

  // 1 枚目のウィンドウの復元を始め、履歴の取得を待っている間にウィンドウを作り直す
  pane.beginReplay();
  pane.pendingReplay = pane.replay;
  const firstReady = handler({ sender: firstWindow.webContents }, [{ id: '1', cols: 80, rows: 24 }]);
  context.win = secondWindow;
  pane.beginReplay();
  pane.pendingReplay = pane.replay;
  const secondReplay = pane.replay;
  const secondReady = handler({ sender: secondWindow.webContents }, [{ id: '1', cols: 100, rows: 30 }]);
  // 閉じたウィンドウから遅れて届いた準備完了は受け付けない
  await handler({ sender: firstWindow.webContents }, [{ id: '1', cols: 80, rows: 24 }]);
  assert.equal(captures.length, 2);

  // 古い取得が先に終わっても、新しい復元は続いたまま（入力の保留も解けない）
  captures[0]('old history');
  await firstReady;
  assert.deepEqual(finished, []);
  assert.equal(pane.pendingReplay, secondReplay);
  assert.equal(pane.replay, secondReplay);

  // 新しい取得が終わったときだけ、履歴を流して復元を終える
  captures[1]('new history');
  await secondReady;
  assert.deepEqual(finished, ['new history']);
  assert.equal(pane.pendingReplay, null);
});

/**
 * main.js の terminal:restore-ready の処理だけを取り出し、tmux とウィンドウを代役にして動かす。
 * 履歴の取得はペインごとに外から完了させられる。
 */
function loadRestoreReadyHandler() {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.on('terminal:restore-ready',");
  const end = source.indexOf("ipcMain.on('terminal:save-layout',", start);
  assert.ok(start !== -1 && end > start);
  const captures = [];
  const commands = [];
  const finishedOutput = [];
  const held = new Set();
  const tmuxHolder = {
    command(args) { commands.push(args.join(' ')); },
    capturePaneWithMode(paneId) {
      return new Promise(resolve => captures.push({ paneId, done: history => resolve({ history, modeOutput: '' }) }));
    },
  };
  const makeTmuxPane = (paneId, windowId) => ({
    isTmuxPane: true, paneId, windowId, replay: null, pendingReplay: null, finished: [],
    beginReplay() { this.replay = { phase: 'capturing' }; },
    endCapture() {},
    // 本物と同じく、復元中でなければ何もしない
    finishReplay(history) { if (!this.replay) return; this.finished.push(history); this.replay = null; },
  });
  const panes = { '1': makeTmuxPane('%1', '@1'), '2': makeTmuxPane('%2', '@2'), '3': { isTmuxPane: false } };
  let handler;
  const outputReplay = { isHeld: id => held.has(id), release: id => { held.delete(id); } };
  const context = {
    ipcMain: { on: (_name, callback) => { handler = callback; } },
    ptys: new Map(Object.entries(panes)), tmuxHolder, win: null,
    outputReplay,
    finishOutputReplay(id, _pane, ready) { held.delete(id); finishedOutput.push(`${id} ${ready.cols}x${ready.rows}`); },
    buildInputModeSequence: () => '', MODE_FORMAT: '', LOG_PREFIX: 'test', console: { warn() {} },
    lastPaneLayout: null, saveHolderLayout() {},
  };
  vm.runInNewContext(source.slice(start, end), context);
  // reattachLiveTerminalPanes と同じく、保持役のペインは復元の目印を、それ以外は出力の保留を置く
  const beginRestore = () => {
    for (const pane of [panes['1'], panes['2']]) { pane.beginReplay(); pane.pendingReplay = pane.replay; }
    held.add('3');
  };
  // main.js のウィンドウの closed と同じく、win を外してから復元待ちを終える
  const closeWindow = () => {
    context.win = null;
    releasePendingPaneRestores(context.ptys, outputReplay);
  };
  const isHeld = id => held.has(id);
  return { handler, context, panes, captures, commands, finishedOutput, beginRestore, closeWindow, isHeld };
}

const readyAt = (cols, rows) => ['1', '2', '3'].map(id => ({ id, cols, rows }));
const flush = () => new Promise(resolve => setImmediate(resolve));
// 古い画面の処理が別のペインの取得を待ち続けても（修正が戻った場合）、テストが止まらずに落ちるよう、
// 少し待って終わったかを返す
const settles = promise => Promise.race([promise.then(() => true), flush().then(flush).then(() => false)]);

for (const oldFirst of [true, false]) {
  test(`複数ペインの復元中に作り直すと、古い画面の処理は残りのペインに触れない（古い取得の完了が${oldFirst ? '先' : '後'}）`, async () => {
    const { handler, context, panes, captures, commands, finishedOutput, beginRestore } = loadRestoreReadyHandler();
    const firstWindow = { webContents: { id: 'first' } };
    const secondWindow = { webContents: { id: 'second' } };
    context.win = firstWindow;
    beginRestore();
    const firstReady = handler({ sender: firstWindow.webContents }, readyAt(80, 24));
    // 1 枚目の履歴の取得を待っている間にウィンドウを作り直し、新しい画面の復元を始める
    context.win = secondWindow;
    beginRestore();
    const secondReplays = [panes['1'].pendingReplay, panes['2'].pendingReplay];
    const secondReady = handler({ sender: secondWindow.webContents }, readyAt(100, 30));
    assert.deepEqual(captures.map(capture => capture.paneId), ['%1', '%1']);
    const [oldCapture, newCapture] = captures;

    if (oldFirst) {
      oldCapture.done('old 1');
      assert.ok(await settles(firstReady), '古い画面の処理が 2 枚目の取得を待っている');
      // 古い画面の処理は、2 枚目を古い画面の大きさにせず、取得も始めず、3 枚目の保留も解かない
      assert.deepEqual(commands, ['resize-window -t @1 -x 80 -y 24', 'resize-window -t @1 -x 100 -y 30']);
      assert.equal(captures.length, 2);
      assert.deepEqual(finishedOutput, []);
      assert.deepEqual([panes['1'].pendingReplay, panes['2'].pendingReplay], secondReplays);
      newCapture.done('new 1');
    } else {
      newCapture.done('new 1');
      await flush();
      oldCapture.done('old 1');
      assert.ok(await settles(firstReady), '古い画面の処理が 2 枚目の取得を待っている');
    }
    await flush();
    // 新しい画面の処理だけが 2 枚目へ進む
    assert.deepEqual(captures.map(capture => capture.paneId), ['%1', '%1', '%2']);
    captures[2].done('new 2');
    await secondReady;
    assert.deepEqual(commands, ['resize-window -t @1 -x 80 -y 24', 'resize-window -t @1 -x 100 -y 30', 'resize-window -t @2 -x 100 -y 30']);
    assert.deepEqual(panes['1'].finished, ['new 1']);
    assert.deepEqual(panes['2'].finished, ['new 2']);
    assert.deepEqual(finishedOutput, ['3 100x30']);
    assert.equal(panes['1'].pendingReplay, null);
    assert.equal(panes['2'].pendingReplay, null);
  });
}

test('作り直した画面がまだ復元を始めていなくても、古い画面の取得の結果は流さない', async () => {
  const { handler, context, panes, captures, commands, finishedOutput, beginRestore } = loadRestoreReadyHandler();
  const firstWindow = { webContents: { id: 'first' } };
  context.win = firstWindow;
  beginRestore();
  const oldReplay = panes['1'].pendingReplay;
  const firstReady = handler({ sender: firstWindow.webContents }, readyAt(80, 24));
  // ウィンドウを作り直したが、新しい画面はまだ terminal:restore を問い合わせていない
  context.win = { webContents: { id: 'second' } };
  captures[0].done('old 1');
  assert.ok(await settles(firstReady), '古い画面の処理が 2 枚目の取得を待っている');
  // 古い画面の履歴は新しい画面へ流さず、復元の続き（新しい画面の問い合わせ）に任せる
  assert.deepEqual(panes['1'].finished, []);
  assert.equal(panes['1'].pendingReplay, oldReplay);
  assert.equal(captures.length, 1);
  assert.deepEqual(commands, ['resize-window -t @1 -x 80 -y 24']);
  assert.deepEqual(finishedOutput, []);
});

test('ウィンドウを閉じたら、復元待ちを終えて入力の保留を解く（ペインは管理対象に残す）', () => {
  const finished = [];
  const tmuxPane = {
    isTmuxPane: true, replay: { phase: 'capturing' }, pendingReplay: null, ended: null,
    endCapture(replay) { this.ended = replay; },
    finishReplay(history, modes) { finished.push([history, modes]); this.replay = null; },
  };
  tmuxPane.pendingReplay = tmuxPane.replay;
  const capturing = tmuxPane.replay;
  const idleTmuxPane = { isTmuxPane: true, replay: null, pendingReplay: null, finishReplay() { throw new Error('復元中でないペインは触らない'); } };
  const released = [];
  const panes = new Map([['1', tmuxPane], ['2', idleTmuxPane], ['3', { isTmuxPane: false }]]);
  releasePendingPaneRestores(panes, { release: id => released.push(id) });
  assert.equal(tmuxPane.ended, capturing);
  assert.deepEqual(finished, [['', '']]);
  assert.equal(tmuxPane.pendingReplay, null);
  assert.deepEqual(released, ['3']);
  assert.deepEqual([...panes.keys()], ['1', '2', '3']);
  // main.js のウィンドウの closed では、閉じたのが今のウィンドウのときだけ、win を外してから 1 度だけ終える
  // （作り直した後に古いウィンドウの closed が届いても、新しいウィンドウの復元を終わらせない）
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("win.on('closed', () => {");
  const body = source.slice(start, source.indexOf('\n  });', start));
  assert.ok(start !== -1);
  assert.equal(body.split('releasePendingPaneRestores(').length - 1, 1);
  assert.ok(body.indexOf('if (win !== createdWindow) return;') < body.indexOf('win = null;'));
  assert.ok(body.indexOf('win = null;') < body.indexOf('releasePendingPaneRestores(ptys, outputReplay);'));
});

for (const reattach of [false, true]) {
  test(`画面の準備完了が届く前にウィンドウを閉じても、入力の保留が残らない（${reattach ? '作り直した画面の復元' : '起動時の復元'}）`, async () => {
    const { handler, context, panes, captures, beginRestore, closeWindow, isHeld } = loadRestoreReadyHandler();
    const window = { webContents: { id: 'first' } };
    context.win = window;
    if (reattach) {
      // 1 枚目のウィンドウの復元を途中で打ち切って作り直し、新しい画面も準備完了の前に閉じる
      beginRestore();
      const oldReady = handler({ sender: window.webContents }, readyAt(80, 24));
      context.win = { webContents: { id: 'second' } };
      beginRestore();
      closeWindow();
      captures[0].done('old 1');
      assert.ok(await settles(oldReady), '古い画面の処理が終わっていない');
    } else {
      beginRestore();
      closeWindow();
    }
    // 履歴を流さずに復元を終え（二重には終えない）、目印と出力の保留も外す
    assert.deepEqual(panes['1'].finished, ['']);
    assert.deepEqual(panes['2'].finished, ['']);
    assert.equal(panes['1'].replay, null);
    assert.equal(panes['2'].replay, null);
    assert.equal(panes['1'].pendingReplay, null);
    assert.equal(panes['2'].pendingReplay, null);
    assert.equal(isHeld('3'), false);
    // 閉じた画面から遅れて届いた準備完了は何もしない
    await handler({ sender: window.webContents }, readyAt(80, 24));
    assert.equal(captures.length, reattach ? 1 : 0);
  });
}

test('履歴の取得中にウィンドウを閉じたら、取得の結果は流さず、残りのペインにも触れない', async () => {
  const { handler, context, panes, captures, commands, finishedOutput, beginRestore, closeWindow, isHeld } = loadRestoreReadyHandler();
  const window = { webContents: { id: 'first' } };
  context.win = window;
  beginRestore();
  const ready = handler({ sender: window.webContents }, readyAt(80, 24));
  closeWindow();
  captures[0].done('old 1');
  assert.ok(await settles(ready), '古い画面の処理が 2 枚目の取得を待っている');
  assert.deepEqual(panes['1'].finished, ['']);
  assert.deepEqual(panes['2'].finished, ['']);
  assert.equal(captures.length, 1);
  assert.deepEqual(commands, ['resize-window -t @1 -x 80 -y 24']);
  assert.deepEqual(finishedOutput, []);
  assert.equal(isHeld('3'), false);

  // 次のウィンドウの復元はふつうに終わる
  const next = { webContents: { id: 'second' } };
  context.win = next;
  beginRestore();
  const nextReady = handler({ sender: next.webContents }, readyAt(100, 30));
  captures[1].done('new 1');
  await flush();
  captures[2].done('new 2');
  await nextReady;
  assert.deepEqual(panes['1'].finished, ['', 'new 1']);
  assert.deepEqual(panes['2'].finished, ['', 'new 2']);
  assert.deepEqual(finishedOutput, ['3 100x30']);
});
