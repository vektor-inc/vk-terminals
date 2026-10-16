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

test('ライフサイクル: 現在世代の正しいトークンだけが running を exited にする', () => {
  const tokens = [TOKEN_A, TOKEN_B];
  const store = createAgentLifecycleStore(() => tokens.shift());
  store.initialize('1', 1);
  const first = store.prepare('1', 1);
  assert.equal(store.get('1', 1), null);
  assert.equal(store.markRunning('1', 1), true);
  assert.equal(store.get('1', 1), 'running');
  const second = store.prepare('1', 2);
  store.markRunning('1', 2);
  assert.equal(store.get('1', 1), null);
  assert.equal(store.get('1', 2), 'running');
  assert.equal(store.markExited('1', first.generation, first.token), false);
  assert.equal(store.markExited('1', second.generation, TOKEN_A), false);
  assert.equal(store.get('1', 2), 'running');
  assert.equal(store.markExited('1', second.generation, second.token), true);
  assert.equal(store.get('1', 2), 'exited');
});

test('ライフサイクル: 起動を書き込めない世代と追跡できない状態は null に倒す', () => {
  const store = createAgentLifecycleStore(() => TOKEN_A);
  store.initialize('plain', 0);
  assert.equal(store.get('plain', 0), null);
  store.prepare('agent', 1);
  store.markRunning('agent', 1);
  assert.equal(store.markUnknown('agent', 1), true);
  assert.equal(store.get('agent', 1), null);
});

test('起動行: 実 ESC を入力行へ埋めず、コマンド終了後に世代固有マーカーを出す', () => {
  const command = buildTrackedLaunchCommand('codex --no-daemon', { generation: 7, token: TOKEN_A });
  assert.equal(command.includes('\x1b'), false);
  assert.match(command, /^\{ codex --no-daemon; printf /);
  assert.match(command, /agent-exit;7;a{64}/);
  assert.match(command, /\\007'; \}$/);
});

test('出力パーサー: 分割されたマーカーだけを画面から除き、厳密な通知を1回返す', () => {
  const markers = [];
  const parser = createAgentLifecycleMarkerParser((generation, token) => markers.push({ generation, token }));
  const marker = `${MARKER_PREFIX}3;${TOKEN_A}\x07`;
  const chunks = ['before', marker.slice(0, 2), marker.slice(2, 31), marker.slice(31), 'after'];
  const visible = chunks.map((chunk) => parser.push(chunk)).join('') + parser.flush();
  assert.equal(visible, 'beforeafter');
  assert.deepEqual(markers, [{ generation: 3, token: TOKEN_A }]);
});

test('出力パーサー: 類似文字列は消さず、未完候補を上限なく保持しない', () => {
  const markers = [];
  const parser = createAgentLifecycleMarkerParser((generation, token) => markers.push({ generation, token }));
  const malformed = `${MARKER_PREFIX}3;short`;
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
