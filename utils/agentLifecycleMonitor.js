#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const net = require('node:net');

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_REPLY_BYTES = 1024;
const [socketPath, termId, generationText, token, encodedCommand] = process.argv.slice(2);
const generation = Number(generationText);

process.on('SIGINT', () => {});
process.on('SIGQUIT', () => {});

function splitCommand(command) {
  const words = [];
  let word = '';
  let quote = null;
  let escaped = false;
  let started = false;
  for (const char of command) {
    if (escaped) { word += char; escaped = false; started = true; continue; }
    if (char === '\\' && quote !== "'") { escaped = true; started = true; continue; }
    if (quote) {
      if (char === quote) quote = null;
      else word += char;
      started = true;
      continue;
    }
    if (char === "'" || char === '"') { quote = char; started = true; continue; }
    if (/\s/.test(char)) {
      if (started) { words.push(word); word = ''; started = false; }
      continue;
    }
    if (';&|<>`$(){}\n\r'.includes(char)) throw new Error('unsupported shell syntax');
    word += char;
    started = true;
  }
  if (escaped || quote) throw new Error('unterminated shell quoting');
  if (started) words.push(word);
  return words;
}

function spawnCommand(command, socket) {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let words;
  try { words = splitCommand(command); } catch (_error) {
    if (socket) socket.destroy();
    process.exitCode = 64;
    return;
  }
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const assignment = words.shift();
    const separator = assignment.indexOf('=');
    env[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  if (words.length === 0) {
    if (socket) socket.destroy();
    process.exitCode = 64;
    return;
  }
  const child = spawn(words[0], words.slice(1), { stdio: 'inherit', env, detached: false });
  let spawned = false;
  child.once('spawn', () => {
    spawned = true;
    if (socket && !socket.destroyed) socket.write('{"type":"started"}\n');
  });
  child.once('error', () => {
    if (socket) socket.destroy();
    process.exitCode = 127;
  });
  child.once('close', (code, signal) => {
    if (!spawned) return;
    const finish = () => { process.exitCode = signal ? 128 : (Number.isInteger(code) ? code : 1); };
    if (socket && !socket.destroyed) socket.end('{"type":"exited"}\n', finish);
    else finish();
  });
}

if (typeof socketPath !== 'string' || !socketPath || typeof termId !== 'string' || !termId ||
    !Number.isSafeInteger(generation) || generation < 1 || !TOKEN_PATTERN.test(token || '') ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedCommand || '')) {
  process.exitCode = 64;
} else {
  const command = Buffer.from(encodedCommand, 'base64').toString('utf8');
  const socket = net.createConnection(socketPath);
  let reply = Buffer.alloc(0);
  let settled = false;
  const fallback = () => {
    if (settled) return;
    settled = true;
    socket.destroy();
    // IPC を利用できない環境でも AI 起動は維持し、状態だけを追跡不能の null にする。
    spawnCommand(command, null);
  };
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
    spawnCommand(command, socket);
  });
  socket.once('error', fallback);
  socket.once('close', fallback);
}
