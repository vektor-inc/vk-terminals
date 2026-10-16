'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PS_ARGS, MARKER_PREFIX, READY_MARKER_PREFIX, parseProcessTable, inspectLifecycle, buildPromptHookCommand, createAgentLifecycleStore, mergeAgentLifecycleStates } = require('../utils/agentLifecycle');

const START = 'Fri Oct 16 10:00:00 2026';
const LATER = 'Fri Oct 16 10:01:00 2026';
const row = (pid, ppid, pgid, tpgid, stat = 'S', lstart = START) => ({ pid, ppid, pgid, tpgid, stat, lstart });
const table = (...rows) => new Map(rows.map((process) => [process.pid, process]));
const initial = () => ({ shellPid: 10, shellLstart: START, trackedGroups: new Map(), completionReceived: false });
const tracking = (pgid, identities, completionReceived = false) => ({
  ...initial(), trackedGroups: new Map([[pgid, new Map(identities)]]), completionReceived,
});

function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('condition timeout'));
      setTimeout(inspect, 20);
    };
    inspect();
  });
}

function createRealPty(t, env = process.env) {
  const pty = require('node-pty');
  const shell = pty.spawn('/bin/zsh', ['-f'], { env: { ...env, TERM: 'xterm-256color', PS1: 'VK_PROMPT> ' } });
  let output = '';
  shell.onData((data) => { output += data; });
  t.after(() => { try { shell.kill(); } catch (_error) {} });
  return { shell, output: () => output, clear: () => { output = ''; } };
}

async function launchTracked(store, shell, command, shellPath = '/bin/zsh') {
  shell.onData((data) => { store.filterOutput('pty', data); });
  const launchToken = store.initialize('pty', 1);
  const prepared = await store.prepare('pty', 1, launchToken, shell.pid, command, shellPath);
  shell.write(`${prepared.setupCommand}\r`);
  await prepared.ready;
  await store.activate('pty', 1, launchToken);
  shell.write(`${prepared.command}\r`);
}

test('psはshellを介さない固定引数で必要な列を取得する', () => {
  assert.deepEqual(PS_ARGS, ['-A', '-o', 'pid=,ppid=,pgid=,tpgid=,stat=,lstart=']);
  const parsed = parseProcessTable(` 10 1 10 20 Ss ${START}\n 20 10 20 20 T ${START}\n`);
  assert.deepEqual(parsed.get(20), row(20, 10, 20, 20, 'T'));
});

test('シェルと異なる前景groupにシェル子孫がいる場合だけrunning', () => {
  const yes = inspectLifecycle(initial(), table(row(10, 1, 10, 20), row(20, 10, 20, 20)));
  assert.equal(yes.state, 'running');
  assert.equal(yes.trackedGroups.has(20), true);
  assert.equal(inspectLifecycle(initial(), table(row(10, 1, 10, 10))).state, null);
  assert.equal(inspectLifecycle(initial(), table(row(10, 1, 10, 20), row(20, 1, 20, 20))).state, null);
});

test('停止中groupは前景がシェルへ戻ってもrunningを維持する', () => {
  const snapshot = tracking(20, [[20, START]]);
  assert.equal(inspectLifecycle(snapshot, table(row(10, 1, 10, 10), row(20, 10, 20, 10, 'T'))).state, 'running');
});

test('追跡groupの全member消失とcompletion marker受信が揃った場合だけexited', () => {
  const snapshot = tracking(20, [[20, START], [21, START]], true);
  assert.equal(inspectLifecycle(snapshot, table(row(10, 1, 10, 10), row(21, 1, 20, 10))).state, 'running');
  const exited = inspectLifecycle(snapshot, table(row(10, 1, 10, 10)));
  assert.equal(exited.state, 'exited');
  assert.equal(exited.terminal, true);
});

test('最初のgroup消失後もmarkerまでは遅延した後継groupを同じ世代へ追加する', () => {
  const first = inspectLifecycle(initial(), table(row(10, 1, 10, 20), row(20, 10, 20, 20)));
  const builtinGap = inspectLifecycle({ ...initial(), trackedGroups: first.trackedGroups }, table(row(10, 1, 10, 10)));
  assert.equal(builtinGap.state, 'running');

  const successor = inspectLifecycle(
    { ...initial(), trackedGroups: builtinGap.trackedGroups },
    table(row(10, 1, 10, 30), row(30, 10, 30, 30)),
  );
  assert.equal(successor.state, 'running');
  assert.deepEqual([...successor.trackedGroups.keys()], [20, 30]);

  const markerWhileAlive = inspectLifecycle(
    { ...initial(), trackedGroups: successor.trackedGroups, completionReceived: true },
    table(row(10, 1, 10, 10), row(30, 10, 30, 10, 'T')),
  );
  assert.equal(markerWhileAlive.state, 'running');
  const afterAllGroupsExit = inspectLifecycle(
    { ...initial(), trackedGroups: markerWhileAlive.trackedGroups, completionReceived: true },
    table(row(10, 1, 10, 10)),
  );
  assert.equal(afterAllGroupsExit.state, 'exited');
  assert.equal(afterAllGroupsExit.terminal, true);
});

