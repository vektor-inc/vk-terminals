'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');

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
  return { output: () => output, closed: new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal }))) };
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
