'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { createAgentLifecycleStore, buildTrackedLaunchCommand } = require('../utils/agentLifecycle');
const { buildTrackedShellCommand } = require('../utils/userShellCommand');

const monitor = path.join(__dirname, '..', 'utils', 'agentLifecycleMonitor.js');
function waitFor(predicate, timeoutMs = 4000) {
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

async function launchTracked(command, options = {}) {
  const store = createAgentLifecycleStore();
  await store.start();
  const credentials = store.prepare('pty', 1);
  const launch = buildTrackedLaunchCommand(command, credentials, {
    executable: process.execPath,
    monitorPath: monitor,
    userShell: options.userShell,
  });
  const outerShell = options.userShell || '/bin/sh';
  const shell = spawn(outerShell, outerShell === '/bin/sh' ? ['-c', launch] : ['-ic', launch], {
    detached: options.detached === true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: options.env || process.env,
  });
  let output = '';
  shell.stdout.on('data', (chunk) => { output += chunk; });
  return { store, shell, output: () => output };
}

test('監視: spawn後にrunning、正常close後にexited', { skip: process.platform === 'win32' }, async (t) => {
  const run = await launchTracked(`${process.execPath} -e 'console.log("ready"); setTimeout(()=>{},150)'`);
  t.after(() => run.store.close());
  await waitFor(() => run.store.get('pty', 1) === 'running');
  await new Promise((resolve) => run.shell.once('close', resolve));
  await waitFor(() => run.store.get('pty', 1) === 'exited');
});

test('監視: ユーザーシェルのspawn成功後はコマンド不在でもclose後にexited', { skip: process.platform === 'win32' }, async (t) => {
  const run = await launchTracked('/definitely/missing/vk-command');
  t.after(() => run.store.close());
  await new Promise((resolve) => run.shell.once('close', resolve));
  await waitFor(() => run.store.get('pty', 1) === 'exited');
});

test('IPC接続不能でも元コマンドを実行し、終了コードと一時ファイルcleanupを維持する', {
  skip: process.platform === 'win32',
}, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-no-ipc-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credentials = {
    socketPath: path.join(root, 'missing.sock'),
    termId: 'pty',
    generation: 1,
    token: 'a'.repeat(64),
  };
  const launch = buildTrackedLaunchCommand("printf 'NO_IPC'; exit 23", credentials, {
    executable: process.execPath,
    monitorPath: monitor,
    userShell: '/bin/sh',
  });
  const result = spawnSync('/bin/sh', ['-c', launch], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.stdout, 'NO_IPC');
  assert.equal(result.status, 23);
  assert.deepEqual(fs.readdirSync(root), []);
});

for (const shellName of ['zsh', 'bash']) {
  test(`${shellName}: 通常起動と監視付き起動が同じalias/function定義を使う`, {
    skip: process.platform === 'win32' || spawnSync(shellName, ['--version']).status !== 0,
    timeout: 10000,
  }, async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `vk-shell-${shellName}-`));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const shellPath = execFileSync('which', [shellName], { encoding: 'utf8' }).trim();
    const rc = shellName === 'zsh' ? '.zshrc' : '.bashrc';
    fs.writeFileSync(path.join(root, rc), [
      "alias claude='printf alias-definition'",
      "codex() { printf function-definition; }",
    ].join('\n'));
    const env = {
      ...process.env,
      HOME: root,
      ...(shellName === 'zsh' ? { ZDOTDIR: root } : {}),
    };
    const command = "printf '<'; claude; printf '><'; codex; printf '>'";
    const direct = spawnSync(shellPath, ['-ic', command], { env, encoding: 'utf8' });
    assert.equal(direct.status, 0);
    const run = await launchTracked(command, { userShell: shellPath, env });
    t.after(() => run.store.close());
    await new Promise((resolve) => run.shell.once('close', resolve));
    assert.equal(run.output(), direct.stdout);
    await waitFor(() => run.store.get('pty', 1) === 'exited');
  });
}

test('fish: 対話設定を読む起動引数とjob control無効化を生成する', () => {
  const generated = buildTrackedShellCommand('/usr/local/bin/fish', 'node monitor.js', '/tmp/ready');
  assert.match(generated, /^begin; set -l vk_ready '\/tmp\/ready'; set -l vk_started "\$vk_ready\.started"; node monitor\.js &;/);
  assert.match(generated, /eval \$vk_command/);
  assert.match(generated, /kill -s USR2 \$vk_monitor_pid/);
  assert.match(generated, /kill -s USR1 \$vk_monitor_pid/);
});

