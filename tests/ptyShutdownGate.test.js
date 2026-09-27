'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPtyShutdownGate } = require('../utils/ptyShutdownGate');

test('ptyShutdownGate: idle で待つべき pty が無ければ finalize を返し、done へ遷移する', () => {
  const gate = createPtyShutdownGate();
  assert.equal(gate.state, 'idle');
  assert.equal(gate.beginBeforeQuit(false), 'finalize');
  assert.equal(gate.state, 'done');
});

test('ptyShutdownGate: idle で待つべき pty があれば start を返し、pending へ遷移する', () => {
  const gate = createPtyShutdownGate();
  assert.equal(gate.beginBeforeQuit(true), 'start');
  assert.equal(gate.state, 'pending');
});

test('ptyShutdownGate: pending 中の再入は wait を返し、状態を変えない', () => {
  const gate = createPtyShutdownGate();
  gate.beginBeforeQuit(true); // → pending
  assert.equal(gate.beginBeforeQuit(true), 'wait');
  assert.equal(gate.state, 'pending');
  // 2回目以降、待つべき pty が無くなっていても pending 中は wait のまま
  // （cleanupPtys() の完了を finish() で明示的に伝えるまで状態は変わらない）。
  assert.equal(gate.beginBeforeQuit(false), 'wait');
  assert.equal(gate.state, 'pending');
});

test('ptyShutdownGate: finish() 後は done になり、以降の before-quit は skip を返す', () => {
  const gate = createPtyShutdownGate();
  gate.beginBeforeQuit(true); // → pending
  gate.finish();
  assert.equal(gate.state, 'done');
  assert.equal(gate.beginBeforeQuit(true), 'skip');
  assert.equal(gate.beginBeforeQuit(false), 'skip');
  assert.equal(gate.state, 'done');
});

test('ptyShutdownGate: isPaneCreationBlocked は idle のときだけ false', () => {
  const gate = createPtyShutdownGate();
  assert.equal(gate.isPaneCreationBlocked(), false);

  gate.beginBeforeQuit(true); // → pending
  assert.equal(gate.isPaneCreationBlocked(), true);

  gate.finish(); // → done
  assert.equal(gate.isPaneCreationBlocked(), true);
});

test('ptyShutdownGate: 待つべき pty が無いまま finalize された場合もペイン作成は拒否される（done 扱い）', () => {
  const gate = createPtyShutdownGate();
  gate.beginBeforeQuit(false); // → done（finalize）
  assert.equal(gate.isPaneCreationBlocked(), true);
});
