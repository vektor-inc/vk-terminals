'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { waitForPtyExit, waitForAllPtysExit } = require('../utils/ptyShutdown');

// 実時間を待たずに検証できるよう、setTimeout / clearTimeout を差し替える簡易クロック
// （tests/autoClose.test.js と同じ手法）。
function fakeClock() {
  let now = 0;
  let nextId = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      nextId += 1;
      pending.set(nextId, { fn, at: now + ms });
      return nextId;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    // ms 進めて、期限を迎えたものを発火させる。
    tick(ms) {
      now += ms;
      for (const [id, item] of [...pending]) {
        if (item.at > now) continue;
        pending.delete(id);
        item.fn();
      }
    },
  };
}

// node-pty の IPty 互換の偽オブジェクト。kill() された signal を記録し、
// _fireExit() で onExit に登録済みのコールバックを呼べる。
function createFakePty() {
  const killedSignals = [];
  const onExitCallbacks = [];
  return {
    kill(signal) {
      killedSignals.push(signal);
    },
    onExit(cb) {
      onExitCallbacks.push(cb);
      return { dispose() {} };
    },
    _fireExit() {
      for (const cb of [...onExitCallbacks]) cb();
    },
    _killedSignals: killedSignals,
  };
}

test('waitForPtyExit: kill を送った後、onExit が届くまで resolve しない', async () => {
  const pty = createFakePty();
  let resolved = false;
  const promise = waitForPtyExit(pty).then(() => { resolved = true; });

  // マイクロタスクを一巡させても、onExit が来ていなければ resolve しないはず。
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.deepEqual(pty._killedSignals, [undefined]); // 通常の kill() が1回送られている

  pty._fireExit();
  await promise;
  assert.equal(resolved, true);
  assert.deepEqual(pty._killedSignals, [undefined]); // onExit が間に合えば SIGKILL は送らない
});

test('waitForPtyExit: 上限（graceMs）を超えても onExit が届かなければ SIGKILL で強制終了する', async () => {
  const pty = createFakePty();
  const clock = fakeClock();
  let resolved = false;
  const promise = waitForPtyExit(pty, {
    graceMs: 1000,
    forceMs: 300,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }).then(() => { resolved = true; });

  assert.deepEqual(pty._killedSignals, [undefined]);

  clock.tick(999);
  await Promise.resolve();
  assert.equal(resolved, false);
  assert.deepEqual(pty._killedSignals, [undefined]); // まだ graceMs 未到達

  clock.tick(1); // graceMs 到達 → SIGKILL
  await Promise.resolve();
  assert.deepEqual(pty._killedSignals, [undefined, 'SIGKILL']);
  assert.equal(resolved, false); // forceMs はまだ経過していない

  clock.tick(300); // forceMs 到達 → 待ちきれず諦めて resolve
  await Promise.resolve();
  assert.equal(resolved, true);
});

test('waitForPtyExit: SIGKILL 後でも onExit が届けば forceMs を待たず resolve する', async () => {
  const pty = createFakePty();
  const clock = fakeClock();
  let resolved = false;
  const promise = waitForPtyExit(pty, {
    graceMs: 1000,
    forceMs: 300,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }).then(() => { resolved = true; });

  clock.tick(1000); // SIGKILL 送信
  await Promise.resolve();
  assert.deepEqual(pty._killedSignals, [undefined, 'SIGKILL']);

  pty._fireExit(); // forceMs 経過前に終了通知が届く
  await promise;
  assert.equal(resolved, true);
});

test('waitForAllPtysExit: pty が0件なら待たずに即 resolve する', async () => {
  await waitForAllPtysExit([]);
  assert.ok(true); // ここに到達すれば待ち時間なしに解決している
});

test('waitForAllPtysExit: すべての pty の onExit が届くまで resolve しない', async () => {
  const ptyA = createFakePty();
  const ptyB = createFakePty();
  let resolved = false;
  const promise = waitForAllPtysExit([ptyA, ptyB]).then(() => { resolved = true; });

  ptyA._fireExit();
  await Promise.resolve();
  assert.equal(resolved, false); // ptyB がまだ終了していない

  ptyB._fireExit();
  await promise;
  assert.equal(resolved, true);
});

test('waitForPtyExit: onExit を持たないオブジェクトは待たずに resolve する', async () => {
  const brokenPty = {
    kill() {},
    onExit() { throw new Error('not supported'); },
  };
  await waitForPtyExit(brokenPty);
  assert.ok(true);
});
