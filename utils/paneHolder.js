'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { isTerminalQueryReplyOnly } = require('./terminalUserInput');

const SERVER_ENV_KEYS = Object.freeze(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERMINFO', 'TERMINFO_DIRS']);

function supportsHolderCommands(versionOutput) {
  const match = /^tmux (?:next-)?(\d+)\.(\d+)(?:[a-z]|-rc\d*)?(?:\s|$)/i.exec(versionOutput.trim());
  // send-keys -H は 3.0 から。openbsd-* は OS の版で tmux の機能を保証できないため使わない。
  return Boolean(match && Number(match[1]) >= 3);
}

function serverEnvironment(env) {
  return Object.fromEntries(SERVER_ENV_KEYS.filter(key => typeof env[key] === 'string' && env[key].length).map(key => [key, env[key]]));
}

function isSafeSocketPresent(socket, fsApi = fs, uid = process.getuid?.()) {
  if (Buffer.byteLength(socket) >= 104) throw new Error('tmux socket path exceeds 103 bytes');
  const parent = fsApi.lstatSync(path.dirname(socket));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== uid || (parent.mode & 0o777) !== 0o700) {
    throw new Error('tmux socket directory is unsafe');
  }
  try {
    const entry = fsApi.lstatSync(socket);
    if (!entry.isSocket() || entry.isSymbolicLink() || entry.uid !== uid || ![0o600, 0o700].includes(entry.mode & 0o777)) {
      throw new Error('tmux socket is unsafe');
    }
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function createHolderSocketPath(env = process.env, home = os.homedir()) {
  const runDir = env.VK_TERMINALS_HOLDER_RUN_DIR || path.join(home, '.vk-terminals', 'run');
  if (!path.isAbsolute(runDir)) throw new Error('tmux run directory must be absolute');
  // 既存の親要素も順に検査し、リンク経由の作成を拒む。
  let current = path.parse(runDir).root;
  for (const part of path.relative(current, runDir).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('tmux run directory contains a link or non-directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  const socket = path.join(runDir, 'tmux.sock');
  isSafeSocketPresent(socket);
  return socket;
}

function quoteShell(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function createPaneEnvironmentScript(runDir, ptyEnv, shell) {
  const entries = Object.entries({ ...ptyEnv, TERM: 'xterm-256color' });
  const valid = entries.filter(([key, value]) => {
    if (typeof value !== 'string' || value.includes('\0')) throw new Error('invalid pane environment value');
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && !['UID', 'EUID', 'PPID', 'SHELLOPTS', 'BASHOPTS', 'BASHPID'].includes(key)) return true;
    console.warn(`tmux pane: skipped unsupported environment name ${JSON.stringify(key)}`);
    return false;
  });
  const script = path.join(runDir, `pane-${process.pid}-${require('node:crypto').randomBytes(8).toString('hex')}.sh`);
  // 実行途中で export が失敗しても値をディスクへ残さない。
  const body = `#!/bin/sh\nrm -f -- ${quoteShell(script)}\n` +
    valid.filter(([key]) => key !== 'SHLVL').map(([key, value]) => `export ${key}=${quoteShell(value)}\n`).join('') +
    (Object.hasOwn(ptyEnv, 'SHLVL') ? `export SHLVL=${quoteShell(ptyEnv.SHLVL)}\n` : 'unset SHLVL\n') +
    `exec ${quoteShell(shell)}\n`;
  fs.writeFileSync(script, body, { flag: 'wx', mode: 0o600 });
  return script;
}

function escapeTmuxArgument(value) {
  return value.endsWith(';') ? `${value.slice(0, -1)}\\;` : value;
}

function encodeKeys(data) {
  return Buffer.from(data, 'utf8').toString('hex').match(/../g) || [];
}

function decodeOutput(text) {
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\\' && /^[0-7]{3}$/.test(text.slice(i + 1, i + 4))) {
      bytes.push(parseInt(text.slice(i + 1, i + 4), 8));
      i += 3;
    } else {
      bytes.push(text.charCodeAt(i));
    }
  }
  return Buffer.from(bytes);
}

function metadataPath(socket) { return path.join(path.dirname(socket), 'panes.json'); }

function readPaneMetadata(socket) {
  isSafeSocketPresent(socket);
  const file = metadataPath(socket);
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.() || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error('unsafe pane metadata');
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!data || data.version !== 1 || !Array.isArray(data.panes)) throw new Error('invalid pane metadata');
    return data;
  } catch (error) {
    if (error.code === 'ENOENT') return { version: 1, panes: [] };
    throw error;
  }
}

