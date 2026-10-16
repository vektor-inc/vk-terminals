'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { MAX_MESSAGE_BYTES, createAgentLifecycleStore, buildTrackedLaunchCommand, mergeAgentLifecycleStates } = require('../utils/agentLifecycle');

const TOKEN_A = 'a'.repeat(64);
function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const inspect = () => {
      if (predicate()) return resolve();
      if (Date.now() >= deadline) return reject(new Error('condition timeout'));
      setTimeout(inspect, 10);
    };
    inspect();
  });
}

test('IPC: 認証後の started/exited だけを厳密な順序で反映する', async (t) => {
  const store = createAgentLifecycleStore({ createToken: () => TOKEN_A });
  await store.start();
  t.after(() => store.close());
  const credentials = store.prepare('1', 1);
  const socket = net.createConnection(credentials.socketPath);
  t.after(() => socket.destroy());
  socket.write(`${JSON.stringify({ type: 'auth', termId: '1', generation: 1, token: TOKEN_A })}\n`);
  await new Promise((resolve) => socket.once('data', resolve));
  const duplicate = net.createConnection(credentials.socketPath);
  const duplicateClosed = new Promise((resolve) => duplicate.once('close', resolve));
  duplicate.write(`${JSON.stringify({ type: 'auth', termId: '1', generation: 1, token: TOKEN_A })}\n`);
  await duplicateClosed;
  socket.write('{"type":"started"}\n');
  await waitFor(() => store.get('1', 1) === 'running');
  socket.end('{"type":"exited"}\n');
  await waitFor(() => store.get('1', 1) === 'exited');
});

test('IPC: exited 前の接続消失は現在世代だけを null に戻す', async (t) => {
  const tokens = [TOKEN_A, 'b'.repeat(64)];
  const store = createAgentLifecycleStore({ createToken: () => tokens.shift() });
  await store.start();
  t.after(() => store.close());
  const first = store.prepare('1', 1);
  const oldSocket = net.createConnection(first.socketPath);
  oldSocket.write(`${JSON.stringify({ type: 'auth', termId: '1', generation: 1, token: first.token })}\n`);
  await new Promise((resolve) => oldSocket.once('data', resolve));
  oldSocket.write('{"type":"started"}\n');
  await waitFor(() => store.get('1', 1) === 'running');
  oldSocket.destroy();
  await waitFor(() => store.get('1', 1) === null);

  const second = store.prepare('1', 2);
  const currentSocket = net.createConnection(second.socketPath);
  t.after(() => currentSocket.destroy());
  currentSocket.write(`${JSON.stringify({ type: 'auth', termId: '1', generation: 2, token: second.token })}\n`);
  await new Promise((resolve) => currentSocket.once('data', resolve));
  currentSocket.write('{"type":"started"}\n');
  await waitFor(() => store.get('1', 2) === 'running');
  assert.equal(store.get('1', 2), 'running');
});

test('IPC: 不正資格情報と巨大メッセージを拒否し、socketをprivateにする', async (t) => {
  const store = createAgentLifecycleStore({ createToken: () => TOKEN_A });
  await store.start();
  t.after(() => store.close());
  const credentials = store.prepare('1', 1);
  assert.equal(fs.statSync(credentials.socketPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(credentials.socketPath)).mode & 0o777, 0o700);
  for (const payload of [
    `${JSON.stringify({ type: 'auth', termId: '1', generation: 1, token: 'b'.repeat(64) })}\n`,
    'x'.repeat(MAX_MESSAGE_BYTES + 1),
  ]) {
    const socket = net.createConnection(credentials.socketPath);
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.write(payload);
    await closed;
  }
  assert.equal(store.get('1', 1), null);
});

test('起動行: 認証情報と元コマンドを固定引数としてクォートする', () => {
  const original = `env FOO='a b' codex --config 'x="y"'`;
  const command = buildTrackedLaunchCommand(original, {
    socketPath: "/tmp/it's.sock", termId: '7', generation: 3, token: TOKEN_A,
  }, { executable: '/path/node', monitorPath: '/app/monitor.js' });
  assert.match(command, /env ELECTRON_RUN_AS_NODE=1 /);
  assert.equal(command.includes('\x1b'), false);
  assert.match(command, /eval "\$vk_command"/);
  assert.match(command, /env ELECTRON_RUN_AS_NODE=1/);
  const specPath = command.match(/'(\/tmp\/it'\\''s\.sock\.7\.3\.[a-f0-9]+\.json)'/)[1].replace(/'\\''/g, "'");
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  fs.unlinkSync(specPath);
  assert.equal(spec.command, original);
  assert.equal(spec.token, TOKEN_A);
});

test('Windows相当: IPCが無効でも状態はnullのまま', async () => {
  const store = createAgentLifecycleStore({ platform: 'win32' });
  assert.equal(await store.start(), false);
  store.initialize('1', 1);
  assert.equal(store.prepare('1', 1), null);
  assert.equal(store.get('1', 1), null);
});

test('状態マージ: 既存値を保ち、世代と客観状態を追加する', () => {
  const states = { pane: { termId: '4', status: 'idle' } };
  assert.deepEqual(mergeAgentLifecycleStates(states, () => 2, () => 'exited'), {
    pane: { termId: '4', status: 'idle', agentGeneration: 2, agentCommandState: 'exited' },
  });
});
