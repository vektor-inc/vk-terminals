// Codex が起動直後に `timed out discarding buffered terminal input` で終了する問題（issue #621）の検証。
// 1. 起動直後の短時間は、利用者が求めていない端末通知（フォーカス・マウス）を PTY へ流さない。
// 2. 起動直後に AI が終了したら、同じ起動コマンドで 1 回だけ起動し直す。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { scheduleLaunchCommand } = require('../utils/delayedLaunch');
const { createAgentLifecycleStore, READY_MARKER_PREFIX, MARKER_PREFIX } = require('../utils/agentLifecycle');
const {
  LAUNCH_INPUT_QUIET_MS,
  isUnsolicitedTerminalNotification,
  createLaunchInputQuietWindow,
} = require('../utils/launchInputQuiet');

const START = 'Wed Sep 10 18:20:00 2026';
const row = (pid, ppid, pgid, tpgid, stat = 'S', lstart = START) => ({ pid, ppid, pgid, tpgid, stat, lstart });
const table = (...rows) => new Map(rows.map((process) => [process.pid, process]));

// 登録した関数を溜めるだけの setTimeout 差し替え。
function createTimers() {
  const pending = [];
  return {
    setTimer: (callback, delayMs) => {
      const timer = { callback, delayMs, cleared: false };
      pending.push(timer);
      return timer;
    },
    clearTimer: (timer) => { if (timer) timer.cleared = true; },
    pending,
    fireNext: async () => {
      const timer = pending.find((item) => !item.cleared);
      timer.cleared = true;
      await timer.callback();
    },
  };
}

const flush = () => new Promise(setImmediate);

test('起動直後の短時間はフォーカス・マウス通知だけの入力を落とし、問い合わせ応答と利用者入力は通す', () => {
  let now = 1000;
  const quiet = createLaunchInputQuietWindow({ now: () => now });
  assert.equal(quiet.shouldDrop('1', '\x1b[I'), false, '起動前は何も落とさない');
  quiet.begin('1');
  assert.equal(quiet.shouldDrop('1', '\x1b[I'), true);
  assert.equal(quiet.shouldDrop('1', '\x1b[O\x1b[I'), true);
  assert.equal(quiet.shouldDrop('1', '\x1b[<35;10;5M'), true);
  assert.equal(quiet.shouldDrop('1', '\x1b[M #!'), true);
  // Codex の起動時の問い合わせへの応答は Codex が待っているため落とさない。
  assert.equal(quiet.shouldDrop('1', '\x1b[?1;2c'), false);
  assert.equal(quiet.shouldDrop('1', '\x1b[12;1R'), false);
  assert.equal(quiet.shouldDrop('1', '\x1b]11;rgb:0000/0000/0000\x1b\\'), false);
  // 利用者の入力は落とさない。
  assert.equal(quiet.shouldDrop('1', 'a'), false);
  assert.equal(quiet.shouldDrop('1', '\r'), false);
  assert.equal(quiet.shouldDrop('1', '\x1b[I a'), false);
  // 別ペインには影響しない。
  assert.equal(quiet.shouldDrop('2', '\x1b[I'), false);
  now += LAUNCH_INPUT_QUIET_MS;
  assert.equal(quiet.shouldDrop('1', '\x1b[I'), false, '時間が過ぎたら通す');
  quiet.begin('1');
  quiet.delete('1');
  assert.equal(quiet.shouldDrop('1', '\x1b[I'), false, 'ペインを閉じたら記録を消す');
});

test('自発的な端末通知の判定は、フォーカス・マウス通知だけで構成される入力に限る', () => {
  assert.equal(isUnsolicitedTerminalNotification('\x1b[I'), true);
  assert.equal(isUnsolicitedTerminalNotification('\x1b[<0;1;1m'), true);
  assert.equal(isUnsolicitedTerminalNotification(''), false);
  assert.equal(isUnsolicitedTerminalNotification(null), false);
  assert.equal(isUnsolicitedTerminalNotification('\x1b[A'), false);
  assert.equal(isUnsolicitedTerminalNotification('\x1b'), false);
});

