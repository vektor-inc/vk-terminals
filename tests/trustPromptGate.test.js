'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TRUST_WINDOW_MS,
  createTrustPromptGate,
} = require('../utils/trustPromptGate');

test('canAutoRespond: 窓の内側 かつ ready 未検知なら発火する', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // ペイン作成から 1 秒後（窓の内側）
  assert.equal(gate.canAutoRespond(spawnTime + 1000), true);
});

test('canAutoRespond: 窓の外（経過時間超過）なら発火しない', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // ペイン作成から TRUST_WINDOW_MS を 1ms 超えた時刻
  assert.equal(gate.canAutoRespond(spawnTime + TRUST_WINDOW_MS + 1), false);
});

test('canAutoRespond: 窓ちょうどの経過時間（境界）はまだ発火する', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  assert.equal(gate.canAutoRespond(spawnTime + TRUST_WINDOW_MS), true);
});

test('canAutoRespond: ready 検知済みなら窓の内側でも発火しない', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  gate.markReadyDetected();

  // 窓の内側（ペイン作成から 100ms 後）だが ready 検知済みのため発火しない
  assert.equal(gate.canAutoRespond(spawnTime + 100), false);
  assert.equal(gate.isReadyDetected(), true);
});

test('canAutoRespond: 一度発火（markTrustHandled）したら二度目は発火しない', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // 1回目: 窓の内側・ready 未検知なので発火してよい
  assert.equal(gate.canAutoRespond(spawnTime + 500), true);
  gate.markTrustHandled();

  // 2回目: 同じ窓の内側でも、既に発火済みのため発火しない
  assert.equal(gate.canAutoRespond(spawnTime + 600), false);
  assert.equal(gate.isTrustHandled(), true);
});

test('shouldStopWatching: 窓が閉じ、initialCommand も送られる見込みが無ければ監視終了と判定する', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // 経過時間超過で窓が閉じている・initialCommand も送信済み（pending ではない）
  const now = spawnTime + TRUST_WINDOW_MS + 1;
  assert.equal(gate.shouldStopWatching(now, { initialCommandPending: false }), true);
});

test('shouldStopWatching: ready 検知で窓が閉じても、initialCommand がまだ送られうるなら監視を続ける', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  gate.markReadyDetected();

  // 窓は閉じている（ready 検知済み）が、initialCommand の送信がまだ起こりうる場合は
  // READY_PATTERN 検知による sendInitialCommand 呼び出しが完了するまで監視を続ける必要がある
  assert.equal(
    gate.shouldStopWatching(spawnTime + 100, { initialCommandPending: true }),
    false
  );
});

test('shouldStopWatching: 窓が開いている間は initialCommand が pending でなくても監視を続ける', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime });

  // 窓の内側・ready 未検知（まだ信頼確認が出うる）なので、initialCommand が pending
  // でなくても監視を止めてはいけない
  assert.equal(
    gate.shouldStopWatching(spawnTime + 100, { initialCommandPending: false }),
    false
  );
});

test('createTrustPromptGate: spawnTime 未指定は例外を投げる', () => {
  assert.throws(() => createTrustPromptGate({}), TypeError);
  assert.throws(() => createTrustPromptGate(), TypeError);
});

test('createTrustPromptGate: trustWindowMs を指定すると既定の TRUST_WINDOW_MS を上書きできる', () => {
  const spawnTime = 1000;
  const gate = createTrustPromptGate({ spawnTime, trustWindowMs: 5000 });

  assert.equal(gate.canAutoRespond(spawnTime + 5000), true);
  assert.equal(gate.canAutoRespond(spawnTime + 5001), false);
});
