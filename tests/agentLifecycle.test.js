'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PS_ARGS, MARKER_PREFIX, parseProcessTable, inspectLifecycle, buildTrackedLaunchCommand, createAgentLifecycleStore, mergeAgentLifecycleStates } = require('../utils/agentLifecycle');

const START = 'Fri Oct 16 10:00:00 2026';
const LATER = 'Fri Oct 16 10:01:00 2026';
const row = (pid, ppid, pgid, tpgid, stat = 'S', lstart = START) => ({ pid, ppid, pgid, tpgid, stat, lstart });
const table = (...rows) => new Map(rows.map((process) => [process.pid, process]));
const initial = () => ({ shellPid: 10, shellLstart: START, trackedPgid: null, identities: new Map() });

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
  assert.equal(yes.trackedPgid, 20);
  assert.equal(inspectLifecycle(initial(), table(row(10, 1, 10, 10))).state, null);
  assert.equal(inspectLifecycle(initial(), table(row(10, 1, 10, 20), row(20, 1, 20, 20))).state, null);
});

test('停止中groupは前景がシェルへ戻ってもrunningを維持する', () => {
  const snapshot = { ...initial(), trackedPgid: 20, identities: new Map([[20, START]]) };
  assert.equal(inspectLifecycle(snapshot, table(row(10, 1, 10, 10), row(20, 10, 20, 10, 'T'))).state, 'running');
});

test('追跡groupの全member消失時だけexited', () => {
  const snapshot = { ...initial(), trackedPgid: 20, identities: new Map([[20, START], [21, START]]) };
  assert.equal(inspectLifecycle(snapshot, table(row(10, 1, 10, 10), row(21, 1, 20, 10))).state, 'running');
  assert.deepEqual(inspectLifecycle(snapshot, table(row(10, 1, 10, 10))), { state: 'exited', terminal: true });
});

test('poll間に親が生成して先に終了した子を追跡集合へ引き継ぐ', () => {
  const snapshot = { ...initial(), trackedPgid: 20, identities: new Map([[20, START]]) };
  const withChild = inspectLifecycle(snapshot, table(row(10, 1, 10, 20), row(20, 10, 20, 20), row(21, 20, 20, 20)));
  assert.equal(withChild.state, 'running');
  assert.equal(withChild.identities.get(21), START);
  const afterParentExit = inspectLifecycle({ ...snapshot, identities: withChild.identities }, table(row(10, 1, 10, 20), row(21, 1, 20, 20)));
  assert.equal(afterParentExit.state, 'running');
});

test('group leaderが先に終了しても既知memberが残る間はrunning', () => {
  const snapshot = { ...initial(), trackedPgid: 20, identities: new Map([[20, START], [21, START]]) };
  assert.equal(inspectLifecycle(snapshot, table(row(10, 1, 10, 20), row(21, 1, 20, 20))).state, 'running');
});

test('既知identity消失後に同PGIDの未観測memberが残ればnull', () => {
  const snapshot = { ...initial(), trackedPgid: 20, identities: new Map([[20, START]]) };
  assert.deepEqual(inspectLifecycle(snapshot, table(row(10, 1, 10, 20), row(21, 1, 20, 20))), { state: null, terminal: true });
});

test('baselineに存在したgroupとidentityは取得しない', () => {
  const snapshot = { ...initial(), baselinePgids: new Set([20]), baselineIdentities: new Map([[20, START]]) };
  assert.equal(inspectLifecycle(snapshot, table(row(10, 1, 10, 20), row(20, 10, 20, 20))).state, null);
});

test('同じPID/PGIDでもlstartが変われば再利用としてnull', () => {
  const snapshot = { ...initial(), trackedPgid: 20, identities: new Map([[20, START]]) };
  assert.deepEqual(inspectLifecycle(snapshot, table(row(10, 1, 10, 10), row(20, 1, 20, 10, 'S', LATER))), { state: null, terminal: true });
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
  const markerToken = prepared.command.match(/VKAgentLifecycle=([a-f0-9]+)/)[1];
  const marker = `${MARKER_PREFIX}${markerToken}${String.fromCharCode(7)}`;
  const splitAt = Math.floor(marker.length / 2);
  assert.equal(store.filterOutput('1', `before${marker.slice(0, splitAt)}`), 'before');
  assert.equal(store.filterOutput('1', `${marker.slice(splitAt)}after`), 'after');
  assert.equal(store.get('1', 1), null);
  assert.ok(timers.length >= 2);
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
  await store.prepare('1', 1, token, 10, 'claude', '/bin/zsh');
  timers[0]();
  processes = table(row(10, 1, 10, 20), row(20, 10, 20, 20));
  await timers[1]();
  assert.equal(store.get('1', 1), null);
  assert.equal(store.filterOutput('1', `${MARKER_PREFIX}wrong${String.fromCharCode(7)}`), `${MARKER_PREFIX}wrong${String.fromCharCode(7)}`);
});