test('起動コマンドを書き込むたびに onLaunchWritten を呼ぶ', async () => {
  const timers = createTimers();
  const written = [];
  const ptyProcess = { write: (data) => written.push(data) };
  const launched = [];
  scheduleLaunchCommand({
    ptys: new Map([['1', ptyProcess]]), id: '1', ptyProcess, command: 'codex', discard: () => {}, delayMs: 200,
    setTimer: timers.setTimer, onLaunchWritten: () => launched.push(written.length),
  });
  await timers.fireNext();
  await flush();
  assert.deepEqual(written, ['codex\r']);
  assert.deepEqual(launched, [1]);
});

test('起動直後に AI が終了したら、行を消してから同じ起動コマンドで 1 回だけ起動し直す', async () => {
  const timers = createTimers();
  const written = [];
  const ptyProcess = { write: (data) => written.push(data) };
  const discarded = [];
  const successes = [];
  const exitChecks = [];
  const logs = [];
  scheduleLaunchCommand({
    ptys: new Map([['1', ptyProcess]]), id: '1', ptyProcess, command: 'codex', delayMs: 200,
    discard: () => discarded.push('discard'), onWriteSuccess: () => successes.push('ok'),
    setTimer: timers.setTimer, log: (message) => logs.push(message),
    waitForEarlyExit: () => { exitChecks.push('check'); return Promise.resolve(true); },
    relaunchDelayMs: 500,
  });
  await timers.fireNext();
  await flush();
  assert.deepEqual(written, ['codex\r']);
  // 終了の検知から起動し直すまで少し待つ（残った入力をシェルに処理させる）。
  const relaunchTimer = timers.pending.find((item) => !item.cleared);
  assert.equal(relaunchTimer.delayMs, 500);
  await timers.fireNext();
  await flush();
  assert.deepEqual(written, ['codex\r', '\x15', 'codex\r']);
  // 2 回目の終了は確認せず、無限に起動し直さない。
  assert.deepEqual(exitChecks, ['check']);
  assert.equal(timers.pending.filter((item) => !item.cleared).length, 0);
  // 1 度動いた Codex の専用フォルダは回収しない。成功通知も 1 回だけ。
  assert.deepEqual(discarded, []);
  assert.deepEqual(successes, ['ok']);
  assert.ok(logs.some((message) => /relaunch/.test(message)));
});

test('起動直後に終了しなければ起動し直さない', async () => {
  const timers = createTimers();
  const written = [];
  const ptyProcess = { write: (data) => written.push(data) };
  scheduleLaunchCommand({
    ptys: new Map([['1', ptyProcess]]), id: '1', ptyProcess, command: 'codex', delayMs: 200, discard: () => {},
    setTimer: timers.setTimer, waitForEarlyExit: () => Promise.resolve(false),
  });
  await timers.fireNext();
  await flush();
  assert.deepEqual(written, ['codex\r']);
  assert.equal(timers.pending.filter((item) => !item.cleared).length, 0);
});

for (const cancellation of ['closed', 'restarted']) {
  test(`起動し直す前にペインが閉じた・世代が変わったら起動し直さない: ${cancellation}`, async () => {
    const timers = createTimers();
    const written = [];
    const ptyProcess = { write: (data) => written.push(data) };
    const ptys = new Map([['1', ptyProcess]]);
    let current = true;
    scheduleLaunchCommand({
      ptys, id: '1', ptyProcess, command: 'codex', delayMs: 200, discard: () => {},
      setTimer: timers.setTimer, isLaunchCurrent: () => current,
      waitForEarlyExit: () => Promise.resolve(true),
    });
    await timers.fireNext();
    await flush();
    if (cancellation === 'closed') ptys.delete('1');
    else current = false;
    await timers.fireNext();
    await flush();
    assert.deepEqual(written, ['codex\r']);
  });
}

