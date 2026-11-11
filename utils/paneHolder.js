'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { isTerminalQueryReplyOnly } = require('./terminalUserInput');

const SERVER_ENV_KEYS = Object.freeze(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERMINFO', 'TERMINFO_DIRS']);

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

function socketExists(socket) { return isSafeSocketPresent(socket); }

function createHolderSocketDirectory(env = process.env, home = os.homedir()) {
  const runDir = env.VK_TERMINALS_HOLDER_RUN_DIR || path.join(home, '.vk-terminals', 'run');
  if (!path.isAbsolute(runDir)) throw new Error('tmux run directory must be absolute');
  // mkdir の前に各既存要素を lstat し、リンク経由の作成を拒む。
  let current = path.parse(runDir).root;
  for (const part of path.relative(current, runDir).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = fs.lstatSync(current);
      if (current === runDir && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('tmux run directory contains a link or non-directory');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(current, { mode: 0o700 });
    }
  }
  const socket = path.join(runDir, 'tmux.sock');
  isSafeSocketPresent(socket);
  return socket;
}

function paneArguments(ptyEnv, shell) {
  const entries = Object.entries({ ...ptyEnv, TERM: 'xterm-256color' });
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) {
      throw new Error('invalid pane environment');
    }
  }
  return ['env', '-i', ...entries.map(([key, value]) => `${key}=${value}`), shell];
}

function quoteShell(value) {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function createPaneEnvironmentScript(runDir, ptyEnv, shell) {
  const entries = Object.entries({ ...ptyEnv, TERM: 'xterm-256color' });
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string' || value.includes('\0')) throw new Error('invalid pane environment');
  }
  const script = path.join(runDir, `pane-${process.pid}-${require('node:crypto').randomBytes(8).toString('hex')}.sh`);
  const body = '#!/bin/sh\n' + entries.map(([key, value]) => `export ${key}=${quoteShell(value)}\n`).join('') +
    `rm -f -- ${quoteShell(script)}\nexec ${quoteShell(shell)}\n`;
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
    for (let i = 0; i < keys.length; i += 64) this.holder.queueKeys(['send-keys', '-t', this.paneId, '-H', ...keys.slice(i, i + 64)]);
  }
  resize(cols, rows) { if (!this.exited) this.holder.sendControl(['resize-window', '-t', this.windowId, '-x', String(cols), '-y', String(rows)]); }
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
    this.socket = createHolderSocketDirectory(env, home);
    this.tmux = tmux;
    this.config = config;
    this.panes = new Map();
    this.buffer = '';
    this.keyQueue = [];
    this.keyTimer = null;
    this.session = `vk-terminals-${process.pid}`;
    const lock = path.join(path.dirname(this.socket), 'tmux.lock');
    let lockFd;
    let created = false;
    try {
      lockFd = fs.openSync(lock, 'wx', 0o600);
      if (isSafeSocketPresent(this.socket)) {
        let sessions;
        try { sessions = this.command(['list-sessions', '-F', '#{session_name}']); } catch (_) { sessions = null; }
        if (sessions === null) fs.unlinkSync(this.socket);
        else {
          const owners = sessions.split('\n').map(line => /^vk-terminals-(\d+)$/.exec(line)).filter(Boolean);
          if (!owners.length || owners.some(match => { try { process.kill(Number(match[1]), 0); return true; } catch (_) { return false; } })) {
            throw new Error('tmux holder socket is in use');
          }
          this.command(['kill-server']);
          isSafeSocketPresent(this.socket);
          fs.unlinkSync(this.socket);
        }
      }
      // 排他中にサーバーと制御クライアントを作る。
      this.command(['new-session', '-d', '-s', this.session, '-n', 'holder', 'sleep', '2147483647']);
      created = true;
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
    clearTimeout(this.keyTimer);
    this.keyTimer = null;
    this.keyQueue.length = 0;
    for (const pane of [...this.panes.values()]) pane.exit();
    // 制御クライアントの異常終了時は main を待たせず専用サーバーを停止する。
    try {
      if (!socketExists(this.socket)) return;
      execFile(this.tmux, ['-S', this.socket, '-f', this.config, 'kill-server'], { env: this.env, timeout: 5000 }, () => {
        try { if (socketExists(this.socket)) fs.unlinkSync(this.socket); } catch (_) {}
      });
    } catch (_) {}
  }
  sendControl(args) {
    if (!this.active || this.control.stdin.destroyed) return;
    this.control.stdin.write(`${args.map(escapeTmuxArgument).join(' ')}\n`);
  }
  queueKeys(args) {
    this.keyQueue.push(args);
    if (!this.keyTimer) this.drainKeys();
  }
  drainKeys() {
    const args = this.keyQueue.shift();
    if (args) this.sendControl(args);
    this.keyTimer = setTimeout(() => {
      this.keyTimer = null;
      if (this.keyQueue.length) this.drainKeys();
    }, 5);
  }
  command(args) {
    isSafeSocketPresent(this.socket);
    return execFileSync(this.tmux, ['-S', this.socket, '-f', this.config, ...args.map(escapeTmuxArgument)], { env: this.env, encoding: 'utf8', timeout: 5000 });
  }
  createPane({ shell, cwd, env, cols = 80, rows = 24 }) {
    if (!this.active) throw new Error('tmux control client stopped');
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
    const pane = new PaneAdapter(this, id, pid, windowId);
    this.panes.set(id, pane);
    pane.resize(cols, rows);
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
  close() {
    clearTimeout(this.keyTimer);
    this.keyTimer = null;
    this.keyQueue.length = 0;
    for (const pane of [...this.panes.values()]) pane.exit();
    try { if (isSafeSocketPresent(this.socket)) this.command(['kill-server']); }
    finally {
      this.active = false;
      this.control.kill();
      if (isSafeSocketPresent(this.socket)) fs.unlinkSync(this.socket);
    }
  }
}

module.exports = { SERVER_ENV_KEYS, serverEnvironment, isSafeSocketPresent, createHolderSocketDirectory, paneArguments, encodeKeys, decodeOutput, TmuxHolder };
