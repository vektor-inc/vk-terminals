'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MESSAGE_BYTES = 1024;

function quoteShellArgument(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

/** main プロセスが所有する、世代単位の認証済みライフサイクル接続を管理する。 */
function createAgentLifecycleStore(options = {}) {
  const createToken = options.createToken || (() => crypto.randomBytes(32).toString('hex'));
  const platform = options.platform || process.platform;
  const states = new Map();
  const sockets = new Set();
  let server = null;
  let runtimeDir = null;
  let socketPath = null;

  const clearConnection = (current, socket) => {
    if (current.connection !== socket) return;
    current.connection = null;
    if (current.phase !== 'exited') {
      current.phase = 'unknown';
      current.state = null;
    }
  };
  const rejectSocket = (socket) => { if (!socket.destroyed) socket.destroy(); };
  const handleConnection = (socket) => {
    sockets.add(socket);
    let buffer = Buffer.alloc(0);
    let current = null;
    let authenticated = false;
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
      if (buffer.length > MAX_MESSAGE_BYTES) return rejectSocket(socket);
      let newline;
      while ((newline = buffer.indexOf(0x0a)) >= 0) {
        const line = buffer.subarray(0, newline);
        buffer = buffer.subarray(newline + 1);
        if (line.length === 0 || line.length > MAX_MESSAGE_BYTES) return rejectSocket(socket);
        let message;
        try { message = JSON.parse(line.toString('utf8')); } catch (_error) { return rejectSocket(socket); }
        if (!message || typeof message !== 'object' || Array.isArray(message)) return rejectSocket(socket);
        if (!authenticated) {
          if (message.type !== 'auth' || typeof message.termId !== 'string' ||
              !Number.isSafeInteger(message.generation) || !TOKEN_PATTERN.test(message.token || '')) return rejectSocket(socket);
          current = states.get(message.termId);
          if (!current || current.generation !== message.generation || current.token !== message.token ||
              current.phase !== 'prepared' || current.connection) return rejectSocket(socket);
          authenticated = true;
          current.connection = socket;
          current.phase = 'connected';
          current.token = null;
          socket.write('{"type":"ready"}\n');
          continue;
        }
        if (message.type === 'started' && current.phase === 'connected') {
          current.phase = 'running';
          current.state = 'running';
        } else if (message.type === 'exited' && current.phase === 'running') {
          current.phase = 'exited';
          current.state = 'exited';
        } else return rejectSocket(socket);
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      if (current) clearConnection(current, socket);
    });
  };

  return {
    async start() {
      if (platform === 'win32' || server) return false;
      try {
        runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-agent-'));
        fs.chmodSync(runtimeDir, 0o700);
        socketPath = path.join(runtimeDir, 'lifecycle.sock');
        server = net.createServer(handleConnection);
        await new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(socketPath, () => { server.off('error', reject); resolve(); });
        });
        // listen 後の socket エラーで main プロセスを落とさず、既存接続の切断検知を継続する。
        server.on('error', () => {});
        fs.chmodSync(socketPath, 0o600);
        return true;
      } catch (_error) {
        if (server) server.close();
        server = null;
        socketPath = null;
        if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true });
        runtimeDir = null;
        return false;
      }
    },
    initialize(termId, generation) {
      states.set(String(termId), { generation, state: null, phase: 'idle', token: null, connection: null });
    },
    prepare(termId, generation) {
      const id = String(termId);
      const previous = states.get(id);
      if (previous?.connection) previous.connection.destroy();
      if (!server || !socketPath) {
        states.set(id, { generation, state: null, phase: 'unavailable', token: null, connection: null });
        return null;
      }
      const token = createToken();
      if (!TOKEN_PATTERN.test(token)) throw new Error('invalid agent lifecycle token');
      states.set(id, { generation, state: null, phase: 'prepared', token, connection: null });
      return { termId: id, generation, token, socketPath };
    },
    reset(termId, generation) {
      const current = states.get(String(termId));
      if (!current || current.generation !== generation) return false;
      if (current.connection) current.connection.destroy();
      current.state = null;
      current.phase = 'unknown';
      current.token = null;
      current.connection = null;
      return true;
    },
    get(termId, generation) {
      const current = states.get(String(termId));
      return current && current.generation === generation ? current.state : null;
    },
    delete(termId) {
      const current = states.get(String(termId));
      if (current?.connection) current.connection.destroy();
      states.delete(String(termId));
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      const closingServer = server;
      server = null;
      socketPath = null;
      if (closingServer) await new Promise((resolve) => closingServer.close(resolve));
      if (runtimeDir) fs.rmSync(runtimeDir, { recursive: true, force: true });
      runtimeDir = null;
    },
  };
}

/** 外部入力をシェル構文として再解釈せず、監視プロセスの固定引数へ渡す。 */
function buildTrackedLaunchCommand(command, credentials, options = {}) {
  if (typeof command !== 'string' || !command) throw new Error('launch command required');
  if (!credentials || typeof credentials.termId !== 'string' ||
      !Number.isSafeInteger(credentials.generation) || credentials.generation < 1 ||
      !TOKEN_PATTERN.test(credentials.token || '') || typeof credentials.socketPath !== 'string') {
    throw new Error('invalid agent lifecycle credentials');
  }
  const executable = options.executable || process.execPath;
  const monitorPath = options.monitorPath || require.resolve('./agentLifecycleMonitor');
  const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
  return `ELECTRON_RUN_AS_NODE=1 ${quoteShellArgument(executable)} ${quoteShellArgument(monitorPath)} ${quoteShellArgument(credentials.socketPath)} ${quoteShellArgument(credentials.termId)} ${quoteShellArgument(credentials.generation)} ${quoteShellArgument(credentials.token)} ${quoteShellArgument(encodedCommand)}`;
}

function mergeAgentLifecycleStates(states, getGeneration, getLifecycleState) {
  if (!states || typeof states !== 'object' || Array.isArray(states)) return states;
  return Object.fromEntries(Object.entries(states).map(([paneId, state]) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return [paneId, state];
    const generation = getGeneration(state.termId);
    return [paneId, { ...state, agentGeneration: generation, agentCommandState: getLifecycleState(state.termId, generation) }];
  }));
}

module.exports = { MAX_MESSAGE_BYTES, createAgentLifecycleStore, buildTrackedLaunchCommand, mergeAgentLifecycleStates };
