// 新規ペインの遅延起動（utils/delayedLaunch.js。issue #428）の検証。
// 待ち時間中に PTY が消えた場合と、書き込みが例外になった場合に、専用 CODEX_HOME を回収することを確認する。
const test = require('node:test');
const assert = require('node:assert/strict');

const { scheduleLaunchCommand } = require('../utils/delayedLaunch');
const { createAgentLifecycleStore } = require('../utils/agentLifecycle');

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
  const writes = [];
  const params = {
    ptys: new Map(),
    id: '1',
    command: "codex --no-daemon",
    discard: () => discarded.push('discard'),
    delayMs: 200,
    log: (message) => logs.push(message),
    onWriteSuccess: () => writes.push('success'),
    setTimer: timers.setTimer,
    ...overrides,
  };
  scheduleLaunchCommand(params);
  return { timers, discarded, logs, writes, params };
}

test('PTY が残っていれば待ち時間の後に起動コマンドを書き込み、専用フォルダは回収しない', () => {
  const { ptyProcess, written } = createPane();
  const { timers, discarded, writes } = schedule({ ptyProcess, ptys: new Map([['1', ptyProcess]]) });
  assert.equal(timers.pending[0].delayMs, 200);
  assert.deepEqual(written, []);
  timers.fire();
  assert.deepEqual(written, ['codex --no-daemon\r']);
  assert.deepEqual(discarded, []);
  assert.deepEqual(writes, ['success']);
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

test('baseline取得中にPTYが消えたら、取得完了後も書き込まない', async () => {
  const pane = createPane();
  const ptys = new Map([['1', pane.ptyProcess]]);
  let resolvePreparation;
  const preparation = new Promise((resolve) => { resolvePreparation = resolve; });
  const { timers, discarded } = schedule({
    ptyProcess: pane.ptyProcess,
    ptys,
    prepareCommand: () => preparation,
  });
  timers.fire();
  ptys.delete('1');
  resolvePreparation({ status: 'ready', command: 'tracked-command' });
  await Promise.resolve();
  assert.deepEqual(pane.written, []);
  assert.deepEqual(discarded, ['discard']);
});

test('prepare完了後にlaunch tokenが旧世代になったら旧コマンドを書かない', async () => {
  const pane = createPane();
  const ptys = new Map([['1', pane.ptyProcess]]);
  let current = true;
  let resolvePreparation;
  const preparation = new Promise((resolve) => { resolvePreparation = resolve; });
  const { timers, discarded } = schedule({
    ptyProcess: pane.ptyProcess,
    ptys,
    prepareCommand: () => preparation,
    isLaunchCurrent: () => current,
  });
  timers.fire();
  current = false;
  resolvePreparation({ status: 'ready', command: 'old-generation-command' });
  await Promise.resolve();
  assert.deepEqual(pane.written, []);
  assert.deepEqual(discarded, ['discard']);
});

test('hook ready失敗でも元コマンドを無加工送信する', async () => {
  const pane = createPane();
  const ptys = new Map([['1', pane.ptyProcess]]);
  const { timers, logs } = schedule({
    ptyProcess: pane.ptyProcess,
    ptys,
    prepareCommand: (command) => ({ status: 'ready', setupCommand: 'setup-hook', command, ready: Promise.resolve(false) }),
  });
  timers.fire();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(pane.written, ['setup-hook\r', 'codex --no-daemon\r']);
  assert.ok(logs.some((message) => /lifecycle state is unknown/.test(message)));
});

test('hook ready待機中に世代が変わったら旧世代は元コマンドを書かない', async () => {
  const pane = createPane();
  const ptys = new Map([['1', pane.ptyProcess]]);
  let current = true;
  let resolveReady;
  const ready = new Promise((resolve) => { resolveReady = resolve; });
  const { timers, discarded } = schedule({
    ptyProcess: pane.ptyProcess,
    ptys,
    isLaunchCurrent: () => current,
    prepareCommand: (command) => ({ status: 'ready', setupCommand: 'setup-hook', command, ready }),
  });
  timers.fire();
  current = false;
  resolveReady(true);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(pane.written, ['setup-hook\r']);
  assert.deepEqual(discarded, ['discard']);
});

test('初回遅延起動のprepare待ち中にrestartしても世代2監視を維持する', async () => {
  const pane = createPane();
  const ptys = new Map([['1', pane.ptyProcess]]);
  let resolveBaseline;
  const baseline = new Promise((resolve) => { resolveBaseline = resolve; });
  const processes = new Map([[10, { pid: 10, ppid: 1, pgid: 10, tpgid: 10, stat: 'S', lstart: 'Fri Oct 16 10:00:00 2026' }]]);
  const store = createAgentLifecycleStore({ listProcesses: () => baseline });
  const initialToken = store.initialize('1', 1);
  const { timers, discarded } = schedule({
    ptyProcess: pane.ptyProcess,
    ptys,
    prepareCommand: (command) => store.prepare('1', 1, initialToken, 10, command, '/bin/zsh'),
    isLaunchCurrent: () => store.isCurrent('1', 1, initialToken),
  });
  timers.fire();
  const restartToken = store.initialize('1', 2);
  resolveBaseline(processes);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(pane.written, []);
  assert.deepEqual(discarded, ['discard']);
  assert.equal(store.isCurrent('1', 2, restartToken), true);
  assert.equal(store.get('1', 2), null);
  await store.close();
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
