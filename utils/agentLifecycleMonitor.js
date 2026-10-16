#!/usr/bin/env node
'use strict';

const net = require('node:net');
const fs = require('node:fs');

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REPLY_BYTES = 1024;
const [specPath] = process.argv.slice(2);
let spec = null;
try {
  spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
  fs.unlinkSync(specPath);
} catch (_error) {}
const { socketPath, termId, generation, token, command } = spec || {};
const readyPath = `${specPath}.ready`;
const startedPath = `${readyPath}.started`;

const monitoredShellPid = process.ppid;
let startRequested = false;
let completionRequested = false;
let socket = null;
let settled = false;
let authenticated = false;
let readyPublished = false;
let exitTimer = null;
const publishReady = () => {
  if (readyPublished) return;
  try {
    fs.writeFileSync(readyPath, command, { flag: 'wx', mode: 0o600 });
    readyPublished = true;
  } catch (_error) {}
};
const finish = (message) => {
  if (exitTimer) return;
  if (socket && !socket.destroyed && message) socket.end(`${JSON.stringify({ type: message })}\n`);
  else if (socket && !socket.destroyed) socket.destroy();
  exitTimer = setTimeout(() => process.exit(0), 250);
  exitTimer.unref();
};
const requestStart = () => {
  if (completionRequested) return finish(null);
  startRequested = true;
  if (authenticated && socket && !socket.destroyed) socket.write('{"type":"started"}\n');
  try { fs.writeFileSync(startedPath, '', { flag: 'wx', mode: 0o600 }); } catch (_error) {}
};
const requestCompletion = () => {
  completionRequested = true;
  // eval 開始通知より前の完了は異常順序。exited にせず切断して null に戻す。
  finish(startRequested && authenticated ? 'exited' : null);
};
process.on('SIGINT', () => {
  // Ctrl+C で前景のシェルグループが終了したことを確認してから exited を送る。
  const timer = setInterval(() => {
    if (process.ppid !== monitoredShellPid) {
      clearInterval(timer);
      setTimeout(requestCompletion, 50);
      return;
    }
    try { process.kill(monitoredShellPid, 0); } catch (_error) {
      clearInterval(timer);
      setTimeout(requestCompletion, 50);
    }
  }, 10);
  timer.unref();
});
process.on('SIGQUIT', () => {});
process.once('SIGUSR2', requestStart);
process.once('SIGUSR1', requestCompletion);

if (typeof socketPath !== 'string' || !socketPath || typeof termId !== 'string' || !termId ||
    !Number.isSafeInteger(generation) || generation < 1 || !TOKEN_PATTERN.test(token || '') ||
    typeof command !== 'string' || !command || typeof specPath !== 'string' || !specPath) {
  process.exitCode = 64;
} else {
  socket = net.createConnection(socketPath);
  let reply = Buffer.alloc(0);
  const fallback = () => {
    if (settled) return;
    settled = true;
    socket.destroy();
    // IPC を利用できない環境でもシェル側の AI コマンドは独立して起動を継続する。
    publishReady();
  };
  const connectTimer = setTimeout(fallback, 500);
  socket.once('connect', () => socket.write(`${JSON.stringify({ type: 'auth', termId, generation, token })}\n`));
  socket.on('data', (chunk) => {
    if (settled) return;
    reply = Buffer.concat([reply, chunk]);
    if (reply.length > MAX_REPLY_BYTES) return fallback();
    const newline = reply.indexOf(0x0a);
    if (newline < 0) return;
    let message;
    try { message = JSON.parse(reply.subarray(0, newline).toString('utf8')); } catch (_error) { return fallback(); }
    if (!message || message.type !== 'ready') return fallback();
    settled = true;
    authenticated = true;
    clearTimeout(connectTimer);
    publishReady();
    if (completionRequested) finish(null);
    else if (startRequested) socket.write('{"type":"started"}\n');
  });
  socket.once('error', fallback);
  socket.once('close', fallback);
}