test('completion後の由来不明なbaseline外子孫はrunningにもexitedにもせずnull', () => {
  const snapshot = {
    ...tracking(20, [[20, START]], true),
    baselinePgids: new Set([10]),
    baselineIdentities: new Map([[10, START]]),
  };
  const result = inspectLifecycle(snapshot, table(
    row(10, 1, 10, 10),
    row(30, 10, 30, 10, 'T'),
  ));
  assert.equal(result.state, null);
  assert.equal(result.terminal, true);
  assert.equal(result.trackedGroups.has(30), false);
});

test('既知identityは親終了後にreparent・PGID変更しても全体表から追跡する', () => {
  const snapshot = tracking(20, [[20, START], [21, START]], true);
  const result = inspectLifecycle(snapshot, table(
    row(10, 1, 10, 10),
    row(21, 1, 21, 10),
  ));
  assert.equal(result.state, 'running');
  assert.equal(result.trackedGroups.get(20).has(21), false);
  assert.equal(result.trackedGroups.get(21).get(21), START);
});

test('既知identityの子孫は別groupでも取得し、reparent後もidentityで追跡する', () => {
  const snapshot = tracking(20, [[20, START]]);
  const withChild = inspectLifecycle(snapshot, table(
    row(10, 1, 10, 20),
    row(20, 10, 20, 20),
    row(21, 20, 21, 20),
  ));
  assert.equal(withChild.trackedGroups.get(21).get(21), START);
  const reparented = inspectLifecycle({ ...snapshot, trackedGroups: withChild.trackedGroups }, table(
    row(10, 1, 10, 10),
    row(21, 1, 21, 10),
  ));
  assert.equal(reparented.state, 'running');
});

test('poll間に親が生成して先に終了した子を追跡集合へ引き継ぐ', () => {
  const snapshot = tracking(20, [[20, START]]);
  const withChild = inspectLifecycle(snapshot, table(row(10, 1, 10, 20), row(20, 10, 20, 20), row(21, 20, 20, 20)));
  assert.equal(withChild.state, 'running');
  assert.equal(withChild.trackedGroups.get(20).get(21), START);
  const afterParentExit = inspectLifecycle({ ...snapshot, trackedGroups: withChild.trackedGroups }, table(row(10, 1, 10, 20), row(21, 1, 20, 20)));
  assert.equal(afterParentExit.state, 'running');
});

test('group leaderが先に終了しても既知memberが残る間はrunning', () => {
  const snapshot = tracking(20, [[20, START], [21, START]]);
  assert.equal(inspectLifecycle(snapshot, table(row(10, 1, 10, 20), row(21, 1, 20, 20))).state, 'running');
});

test('既知identity消失後に同PGIDの未観測memberが残ればnull', () => {
  const snapshot = tracking(20, [[20, START]]);
  const result = inspectLifecycle(snapshot, table(row(10, 1, 10, 20), row(21, 1, 20, 20)));
  assert.equal(result.state, null);
  assert.equal(result.terminal, true);
});

test('baselineに存在したgroupとidentityは取得しない', () => {
  const snapshot = { ...initial(), baselinePgids: new Set([20]), baselineIdentities: new Map([[20, START]]) };
  assert.equal(inspectLifecycle(snapshot, table(row(10, 1, 10, 20), row(20, 10, 20, 20))).state, null);
});

test('既存background jobが生成したbaseline外の子を取得しない', () => {
  const snapshot = {
    ...initial(),
    baselinePgids: new Set([10, 40]),
    baselineIdentities: new Map([[10, START], [40, START]]),
  };
  const result = inspectLifecycle(snapshot, table(
    row(10, 1, 10, 10),
    row(40, 10, 40, 10),
    row(41, 40, 40, 10),
  ));
  assert.equal(result.state, null);
  assert.equal(result.trackedGroups.size, 0);
});

