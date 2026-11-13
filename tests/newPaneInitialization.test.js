const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('初期化前の新規ペイン要求は端末を作らずエラーを返す', async () => {
  const source = fs.readFileSync(process.env.VK_NEW_PANE_TEST_SOURCE || path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const start = source.indexOf("VKIpc.on('terminal:request-new-pane'");
  const end = source.indexOf("VKIpc.on('terminal:request-close-pane'", start);
  assert.ok(start >= 0 && end > start);

  let handler;
  const replies = [];
  let created = 0;
  const context = {
    initialRenderDone: false,
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
  // IPC ハンドラーだけを評価し、起動前の状態を決定的に再現する。
  vm.runInNewContext(source.slice(start, end), context);
  await handler({ requestId: 'before', noClaude: true });

  assert.equal(created, 0);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].requestId, 'before');
  assert.equal(replies[0].error, 'renderer not initialized');
});