test('lifecycle: 起動直後の終了を待つと exited で true、時間内に終わらなければ false', async () => {
  let processes = table(row(10, 1, 10, 10));
  const timers = createTimers();
  const store = createAgentLifecycleStore({ listProcesses: async () => processes, setTimer: timers.setTimer, clearTimer: timers.clearTimer });
  const token = store.initialize('pane', 1);

  // 1 回目の起動: 準備→合図→取得開始→実行中→終了。
  const launch = async () => {
    const prepared = await store.prepare('pane', 1, token, 10, 'codex', '/bin/zsh');
    assert.equal(prepared.status, 'ready');
    const marker = prepared.setupCommand.match(/VKAgentLifecycle=([a-f0-9]+)/)[1];
    store.filterOutput('pane', `${READY_MARKER_PREFIX}${marker}:ok\x07`);
    assert.equal(await prepared.ready, true);
    assert.equal(await store.activate('pane', 1, token), true);
    return marker;
  };
  const marker = await launch();
  const earlyExit = store.waitForEarlyExit('pane', 1, token, 5000);
  const waitTimer = timers.pending.find((item) => item.delayMs === 5000);
  assert.ok(waitTimer, '待ち時間のタイマーを張る');
  processes = table(row(10, 1, 10, 20), row(20, 10, 20, 20));
  await timers.pending.find((item) => !item.cleared && item.delayMs === 100).callback();
  assert.equal(store.get('pane', 1), 'running');
  processes = table(row(10, 1, 10, 10));
  store.filterOutput('pane', `${MARKER_PREFIX}${marker}\x07`);
  const polls = timers.pending.filter((item) => !item.cleared && item.delayMs === 100);
  await polls[polls.length - 1].callback();
  assert.equal(store.get('pane', 1), 'exited');
  assert.equal(await earlyExit, true);
  assert.equal(waitTimer.cleared, true);

  // 起動し直したときも、同じ世代のまま実行中を追跡できる。
  const secondMarker = await launch();
  assert.notEqual(secondMarker, marker);
  processes = table(row(10, 1, 10, 30), row(30, 10, 30, 30));
  const pollsAfterRelaunch = timers.pending.filter((item) => !item.cleared && item.delayMs === 100);
  await pollsAfterRelaunch[pollsAfterRelaunch.length - 1].callback();
  assert.equal(store.get('pane', 1), 'running');

  // 時間内に終わらなければ false。
  const late = store.waitForEarlyExit('pane', 1, token, 5000);
  const lateTimer = timers.pending.filter((item) => !item.cleared && item.delayMs === 5000).pop();
  await lateTimer.callback();
  assert.equal(await late, false);

  // 世代が古ければすぐ false。
  assert.equal(await store.waitForEarlyExit('pane', 2, token, 5000), false);
  await store.close();
});

test('main.js: Codex の起動だけが起動し直しと入力の抑制を使い、terminal:input が抑制を確認する', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /scheduleLaunchCommand\(\{[\s\S]*?waitForEarlyExit: resolvedEngine === 'codex'[\s\S]*?onLaunchWritten:[\s\S]*?\}\);/);
  assert.match(source, /ipcMain\.on\('terminal:input', \(event, id, data\) => \{[\s\S]*?launchInputQuiet\.shouldDrop\(id, data\)[\s\S]*?p\.write\(data\);/);
  // 再起動 API で Codex を起動するときも、書き込み直後から抑制する。
  assert.match(source, /ptyProcess\.write\(`\$\{prepared\.command\}\\r`\);\s*if \(request\.engine === 'codex'\) launchInputQuiet\.begin\(request\.termId\);/);
});