test('baseline既存jobを祖先に持つ別PGIDの前景子を初回取得しない', () => {
  const snapshot = {
    ...initial(),
    baselinePgids: new Set([10, 40]),
    baselineIdentities: new Map([[10, START], [40, START]]),
  };
  const result = inspectLifecycle(snapshot, table(
    row(10, 1, 10, 41),
    row(40, 10, 40, 41),
    row(41, 40, 41, 41),
  ));
  assert.equal(result.state, null);
  assert.equal(result.trackedGroups.size, 0);
});

test('初回候補の祖先chainが循環・欠損なら安全側で取得しない', () => {
  const snapshot = { ...initial(), baselinePgids: new Set([10]), baselineIdentities: new Map([[10, START]]) };
  for (const processes of [
    table(row(10, 1, 10, 41), row(40, 41, 40, 41), row(41, 40, 41, 41)),
    table(row(10, 1, 10, 41), row(41, 999, 41, 41)),
  ]) {
    assert.equal(inspectLifecycle(snapshot, processes).trackedGroups.size, 0);
  }
});

test('存在しないAIのcompletion後に開始した別の前景jobを取得しない', () => {
  const result = inspectLifecycle(
    { ...initial(), completionReceived: true },
    table(row(10, 1, 10, 30), row(30, 10, 30, 30)),
  );
  assert.equal(result.state, null);
  assert.equal(result.trackedGroups.size, 0);
});

test('Ctrl+Z中の既知identityが残る間は別の前景groupを後継取得しない', () => {
  const result = inspectLifecycle(
    tracking(20, [[20, START]]),
    table(row(10, 1, 10, 30), row(20, 10, 20, 30, 'T'), row(30, 10, 30, 30)),
  );
  assert.equal(result.state, 'running');
  assert.equal(result.trackedGroups.has(20), true);
  assert.equal(result.trackedGroups.has(30), false);
});

test('shellと同じPGIDの子は追跡memberに含めない', () => {
  const result = inspectLifecycle(initial(), table(
    row(10, 1, 10, 10),
    row(11, 10, 10, 10),
  ));
  assert.equal(result.state, null);
  assert.equal(result.trackedGroups.size, 0);
});

test('同じPID/PGIDでもlstartが変われば再利用としてnull', () => {
  const snapshot = tracking(20, [[20, START]]);
  const result = inspectLifecycle(snapshot, table(row(10, 1, 10, 10), row(20, 1, 20, 10, 'S', LATER)));
  assert.equal(result.state, null);
  assert.equal(result.terminal, true);
});

test('baseline取得失敗と世代変更によるcancelを区別し、旧prepareは新世代を変更しない', async () => {
  let resolveOld;
  const oldRead = new Promise((resolve) => { resolveOld = resolve; });
  const store = createAgentLifecycleStore({ listProcesses: () => oldRead });
  const oldToken = store.initialize('1', 1);
  const oldMonitor = store.prepare('1', 1, oldToken, 10, 'claude', '/bin/zsh');
  const newToken = store.initialize('1', 2);
  resolveOld(table(row(10, 1, 10, 10)));
  assert.deepEqual(await oldMonitor, { status: 'cancelled' });
  assert.equal(store.isCurrent('1', 2, newToken), true);
  assert.equal(store.get('1', 2), null);
  assert.equal(store.get('1', 1), null);
  await store.close();

  const failed = createAgentLifecycleStore({ listProcesses: () => Promise.reject(new Error('ps failed')) });
  const failedToken = failed.initialize('1', 1);
  assert.deepEqual(await failed.prepare('1', 1, failedToken, 10, 'claude', '/bin/zsh'), { status: 'passthrough', command: 'claude' });
  assert.equal(failed.get('1', 1), null);
});

test('Windowsでは監視せずnullを維持する', async () => {
  const store = createAgentLifecycleStore({ platform: 'win32', listProcesses: () => { throw new Error('should not run'); } });
  const token = store.initialize('1', 1);
  assert.deepEqual(await store.prepare('1', 1, token, 10, 'claude', '/bin/zsh'), { status: 'passthrough', command: 'claude' });
  assert.equal(store.get('1', 1), null);
});

