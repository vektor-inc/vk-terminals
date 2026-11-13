const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = fs.readFileSync(process.env.VK_NEW_PANE_TEST_SOURCE || path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const start = source.indexOf("VKIpc.on('terminal:request-new-pane'");
const end = source.indexOf("VKIpc.on('terminal:request-close-pane'", start);
assert.ok(start >= 0 && end > start);

function makeHandler() {
  let handler;
  let finishInitialization;
  const replies = [];
  let created = 0;
  const context = {
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
  return { handler, context, replies, finishInitialization, created: () => created };
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
  const startupEnd = source.indexOf('// 設定モーダルの歯車ボタン', startupStart);
  assert.ok(startupStart >= 0 && startupEnd > startupStart);
  const sent = [];
  let rendered = 0;
  const context = {
    initApp: async () => { throw new Error('initial pane failed'); },
    console: { error: () => {} },
    tree: null,
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