// 起動し直しを待っている間に利用者が入力したら、行を消したり別のプログラムへ書き込んだりしない。
function scheduleWithUserInput({ prepareCommand } = {}) {
  const timers = createTimers();
  const written = [];
  const ptyProcess = { write: (data) => written.push(data) };
  let revision = 0;
  let resolveExit;
  scheduleLaunchCommand({
    ptys: new Map([['1', ptyProcess]]), id: '1', ptyProcess, command: 'codex', delayMs: 200, discard: () => {},
    setTimer: timers.setTimer, prepareCommand,
    getUserInputRevision: () => revision,
    waitForEarlyExit: () => new Promise((resolve) => { resolveExit = resolve; }),
  });
  return { timers, written, input: () => { revision += 1; }, exit: () => resolveExit(true) };
}

test('終了を検知する前に利用者が入力していたら起動し直さない', async () => {
  const pane = scheduleWithUserInput();
  await pane.timers.fireNext();
  await flush();
  pane.input();
  pane.exit();
  await flush();
  assert.equal(pane.timers.pending.filter((item) => !item.cleared).length, 0);
  assert.deepEqual(pane.written, ['codex\r']);
});

test('起動し直すまで待っている間に利用者が入力したら、Ctrl+U も起動コマンドも送らない', async () => {
  const pane = scheduleWithUserInput();
  await pane.timers.fireNext();
  await flush();
  pane.exit();
  await flush();
  pane.input();
  await pane.timers.fireNext();
  await flush();
  assert.deepEqual(pane.written, ['codex\r']);
});

test('起動し直しの準備（prepare）を待っている間に利用者が入力したら、何も送らない', async () => {
  let calls = 0;
  let resolveSecond;
  const pane = scheduleWithUserInput({
    prepareCommand: (command) => {
      calls += 1;
      if (calls === 1) return { status: 'ready', setupCommand: 'setup-hook', command, ready: Promise.resolve(true) };
      return new Promise((resolve) => { resolveSecond = () => resolve({ status: 'ready', setupCommand: 'setup-hook', command, ready: Promise.resolve(true) }); });
    },
  });
  await pane.timers.fireNext();
  await flush();
  pane.exit();
  await flush();
  await pane.timers.fireNext();
  await flush();
  assert.equal(calls, 2, '起動し直しの準備に入っている');
  pane.input();
  resolveSecond();
  await flush();
  assert.deepEqual(pane.written, ['setup-hook\r', 'codex\r']);
});

test('利用者入力の番号は、利用者の入力だけで進み、端末の応答・通知では進まない', () => {
  const { createUserInputRevisions } = require('../utils/terminalUserInput');
  const revisions = createUserInputRevisions();
  assert.equal(revisions.get('1'), 0);
  for (const auto of ['\x1b[?1;2c', '\x1b[12;1R', '\x1b]11;rgb:0000/0000/0000\x1b\\', '\x1b[I', '\x1b[<35;1;1M', '']) revisions.note('1', auto);
  assert.equal(revisions.get('1'), 0);
  revisions.note('1', 'a');
  revisions.note('1', '\r');
  assert.equal(revisions.get('1'), 2);
  assert.equal(revisions.get('2'), 0);
  revisions.delete('1');
  assert.equal(revisions.get('1'), 0);
});

test('main.js: terminal:input と API の入力で利用者入力の番号を進め、起動し直しの照合に渡す', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /ipcMain\.on\('terminal:input', \(event, id, data\) => \{[\s\S]*?userInputRevisions\.note\(id, data\);[\s\S]*?p\.write\(data\);/);
  assert.match(source, /const result = conditionalTerminalInput\.writeEnter\([\s\S]*?userInputRevisions\.note\(termId, '\\r'\);/);
  assert.match(source, /userInputRevisions\.note\(termId, input\);\s*const trailingNewline = input\.match/);
  assert.match(source, /scheduleLaunchCommand\(\{[\s\S]*?getUserInputRevision: \(\) => userInputRevisions\.get\(id\),[\s\S]*?\}\);/);
});