test('completion markerは未取得の取得期間だけを閉じ、画面から除去する', async () => {
  const timers = [];
  const processes = table(row(10, 1, 10, 10));
  const store = createAgentLifecycleStore({
    listProcesses: async () => processes,
    setTimer: (callback) => { timers.push(callback); return callback; },
    clearTimer: () => {},
  });
  const launchToken = store.initialize('1', 1);
  const prepared = await store.prepare('1', 1, launchToken, 10, 'missing-command', '/bin/zsh');
  const markerToken = prepared.setupCommand.match(/VKAgentLifecycle=([a-f0-9]+)/)[1];
  store.filterOutput('1', `${READY_MARKER_PREFIX}${markerToken}:ok${String.fromCharCode(7)}`);
  await store.activate('1', 1, launchToken);
  const marker = `${MARKER_PREFIX}${markerToken}${String.fromCharCode(7)}`;
  const splitAt = Math.floor(marker.length / 2);
  assert.equal(store.filterOutput('1', `before${marker.slice(0, splitAt)}`), 'before');
  assert.equal(store.filterOutput('1', `${marker.slice(splitAt)}after`), 'after');
  assert.equal(store.get('1', 1), null);
  assert.ok(timers.length >= 2);
});

test('ready markerは画面から除去してhook待機を解決する', async () => {
  const store = createAgentLifecycleStore({ listProcesses: async () => table(row(10, 1, 10, 10)) });
  const token = store.initialize('1', 1);
  const prepared = await store.prepare('1', 1, token, 10, 'claude', '/bin/zsh');
  const markerToken = prepared.setupCommand.match(/VKAgentLifecycle=([a-f0-9]+)/)[1];
  const ready = `${READY_MARKER_PREFIX}${markerToken}:ok${String.fromCharCode(7)}`;
  assert.equal(store.filterOutput('1', `before${ready}after`), 'beforeafter');
  assert.equal(await prepared.ready, true);
  assert.equal(await store.activate('1', 1, token), true);
  await store.close();
});

test('準備group後の由来不明な子孫にcompletionが先着した場合はnullにする', async () => {
  const timers = [];
  let processes = table(row(10, 1, 10, 10));
  const store = createAgentLifecycleStore({
    listProcesses: async () => processes,
    setTimer: (callback) => { timers.push(callback); return callback; },
    clearTimer: () => {},
  });
  const token = store.initialize('1', 1);
  const prepared = await store.prepare('1', 1, token, 10, 'claude', '/bin/zsh');
  const markerToken = prepared.setupCommand.match(/VKAgentLifecycle=([a-f0-9]+)/)[1];
  store.filterOutput('1', `${READY_MARKER_PREFIX}${markerToken}:ok${String.fromCharCode(7)}`);
  await store.activate('1', 1, token);
  processes = table(row(10, 1, 10, 10), row(30, 10, 30, 10, 'T'));
  store.filterOutput('1', `${MARKER_PREFIX}${markerToken}${String.fromCharCode(7)}`);
  await timers[2]();
  assert.equal(store.get('1', 1), null);
  await store.close();
});

test('completion marker spoofと取得期限切れはnullへ確定する', async () => {
  const timers = [];
  let processes = table(row(10, 1, 10, 10));
  const store = createAgentLifecycleStore({
    listProcesses: async () => processes,
    setTimer: (callback) => { timers.push(callback); return callback; },
    clearTimer: () => {},
    acquisitionTimeoutMs: 25,
  });
  const token = store.initialize('1', 1);
  const prepared = await store.prepare('1', 1, token, 10, 'claude', '/bin/zsh');
  const markerToken = prepared.setupCommand.match(/VKAgentLifecycle=([a-f0-9]+)/)[1];
  store.filterOutput('1', `${READY_MARKER_PREFIX}${markerToken}:ok${String.fromCharCode(7)}`);
  await store.activate('1', 1, token);
  timers[1]();
  processes = table(row(10, 1, 10, 20), row(20, 10, 20, 20));
  await timers[2]();
  assert.equal(store.get('1', 1), null);
  assert.equal(store.filterOutput('1', `${MARKER_PREFIX}wrong${String.fromCharCode(7)}`), `${MARKER_PREFIX}wrong${String.fromCharCode(7)}`);
});

