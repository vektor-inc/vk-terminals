'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { buildTrackedLaunchCommand, createAgentLifecycleMarkerParser, createAgentLifecycleStore } = require('../utils/agentLifecycle');

const monitor = path.join(__dirname, '..', 'utils', 'agentLifecycleMonitor.js');
const START = 'a'.repeat(64);
const EXIT = 'b'.repeat(64);

function runMonitor(command, options = {}) {
  return spawn(process.execPath, [monitor, '9', START, EXIT, Buffer.from(command).toString('base64')], {
    env: { ...process.env },
    detached: options.detached || false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function collect(child) {
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  return { output: () => output, stream: child.stdout, closed: new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))) };
}

function waitForOutput(result, pattern) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`output timeout: ${pattern}`)), 2000);
    const inspect = () => {
      if (!pattern.test(result.output())) return;
      clearTimeout(timeout);
      resolve();
    };
    result.stream.on('data', inspect);
    inspect();
  });
}

test('監視プロセス: 子の spawn 後だけ start、close 後だけ exit を出す', async () => {
  const child = runMonitor(`VK_TEST_VALUE='a b' ${process.execPath} -e 'process.stdout.write(process.env.VK_TEST_VALUE); process.exit(7)'`);
  const result = collect(child);
  assert.deepEqual(await result.closed, { code: 7, signal: null });
  assert.equal(result.output(), `\x1b]777;vk-terminals;agent-start;9;${START}\x07a b\x1b]777;vk-terminals;agent-exit;9;${EXIT}\x07`);
});

test('監視プロセス: 子を spawn できなければマーカーを一切出さない', async () => {
  const child = runMonitor('/definitely/missing/vk-command');
  const result = collect(child);
  assert.deepEqual(await result.closed, { code: 127, signal: null });
  assert.equal(result.output(), '');
});

test('監視プロセス: SIGINT で子が終了しても close 後に exit を出す', { skip: process.platform === 'win32' }, async () => {
  const child = runMonitor(`${process.execPath} -e 'console.log("ready"); setInterval(() => {}, 1000)'`, { detached: true });
  const result = collect(child);
  await waitForOutput(result, /ready/);
  process.kill(-child.pid, 'SIGINT');
  assert.deepEqual(await result.closed, { code: 128, signal: null });
  assert.match(result.output(), new RegExp(`agent-exit;9;${EXIT}`));
});

test('監視プロセス: 子が SIGINT を処理して継続する間は exit を出さない', { skip: process.platform === 'win32' }, async () => {
  const script = 'process.on("SIGINT",()=>console.log("continued")); console.log("ready"); setTimeout(()=>{},350)';
  const child = runMonitor(`${process.execPath} -e '${script}'`, { detached: true });
  const result = collect(child);
  await waitForOutput(result, /ready/);
  process.kill(-child.pid, 'SIGINT');
  await waitForOutput(result, /continued/);
  assert.equal(result.output().includes('agent-exit'), false);
  assert.deepEqual(await result.closed, { code: 0, signal: null });
  assert.match(result.output(), new RegExp(`agent-exit;9;${EXIT}`));
});

test('監視プロセス: exit を出せず異常終了したらシェルが unknown を通知する', { skip: process.platform === 'win32' }, async () => {
  const tokens = [START, EXIT];
  const store = createAgentLifecycleStore(() => tokens.shift());
  const marker = store.prepare('1', 9);
  const command = `${process.execPath} -e 'setTimeout(()=>process.kill(process.ppid,"SIGKILL"),50); setTimeout(()=>{},150)'`;
  const launchCommand = buildTrackedLaunchCommand(command, marker, { executable: process.execPath, monitorPath: monitor });
  const shell = spawn('/bin/sh', ['-c', launchCommand], { stdio: ['ignore', 'pipe', 'pipe'] });
  const result = collect(shell);
  const markers = [];
  const parser = createAgentLifecycleMarkerParser((type, generation, token) => {
    markers.push(type);
    if (type === 'start') store.markStarted('1', generation, token);
    else if (type === 'exit') store.markExited('1', generation, token);
    else store.markUnknown('1', generation, token);
  });
  shell.stdout.on('data', (chunk) => parser.push(chunk));
  await result.closed;
  parser.flush();
  assert.deepEqual(markers, ['start', 'unknown']);
  assert.equal(store.get('1', 9), null);
});

