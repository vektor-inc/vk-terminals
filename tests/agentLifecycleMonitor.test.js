'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { createAgentLifecycleStore, buildTrackedLaunchCommand } = require('../utils/agentLifecycle');

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
  const launch = buildTrackedLaunchCommand(command, credentials, { executable: process.execPath, monitorPath: monitor });
  const shell = spawn('/bin/sh', ['-c', launch], { detached: options.detached === true, stdio: ['pipe', 'pipe', 'pipe'] });
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

test('監視: spawn失敗はnull', { skip: process.platform === 'win32' }, async (t) => {
  const run = await launchTracked('/definitely/missing/vk-command');
  t.after(() => run.store.close());
  await new Promise((resolve) => run.shell.once('close', resolve));
  await waitFor(() => run.store.get('pty', 1) === null);
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

test('実PTY: Ctrl+Cは子終了後exited、Ctrl+Z中はrunning、fg後の終了はexited', {
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
  output = '';
  run(2);
  await waitFor(() => output.includes('READY') && store.get('pty', 2) === 'running');
  shell.write('\x1a');
  await waitFor(() => /suspended/i.test(output));
  assert.equal(store.get('pty', 2), 'running');
  output = '';
  shell.write('fg\r');
  await new Promise((resolve) => setTimeout(resolve, 100));
  shell.write('finish\r');
  await waitFor(() => store.get('pty', 2) === 'exited');
});