test('世代更新とdeleteはpoll・取得期限timerを回収する', async () => {
  const cleared = [];
  const store = createAgentLifecycleStore({
    listProcesses: async () => table(row(10, 1, 10, 10)),
    setTimer: (callback) => callback,
    clearTimer: (timer) => { cleared.push(timer); },
  });
  const token = store.initialize('1', 1);
  await store.prepare('1', 1, token, 10, 'claude', '/bin/zsh');
  store.initialize('1', 2);
  assert.equal(cleared.length, 2);
  store.delete('1');
  assert.equal(store.get('1', 2), null);
});

test('新規起動とrestartの双方が書き込み前baseline取得を通る', () => {
  const source = fs.readFileSync(require.resolve('../main'), 'utf8');
  assert.match(source, /prepareCommand: \(command\) => agentLifecycles\.prepare\(id, 1, initialLaunchToken, ptyProcess\.pid, command, shell\)/);
  assert.match(source, /prepareWrite\(launch, command\)[\s\S]*?agentLifecycles\.prepare\(request\.termId, launch\.generation, launch\.launchToken/);
  assert.match(source, /const prepared = await lifecycleLaunch\.prepareWrite\(launch, command\);[\s\S]*?lifecycleLaunch\.isCurrent\(launch\)[\s\S]*?ptyProcess\.write\(`\$\{prepared\.command\}\\r`\)/);
});

test('状態マージはagentCommandState APIの後方互換を維持する', () => {
  const states = { pane: { termId: '4', status: 'idle' } };
  assert.deepEqual(mergeAgentLifecycleStates(states, () => 2, () => 'exited'), {
    pane: { termId: '4', status: 'idle', agentGeneration: 2, agentCommandState: 'exited' },
  });
});

test('zsh/bashとfishは現在シェルで元コマンドを実行し終了コードを維持する', () => {
  const marker = 'a'.repeat(48);
  const zsh = buildTrackedLaunchCommand('claude --model sonnet', marker, '/bin/zsh');
  const fish = buildTrackedLaunchCommand('claude --model sonnet', marker, '/usr/bin/fish');
  assert.match(zsh, /^\{ claude --model sonnet;/);
  assert.match(zsh, /eval "unset vk_agent_status_/);
  assert.match(fish, /^begin; claude --model sonnet;/);
  assert.match(fish, /command sh -c "exit \$vk_agent_status_/);
  assert.ok(zsh.includes('\\033]1337;VKAgentLifecycle='));
  for (const shellPath of ['/bin/zsh', '/bin/bash']) {
    if (spawnSync(shellPath, ['--version']).status !== 0) continue;
    const result = spawnSync(shellPath, ['-c', buildTrackedLaunchCommand('exit 23', marker, shellPath)]);
    assert.equal(result.status, 23);
  }
});

test('実PTY: function内のcd・export・変数変更が親の対話シェルへ残る', {
  skip: process.platform === 'win32' || spawnSync('/bin/zsh', ['--version']).status !== 0,
}, async (t) => {
  const pty = createRealPty(t);
  const store = createAgentLifecycleStore({ pollIntervalMs: 20 });
  t.after(() => store.close());
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  const target = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-agent-cwd-'));
  t.after(() => fs.rmSync(target, { recursive: true, force: true }));
  pty.shell.write(`vk_change_shell() { cd ${target}; export VK_AGENT_PERSIST=yes; VK_AGENT_VALUE=kept; }; vk_change_shell\r`);
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  await launchTracked(store, pty.shell, 'vk_change_shell');
  await waitFor(() => pty.output().split('VK_PROMPT>').length >= 4);
  pty.shell.write('printf "PERSIST:%s:%s:%s\\n" "$PWD" "$VK_AGENT_PERSIST" "$VK_AGENT_VALUE"\r');
  await waitFor(() => pty.output().includes(`PERSIST:${target}:yes:kept`));
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
  fs.writeFileSync(path.join(root, '.zshrc'), `PS1='VK_PROMPT> '\nvk_agent_function() { printf alias-ok >> ${marker}; ${process.execPath} -e 'setTimeout(()=>{},1000)'; }\nalias claude=vk_agent_function\n`);
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