test('監視プロセス: 同じプロセスグループの停止中は exit マーカーを出さない', { skip: process.platform === 'win32' }, async () => {
  const command = `${process.execPath} -e 'console.log(process.pid); setTimeout(() => {}, 450)'`;
  const child = runMonitor(command, { detached: true });
  const result = collect(child);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('start marker timeout')), 2000);
    child.stdout.on('data', () => {
      if (result.output().includes('agent-start') && /\d+\n/.test(result.output())) { clearTimeout(timeout); resolve(); }
    });
  });
  const childPid = Number(result.output().match(/(\d+)\n/)[1]);
  const { execFileSync } = require('node:child_process');
  const monitorPgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim();
  const childPgid = execFileSync('ps', ['-o', 'pgid=', '-p', String(childPid)], { encoding: 'utf8' }).trim();
  assert.equal(childPgid, monitorPgid);
  process.kill(-child.pid, 'SIGSTOP');
  await new Promise((resolve) => setTimeout(resolve, 550));
  assert.equal(result.output().includes('agent-exit'), false);
  process.kill(-child.pid, 'SIGCONT');
  assert.deepEqual(await result.closed, { code: 0, signal: null });
  assert.equal(result.output().includes(`agent-exit;9;${EXIT}`), true);
});

test('実PTY: zsh の Ctrl+Z で停止し、fg 後の実終了で exited になる', {
  skip: process.platform === 'win32' || spawnSync('zsh', ['--version']).status !== 0,
  timeout: 10000,
}, async (t) => {
  const pty = require('node-pty');
  const tokens = [START, EXIT];
  const store = createAgentLifecycleStore(() => tokens.shift());
  const marker = store.prepare('pty', 9);
  const aiCommand = `${process.execPath} -e 'process.on("SIGCONT",()=>console.log("AI_RESUMED")); console.log("AI_READY"); process.stdin.once("data",()=>process.exit(0)); setInterval(()=>{},1000)'`;
  const launchCommand = buildTrackedLaunchCommand(aiCommand, marker, {
    executable: process.execPath,
    monitorPath: monitor,
  });
  const shell = pty.spawn('zsh', ['-f'], {
    cols: 100,
    rows: 30,
    env: { ...process.env, TERM: 'xterm-256color', PS1: 'VK_PROMPT> ' },
  });
  t.after(() => {
    try { shell.kill(); } catch (_error) { /* 終了済みなら何もしない。 */ }
  });

  let output = '';
  const waitForPtyOutput = (pattern) => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`PTY output timeout: ${pattern}\n${output}`)), 3000);
    const inspect = () => {
      if (!pattern.test(output)) return;
      clearTimeout(timeout);
      subscription.dispose();
      resolve();
    };
    const subscription = shell.onData((data) => { output += data; inspect(); });
    inspect();
  });
  const parser = createAgentLifecycleMarkerParser((type, generation, token) => {
    if (type === 'start') store.markStarted('pty', generation, token);
    else if (type === 'exit') store.markExited('pty', generation, token);
    else store.markUnknown('pty', generation, token);
  });
  const parserSubscription = shell.onData((data) => parser.push(data));
  t.after(() => parserSubscription.dispose());

  await waitForPtyOutput(/VK_PROMPT>/);
  output = '';
  shell.write(`${launchCommand}\r`);
  await waitForPtyOutput(/AI_READY/);
  assert.equal(store.get('pty', 9), 'running');

  output = '';
  shell.write('\x1a');
  await waitForPtyOutput(/suspended/);
  assert.equal(store.get('pty', 9), 'running');
  assert.equal(output.includes('agent-unknown'), false);
  assert.equal(output.includes('agent-exit'), false);

  output = '';
  shell.write('fg\r');
  await waitForPtyOutput(/AI_RESUMED/);
  output = '';
  shell.write('finish\r');
  await waitForPtyOutput(/VK_PROMPT>/);
  parser.flush();
  assert.equal(store.get('pty', 9), 'exited');
});
