'use strict';

const crypto = require('node:crypto');
const MARKER_PREFIX = '\x1b]777;vk-terminals;agent-';
const MARKER_TERMINATOR = '\x07';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MARKER_LENGTH = 240;

/** ペインごとの現在世代、起動状態、世代固有トークンを保持する。 */
function createAgentLifecycleStore(createToken = () => crypto.randomBytes(32).toString('hex')) {
  const states = new Map();
  const newToken = () => {
    const token = createToken();
    if (!TOKEN_PATTERN.test(token)) throw new Error('invalid agent lifecycle token');
    return token;
  };
  return {
    initialize(termId, generation) {
      states.set(String(termId), { generation, state: null, startToken: null, exitToken: null });
    },
    prepare(termId, generation) {
      const marker = { generation, startToken: newToken(), exitToken: newToken() };
      states.set(String(termId), { ...marker, state: null });
      return marker;
    },
    markStarted(termId, generation, token) {
      const current = states.get(String(termId));
      if (!current || current.generation !== generation || current.startToken !== token) return false;
      current.state = 'running';
      current.startToken = null;
      return true;
    },
    markExited(termId, generation, token) {
      const current = states.get(String(termId));
      if (!current || current.generation !== generation || current.state !== 'running' || current.exitToken !== token) return false;
      current.state = 'exited';
      current.exitToken = null;
      return true;
    },
    markUnknown(termId, generation, token) {
      const current = states.get(String(termId));
      if (!current || current.generation !== generation || current.state !== 'running' || current.exitToken !== token) return false;
      current.state = null;
      current.startToken = null;
      current.exitToken = null;
      return true;
    },
    reset(termId, generation) {
      const current = states.get(String(termId));
      if (!current || current.generation !== generation) return false;
      current.state = null;
      current.startToken = null;
      current.exitToken = null;
      return true;
    },
    get(termId, generation) {
      const current = states.get(String(termId));
      return current && current.generation === generation ? current.state : null;
    },
    delete(termId) {
      states.delete(String(termId));
    },
  };
}

function quoteShellArgument(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

/** 元のコマンド文字列を改変せず、専用監視プロセスへ渡す起動行を作る。 */
function buildTrackedLaunchCommand(command, marker, options = {}) {
  if (typeof command !== 'string' || !command) throw new Error('launch command required');
  if (!Number.isSafeInteger(marker?.generation) || marker.generation < 1) throw new Error('invalid agent lifecycle generation');
  if (!TOKEN_PATTERN.test(marker?.startToken || '') || !TOKEN_PATTERN.test(marker?.exitToken || '')) throw new Error('invalid agent lifecycle token');
  const executable = options.executable || process.execPath;
  const monitorPath = options.monitorPath || require.resolve('./agentLifecycleMonitor');
  const encodedCommand = Buffer.from(command, 'utf8').toString('base64');
  const monitorCommand = `ELECTRON_RUN_AS_NODE=1 ${quoteShellArgument(executable)} ${quoteShellArgument(monitorPath)} ${marker.generation} ${marker.startToken} ${marker.exitToken} ${encodedCommand}`;
  const unknownMarker = `\\033]777;vk-terminals;agent-unknown;${marker.generation};${marker.exitToken}\\007`;
  // 監視が exit を出せず終了しても、シェルへ制御が戻れば現在世代だけを不明へ戻す。
  return `${monitorCommand}; __vk_agent_status=$?; printf '${unknownMarker}'; (exit "$__vk_agent_status")`;
}

/** 分割チャンクをまたぐ start/exit/unknown マーカーを取り除き、検証済み通知だけを返す。 */
function createAgentLifecycleMarkerParser(onMarker) {
  let pending = '';
  const parse = (flush) => {
    let output = '';
    while (pending) {
      const start = pending.indexOf(MARKER_PREFIX);
      if (start < 0) {
        if (flush) {
          output += pending;
          pending = '';
          break;
        }
        let retained = 0;
        for (let length = Math.min(pending.length, MARKER_PREFIX.length - 1); length > 0; length -= 1) {
          if (MARKER_PREFIX.startsWith(pending.slice(-length))) {
            retained = length;
            break;
          }
        }
        output += pending.slice(0, pending.length - retained);
        pending = pending.slice(pending.length - retained);
        break;
      }
      output += pending.slice(0, start);
      pending = pending.slice(start);
      const end = pending.indexOf(MARKER_TERMINATOR, MARKER_PREFIX.length);
      if (end < 0) {
        if (!flush && pending.length <= MAX_MARKER_LENGTH) break;
        output += pending[0];
        pending = pending.slice(1);
        continue;
      }
      const match = pending.slice(MARKER_PREFIX.length, end).match(/^(start|exit|unknown);(\d+);([a-f0-9]{64})$/);
      if (!match || end + 1 > MAX_MARKER_LENGTH) {
        output += pending[0];
        pending = pending.slice(1);
        continue;
      }
      const generation = Number(match[2]);
      if (!Number.isSafeInteger(generation) || generation < 1) {
        output += pending[0];
        pending = pending.slice(1);
        continue;
      }
      onMarker(match[1], generation, match[3]);
      pending = pending.slice(end + 1);
    }
    return output;
  };
  return {
    push(chunk) {
      pending += String(chunk);
      return parse(false);
    },
    flush() {
      return parse(true);
    },
  };
}

// renderer の状態を変更せず、現在世代の客観的な AI コマンド状態だけを追加する。
function mergeAgentLifecycleStates(states, getGeneration, getLifecycleState) {
  if (!states || typeof states !== 'object' || Array.isArray(states)) return states;
  return Object.fromEntries(Object.entries(states).map(([paneId, state]) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return [paneId, state];
    const generation = getGeneration(state.termId);
    return [paneId, { ...state, agentGeneration: generation, agentCommandState: getLifecycleState(state.termId, generation) }];
  }));
}

module.exports = {
  MARKER_PREFIX,
  MAX_MARKER_LENGTH,
  createAgentLifecycleStore,
  buildTrackedLaunchCommand,
  createAgentLifecycleMarkerParser,
  mergeAgentLifecycleStates,
};