function writePaneMetadata(socket, data) {
  isSafeSocketPresent(socket);
  const file = metadataPath(socket);
  // 既存ファイルのリンク・権限を検証してから同一ディレクトリで原子的に置換する。
  readPaneMetadata(socket);
  const temporary = `${file}.${process.pid}.${require('node:crypto').randomBytes(8).toString('hex')}`;
  try {
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, panes: data.panes, order: data.order || [], stashOrder: data.stashOrder || [] }), { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file);
  } finally { try { fs.unlinkSync(temporary); } catch (_) {} }
}

function stopHolder(socket, tmux = 'tmux', env = process.env) {
  const runDir = env.VK_TERMINALS_HOLDER_RUN_DIR || path.join(env.HOME || os.homedir(), '.vk-terminals', 'run');
  if (!socket || !path.isAbsolute(socket) || socket !== path.join(runDir, 'tmux.sock') || !isSafeSocketPresent(socket)) return false;
  execFileSync(tmux, ['-S', socket, 'kill-server'], { env: serverEnvironment(env), timeout: 5000 });
  return true;
}

class PaneAdapter {
  constructor(holder, paneId, pid, windowId) {
    this.holder = holder;
    this.paneId = paneId;
    this.windowId = windowId;
    this.pid = Number(pid);
    this.isTmuxPane = true;
    this.events = new EventEmitter();
    this.decoder = new TextDecoder();
    this.exited = false;
  }
  write(data) {
    if (this.exited || isTerminalQueryReplyOnly(data)) return;
    const keys = encodeKeys(data);
    // 制御クライアントへの入力は順序を保ち、長い入力も main を止めずに送る。
    for (let i = 0; i < keys.length; i += 128) this.holder.queueKeys(['send-keys', '-t', this.paneId, '-H', ...keys.slice(i, i + 128)]);
  }
  resize(cols, rows) { if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new Error('invalid pane size'); if (!this.exited) this.holder.sendControl(['resize-window', '-t', this.windowId, '-x', String(cols), '-y', String(rows)]); }
  kill() {
    if (this.exited) return;
    this.holder.sendControl(['kill-pane', '-t', this.paneId]);
    this.exit();
  }
  onData(callback) { this.events.on('data', callback); return { dispose: () => this.events.off('data', callback) }; }
  onExit(callback) { this.events.on('exit', callback); return { dispose: () => this.events.off('exit', callback) }; }
  output(bytes) { this.events.emit('data', this.decoder.decode(bytes, { stream: true })); }
  exit() {
    if (this.exited) return;
    this.exited = true;
    this.events.emit('exit', { exitCode: 0, signal: 0 });
    this.holder.panes.delete(this.paneId);
  }
}

