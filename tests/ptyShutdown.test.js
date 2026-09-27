'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { terminatePtyAndWait, terminateAllPtysAndWait } = require('../utils/ptyShutdown');

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

test('terminatePtyAndWait: kill を送った後、onExit が届くまで resolve しない', async () => {
  const pty = createFakePty();
  let resolved = false;
  const promise = terminatePtyAndWait(pty).then(() => { resolved = true; });

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

test('terminatePtyAndWait: 上限（graceMs）を超えても onExit が届かなければ SIGKILL で強制終了する', async () => {
  const pty = createFakePty();
  const clock = fakeClock();
  let resolved = false;
  const promise = terminatePtyAndWait(pty, {
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

test('terminatePtyAndWait: SIGKILL 後でも onExit が届けば forceMs を待たず resolve する', async () => {
  const pty = createFakePty();
  const clock = fakeClock();
  let resolved = false;
  const promise = terminatePtyAndWait(pty, {
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

test('terminateAllPtysAndWait: pty が0件なら待たずに即 resolve する', async () => {
  await terminateAllPtysAndWait([]);
  assert.ok(true); // ここに到達すれば待ち時間なしに解決している
});

test('terminateAllPtysAndWait: すべての pty の onExit が届くまで resolve しない', async () => {
  const ptyA = createFakePty();
  const ptyB = createFakePty();
  let resolved = false;
  const promise = terminateAllPtysAndWait([ptyA, ptyB]).then(() => { resolved = true; });

  ptyA._fireExit();
  await Promise.resolve();
  assert.equal(resolved, false); // ptyB がまだ終了していない

  ptyB._fireExit();
  await promise;
  assert.equal(resolved, true);
});

test('terminatePtyAndWait: onExit を持たないオブジェクトは待たずに resolve する', async () => {
  const brokenPty = {
    kill() {},
    onExit() { throw new Error('not supported'); },
  };
  await terminatePtyAndWait(brokenPty);
  assert.ok(true);
});

// レビュー指摘・LOW-5(1): kill() が例外を出しても待ち合わせ自体は失敗せず、
// onExit（または SIGKILL 後の諦め）まで通常どおり進むことを確認する。
test('terminatePtyAndWait: kill() が例外を出しても reject せず、onExit が届けば resolve する', async () => {
  const onExitCallbacks = [];
  let killCallCount = 0;
  const pty = {
    kill(signal) {
      killCallCount += 1;
      throw new Error(`kill failed (call ${killCallCount}, signal=${signal ?? 'default'})`);
    },
    onExit(cb) {
      onExitCallbacks.push(cb);
      return { dispose() {} };
    },
  };
  let resolved = false;
  const promise = terminatePtyAndWait(pty).then(() => { resolved = true; });

  await Promise.resolve();
  assert.equal(resolved, false);
  assert.equal(killCallCount, 1); // kill() が例外を出しても呼び出し自体は行われている

  for (const cb of [...onExitCallbacks]) cb();
  await promise;
  assert.equal(resolved, true);
});

// kill() が例外を出し続け、onExit も届かない最悪ケースでも forceMs 経過後に諦めて resolve する
// （SIGKILL 送信時の例外も同様に無視される）。
test('terminatePtyAndWait: kill() が例外を出し続けても、待ちきれず諦めて resolve する', async () => {
  const clock = fakeClock();
  const pty = {
    kill() { throw new Error('always fails'); },
    onExit() { return { dispose() {} }; }, // 呼ばれても発火しない
  };
  let resolved = false;
  const promise = terminatePtyAndWait(pty, {
    graceMs: 1000,
    forceMs: 300,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  }).then(() => { resolved = true; });

  clock.tick(1000); // SIGKILL 送信（これも例外）
  await Promise.resolve();
  assert.equal(resolved, false);

  clock.tick(300); // forceMs 到達 → 諦めて resolve
  await promise;
  assert.equal(resolved, true);
});

// レビュー指摘・LOW-5(2) / MEDIUM-1 の回帰防止。main.js の terminal:kill はペインを
// 閉じた時点で ptys（生きているペインの Map）から即削除し、終了待ち Promise だけを
// 別の Map（exitingPtys）に残す。cleanupPtys() は ptys 側の terminateAllPtysAndWait と
// exitingPtys に積まれた個別の待ち Promise をまとめて Promise.all で待つ。
// main.js 本体は Electron 依存で直接 require できないため、この合成をここで同じ形に
// 再現し、「ptys からは既に消えたペインの pty」も待ち合わせに含まれることを確認する
// （修正前は kill() を送るだけで誰も待っておらず、ここでアプリを終了すると #409 と
// 同じ競合になっていた）。
test('MEDIUM-1 回帰防止: 閉じたペイン（ptys からは削除済み・exitingPtys で追跡中）の pty も、cleanupPtys 相当の待ち合わせに含まれる', async () => {
  const ptys = new Map(); // 生きているペイン（全ペインを閉じた状態を模すため空にする）
  const exitingPtys = new Map(); // terminal:kill が積む「終了待ち中」の pty

  // terminal:kill 相当の動き: ptys からは即削除し、終了待ち Promise だけを残す。
  const closedPty = createFakePty();
  const exitPromise = terminatePtyAndWait(closedPty).finally(() => exitingPtys.delete('closed-1'));
  exitingPtys.set('closed-1', exitPromise);

  // main.js の cleanupPtys() と同じ合成
  let resolved = false;
  const cleanup = Promise.all([
    terminateAllPtysAndWait(ptys.values()),
    ...exitingPtys.values(),
  ]).then(() => { resolved = true; });

  await Promise.resolve();
  assert.equal(resolved, false); // closedPty がまだ onExit を出していない間は解決しない
  assert.deepEqual(closedPty._killedSignals, [undefined]); // kill() は既に送られている

  closedPty._fireExit();
  await cleanup;
  assert.equal(resolved, true);
  assert.equal(exitingPtys.size, 0); // 待ち終わったら自分で exitingPtys から取り除かれている
});
