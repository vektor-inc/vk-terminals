'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { serverEnvironment, isSafeSocketPresent, createPaneEnvironmentScript, encodeKeys, decodeOutput, TmuxHolder } = require('../utils/paneHolder');
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

test('保持役の環境と一時スクリプトを隔離して検査する', () => {
  assert.deepEqual(serverEnvironment({ HOME: '/tmp', PATH: '/bin', VK915_DUMMY_SECRET: 'secret' }), { HOME: '/tmp', PATH: '/bin' });
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-script-')));
  try {
    const script = createPaneEnvironmentScript(dir, { HOME: dir, UID: '123', 'BASH_FUNC_x%%': 'ignored', TRICK: 'a\n"; touch /tmp/never-run #' }, '/bin/sh');
    const body = fs.readFileSync(script, 'utf8');
    assert.match(body.split('\n')[1], /^rm -f -- /);
    assert.doesNotMatch(body, /export UID=/);
    assert.doesNotMatch(body, /BASH_FUNC/);
    assert.match(body, /unset SHLVL/);
    assert.equal(fs.statSync(script).mode & 0o777, 0o600);
    assert.throws(() => createPaneEnvironmentScript(dir, { BAD: 'a\0b' }, '/bin/sh'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ソケットの権限・リンク・型・所有者・長さを検査する', async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-unit-')));
  const socket = path.join(dir, 'tmux.sock');
  try {
    assert.equal(isSafeSocketPresent(socket), false);
    fs.chmodSync(dir, 0o755);
    assert.throws(() => isSafeSocketPresent(socket));
    fs.chmodSync(dir, 0o700);
    fs.writeFileSync(socket, 'x');
    assert.throws(() => isSafeSocketPresent(socket));
    fs.unlinkSync(socket);
    fs.symlinkSync('/tmp/other', socket);
    assert.throws(() => isSafeSocketPresent(socket));
    assert.throws(() => isSafeSocketPresent(socket, fs, process.getuid() + 1));
    assert.throws(() => isSafeSocketPresent(path.join(dir, 'x'.repeat(105))));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tmux が見つからなくても実行ディレクトリを作らない', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-missing-')));
  try {
    const run = path.join(dir, 'run');
    assert.throws(() => new TmuxHolder({ tmux: '/nonexistent/vk-terminals-tmux', env: { HOME: dir, VK_TERMINALS_HOLDER_RUN_DIR: run }, home: dir }), { code: 'TMUX_NOT_FOUND' });
    assert.equal(fs.existsSync(run), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('tmux 実物: 初期サーバーの秘密変数を後続ペインへ渡さず、入力を返す', async t => {
  const tmux = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'tmux')).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; } });
  if (!tmux) { t.skip('tmux is unavailable'); return; }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-integration-')));
  const env = { HOME: dir, PATH: process.env.PATH || '/usr/bin:/bin', VK_TERMINALS_HOLDER_RUN_DIR: dir, VK915_DUMMY_SECRET: 'secret' };
  let holder;
  try {
    holder = new TmuxHolder({ env, home: dir, tmux });
    assert.throws(() => isSafeSocketPresent(holder.socket, fs, process.getuid() + 1));
    const injectedFile = path.join(dir, 'injected');
    const dangerousValue = `a\n"; touch ${injectedFile}; #`;
    const pane = holder.createPane({ shell: '/bin/sh', cwd: dir, env: { HOME: dir, PATH: env.PATH, TERM: 'xterm-256color', TRICK: dangerousValue, UID: '12345' } });
    pane.resize(101, 37);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.match(holder.command(['display-message', '-p', '-t', pane.paneId, '#{window_width}x#{window_height}']), /101x37/);
    let output = '';
    pane.onData(data => { output += data; });
    holder.accept(`%output ${pane.paneId} SPL`);
    holder.accept('IT\n');
    assert.match(output, /SPLIT/);
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
    const longInput = 'x'.repeat(2000);
    pane.write(`printf '%s' '${longInput}' | wc -c\r`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`long input timeout: ${output.slice(-300)}`)), 10000);
      const poll = setInterval(() => {
        if (/\r?\n\s*2000\r?\n/.test(output)) { clearInterval(poll); clearTimeout(timeout); resolve(); }
      }, 20);
    });
    const rawFile = path.join(dir, 'raw-input');
    pane.write(`stty -icanon -echo; cat > '${rawFile}'\r`);
    await new Promise(resolve => setTimeout(resolve, 100));
    const rawInput = 'éx'.repeat(12000);
    pane.write(rawInput);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`raw input timeout: ${fs.existsSync(rawFile) ? fs.statSync(rawFile).size : 'missing'}`)), 10000);
      const poll = setInterval(() => {
        if (fs.existsSync(rawFile) && fs.statSync(rawFile).size >= Buffer.byteLength(rawInput)) { clearInterval(poll); clearTimeout(timeout); resolve(); }
      }, 20);
    });
    assert.equal(fs.readFileSync(rawFile, 'utf8'), rawInput);
    const other = holder.createPane({ shell: '/bin/sh', cwd: dir, env: { HOME: dir, PATH: env.PATH } });
    let otherOutput = '';
    other.onData(data => { otherOutput += data; });
    const bulk = 'y'.repeat(100 * 1024);
    const bulkStart = performance.now();
    pane.write(bulk);
    other.write('echo OTHER_PANE_READY\r');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('other pane was blocked by bulk input')), 5000);
      const poll = setInterval(() => {
        if (otherOutput.includes('OTHER_PANE_READY')) { clearInterval(poll); clearTimeout(timeout); resolve(); }
      }, 10);
    });
    const otherLatency = Math.round(performance.now() - bulkStart);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('100KB input timeout')), 10000);
      const poll = setInterval(() => {
        if (fs.statSync(rawFile).size >= Buffer.byteLength(rawInput) + bulk.length) { clearInterval(poll); clearTimeout(timeout); resolve(); }
      }, 10);
    });
    const bulkDuration = Math.round(performance.now() - bulkStart);
    console.log(`100KB input: ${bulkDuration}ms; other pane: ${otherLatency}ms`);
    assert.ok(otherLatency < bulkDuration, 'other pane responds before bulk input completes');
    other.kill();
    pane.write('\x03');
    await new Promise(resolve => setTimeout(resolve, 100));
    pane.write('stty sane\r');
    const exited = new Promise((resolve, reject) => {
      pane.onExit(resolve);
      setTimeout(() => reject(new Error('tmux pane exit notification missing')), 3000).unref();
    });
    pane.write('exit\r');
    await exited;
    holder.close();
    fs.writeFileSync(path.join(dir, 'tmux.lock'), '99999999', { mode: 0o600 });
    fs.writeFileSync(path.join(dir, 'pane-123-0123456789abcdef.sh'), 'stale', { mode: 0o600 });
    holder = new TmuxHolder({ env, home: dir, tmux });
    assert.equal(fs.existsSync(path.join(dir, 'tmux.lock')), false);
    assert.equal(fs.existsSync(path.join(dir, 'pane-123-0123456789abcdef.sh')), false);
    assert.ok(holder.active);
    const specialDir = path.join(dir, 'with#;');
    fs.mkdirSync(specialDir);
    const specialValue = 'line1\nline2\'"$`\\;#';
    const special = holder.createPane({ shell: '/bin/sh', cwd: specialDir, env: { HOME: dir, PATH: env.PATH, SPECIAL: specialValue, LARGE: 'z'.repeat(20000) } });
    assert.equal(holder.command(['display-message', '-p', '-t', special.paneId, '#{pane_current_path}']).trim(), specialDir);
    assert.equal(Number(holder.command(['display-message', '-p', '-t', special.paneId, '#{pane_pid}']).trim()), special.pid);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('pane environment script was not removed')), 3000);
      const poll = setInterval(() => {
        if (!fs.readdirSync(dir).some(name => name.startsWith('pane-'))) { clearTimeout(timeout); clearInterval(poll); resolve(); }
      }, 20);
    });
    const valueFile = path.join(dir, 'special-value');
    special.write(`printf '%s' "$SPECIAL" > '${valueFile}'\r`);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('special environment value timeout')), 3000);
      const poll = setInterval(() => {
        if (fs.existsSync(valueFile)) { clearTimeout(timeout); clearInterval(poll); resolve(); }
      }, 20);
    });
    assert.equal(fs.readFileSync(valueFile, 'utf8'), specialValue);
    special.kill();
  } finally {
    if (holder) holder.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
