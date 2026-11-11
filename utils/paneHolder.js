'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { isTerminalQueryReplyOnly } = require('./terminalUserInput');

const SERVER_ENV_KEYS = Object.freeze(['HOME', 'USER', 'LOGNAME', 'SHELL', 'PATH', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'TERMINFO', 'TERMINFO_DIRS']);

function serverEnvironment(env) {
  return Object.fromEntries(SERVER_ENV_KEYS.filter(key => typeof env[key] === 'string' && env[key].length).map(key => [key, env[key]]));
}

function validateSocketPath(socket, fsApi = fs, uid = process.getuid?.()) {
  if (Buffer.byteLength(socket) > 104) throw new Error('tmux socket path exceeds 104 bytes');
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

function holderSocket(env = process.env, home = os.homedir()) {
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
  validateSocketPath(socket);
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
    if (isTerminalQueryReplyOnly(data)) return;
    const keys = encodeKeys(data);
    // OS の argv 上限を超えない単位で送る。送信順は同期コマンドで保証する。
    for (let i = 0; i < keys.length; i += 4096) this.holder.command(['send-keys', '-t', this.paneId, '-H', ...keys.slice(i, i + 4096)]);
  }
  resize(cols, rows) { this.holder.command(['resize-pane', '-t', this.paneId, '-x', String(cols), '-y', String(rows)]); }
  kill() {
    if (this.exited) return;
    this.holder.command(['kill-pane', '-t', this.paneId]);
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
    execFileSync(tmux, ['-V'], { env: this.env, stdio: 'ignore' });
    this.socket = holderSocket(env, home);
    this.tmux = tmux;
    this.config = config;
    this.panes = new Map();
    this.buffer = '';
    this.session = `vk-terminals-${process.pid}`;
    if (validateSocketPath(this.socket)) throw new Error('tmux holder socket already exists');
    // 制限環境のサーバーを作成し、制御モードの唯一の常駐クライアントを接続する。
    this.command(['new-session', '-d', '-s', this.session, '-n', 'holder', 'sleep', '2147483647'], true);
    validateSocketPath(this.socket);
    this.control = spawn(tmux, ['-S', this.socket, '-f', config, '-C', 'attach-session', '-t', this.session], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.active = true;
    this.control.stdout.setEncoding('latin1');
    this.control.stdout.on('data', data => this.accept(data));
    this.control.stderr.resume();
    this.control.on('error', () => { this.active = false; for (const pane of this.panes.values()) pane.exit(); });
    this.control.on('exit', () => { this.active = false; for (const pane of this.panes.values()) pane.exit(); });
  }
  command(args, first = false) {
    if (!first) validateSocketPath(this.socket);
    return execFileSync(this.tmux, ['-S', this.socket, '-f', this.config, ...args], { env: this.env, encoding: 'utf8' });
  }
  createPane({ shell, cwd, env, cols = 80, rows = 24 }) {
    if (!this.active) throw new Error('tmux control client stopped');
    const output = this.command(['new-window', '-d', '-P', '-F', '#{pane_id} #{pane_pid} #{window_id}', '-t', this.session, '-c', cwd, ...paneArguments(env, shell)]).trim();
    const [id, pid, windowId] = output.split(' ');
    if (!/^%\d+$/.test(id) || !/^\d+$/.test(pid) || !/^@\d+$/.test(windowId)) throw new Error('tmux returned invalid pane identity');
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
    for (const pane of [...this.panes.values()]) pane.exit();
    this.command(['kill-server']);
    this.control.kill();
  }
}

module.exports = { SERVER_ENV_KEYS, serverEnvironment, validateSocketPath, holderSocket, paneArguments, encodeKeys, decodeOutput, TmuxHolder };
