'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { createAutoCloseController } = require('../renderer/autoClose');

// 実時間を待たずに検証できるよう、setTimeout / clearTimeout を差し替える簡易クロック。
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
    get pendingCount() {
      return pending.size;
    },
  };
}

// 指定のクロックを使うコントローラと、発火回数のカウンタを組で返す。
function setup(options = {}) {
  const clock = fakeClock();
  const fired = { count: 0 };
  const controller = createAutoCloseController({
    delayMs: 2500,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    onFire: () => { fired.count += 1; },
    ...options,
  });
  return { clock, fired, controller };
}

test('arm: 武装すると指定時間後に発火する', () => {
  const { clock, fired, controller } = setup();
  assert.equal(controller.arm(), true);
  assert.equal(controller.isArmed, true);

  clock.tick(2499);
  assert.equal(fired.count, 0);
  clock.tick(1);
  assert.equal(fired.count, 1);
});

// 発火したらタイマーは保留中でなくなる。onFire の実装（呼び出し側では close）が
// 後始末を通るかどうかに依存せず、このモジュール単体で状態が正しくあってほしい。
test('arm: 発火後は isArmed が false に戻る', () => {
  const { clock, controller } = setup({ onFire: () => {} });
  controller.arm();
  clock.tick(2500);
  assert.equal(controller.isArmed, false);

  // 発火後も武装し直せる（closed にはなっていない）。
  assert.equal(controller.arm(), true);
  assert.equal(controller.isArmed, true);
});

test('cancel: 取り消すと発火しない', () => {
  const { clock, fired, controller } = setup();
  controller.arm();
  controller.cancel();
  assert.equal(controller.isArmed, false);

  clock.tick(5000);
  assert.equal(fired.count, 0);
});

// 性質 1: 閉じたあとは二度と武装しない。
// これが外れると、保存応答が遅れて閉じた後に返ったとき、閉じたモーダルのクロージャから
// タイマーが張られ、開き直した後のモーダルを巻き添えに後始末が走る。
test('arm: markClosed のあとは武装しない', () => {
  const { clock, fired, controller } = setup();
  controller.markClosed();

  assert.equal(controller.arm(), false);
  assert.equal(controller.isArmed, false);
  clock.tick(5000);
  assert.equal(fired.count, 0);
});

// 性質 2: 閉じるときにタイマーを取り消す。
// これが外れると、手動で閉じたあとにタイマーだけが生き残る。
test('markClosed: 武装中のタイマーを取り消す', () => {
  const { clock, fired, controller } = setup();
  controller.arm();
  assert.equal(controller.isArmed, true);

  controller.markClosed();
  assert.equal(controller.isArmed, false);
  clock.tick(5000);
  assert.equal(fired.count, 0);
});

// 性質 3: 閉じる処理は冪等。
// 戻り値で早期 return する呼び出し側（app.js の close）が、2 回目以降に modalOpen を
// 巻き戻さないための土台。遅れて発火したタイマーが close を呼んでも無害になる。
test('markClosed: 2 回目以降は false を返す（close を冪等にするため）', () => {
  const { controller } = setup();
  assert.equal(controller.markClosed(), true);
  assert.equal(controller.markClosed(), false);
  assert.equal(controller.markClosed(), false);
  assert.equal(controller.isClosed, true);
});

// 保存の連打でタイマーが積み残らないこと。張り直す前に取り消していないと、
// 古いタイマーが先に発火して、まだ開いていてよいモーダルを閉じてしまう。
test('arm: 連続して武装しても保留中のタイマーは 1 つだけ', () => {
  const { clock, fired, controller } = setup();
  controller.arm();
  clock.tick(2000);
  controller.arm();
  assert.equal(clock.pendingCount, 1);

  // 1 回目の期限（合計 2500ms）を越えても、張り直した分はまだ発火しない。
  clock.tick(500);
  assert.equal(fired.count, 0);
  clock.tick(2000);
  assert.equal(fired.count, 1);
});

test('isClosed / isArmed: 状態を読み取れる', () => {
  const { controller } = setup();
  assert.equal(controller.isClosed, false);
  assert.equal(controller.isArmed, false);

  controller.arm();
  assert.equal(controller.isArmed, true);

  controller.markClosed();
  assert.equal(controller.isClosed, true);
  assert.equal(controller.isArmed, false);
});
