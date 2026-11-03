'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveDisplayWaiting,
  deriveStatus,
  isManagedPaneState,
  shouldBeepForPaneWaiting,
} = require('../renderer/statusState');

test('isManagedPaneState: 空でない文字列の apiUrl だけを管理ペインと判定する', () => {
  assert.equal(isManagedPaneState({ apiUrl: 'https://example.com/task' }), true);
  assert.equal(isManagedPaneState({ apiUrl: '' }), false);
  assert.equal(isManagedPaneState({}), false);
});

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

test('deriveDisplayWaiting: 管理ペインは構造的待ちまたは外部権威だけを表示する', () => {
  assert.equal(deriveDisplayWaiting({ localWaiting: true, structuralWaiting: false, externalWaiting: false, apiUrl: 'https://example.com/task' }), false);
  assert.equal(deriveDisplayWaiting({ localWaiting: true, structuralWaiting: true, externalWaiting: false, apiUrl: 'https://example.com/task' }), true);
  assert.equal(deriveDisplayWaiting({ localWaiting: true, structuralWaiting: false, externalWaiting: true, apiUrl: 'https://example.com/task' }), true);
});

test('deriveDisplayWaiting: 非管理ペインと apiUrl クリア後は従来のローカル待ちを表示する', () => {
  assert.equal(deriveDisplayWaiting({ localWaiting: true, structuralWaiting: false, externalWaiting: false, apiUrl: '' }), true);
  assert.equal(deriveDisplayWaiting({ localWaiting: true, structuralWaiting: false, externalWaiting: false }), true);
});

test('API 用 status は管理ペインの地の文でも従来どおり waiting のまま', () => {
  assert.equal(status({ localWaiting: true, externalWaiting: false }), 'waiting');
  assert.equal(deriveDisplayWaiting({ localWaiting: true, structuralWaiting: false, externalWaiting: false, apiUrl: 'https://example.com/task' }), false);
});

test('shouldBeepForPaneWaiting: 管理ペインは表示上の off→on だけで鳴らす', () => {
  assert.equal(shouldBeepForPaneWaiting({
    apiUrl: 'https://example.com/task', waitingBefore: true, waiting: true,
    displayWaitingBefore: false, displayWaiting: true,
  }), true);
  assert.equal(shouldBeepForPaneWaiting({
    apiUrl: 'https://example.com/task', waitingBefore: false, waiting: true,
    displayWaitingBefore: true, displayWaiting: true,
  }), false);
});

test('shouldBeepForPaneWaiting: 非管理ペインは従来どおり waiting の false→true で鳴らす', () => {
  assert.equal(shouldBeepForPaneWaiting({
    apiUrl: '', waitingBefore: false, waiting: true,
    displayWaitingBefore: true, displayWaiting: true,
  }), true);
  assert.equal(shouldBeepForPaneWaiting({
    waitingBefore: true, waiting: true,
    displayWaitingBefore: false, displayWaiting: true,
  }), false);
});
