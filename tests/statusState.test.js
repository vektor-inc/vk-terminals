'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveStatus,
} = require('../renderer/statusState');

const RUNNING_IDLE_TIMEOUT_MS = 1500;
const RUNNING_INPUT_GUARD_MS = 200;

function status(overrides) {
  return deriveStatus({
    localWaiting: false,
    externalWaiting: false,
    now: 10000,
    lastOutputTime: 0,
    lastInputTime: 0,
    runningIdleTimeoutMs: RUNNING_IDLE_TIMEOUT_MS,
    runningInputGuardMs: RUNNING_INPUT_GUARD_MS,
    ...overrides,
  });
}

test('deriveStatus: 外部権威 waiting は自動入力直後でも waiting を維持する', () => {
  const lastOutputTime = 9700;
  const lastInputTime = 9950;

  assert.equal(status({ externalWaiting: true, lastOutputTime, lastInputTime }), 'waiting');
  assert.equal(status({ externalWaiting: false, lastOutputTime, lastInputTime }), 'idle');
});

test('deriveStatus: ローカル waiting が true なら waiting', () => {
  assert.equal(status({ localWaiting: true, externalWaiting: false }), 'waiting');
});

test('deriveStatus: ローカル waiting が false でも外部権威 waiting が true なら waiting', () => {
  assert.equal(status({ localWaiting: false, externalWaiting: true }), 'waiting');
});

test('deriveStatus: 直近出力あり・直近入力なしなら running', () => {
  assert.equal(status({ lastOutputTime: 9500, lastInputTime: 0 }), 'running');
});

test('deriveStatus: 直近入力ありなら idle', () => {
  assert.equal(status({ lastOutputTime: 9500, lastInputTime: 9950 }), 'idle');
});

test('deriveStatus: 出力も入力も古ければ idle', () => {
  assert.equal(status({ lastOutputTime: 1000, lastInputTime: 1000 }), 'idle');
});