class TmuxHolder {
  constructor({ env = process.env, home = os.homedir(), tmux = 'tmux', config = path.join(__dirname, '..', 'tmux-holder.conf') } = {}) {
    this.env = serverEnvironment(env);
    // 実行ディレクトリを作る前に tmux 不在を確定する。
    try {
      const version = execFileSync(tmux, ['-V'], { env: serverEnvironment(env), encoding: 'utf8', timeout: 5000 });
      if (!supportsHolderCommands(version)) throw new Error(`tmux 3.0 or newer is required (found ${version.trim() || 'unrecognized version'})`);
    }
    catch (error) { if (error.code === 'ENOENT') { error.code = 'TMUX_NOT_FOUND'; } throw error; }
    this.socket = createHolderSocketPath(env, home);
    this.tmux = tmux;
    this.config = config;
    this.panes = new Map();
    this.buffer = '';
    this.keyQueues = new Map();
    this.keyScheduled = false;
    this.session = `vk-terminals-${process.pid}`;
    const lock = path.join(path.dirname(this.socket), 'tmux.lock');
    let lockFd;
    let created = false;
    try {
      try { lockFd = fs.openSync(lock, 'wx', 0o600); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(fs.readFileSync(lock, 'utf8').trim());
        if (!Number.isSafeInteger(owner) || owner < 1) throw error;
        try { process.kill(owner, 0); throw error; }
        catch (checkError) { if (checkError.code !== 'ESRCH') throw checkError; }
        fs.unlinkSync(lock);
        lockFd = fs.openSync(lock, 'wx', 0o600);
      }
      fs.writeSync(lockFd, String(process.pid));
      if (isSafeSocketPresent(this.socket)) {
        let sessions;
        try { sessions = this.command(['list-sessions', '-F', '#{session_name}']); } catch (error) {
          const detail = String(error.stderr || error.message || '');
          if (!/no server running|connection refused|error connecting to|failed to connect/i.test(detail)) throw error;
          sessions = null;
        }
        if (sessions === null) fs.unlinkSync(this.socket);
        else {
          const holderSession = sessions.split('\n').find(name => /^vk-terminals-\d+$/.test(name));
          if (!holderSession) throw new Error('tmux holder socket is in use');
          this.session = holderSession;
          this.reattached = true;
        }
      }
      // 残留した 0600 スクリプトを次回起動時に掃除する。
      for (const name of fs.readdirSync(path.dirname(this.socket))) {
        if (/^pane-\d+-[a-f0-9]{16}\.sh$/.test(name)) {
          const file = path.join(path.dirname(this.socket), name);
          const stat = fs.lstatSync(file);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()) fs.unlinkSync(file);
        }
      }
      // 排他中にサーバーと制御クライアントを作る。
      if (!this.reattached) {
        this.command(['new-session', '-d', '-s', this.session, '-n', 'holder', 'sleep', '2147483647']);
        created = true;
      }
      isSafeSocketPresent(this.socket);
      this.control = spawn(tmux, ['-S', this.socket, '-f', config, '-C', 'attach-session', '-t', this.session], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (error) {
      if (this.control) this.control.kill();
      if (created && isSafeSocketPresent(this.socket)) {
        try { this.command(['kill-server']); fs.unlinkSync(this.socket); } catch (_) {}
      }
      throw error;
    } finally {
      if (lockFd !== undefined) { fs.closeSync(lockFd); fs.unlinkSync(lock); }
    }
    this.active = true;
    this.control.stdout.setEncoding('latin1');
    this.control.stdout.on('data', data => this.accept(data));
    this.control.stderr.resume();
    this.control.on('error', () => this.controlStopped());
    this.control.on('exit', () => this.controlStopped());
  }
  controlStopped() {
    if (!this.active) return;
    this.active = false;
    this.keyQueues.clear();
    this.keyScheduled = false;
    for (const pane of [...this.panes.values()]) pane.exit();
  }
  sendControl(args) {
    if (!this.active || this.control.stdin.destroyed) return;
    this.control.stdin.write(`${args.map(escapeTmuxArgument).join(' ')}\n`);
  }
  queueKeys(args) {
    if (!this.active) return;
    const paneId = args[2];
    if (!this.keyQueues.has(paneId)) this.keyQueues.set(paneId, []);
    this.keyQueues.get(paneId).push(args);
    this.drainKeys();
  }
  drainKeys() {
    if (this.keyScheduled || !this.active) return;
    this.keyScheduled = true;
    setImmediate(() => {
      this.keyScheduled = false;
      if (!this.active || this.control.stdin.destroyed) return;
      // 1 周につき各ペイン 1 行ずつ送り、大量入力が別ペインを塞がないようにする。
      for (const [id, queue] of this.keyQueues) {
        const args = queue.shift();
        if (!queue.length) this.keyQueues.delete(id);
        if (args && !this.control.stdin.write(`${args.map(escapeTmuxArgument).join(' ')}\n`)) {
          this.control.stdin.once('drain', () => this.drainKeys());
          return;
        }
      }
      if (this.keyQueues.size) this.drainKeys();
    });
  }
  command(args) {
    isSafeSocketPresent(this.socket);
    return execFileSync(this.tmux, ['-S', this.socket, '-f', this.config, ...args.map(escapeTmuxArgument)], { env: this.env, encoding: 'utf8', timeout: 5000 });
  }
  createPane({ shell, cwd, env, termId, cols = 80, rows = 24 }) {
    if (!this.active) throw new Error('tmux control client stopped');
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) throw new Error('invalid pane size');
    const script = createPaneEnvironmentScript(path.dirname(this.socket), env, shell);
    let output;
    try {
      output = this.command(['new-window', '-d', '-P', '-F', '#{pane_id} #{pane_pid} #{window_id}', '-t', this.session, '-c', cwd.replace(/#/g, '##'), 'env', '-i', '/bin/sh', script]).trim();
    } catch (error) { try { fs.unlinkSync(script); } catch (_) {} throw error; }
    const [id, pid, windowId] = output.split(' ');
    if (!/^%\d+$/.test(id) || !/^\d+$/.test(pid) || !/^@\d+$/.test(windowId)) {
      try { fs.unlinkSync(script); } catch (_) {}
      throw new Error('tmux returned invalid pane identity');
    }
    if (termId) this.command(['set-option', '-w', '-t', windowId, '@vk_term_id', String(termId)]);
    const pane = new PaneAdapter(this, id, pid, windowId);
    this.panes.set(id, pane);
    pane.resize(cols, rows);
    return pane;
  }
  listPanes() {
    if (!isSafeSocketPresent(this.socket)) return [];
    const output = this.command(['list-panes', '-a', '-F', '#{pane_id} #{pane_pid} #{window_id} #{@vk_term_id}']);
    return output.split('\n').map(line => /^(%\d+) (\d+) (@\d+) (\d+)$/.exec(line)).filter(Boolean).map(([, paneId, pid, windowId, termId]) => ({ paneId, pid: Number(pid), windowId, termId }));
  }
  attachPane(identity) {
    const pane = new PaneAdapter(this, identity.paneId, identity.pid, identity.windowId);
    this.panes.set(identity.paneId, pane);
    return pane;
  }
  accept(chunk) {
    this.buffer += chunk;
    let end;
    while ((end = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      const match = /^%output (%\d+) (.*)$/.exec(line);
      if (match) this.panes.get(match[1])?.output(decodeOutput(match[2]));
      const closed = /^%(?:unlinked-)?window-close (@\d+)/.exec(line);
      if (closed) {
        for (const pane of this.panes.values()) if (pane.windowId === closed[1]) pane.exit();
      }
    }
  }
  disconnect() {
    this.active = false;
    this.keyQueues.clear();
    this.keyScheduled = false;
    this.control.kill();
    this.panes.clear();
  }
  close() {
    this.keyQueues.clear();
    this.keyScheduled = false;
    for (const pane of [...this.panes.values()]) pane.exit();
    try { if (isSafeSocketPresent(this.socket)) this.command(['kill-server']); }
    finally {
      this.active = false;
      this.control.kill();
      if (isSafeSocketPresent(this.socket)) fs.unlinkSync(this.socket);
    }
  }
}

module.exports = { metadataPath, readPaneMetadata, writePaneMetadata, stopHolder, SERVER_ENV_KEYS, serverEnvironment, supportsHolderCommands, isSafeSocketPresent, createHolderSocketPath, createPaneEnvironmentScript, encodeKeys, decodeOutput, TmuxHolder };
