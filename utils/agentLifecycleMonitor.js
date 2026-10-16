#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const [generationText, startToken, exitToken, encodedCommand] = process.argv.slice(2);
const generation = Number(generationText);

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

if (!Number.isSafeInteger(generation) || generation < 1 || !TOKEN_PATTERN.test(startToken || '') ||
    !TOKEN_PATTERN.test(exitToken || '') || !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedCommand || '')) {
  process.exitCode = 64;
} else {
  const command = Buffer.from(encodedCommand, 'base64').toString('utf8');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  let words;
  try {
    words = splitCommand(command);
  } catch (_error) {
    process.exitCode = 64;
    return;
  }
  while (words.length > 1 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
    const assignment = words.shift();
    const separator = assignment.indexOf('=');
    env[assignment.slice(0, separator)] = assignment.slice(separator + 1);
  }
  if (words.length === 0) {
    process.exitCode = 64;
    return;
  }
  // shell を介さず実コマンドを spawn するため、spawn は AI プロセスの生成成功を示す。
  const child = spawn(words[0], words.slice(1), { stdio: 'inherit', env, detached: false });
  let spawned = false;
  child.once('spawn', () => {
    spawned = true;
    process.stdout.write(`\x1b]777;vk-terminals;agent-start;${generation};${startToken}\x07`);
  });
  child.once('error', () => { process.exitCode = 127; });
  child.once('close', (code, signal) => {
    if (!spawned) return;
    process.stdout.write(`\x1b]777;vk-terminals;agent-exit;${generation};${exitToken}\x07`, () => {
      process.exitCode = signal ? 128 : (Number.isInteger(code) ? code : 1);
    });
  });
}