test('group消失後にmarker未受信のまま後継取得期限が切れた場合はnull', async () => {
  const timers = [];
  let processes = table(row(10, 1, 10, 10));
  const store = createAgentLifecycleStore({
    listProcesses: async () => processes,
    setTimer: (callback) => {
      const timer = { callback, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (timer) => { timer.cleared = true; },
  });
  const runTimer = async (index) => {
    assert.equal(timers[index].cleared, false);
    await timers[index].callback();
  };

  const token = store.initialize('1', 1);
  const prepared = await store.prepare('1', 1, token, 10, 'claude', '/bin/zsh');
  const markerToken = prepared.setupCommand.match(/VKAgentLifecycle=([a-f0-9]+)/)[1];
  store.filterOutput('1', `${READY_MARKER_PREFIX}${markerToken}:ok${String.fromCharCode(7)}`);
  await store.activate('1', 1, token);
  processes = table(row(10, 1, 10, 20), row(20, 10, 20, 20));
  await runTimer(2);
  assert.equal(store.get('1', 1), 'running');

  processes = table(row(10, 1, 10, 10));
  await runTimer(3);
  assert.equal(store.get('1', 1), 'running');
  await runTimer(4);
  assert.equal(store.get('1', 1), null);
});

test('世代更新とdeleteはpoll・取得期限timerを回収する', async () => {
  const cleared = [];
  const store = createAgentLifecycleStore({
    listProcesses: async () => table(row(10, 1, 10, 10)),
    setTimer: (callback) => callback,
    clearTimer: (timer) => { cleared.push(timer); },
  });
  const token = store.initialize('1', 1);
  const prepared = await store.prepare('1', 1, token, 10, 'claude', '/bin/zsh');
  const markerToken = prepared.setupCommand.match(/VKAgentLifecycle=([a-f0-9]+)/)[1];
  store.filterOutput('1', `${READY_MARKER_PREFIX}${markerToken}:ok${String.fromCharCode(7)}`);
  await store.activate('1', 1, token);
  store.initialize('1', 2);
  assert.ok(cleared.length >= 2);
  store.delete('1');
  assert.equal(store.get('1', 2), null);
});

test('新規起動とrestartの双方が書き込み前baseline取得を通る', () => {
  const source = fs.readFileSync(require.resolve('../main'), 'utf8');
  assert.match(source, /prepareCommand: \(command\) => agentLifecycles\.prepare\(id, 1, initialLaunchToken, ptyProcess\.pid, command, shell\)/);
  assert.match(source, /prepareWrite\(launch, command\)[\s\S]*?agentLifecycles\.prepare\(request\.termId, launch\.generation, launch\.launchToken/);
  assert.match(source, /ptyShellExecutables\.set\(id, shell\)[\s\S]*?ptyShellExecutables\.get\(request\.termId\)/);
  assert.match(source, /ptyProcess\.onExit[\s\S]*?ptyShellExecutables\.delete\(id\)/);
  assert.match(source, /async function restartAgentInTerminal[\s\S]*?lifecycleLaunch\.cancelPending\(\);[\s\S]*?await stopAgentChildren/);
  assert.match(source, /const hookReady = await prepared\.ready;[\s\S]*?await lifecycleLaunch\.activate\(launch\);[\s\S]*?ptyProcess\.write\(`\$\{prepared\.command\}\\r`\)/);
  assert.match(source, /const prepared = await lifecycleLaunch\.prepareWrite\(launch, command\);[\s\S]*?lifecycleLaunch\.isCurrent\(launch\)[\s\S]*?ptyProcess\.write\(`\$\{prepared\.command\}\\r`\)/);
});

test('状態マージはagentCommandState APIの後方互換を維持する', () => {
  const states = { pane: { termId: '4', status: 'idle' } };
  assert.deepEqual(mergeAgentLifecycleStates(states, () => 2, () => 'exited'), {
    pane: { termId: '4', status: 'idle', agentGeneration: 2, agentCommandState: 'exited' },
  });
});

test('zsh/bash/fishは元コマンドと分離した世代固有prompt hookを登録する', () => {
  const marker = 'a'.repeat(48);
  const zsh = buildPromptHookCommand(marker, '/bin/zsh');
  const bash = buildPromptHookCommand(marker, '/bin/bash');
  const fish = buildPromptHookCommand(marker, '/usr/bin/fish');
  assert.match(zsh, /precmd_functions/);
  assert.match(bash, /PROMPT_COMMAND/);
  assert.match(bash, /PROMPT_COMMAND\+=\( vk_agent_prompt_/);
  assert.match(bash, /PROMPT_COMMAND="\$\{PROMPT_COMMAND-\}"\$'\\n'vk_agent_prompt_/);
  assert.match(bash, /PROMPT_COMMAND=\$vk_agent_saved_prompt_/);
  assert.match(bash, /unset "PROMPT_COMMAND\[\$vk_agent_index_/);
  assert.match(fish, /--on-event fish_prompt/);
  assert.ok(zsh.includes('\\033]1337;VKAgentLifecycle='));
  for (const setup of [zsh, bash, fish]) assert.doesNotMatch(setup, /claude --model sonnet/);
});

test('prepareは元AIコマンド行を一文字も加工しない', async () => {
  const store = createAgentLifecycleStore({ listProcesses: async () => table(row(10, 1, 10, 10)) });
  const token = store.initialize('1', 1);
  const command = `claude --model 'sonnet' # alias comment`;
  const prepared = await store.prepare('1', 1, token, 10, command, '/bin/zsh');
  assert.equal(prepared.command, command);
  assert.doesNotMatch(prepared.setupCommand, /claude|sonnet|alias comment/);
  await store.close();
});

test('実PTY: function内のcd・export・変数・PATH変更と引用が親の対話シェルへ残る', {
  skip: process.platform === 'win32' || spawnSync('/bin/zsh', ['--version']).status !== 0,
}, async (t) => {
  const pty = createRealPty(t);
  const store = createAgentLifecycleStore({ pollIntervalMs: 20 });
  t.after(() => store.close());
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-agent-cwd-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  pty.shell.write(`vk_change_shell() { cd ${target}; export VK_AGENT_PERSIST=yes; VK_AGENT_VALUE='kept value'; PATH=\"${target}:$PATH\"; }; vk_change_shell\r`);
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  await launchTracked(store, pty.shell, 'vk_change_shell');
  await waitFor(() => pty.output().split('VK_PROMPT>').length >= 4);
  pty.shell.write('printf "PERSIST:%s:%s:%s:%s\\n" "$PWD" "$VK_AGENT_PERSIST" "$VK_AGENT_VALUE" "${PATH%%:*}"\r');
  await waitFor(() => pty.output().includes(`PERSIST:${target}:yes:kept value:${target}`));
});

test('実PTY: 通常起動はrunningから全member消失後exitedへ移る', {
  skip: process.platform === 'win32' || spawnSync('/bin/zsh', ['--version']).status !== 0,
}, async (t) => {
  const pty = createRealPty(t);
  const store = createAgentLifecycleStore({ pollIntervalMs: 20 });
  t.after(() => store.close());
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  pty.clear();
  await launchTracked(store, pty.shell, `${process.execPath} -e 'setTimeout(()=>{},400)'`);
  await waitFor(() => store.get('pty', 1) === 'running');
  await waitFor(() => store.get('pty', 1) === 'exited');
  assert.match(pty.output(), /VK_PROMPT>/);
});

test('実PTY: 存在しないコマンドと監視前に終わる短命コマンドはnull', {
  skip: process.platform === 'win32' || spawnSync('/bin/zsh', ['--version']).status !== 0,
}, async (t) => {
  const pty = createRealPty(t);
  const store = createAgentLifecycleStore({ pollIntervalMs: 20 });
  t.after(() => store.close());
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  pty.clear();
  await launchTracked(store, pty.shell, '/definitely/missing/vk-agent-command');
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(store.get('pty', 1), null);
});

test('実PTY: completion marker後の別jobを取得しない', {
  skip: process.platform === 'win32' || spawnSync('/bin/zsh', ['--version']).status !== 0,
}, async (t) => {
  const pty = createRealPty(t);
  const store = createAgentLifecycleStore({ pollIntervalMs: 20, acquisitionTimeoutMs: 80 });
  t.after(() => store.close());
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  await launchTracked(store, pty.shell, '/definitely/missing/vk-agent-command');
  await new Promise((resolve) => setTimeout(resolve, 120));
  pty.shell.write(`${process.execPath} -e 'setTimeout(()=>{},300)'\r`);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(store.get('pty', 1), null);
});

test('実PTY: zsh functionとaliasを従来どおり解決する', {
  skip: process.platform === 'win32' || spawnSync('/bin/zsh', ['--version']).status !== 0,
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-agent-zsh-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const marker = path.join(root, 'called');
  const preexecLog = path.join(root, 'preexec');
  fs.writeFileSync(path.join(root, '.zshrc'), `PS1='VK_PROMPT> '\nautoload -Uz add-zsh-hook\nvk_capture_preexec() { print -r -- \"$1\" >> ${preexecLog}; }\nadd-zsh-hook preexec vk_capture_preexec\nvk_agent_function() { cd ${root}; export VK_AGENT_FROM_FUNCTION=yes; printf alias-ok >> ${marker}; ${process.execPath} -e 'setTimeout(()=>{},1000)'; }\nalias claude='vk_agent_function # alias comment'\n`);
  const ptyModule = require('node-pty');
  const shell = ptyModule.spawn('/bin/zsh', [], { env: { ...process.env, ZDOTDIR: root, TERM: 'xterm-256color', PS1: 'VK_PROMPT> ' } });
  t.after(() => { try { shell.kill(); } catch (_error) {} });
  let output = '';
  shell.onData((data) => { output += data; });
  const store = createAgentLifecycleStore({ pollIntervalMs: 20 });
  t.after(() => store.close());
  await waitFor(() => output.includes('VK_PROMPT>'));
  await launchTracked(store, shell, 'claude');
  await waitFor(() => store.get('pty', 1) === 'running');
  await waitFor(() => store.get('pty', 1) === 'exited');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'alias-ok');
  assert.ok(fs.readFileSync(preexecLog, 'utf8').split('\n').includes('claude'));
  shell.write(`if typeset | grep -q '^vk_agent_\\(prompt\\|armed\\|saved_prompt\\)_'; then printf 'TEMP:leaked\\n'; else printf 'TEMP:clean\\n'; fi\r`);
  await waitFor(() => output.includes('TEMP:clean'));
  shell.write('printf "FUNCTION:%s:%s\\n" "$PWD" "$VK_AGENT_FROM_FUNCTION"\r');
  await waitFor(() => output.includes(`FUNCTION:${root}:yes`));
});

test('実PTY: Ctrl+Z中はrunningを維持し、fg後の終了でexited', {
  skip: process.platform === 'win32' || spawnSync('/bin/zsh', ['--version']).status !== 0,
  timeout: 10000,
}, async (t) => {
  const pty = createRealPty(t);
  const store = createAgentLifecycleStore({ pollIntervalMs: 20 });
  t.after(() => store.close());
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  pty.clear();
  await launchTracked(store, pty.shell, `${process.execPath} -e 'process.stdin.once("data",()=>process.exit()); setInterval(()=>{},1000)'`);
  await waitFor(() => store.get('pty', 1) === 'running');
  pty.shell.write('\x1a');
  await waitFor(() => /suspended/i.test(pty.output()));
  assert.equal(store.get('pty', 1), 'running');
  pty.shell.write('fg\r');
  await new Promise((resolve) => setTimeout(resolve, 100));
  pty.shell.write('finish\r');
  await waitFor(() => store.get('pty', 1) === 'exited');
});

test('実PTY: bashの既存PROMPT_COMMAND完了後だけreadyとなり、AI groupだけを取得する', {
  skip: process.platform === 'win32' || spawnSync('/bin/bash', ['--version']).status !== 0,
}, async (t) => {
  const shell = require('node-pty').spawn('/bin/bash', ['--noprofile', '--norc'], {
    env: { ...process.env, TERM: 'xterm-256color', PS1: 'VK_BASH> ' },
  });
  let output = '';
  const store = createAgentLifecycleStore({ pollIntervalMs: 20 });
  shell.onData((data) => { output += store.filterOutput('bash', data); });
  t.after(() => { store.close(); try { shell.kill(); } catch (_error) {} });
  await waitFor(() => output.includes('VK_BASH>'));

  const bashMajor = Number(spawnSync('/bin/bash', ['-c', 'printf %s "$BASH_VERSINFO"'], { encoding: 'utf8' }).stdout);
  const cases = [[1, `PROMPT_COMMAND='printf "EXTERNAL_STRING\\n"; sleep 0.12'`, 'EXTERNAL_STRING']];
  if (bashMajor >= 5) cases.push([2, `PROMPT_COMMAND=('printf "EXTERNAL_ARRAY\\n"' 'sleep 0.12')`, 'EXTERNAL_ARRAY']);
  for (const [generation, declaration, externalOutput] of cases) {
    shell.write(`${declaration}\r`);
    await waitFor(() => output.includes(externalOutput));
    await waitFor(() => output.lastIndexOf('VK_BASH>') > output.lastIndexOf(externalOutput));
    output = '';
    const token = store.initialize('bash', generation);
    const command = `${process.execPath} -e 'setTimeout(()=>{},300)'`;
    const prepared = await store.prepare('bash', generation, token, shell.pid, command, '/bin/bash');
    shell.write(`${prepared.setupCommand}\r`);
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(store.get('bash', generation), null);
    assert.equal(await prepared.ready, true);
    assert.ok(output.includes(externalOutput));
    assert.equal(await store.activate('bash', generation, token), true);
    shell.write(`${prepared.command}\r`);
    await waitFor(() => store.get('bash', generation) === 'running');
    await waitFor(() => store.get('bash', generation) === 'exited');
  }
});

test('実PTY: bash文字列の末尾構文を壊さず、完了後にPROMPT_COMMANDを正確に復元する', {
  skip: process.platform === 'win32' || spawnSync('/bin/bash', ['--version']).status !== 0,
  timeout: 15000,
}, async (t) => {
  const shell = require('node-pty').spawn('/bin/bash', ['--noprofile', '--norc'], {
    env: { ...process.env, TERM: 'xterm-256color', PS1: 'VK_BASH> ' },
  });
  let output = '';
  const store = createAgentLifecycleStore({ pollIntervalMs: 20 });
  shell.onData((data) => { output += store.filterOutput('bash-edge', data); });
  t.after(() => { store.close(); try { shell.kill(); } catch (_error) {} });
  await waitFor(() => output.includes('VK_BASH>'));
  const cases = [
    ['semicolon', `PROMPT_COMMAND='printf "PC_SEMI\\n";'`, 'PC_SEMI'],
    ['newlines', `PROMPT_COMMAND=$'printf "PC_NEWLINES\\\\n"\\n\\n'`, 'PC_NEWLINES'],
    ['comment', `PROMPT_COMMAND='printf "PC_COMMENT\\n" # trailing comment'`, 'PC_COMMENT'],
    ['empty', `PROMPT_COMMAND=''`, null],
  ];
  const bashMajor = Number(spawnSync('/bin/bash', ['-c', 'printf %s "$BASH_VERSINFO"'], { encoding: 'utf8' }).stdout);
  if (bashMajor >= 5) cases.push(['array', `PROMPT_COMMAND=('printf "PC_ARRAY_1\\n"' 'printf "PC_ARRAY_2\\n"')`, 'PC_ARRAY_2']);
  for (let generation = 1; generation <= cases.length; generation += 1) {
    const [label, declaration, expectedOutput] = cases[generation - 1];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `vk-agent-bash-${label}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const before = path.join(root, 'before');
    const after = path.join(root, 'after');
    shell.write(`${declaration}; declare -p PROMPT_COMMAND > ${before}\r`);
    await waitFor(() => fs.existsSync(before));
    output = '';
    const token = store.initialize('bash-edge', generation);
    const prepared = await store.prepare('bash-edge', generation, token, shell.pid, `${process.execPath} -e 'setTimeout(()=>{},120)'`, '/bin/bash');
    shell.write(`${prepared.setupCommand}\r`);
    assert.equal(await prepared.ready, true);
    if (expectedOutput) assert.ok(output.includes(expectedOutput), `${label}: 既存prompt処理が実行されていない`);
    await store.activate('bash-edge', generation, token);
    shell.write(`${prepared.command}\r`);
    await waitFor(() => store.get('bash-edge', generation) === 'running');
    await waitFor(() => store.get('bash-edge', generation) === 'exited');
    shell.write(`declare -p PROMPT_COMMAND > ${after}\r`);
    await waitFor(() => fs.existsSync(after));
    assert.equal(fs.readFileSync(after, 'utf8'), fs.readFileSync(before, 'utf8'), `${label}: 復元値`);
    if (expectedOutput) await waitFor(() => output.split(expectedOutput).length >= 3);
  }
});

test('実PTY: bash hookのsetup待機中cancelは既存値を復元して一時定義を削除する', {
  skip: process.platform === 'win32' || spawnSync('/bin/bash', ['--version']).status !== 0,
}, async (t) => {
  const shell = require('node-pty').spawn('/bin/bash', ['--noprofile', '--norc'], {
    env: { ...process.env, TERM: 'xterm-256color', PS1: 'VK_BASH> ' },
  });
  let output = '';
  const store = createAgentLifecycleStore();
  shell.onData((data) => { output += store.filterOutput('bash-cancel', data); });
  t.after(() => { store.close(); try { shell.kill(); } catch (_error) {} });
  await waitFor(() => output.includes('VK_BASH>'));
  shell.write(`PROMPT_COMMAND='printf "PC_CANCEL\\n" # trailing comment'\r`);
  await waitFor(() => output.includes('PC_CANCEL'));
  const token = store.initialize('bash-cancel', 1);
  const prepared = await store.prepare('bash-cancel', 1, token, shell.pid, 'never-written', '/bin/bash');
  shell.write(`${prepared.setupCommand}\r`);
  store.initialize('bash-cancel', 2);
  assert.equal(await prepared.ready, false);
  shell.write(`${prepared.cleanupCommand}\r`);
  shell.write(`case "$(declare -p PROMPT_COMMAND)" in *'trailing comment'*) printf 'RESTORED:yes\\n';; *) printf 'RESTORED:no\\n';; esac; if compgen -A variable vk_agent_ | grep -q . || compgen -A function vk_agent_ | grep -q .; then printf 'TEMP:leaked\\n'; else printf 'TEMP:clean\\n'; fi\r`);
  await waitFor(() => output.includes('RESTORED:yes') && output.includes('TEMP:clean'));
});
