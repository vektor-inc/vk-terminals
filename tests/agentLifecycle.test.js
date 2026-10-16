'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { PS_ARGS, parseProcessTable, inspectLifecycle, createAgentLifecycleStore, mergeAgentLifecycleStates } = require('../utils/agentLifecycle');

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

test('同じPID/PGIDでもlstartが変われば再利用としてexited', () => {
  const snapshot = { ...initial(), trackedPgid: 20, identities: new Map([[20, START]]) };
  assert.deepEqual(inspectLifecycle(snapshot, table(row(10, 1, 10, 10), row(20, 1, 20, 10, 'S', LATER))), { state: 'exited', terminal: true });
});

test('ps失敗はnullへ倒し、古い世代の非同期結果は新世代を上書きしない', async () => {
  let resolveOld;
  const oldRead = new Promise((resolve) => { resolveOld = resolve; });
  const store = createAgentLifecycleStore({ listProcesses: () => oldRead });
  const oldMonitor = store.monitor('1', 1, 10);
  store.initialize('1', 2);
  resolveOld(table(row(10, 1, 10, 10)));
  assert.equal(await oldMonitor, false);
  assert.equal(store.get('1', 2), null);
  assert.equal(store.get('1', 1), null);
  await store.close();

  const failed = createAgentLifecycleStore({ listProcesses: () => Promise.reject(new Error('ps failed')) });
  assert.equal(await failed.monitor('1', 1, 10), false);
  assert.equal(failed.get('1', 1), null);
});

test('Windowsでは監視せずnullを維持する', async () => {
  const store = createAgentLifecycleStore({ platform: 'win32', listProcesses: () => { throw new Error('should not run'); } });
  assert.equal(await store.monitor('1', 1, 10), false);
  assert.equal(store.get('1', 1), null);
});

test('状態マージはagentCommandState APIの後方互換を維持する', () => {
  const states = { pane: { termId: '4', status: 'idle' } };
  assert.deepEqual(mergeAgentLifecycleStates(states, () => 2, () => 'exited'), {
    pane: { termId: '4', status: 'idle', agentGeneration: 2, agentCommandState: 'exited' },
  });
});

test('fishを含む全シェルへ元コマンドを一字も加工せず渡す配線', () => {
  const source = fs.readFileSync(require.resolve('../main'), 'utf8');
  assert.match(source, /command: launchCommand,/);
  assert.match(source, /ptyProcess\.write\(`\$\{command\}\\r`\)/);
  assert.doesNotMatch(source, /buildTrackedShellCommand|eval \"\$vk_command\"/);
});

test('実PTY: 通常起動はrunningから全member消失後exitedへ移る', {
  skip: process.platform === 'win32' || spawnSync('/bin/zsh', ['--version']).status !== 0,
}, async (t) => {
  const pty = createRealPty(t);
  const store = createAgentLifecycleStore({ pollIntervalMs: 20 });
  t.after(() => store.close());
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  pty.clear();
  pty.shell.write(`${process.execPath} -e 'setTimeout(()=>{},400)'\r`);
  await store.monitor('pty', 1, pty.shell.pid);
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
  pty.shell.write('/definitely/missing/vk-agent-command\r');
  await waitFor(() => pty.output().includes('VK_PROMPT>'));
  await store.monitor('pty', 1, pty.shell.pid);
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
  shell.write('claude\r');
  await store.monitor('pty', 1, shell.pid);
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
  pty.shell.write(`${process.execPath} -e 'process.stdin.once("data",()=>process.exit()); setInterval(()=>{},1000)'\r`);
  await store.monitor('pty', 1, pty.shell.pid);
  await waitFor(() => store.get('pty', 1) === 'running');
  pty.shell.write('\x1a');
  await waitFor(() => /suspended/i.test(pty.output()));
  assert.equal(store.get('pty', 1), 'running');
  pty.shell.write('fg\r');
  await new Promise((resolve) => setTimeout(resolve, 100));
  pty.shell.write('finish\r');
  await waitFor(() => store.get('pty', 1) === 'exited');
});
