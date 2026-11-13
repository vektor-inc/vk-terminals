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
  for (const value of [null, 1, [], {}, { command: '' }, { command: ' ' }, { command: 1 }, { command: 'x'.repeat(1001) }, { command: 'a\nb' }, { command: 'a\rb' }, { command: 'a\x1bb' }, { command: 'a\x7fb' }, { command: 'a\x00b' }, { command: 'a\tb' }, { command: 'a\u0085b' }, { command: 'a\u2028b' }, { command: 'a\u2029b' }, { command: 'a\u202eb' }, { command: 'a\u200bb' }, { command: 'x', cwd: '.' }, { command: 'x', cwd: '/missing-607' }]) {
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

test('ブラケット貼り付けが無い場合は素の文字列を入力する', () => {
  const writes = [];
  let callback;
  createSetupShellInput('echo hello', value => writes.push(value), { setTimer: fn => { callback = fn; return 1; }, clearTimer: () => {} }).onData('$ ');
  callback();
  assert.deepEqual(writes, ['echo hello']);
});

test('貼り付けモードの分割・解除と右側プロンプトを扱う', () => {
  const writes = [];
  let callbacks = [];
  const timer = { setTimer: fn => { callbacks.push(fn); return callbacks.length; }, clearTimer: () => {} };
  const input = createSetupShellInput('echo hello', value => writes.push(value), timer);
  input.onData('\x1b[?20');
  input.onData('04h➜  ~ ');
  callbacks.at(-1)();
  assert.deepEqual(writes, ['\x1b[200~echo hello\x1b[201~']);
  const disabled = createSetupShellInput('echo hello', value => writes.push(value), timer);
  disabled.onData('\x1b[?2004h\x1b[?2004l➜  ~ ');
  callbacks.at(-1)();
  assert.equal(writes.length, 1);
  const fallback = createSetupShellInput('echo hello', value => writes.push(value), timer);
  fallback.onData('➜  ~ \x1b[10G');
  callbacks.at(-1)();
  assert.equal(writes.at(-1), 'echo hello');
});

test('dispose と30秒の期限後は入力しない', () => {
  for (const expire of [false, true]) {
    const writes = [];
    const timers = new Map();
    let next = 0;
    const input = createSetupShellInput('echo', value => writes.push(value), {
      setTimer: (fn, delay) => { timers.set(++next, { fn, delay }); return next; },
      clearTimer: id => timers.delete(id),
    });
    input.onData('$ ');
    const quiet = [...timers.values()].find(item => item.delay === 150).fn;
    if (expire) timers.get(1).fn(); else input.dispose();
    quiet();
    input.onData('$ ');
    assert.deepEqual(writes, []);
  }
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

test('専用セッションの起動条件と追加ペインの安全側の既定値', () => {
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  assert.match(main, /SETUP_SHELL \? null : resolvePaneHolder/);
  assert.match(main, /options\.setupShell === true && ptys\.size === 0 && !setupShellInputUsed/);
  assert.match(main, /const noClaude = SETUP_SHELL \? true/);
  assert.match(renderer, /setupShellInputUsed \? \{ noClaude: true \} : \{ setupShell: true \}/);
});
