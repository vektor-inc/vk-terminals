'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { serverEnvironment, supportsHolderCommands, isSafeSocketPresent, createPaneEnvironmentScript, encodeKeys, decodeOutput, TmuxHolder, readPaneMetadata, writePaneMetadata, stopHolder } = require('../utils/paneHolder');
const { getReadyPatternForEngine } = require('../utils/trustPromptWatcher');

test('保持役が必要とする tmux バージョンを判定する', () => {
  for (const version of ['tmux 3.0', 'tmux 3.3a', 'tmux next-3.4', 'tmux 3.4-rc', 'tmux 3.6-rc2', 'tmux 4.0']) assert.equal(supportsHolderCommands(version), true, version);
  for (const version of ['tmux 2.8', 'tmux 2.9', 'tmux 2.9-rc', 'tmux openbsd-7.6', 'tmux master', 'unknown', 'tmux 3']) assert.equal(supportsHolderCommands(version), false, version);
});

test('古い tmux は保持役の実行ディレクトリを作らずに拒否する', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-version-')));
  try {
    const fakeTmux = path.join(dir, 'tmux');
    const run = path.join(dir, 'run');
    fs.writeFileSync(fakeTmux, '#!/bin/sh\nprintf "tmux 2.9\\n"\n', { mode: 0o700 });
    assert.throws(() => new TmuxHolder({ tmux: fakeTmux, env: { HOME: dir, VK_TERMINALS_HOLDER_RUN_DIR: run }, home: dir }), /tmux 3\.0 or newer is required/);
    assert.equal(fs.existsSync(run), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('保持役の初期化失敗後は次のペインで再試行せず、接続停止後は再生成する', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("    if (tmuxHolder && !tmuxHolder.active) tmuxHolder = null;", source.indexOf('function createTerminalPane('));
  const end = source.indexOf('    if (tmuxHolder) {', start);
  assert.ok(start !== -1 && end > start);
  const attempts = [];
  const warnings = [];
  const context = {
    tmuxHolder: null, tmuxUnavailable: false, PANE_HOLDER: 'tmux',
    TmuxHolder: class { constructor() { attempts.push(1); throw new Error('socket is in use'); } },
    path, RESOURCE_ROOT: '/tmp', process: { env: { VK_TERMINALS_HOLDER_RUN_DIR: '/tmp/holder' } },
    os, LOG_PREFIX: 'test', console: { warn: message => warnings.push(message) },
  };
  const initialize = () => vm.runInNewContext(source.slice(start, end), context);
  initialize();
  initialize();
  assert.equal(attempts.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(context.tmuxUnavailable, true);
  context.tmuxUnavailable = false;
  context.tmuxHolder = { active: false };
  initialize();
  assert.equal(attempts.length, 2);
});

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


test('メタデータを 0600 で原子的に保存し、危険なファイルを拒否する', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-meta-')));
  try {
    fs.chmodSync(dir, 0o700);
    const socket = path.join(dir, 'tmux.sock');
    assert.deepEqual(readPaneMetadata(socket), { version: 1, panes: [] });
    writePaneMetadata(socket, { panes: [{ termId: '5', paneId: '%1' }], order: ['pane-5'], stashOrder: [] });
    assert.equal(readPaneMetadata(socket).panes[0].termId, '5');
    assert.deepEqual(readPaneMetadata(socket).order, ['pane-5']);
    const file = path.join(dir, 'panes.json');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.chmodSync(file, 0o644);
    assert.throws(() => readPaneMetadata(socket), /unsafe/);
    writePaneMetadata(socket, { panes: [] });
    assert.deepEqual(readPaneMetadata(socket).panes, []);
    fs.unlinkSync(file);
    fs.symlinkSync(path.join(dir, 'target'), file);
    assert.throws(() => readPaneMetadata(socket), /unsafe/);
    fs.unlinkSync(file);
    fs.writeFileSync(file, '{}', { mode: 0o600 });
    fs.linkSync(file, path.join(dir, 'hardlink'));
    assert.throws(() => readPaneMetadata(socket), /unsafe/);
    fs.unlinkSync(path.join(dir, 'hardlink'));
    fs.writeFileSync(file, 'x'.repeat(1024 * 1024 + 1));
    assert.throws(() => readPaneMetadata(socket), /unsafe/);
    fs.chmodSync(dir, 0o755);
    assert.throws(() => readPaneMetadata(socket));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('停止関数は検証済みの専用ソケットのみ -S で指定する', () => {
  assert.equal(stopHolder(''), false);
  assert.equal(stopHolder('/tmp/other.sock'), false);
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-stop-')));
  try {
    fs.chmodSync(dir, 0o700);
    assert.equal(stopHolder(path.join(dir, 'tmux.sock')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('接続中のクライアントがいる保持役には再接続しない', t => {
  const tmux = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'tmux')).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; } });
  if (!tmux) { t.skip('tmux is unavailable'); return; }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-client-')));
  const env = { HOME: dir, PATH: process.env.PATH || '/usr/bin:/bin', VK_TERMINALS_HOLDER_RUN_DIR: dir };
  let holder;
  try {
    holder = new TmuxHolder({ env, home: dir, tmux });
    assert.throws(() => new TmuxHolder({ env, home: dir, tmux }), /tmux holder socket is in use/);
  } finally {
    try { if (holder) stopHolder(holder.socket, tmux, env); } catch (_) {}
    holder?.disconnect();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('保持役停止後も別ソケットの tmux サーバーは動く', t => {
  const tmux = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'tmux')).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; } });
  if (!tmux) { t.skip('tmux is unavailable'); return; }
  const { execFileSync } = require('node:child_process');
  const first = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-stop-a-')));
  const second = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-stop-b-')));
  const env = { HOME: first, PATH: process.env.PATH || '/usr/bin:/bin', VK_TERMINALS_HOLDER_RUN_DIR: first };
  let holder;
  const otherSocket = path.join(second, 'other.sock');
  try {
    holder = new TmuxHolder({ env, home: first, tmux });
    execFileSync(tmux, ['-S', otherSocket, 'new-session', '-d', '-s', 'other'], { env });
    assert.equal(stopHolder(holder.socket, tmux, env), true);
    assert.match(execFileSync(tmux, ['-S', otherSocket, 'list-sessions'], { env, encoding: 'utf8' }), /other/);
  } finally {
    try { execFileSync(tmux, ['-S', otherSocket, 'kill-server'], { env }); } catch (_) {}
    try { holder?.disconnect(); } catch (_) {}
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('tmux 実物: 切断後に同じペインと番号へ再接続する', async t => {
  const tmux = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'tmux')).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; } });
  if (!tmux) { t.skip('tmux is unavailable'); return; }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-holder-reattach-')));
  const env = { HOME: dir, PATH: process.env.PATH || '/usr/bin:/bin', VK_TERMINALS_HOLDER_RUN_DIR: dir };
  let holder;
  try {
    holder = new TmuxHolder({ env, home: dir, tmux });
    const pane = holder.createPane({ shell: '/bin/sh', cwd: dir, env, termId: '7' });
    holder.disconnect();
    holder = new TmuxHolder({ env, home: dir, tmux });
    assert.equal(holder.reattached, true);
    assert.equal(holder.listPanes().find(item => item.paneId === pane.paneId)?.termId, '7');
    const second = holder.createPane({ shell: '/bin/sh', cwd: dir, env, termId: '8' });
    const firstLine = '日本語の履歴';
    const attached = holder.attachPane(holder.listPanes().find(item => item.paneId === pane.paneId));
    const octal = [...Buffer.from(firstLine)].map(byte => `\\${byte.toString(8).padStart(3, '0')}`).join('');
    attached.write(`printf '${octal}\\n'; printf '%s\\n' '%prefix' '%end 1 2 3'\r`);
    second.write(`printf '%s\\n' 'SECOND_ONLY'\r`);
    await new Promise(resolve => setTimeout(resolve, 100));
    holder.attachPane(holder.listPanes().find(item => item.paneId === second.paneId));
    const { MODE_FORMAT, buildInputModeSequence } = require('../utils/paneHolderRestore');
    const { history: firstHistory, modeOutput } = await holder.capturePaneWithMode(pane.paneId, MODE_FORMAT);
    assert.doesNotThrow(() => buildInputModeSequence(modeOutput));
    const secondHistory = await holder.capturePane(second.paneId);
    assert.match(firstHistory, /日本語の履歴/);
    assert.match(firstHistory, /%prefix/);
    assert.match(firstHistory, /%end 1 2 3/);
    assert.doesNotMatch(firstHistory, /SECOND_ONLY/);
    assert.match(secondHistory, /SECOND_ONLY/);
    attached.beginReplay();
    let replayed = '';
    attached.onData(data => { replayed += data; });
    attached.write('echo AFTER_REPLAY\r');
    const history = await Promise.race([
      holder.capturePane(pane.paneId),
      new Promise((_, reject) => setTimeout(() => reject(new Error('capture response timeout')), 5000)),
    ]);
    assert.equal(replayed, '');
    attached.finishReplay(history, '');
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('replayed input timeout')), 5000);
      const poll = setInterval(() => {
        if (replayed.includes('AFTER_REPLAY')) { clearTimeout(timeout); clearInterval(poll); resolve(); }
      }, 20);
    });
    const pendingCapture = holder.capturePane(pane.paneId);
    holder.disconnect();
    await assert.rejects(pendingCapture, /disconnected/);

  } finally {
    try { if (holder) stopHolder(holder.socket, tmux, env); } catch (_) {}
    try { holder?.disconnect(); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
