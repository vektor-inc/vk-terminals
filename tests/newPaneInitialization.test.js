const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

// 旧版での回帰確認にも同じテストを使えるよう、検査対象のソースを指定できる。
const source = fs.readFileSync(process.env.VK_NEW_PANE_TEST_SOURCE || path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const waitConstant = source.match(/const NEW_PANE_STARTUP_WAIT_MS = (\d+);/);
const start = source.indexOf("VKIpc.on('terminal:request-new-pane'");
const end = source.indexOf("VKIpc.on('terminal:request-close-pane'", start);
assert.ok(start >= 0 && end > start);

function makeHandler({ mockClock = false } = {}) {
  let handler;
  let finishInitialization;
  const replies = [];
  let created = 0;
  let now = 0;
  let fireTimeout;
  const context = {
    NEW_PANE_STARTUP_WAIT_MS: waitConstant ? Number(waitConstant[1]) : 12000,
    Date: { now: () => now },
    setTimeout: mockClock ? callback => { fireTimeout = callback; return 1; } : setTimeout,
    clearTimeout: mockClock ? () => {} : clearTimeout,
    initialRenderDone: false,
    initAppSettled: new Promise(resolve => { finishInitialization = resolve; }),
    tree: null,
    focusedPaneId: null,
    VKIpc: {
      on: (_channel, callback) => { handler = callback; },
      send: (_channel, result) => { replies.push(result); },
    },
    findLargestVisiblePaneId: () => null,
    getPaneRect: () => null,
    addPane: async () => { created++; return { paneId: 'pane-1', termId: '1' }; },
  };
  // IPC ハンドラーだけを評価し、初期化中の要求を再現する。
  vm.runInNewContext(source.slice(start, end), context);
  return { handler, context, replies, finishInitialization, created: () => created, advance: ms => { now += ms; if (fireTimeout) fireTimeout(); } };
}

test('初期化中の新規ペイン要求は完了まで端末を作らない', async () => {
  const state = makeHandler();
  const request = state.handler({ requestId: 'during', noClaude: true });
  await Promise.resolve();
  assert.equal(state.created(), 0);
  assert.equal(state.replies.length, 0);
  state.context.initialRenderDone = true;
  state.finishInitialization();
  await request;
  assert.equal(state.created(), 1);
  assert.equal(state.replies[0].termId, '1');
});

test('初期化が期限を超えたら端末を作らず返信し、後から完了しても作らない', async () => {
  const state = makeHandler({ mockClock: true });
  const request = state.handler({ requestId: 'late', noClaude: true });
  state.advance(12000);
  await Promise.race([request, new Promise((_, reject) => setTimeout(() => reject(new Error('返信なし')), 50))]);
  assert.equal(state.created(), 0);
  assert.match(state.replies[0].error, /起動中のため追加できませんでした/);
  state.context.initialRenderDone = true;
  state.finishInitialization();
  await Promise.resolve();
  assert.equal(state.created(), 0);
});

test('初期化が完了しても描画できなければ日本語のエラーを返す', async () => {
  const state = makeHandler();
  const request = state.handler({ requestId: 'failed', noClaude: true });
  state.finishInitialization();
  await request;
  assert.equal(state.created(), 0);
  assert.equal(state.replies.length, 1);
  assert.equal(state.replies[0].requestId, 'failed');
  assert.equal(state.replies[0].error, '起動中のため追加できませんでした。少し待ってからもう一度お試しください');
});

test('初期化例外後は空画面を描画して追加ペインの処理を再開する', async () => {
  const startupStart = source.indexOf('const initAppSettled = initApp()');
  const startupEnd = source.indexOf('setupSettingsPanel();', startupStart);
  assert.ok(startupStart >= 0 && startupEnd > startupStart);
  const sent = [];
  let rendered = 0;
  const context = {
    initApp: async () => { throw new Error('initial pane failed'); },
    console: { error: () => {} },
    tree: null,
    terminals: {},
    focusedPaneId: null,
    initialRenderDone: false,
    DEFAULT_SIDEBAR_WIDTH: 240,
    render: () => { rendered++; },
    VKIpc: { send: channel => sent.push(channel) },
  };
  vm.runInNewContext(`${source.slice(startupStart, startupEnd)}\nglobalThis.settled = initAppSettled;`, context);
  await context.settled;
  assert.equal(rendered, 1);
  assert.equal(context.initialRenderDone, true);
  assert.equal(context.tree.order.length, 0);
  assert.deepEqual(sent, ['terminal:renderer-ready']);
});

test('復旧描画も失敗した場合は初期化 Promise を拒否せず、後続要求にエラーを返す', async () => {
  const startupStart = source.indexOf('const initAppSettled = initApp()');
  const startupEnd = source.indexOf('setupSettingsPanel();', startupStart);
  const context = {
    initApp: async () => { throw new Error('initial pane failed'); },
    console: { error: () => {} },
    tree: { type: 'grid', order: ['pane-1', 'missing'], stashOrder: [] },
    terminals: { 'pane-1': {} },
    focusedPaneId: 'missing',
    initialRenderDone: false,
    render: () => { throw new Error('render failed'); },
    VKIpc: { send: () => {} },
  };
  vm.runInNewContext(`${source.slice(startupStart, startupEnd)}\nglobalThis.settled = initAppSettled;`, context);
  await context.settled;
  assert.equal(context.focusedPaneId, 'pane-1');
  assert.equal(context.tree.order.join(','), 'pane-1');
  assert.equal(context.initialRenderDone, false);
  const state = makeHandler();
  state.context.initAppSettled = context.settled;
  await state.handler({ requestId: 'recovery-failed' });
  assert.match(state.replies[0].error, /起動中のため追加できませんでした/);
});
