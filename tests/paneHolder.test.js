'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serverEnvironment, validateSocketPath, paneArguments, encodeKeys, decodeOutput, TmuxHolder } = require('../utils/paneHolder');
const { getReadyPatternForEngine } = require('../utils/trustPromptWatcher');

test('control output の 8 進復号と入力の 16 進符号化', () => {
  assert.deepEqual(decodeOutput('A\\033\\303\\251'), Buffer.from('A\x1bé'));
  assert.deepEqual(encodeKeys('é\r'), ['c3', 'a9', '0d']);
});

test('ready プロンプト検知は直接出力と control output 復号後で同じ', () => {
  for (const [engine, prompt] of [['claude', 'Welcome to Claude'], ['codex', 'OpenAI Codex']]) {
    const escaped = Buffer.from(prompt).reduce((result, byte) => result + `\\${byte.toString(8).padStart(3, '0')}`, '');
    const direct = getReadyPatternForEngine(engine).test(prompt);
    const restored = getReadyPatternForEngine(engine).test(decodeOutput(escaped).toString());
    assert.equal(restored, direct);
    assert.equal(restored, true);
  }
});

test('保持役の環境と env -i の argv は指定値だけを渡す', () => {
  assert.deepEqual(serverEnvironment({ HOME: '/tmp', PATH: '/bin', VK915_DUMMY_SECRET: 'secret' }), { HOME: '/tmp', PATH: '/bin' });
  const malicious = 'a\n"; touch /tmp/never-run #';
  const args = paneArguments({ HOME: '/tmp', TRICK: malicious }, '/bin/sh');
  assert.deepEqual(args, ['env', '-i', 'HOME=/tmp', `TRICK=${malicious}`, 'TERM=xterm-256color', '/bin/sh']);
  assert.throws(() => paneArguments({ 'BAD=NAME': 'x' }, '/bin/sh'));
  assert.throws(() => paneArguments({ BAD: 'a\0b' }, '/bin/sh'));
});

test('ソケットの権限・リンク・型・所有者・長さを検査する', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-unit-')));
  const socket = path.join(dir, 'tmux.sock');
  try {
    assert.equal(validateSocketPath(socket), false);
    fs.chmodSync(dir, 0o755);
    assert.throws(() => validateSocketPath(socket));
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(socket, 'x');
    assert.throws(() => validateSocketPath(socket));
    fs.unlinkSync(socket);
    fs.symlinkSync('/tmp/other', socket);
    assert.throws(() => validateSocketPath(socket));
    assert.throws(() => validateSocketPath(socket, fs, process.getuid() + 1));
    assert.throws(() => validateSocketPath(path.join(dir, 'x'.repeat(105))));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tmux が見つからなければ ENOENT とし、呼び出し元が node-pty へ戻せる', () => {
  assert.throws(() => new TmuxHolder({ tmux: '/nonexistent/vk-terminals-tmux' }), { code: 'ENOENT' });
});

test('tmux 実物: 初期サーバーの秘密変数を後続ペインへ渡さず、入力を返す', async t => {
  const tmux = '/opt/homebrew/bin/tmux';
  if (!fs.existsSync(tmux)) { t.skip('tmux is unavailable'); return; }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-integration-')));
  const env = { HOME: dir, PATH: process.env.PATH || '/usr/bin:/bin', VK_TERMINALS_HOLDER_RUN_DIR: dir, VK915_DUMMY_SECRET: 'secret' };
  let holder;
  try {
    holder = new TmuxHolder({ env, home: dir, tmux });
    assert.throws(() => validateSocketPath(holder.socket, fs, process.getuid() + 1));
    const injectedFile = path.join(dir, 'injected');
    const dangerousValue = `a\n"; touch ${injectedFile}; #`;
    const pane = holder.createPane({ shell: '/bin/sh', cwd: dir, env: { HOME: dir, PATH: env.PATH, TERM: 'xterm-256color', TRICK: dangerousValue } });
    let output = '';
    pane.onData(data => { output += data; });
    pane.write('printf "INPUT_OK\\n"; if [ -z "$VK915_DUMMY_SECRET" ]; then echo SECRET_ABSENT; fi; printf "%s" "$TRICK"\r');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`tmux output timeout: ${output}`)), 5000);
      const poll = setInterval(() => {
        if (output.includes('SECRET_ABSENT') && output.includes('INPUT_OK')) { clearInterval(poll); clearTimeout(timeout); resolve(); }
      }, 20);
    });
    assert.match(output, /INPUT_OK/);
    assert.match(output, /SECRET_ABSENT/);
    assert.equal(fs.existsSync(injectedFile), false);
    assert.ok(output.replace(/\r\n/g, '\n').includes(dangerousValue));
    const exited = new Promise((resolve, reject) => {
      pane.onExit(resolve);
      setTimeout(() => reject(new Error('tmux pane exit notification missing')), 3000).unref();
    });
    pane.write('exit\r');
    await exited;
  } finally {
    if (holder) holder.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
