'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeEmbeddedOptions } = require('../utils/runtimeOptions');
const { createSetupShellInput } = require('../utils/setupShellInput');

test('setupShell はコマンドと任意の作業フォルダを受け付ける', () => {
  const command = 'curl -fsSL https://claude.ai/install.sh | bash';
  assert.deepEqual(normalizeEmbeddedOptions({ setupShell: { command, cwd: process.cwd() } }).setupShell, { command, cwd: process.cwd() });
  assert.deepEqual(normalizeEmbeddedOptions({ setupShell: { command } }).setupShell, { command, cwd: null });
  assert.equal(normalizeEmbeddedOptions({}).setupShell, null);
});

test('setupShell は不正な入力を拒否する', () => {
  for (const value of [null, 1, [], {}, { command: '' }, { command: ' ' }, { command: 1 }, { command: 'x'.repeat(1001) }, { command: 'a\nb' }, { command: 'a\rb' }, { command: 'a\x1bb' }, { command: 'a\x7fb' }, { command: 'a\x00b' }, { command: 'x', cwd: '.' }, { command: 'x', cwd: '/missing-607' }]) {
    assert.throws(() => normalizeEmbeddedOptions({ setupShell: value }), TypeError);
  }
});

test('プロンプトが出るまで書かず、Enter なしで一度だけ貼り付ける', () => {
  const writes = [];
  const callbacks = [];
  const input = createSetupShellInput('curl example | bash', value => writes.push(value), { setTimer: fn => { callbacks.push(fn); return callbacks.length; }, clearTimer: () => {} });
  input.onData('login banner\r\n');
  assert.equal(writes.length, 0);
  input.onData('\x1b[?2004huser@host % ');
  callbacks.at(-1)();
  input.onData('user@host % ');
  assert.deepEqual(writes, ['\x1b[200~curl example | bash\x1b[201~']);
  assert.equal(writes[0].includes('\r'), false);
  assert.equal(writes[0].includes('\n'), false);
});

test('ブラケット貼り付けが無い場合も Enter を付けず、タブは quote-next で入力する', () => {
  const writes = [];
  let callback;
  const scheduler = { setTimer: fn => { callback = fn; return 1; }, clearTimer: () => {} };
  createSetupShellInput('echo hello', value => writes.push(value), scheduler).onData('$ ');
  callback();
  assert.deepEqual(writes, ['echo hello']);
  createSetupShellInput('echo\thello', value => writes.push(value), scheduler).onData('$ ');
  callback();
  assert.deepEqual(writes, ['echo hello', 'echo\x16\thello']);
});

test('先に利用者が入力した場合は自動挿入しない', () => {
  const writes = [];
  let callback;
  const input = createSetupShellInput('echo hello', value => writes.push(value), { setTimer: fn => { callback = fn; return 1; }, clearTimer: () => {} });
  input.onData('$ ');
  input.onInput('x');
  callback();
  assert.deepEqual(writes, []);
});

test('専用起動だけが復元・追加ペイン・セットアップ自動確認を止める', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  assert.match(main, /const SETUP_SHELL = EMBEDDED_OPTIONS\?\.setupShell \|\| null/);
  assert.match(main, /const noClaude = setupShellLaunch \? true/);
  assert.match(main, /if \(EMBEDDED_OPTIONS\?\.setupShell\) return \{ panes: \[\]/);
  assert.match(main, /if \(SETUP_SHELL\) return;\n  if \(restoredPaneCount\)/);
  assert.match(renderer, /if \(!setupShellStartup && initialRestorePending/);
  assert.match(renderer, /if \(setupShellStartup\) initialPaneOptions = \{ setupShell: true \}/);
  assert.match(renderer, /if \(setupPanel && !setupShellStartup\)/);
});
