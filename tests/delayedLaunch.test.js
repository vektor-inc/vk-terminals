// 新規ペインの遅延起動（utils/delayedLaunch.js。issue #428）の検証。
// 待ち時間中に PTY が消えた場合と、書き込みが例外になった場合に、専用 CODEX_HOME を回収することを確認する。
const test = require('node:test');
const assert = require('node:assert/strict');

const { scheduleLaunchCommand } = require('../utils/delayedLaunch');

// 登録した関数を溜めるだけの setTimeout 差し替え。テストが好きなタイミングで発火させる。
function createTimers() {
  const pending = [];
  return {
    setTimer: (callback, delayMs) => {
      pending.push({ callback, delayMs });
      return pending.length;
    },
    pending,
    fire: () => pending.shift().callback(),
  };
}

function createPane({ writeError } = {}) {
  const written = [];
  const ptyProcess = {
    write: (data) => {
      if (writeError) throw writeError;
      written.push(data);
    },
  };
  return { ptyProcess, written };
}

function schedule(overrides) {
  const timers = createTimers();
  const discarded = [];
  const logs = [];
  const params = {
    ptys: new Map(),
    id: '1',
    command: "codex --no-daemon",
    discard: () => discarded.push('discard'),
    delayMs: 200,
    log: (message) => logs.push(message),
    setTimer: timers.setTimer,
    ...overrides,
  };
  scheduleLaunchCommand(params);
  return { timers, discarded, logs, params };
}

test('PTY が残っていれば待ち時間の後に起動コマンドを書き込み、専用フォルダは回収しない', () => {
  const { ptyProcess, written } = createPane();
  const { timers, discarded } = schedule({ ptyProcess, ptys: new Map([['1', ptyProcess]]) });
  assert.equal(timers.pending[0].delayMs, 200);
  assert.deepEqual(written, []);
  timers.fire();
  assert.deepEqual(written, ['codex --no-daemon\r']);
  assert.deepEqual(discarded, []);
});

test('待っている間に PTY が消えたら、書き込まずに専用フォルダを回収する', () => {
  const { ptyProcess, written } = createPane();
  const ptys = new Map([['1', ptyProcess]]);
  const { timers, discarded } = schedule({ ptyProcess, ptys });
  ptys.delete('1');
  assert.doesNotThrow(() => timers.fire());
  assert.deepEqual(written, []);
  assert.deepEqual(discarded, ['discard']);
});

test('同じ ID が別の PTY に差し替わっていたら、元の PTY へは書き込まず専用フォルダを回収する', () => {
  const original = createPane();
  const replacement = createPane();
  const ptys = new Map([['1', original.ptyProcess]]);
  const { timers, discarded } = schedule({ ptyProcess: original.ptyProcess, ptys });
  ptys.set('1', replacement.ptyProcess);
  timers.fire();
  assert.deepEqual(original.written, []);
  assert.deepEqual(replacement.written, []);
  assert.deepEqual(discarded, ['discard']);
});

test('書き込みが例外になっても、例外をタイマーの外へ出さず専用フォルダを回収して記録する', () => {
  const { ptyProcess } = createPane({ writeError: new Error('pty closed') });
  const { timers, discarded, logs } = schedule({ ptyProcess, ptys: new Map([['1', ptyProcess]]) });
  assert.doesNotThrow(() => timers.fire());
  assert.deepEqual(discarded, ['discard']);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /failed to write launch command to terminal 1: pty closed/);
});

test('回収そのものが例外になっても、タイマーの外へ出さず記録する', () => {
  const { ptyProcess } = createPane({ writeError: new Error('pty closed') });
  const { timers, logs } = schedule({
    ptyProcess,
    ptys: new Map([['1', ptyProcess]]),
    discard: () => { throw new Error('cleanup failed'); },
  });
  assert.doesNotThrow(() => timers.fire());
  assert.ok(logs.some((message) => /failed to discard launch home: cleanup failed/.test(message)));
});

test('main.js の遅延起動は scheduleLaunchCommand を通り、直接の setTimeout 書き込みを持たない', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /scheduleLaunchCommand\(\{[\s\S]*?discard: discardLaunchHome/);
  assert.equal(/ptyProcess\.write\(`\$\{launchCommand\}/.test(source), false);
});