for (const signal of ['SIGTERM', 'SIGKILL']) {
  test(`実PTY: 前景グループ全体への${signal}後、PTYが残ってもnull`, {
    skip: process.platform === 'win32' || spawnSync('zsh', ['--version']).status !== 0,
    timeout: 10000,
  }, async (t) => {
    const pty = require('node-pty');
    const store = createAgentLifecycleStore();
    await store.start();
    t.after(() => store.close());
    const command = `${process.execPath} -e 'console.log("AI_PID="+process.pid); setInterval(()=>{},1000)'`;
    const launch = buildTrackedLaunchCommand(command, store.prepare('pty', 1), { executable: process.execPath, monitorPath: monitor });
    const shell = pty.spawn('zsh', ['-f'], { env: { ...process.env, TERM: 'xterm-256color', PS1: 'VK_PROMPT> ' } });
    t.after(() => { try { shell.kill(); } catch (_error) {} });
    let output = '';
    shell.onData((data) => { output += data; });
    await waitFor(() => output.includes('VK_PROMPT>'));
    output = '';
    shell.write(`${launch}\r`);
    await waitFor(() => /AI_PID=\d+/.test(output));
    await waitFor(() => store.get('pty', 1) === 'running');
    const pid = Number(output.match(/AI_PID=(\d+)/)[1]);
    const pgid = Number(execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
    process.kill(-pgid, signal);
    await waitFor(() => store.get('pty', 1) === null);
    await waitFor(() => output.includes('VK_PROMPT>'));
    assert.equal(store.get('pty', 1), null);
  });
}

test('実PTY: Ctrl+Cは子終了後exited', {
  skip: process.platform === 'win32' || spawnSync('zsh', ['--version']).status !== 0,
  timeout: 15000,
}, async (t) => {
  const pty = require('node-pty');
  const store = createAgentLifecycleStore();
  await store.start();
  t.after(() => store.close());
  const shell = pty.spawn('zsh', ['-f'], { env: { ...process.env, TERM: 'xterm-256color', PS1: 'VK_PROMPT> ' } });
  t.after(() => { try { shell.kill(); } catch (_error) {} });
  let output = '';
  shell.onData((data) => { output += data; });
  await waitFor(() => output.includes('VK_PROMPT>'));
  const run = (generation) => {
    const ai = `${process.execPath} -e 'console.log("READY"); process.stdin.once("data",()=>process.exit(0)); setInterval(()=>{},1000)'`;
    shell.write(`${buildTrackedLaunchCommand(ai, store.prepare('pty', generation), { executable: process.execPath, monitorPath: monitor })}\r`);
  };
  output = '';
  run(1);
  await waitFor(() => output.includes('READY') && store.get('pty', 1) === 'running');
  shell.write('\x03');
  await waitFor(() => store.get('pty', 1) === 'exited');
});

test('実PTY: Ctrl+Z中はrunning、fg後の終了はexited', {
  skip: process.platform === 'win32' || spawnSync('zsh', ['--version']).status !== 0,
  timeout: 10000,
}, async (t) => {
  const pty = require('node-pty');
  const store = createAgentLifecycleStore();
  await store.start();
  t.after(() => store.close());
  const shell = pty.spawn('zsh', ['-f'], { env: { ...process.env, TERM: 'xterm-256color', PS1: 'VK_PROMPT> ' } });
  t.after(() => { try { shell.kill(); } catch (_error) {} });
  let output = '';
  shell.onData((data) => { output += data; });
  await waitFor(() => output.includes('VK_PROMPT>'));
  output = '';
  const ai = `${process.execPath} -e 'console.log("READY"); process.stdin.once("data",()=>process.exit(0)); setInterval(()=>{},1000)'`;
  shell.write(`${buildTrackedLaunchCommand(ai, store.prepare('pty', 1), { executable: process.execPath, monitorPath: monitor })}\r`);
  await waitFor(() => output.includes('READY') && store.get('pty', 1) === 'running');
  shell.write('\x1a');
  await waitFor(() => /suspended/i.test(output));
  assert.equal(store.get('pty', 1), 'running');
  output = '';
  shell.write('fg\r');
  await new Promise((resolve) => setTimeout(resolve, 100));
  shell.write('finish\r');
  await waitFor(() => store.get('pty', 1) === 'exited');
});
