'use strict';

// タスク一覧の再取得ボタンの取得中状態（renderer/taskRefreshState.js。issue #617）の単体テスト。
// 時計とタイマーを差し替え、古い依頼のタイマーや遅れて届く送信失敗が、押し直した依頼の
// 取得中を解除しないことを確かめる（実アプリでは IPC の応答を遅らせられないため単体で検証する）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { createTaskRefreshState } = require('../renderer/taskRefreshState');

// 手動で進める時計とタイマーを用意する。
function setup() {
  let clock = 1000;
  const timers = new Map();
  let nextId = 1;
  const changes = [];
  const state = createTaskRefreshState({
    timeoutMs: 60000,
    onChange: (busy) => changes.push(busy),
    now: () => clock,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: clock + ms }); return id; },
    clearTimer: (id) => { timers.delete(id); },
  });
  // 指定時間進め、期限が来たタイマーを実行する。
  function advance(ms) {
    clock += ms;
    for (const [id, t] of [...timers]) {
      if (t.at <= clock) { timers.delete(id); t.fn(); }
    }
  }
  return { state, changes, advance, timers, now: () => clock };
}

test('start: 取得中は新しい依頼を受け付けない（連打）', () => {
  const { state, changes } = setup();
  const token = state.start();
  assert.notEqual(token, null);
  assert.equal(state.start(), null);
  assert.equal(state.isBusy(), true);
  assert.deepEqual(changes, [true]);
});

test('タイムアウトで解除し、タイマーは解除後に残らない', () => {
  const { state, changes, advance, timers } = setup();
  state.start();
  advance(59999);
  assert.equal(state.isBusy(), true);
  advance(1);
  assert.equal(state.isBusy(), false);
  assert.deepEqual(changes, [true, false]);
  assert.equal(timers.size, 0);
});

test('タイムアウト後に押し直した依頼は、最初の依頼の送信失敗が遅れて届いても解除されない', () => {
  const { state, advance, timers } = setup();
  const first = state.start();
  advance(60000);
  const second = state.start();
  assert.notEqual(second, first);
  // 最初の依頼の失敗が遅れて届く。今の依頼ではないので解除しない（トースト判定にも使う戻り値は false）。
  assert.equal(state.finish(first), false);
  assert.equal(state.isBusy(), true);
  // 押し直した依頼のタイマーは消えていない。
  assert.equal(timers.size, 1);
  advance(60000);
  assert.equal(state.isBusy(), false);
});

test('一覧の更新で解除した後に押し直した依頼も、古い依頼の失敗では解除されない', () => {
  const { state, advance, now } = setup();
  const first = state.start();
  advance(1000);
  assert.equal(state.finishIfNewer(now()), true);
  const second = state.start();
  assert.equal(state.finish(first), false);
  assert.equal(state.isBusy(), true);
  assert.equal(state.finish(second), true);
  assert.equal(state.isBusy(), false);
});

test('宣言の消失で解除した後に押し直した依頼も、古い依頼の失敗では解除されない', () => {
  const { state } = setup();
  const first = state.start();
  assert.equal(state.cancel(), true);
  state.start();
  assert.equal(state.finish(first), false);
  assert.equal(state.isBusy(), true);
});

test('finishIfNewer: 押した時刻以前の updatedAt や読めない値では解除しない', () => {
  const { state, now } = setup();
  state.start();
  assert.equal(state.finishIfNewer(now()), false);
  assert.equal(state.finishIfNewer(now() - 1), false);
  assert.equal(state.finishIfNewer(NaN), false);
  assert.equal(state.isBusy(), true);
  assert.equal(state.finishIfNewer(now() + 1), true);
  assert.equal(state.isBusy(), false);
});

test('取得中でないときの finish / cancel / finishIfNewer は何もしない', () => {
  const { state, changes } = setup();
  assert.equal(state.finish(1), false);
  assert.equal(state.cancel(), false);
  assert.equal(state.finishIfNewer(Date.now()), false);
  assert.deepEqual(changes, []);
});
