'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MARKER_PREFIX,
  MAX_MARKER_LENGTH,
  createAgentLifecycleStore,
  buildTrackedLaunchCommand,
  createAgentLifecycleMarkerParser,
  mergeAgentLifecycleStates,
} = require('../utils/agentLifecycle');

const TOKEN_A = 'a'.repeat(64);
const TOKEN_B = 'b'.repeat(64);

test('ライフサイクル: spawn と exit の現在世代トークンを別々に厳密照合する', () => {
  const tokens = [TOKEN_A, TOKEN_B, 'c'.repeat(64), 'd'.repeat(64)];
  const store = createAgentLifecycleStore(() => tokens.shift());
  store.initialize('1', 1);
  const first = store.prepare('1', 1);
  assert.equal(store.get('1', 1), null);
  assert.equal(store.markExited('1', 1, first.exitToken), false);
  assert.equal(store.markStarted('1', 1, first.startToken), true);
  assert.equal(store.get('1', 1), 'running');
  const second = store.prepare('1', 2);
  assert.equal(store.markStarted('1', 2, TOKEN_A), false);
  assert.equal(store.get('1', 2), null);
  assert.equal(store.markStarted('1', 2, second.startToken), true);
  assert.equal(store.get('1', 1), null);
  assert.equal(store.get('1', 2), 'running');
  assert.equal(store.markExited('1', first.generation, first.exitToken), false);
  assert.equal(store.markExited('1', second.generation, TOKEN_A), false);
  assert.equal(store.get('1', 2), 'running');
  assert.equal(store.markExited('1', second.generation, second.exitToken), true);
  assert.equal(store.get('1', 2), 'exited');
});

test('ライフサイクル: 起動を書き込めない世代と追跡できない状態は null に倒す', () => {
  const tokens = [TOKEN_A, TOKEN_B];
  const store = createAgentLifecycleStore(() => tokens.shift());
  store.initialize('plain', 0);
  assert.equal(store.get('plain', 0), null);
  const marker = store.prepare('agent', 1);
  store.markStarted('agent', 1, marker.startToken);
  assert.equal(store.markUnknown('agent', 1), true);
  assert.equal(store.get('agent', 1), null);
});

test('起動行: 元コマンドを改変せず監視プロセスの単一引数へ渡す', () => {
  const original = `env FOO='a b' codex --config 'x="y"'`;
  const command = buildTrackedLaunchCommand(original, { generation: 7, startToken: TOKEN_A, exitToken: TOKEN_B }, {
    executable: '/path with quote/node', monitorPath: "/app/it's monitor.js",
  });
  assert.equal(command.includes('\x1b'), false);
  assert.match(command, /^ELECTRON_RUN_AS_NODE=1 /);
  assert.match(command, / 7 a{64} b{64} /);
  const encoded = command.split(' ').at(-1);
  assert.equal(Buffer.from(encoded, 'base64').toString(), original);
});

test('出力パーサー: 分割された start/exit マーカーだけを画面から除き、厳密に通知する', () => {
  const markers = [];
  const parser = createAgentLifecycleMarkerParser((type, generation, token) => markers.push({ type, generation, token }));
  const startMarker = `${MARKER_PREFIX}start;3;${TOKEN_A}\x07`;
  const exitMarker = `${MARKER_PREFIX}exit;3;${TOKEN_B}\x07`;
  const markersText = startMarker + exitMarker;
  const chunks = ['before', markersText.slice(0, 2), markersText.slice(2, 91), markersText.slice(91), 'after'];
  const visible = chunks.map((chunk) => parser.push(chunk)).join('') + parser.flush();
  assert.equal(visible, 'beforeafter');
  assert.deepEqual(markers, [
    { type: 'start', generation: 3, token: TOKEN_A },
    { type: 'exit', generation: 3, token: TOKEN_B },
  ]);
});

test('出力パーサー: 類似文字列は消さず、未完候補を上限なく保持しない', () => {
  const markers = [];
  const parser = createAgentLifecycleMarkerParser((type, generation, token) => markers.push({ type, generation, token }));
  const malformed = `${MARKER_PREFIX}exit;3;short`;
  const visible = parser.push(malformed + 'x'.repeat(MAX_MARKER_LENGTH + 10)) + parser.flush();
  assert.equal(visible, malformed + 'x'.repeat(MAX_MARKER_LENGTH + 10));
  assert.deepEqual(markers, []);
});

test('状態マージ: 既存値を保ち、世代と客観状態を追加する', () => {
  const states = { pane: { termId: '4', status: 'idle' } };
  assert.deepEqual(
    mergeAgentLifecycleStates(states, () => 2, () => 'exited'),
    { pane: { termId: '4', status: 'idle', agentGeneration: 2, agentCommandState: 'exited' } }
  );
  assert.equal(states.pane.agentCommandState, undefined);
});
