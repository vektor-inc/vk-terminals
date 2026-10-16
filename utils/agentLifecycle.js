'use strict';

const crypto = require('node:crypto');

const MARKER_PREFIX = '\x1b]777;vk-terminals;agent-exit;';
const MARKER_TERMINATOR = '\x07';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const MAX_MARKER_LENGTH = 160;

/**
 * ペインごとの、VK Terminals が起動した AI コマンドの状態を保持する。
 * 世代とトークンが現在値に一致する通知だけを終了証明として受け付ける。
 *
 * @param {() => string} [createToken] テスト時に差し替えるトークン生成関数。
 * @returns {object} ライフサイクル状態ストア。
 */
function createAgentLifecycleStore(createToken = () => crypto.randomBytes(32).toString('hex')) {
  const states = new Map();

  return {
    initialize(termId, generation) {
      states.set(String(termId), {
        generation,
        state: null,
        token: null,
      });
    },
    prepare(termId, generation) {
      const token = createToken();
      if (!TOKEN_PATTERN.test(token)) throw new Error('invalid agent lifecycle token');
      states.set(String(termId), { generation, state: null, token });
      return { generation, token };
    },
    markRunning(termId, generation) {
      const current = states.get(String(termId));
      if (!current || current.generation !== generation || current.token === null) return false;
      current.state = 'running';
      return true;
    },
    markExited(termId, generation, token) {
      const current = states.get(String(termId));
      if (!current || current.generation !== generation || current.token !== token) return false;
      current.state = 'exited';
      current.token = null;
      return true;
    },
    markUnknown(termId, generation) {
      const current = states.get(String(termId));
      if (!current || current.generation !== generation) return false;
      current.state = null;
      current.token = null;
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

/**
 * AI コマンドの終了直後に、シェル自身が認証用マーカーを出す起動行を組み立てる。
 * マーカーは入力行ではバックスラッシュ表現のため、PTY 出力の実 ESC と一致しない。
 *
 * @param {string} command 起動する AI コマンド。
 * @param {{generation: number, token: string}} marker 世代固有のマーカー情報。
 * @returns {string} シェルへ書き込むコマンド。
 */
function buildTrackedLaunchCommand(command, marker) {
  if (typeof command !== 'string' || !command) throw new Error('launch command required');
  if (!Number.isSafeInteger(marker?.generation) || marker.generation < 1) {
    throw new Error('invalid agent lifecycle generation');
  }
  if (!TOKEN_PATTERN.test(marker?.token || '')) throw new Error('invalid agent lifecycle token');
  const payload = `777;vk-terminals;agent-exit;${marker.generation};${marker.token}`;
  return `{ ${command}; printf '\\033]${payload}\\007'; }`;
}

/**
 * PTY 出力からライフサイクルマーカーだけを除去し、通常出力を返すストリームパーサー。
 * 分割チャンクをまたぐ候補だけを上限付きで保持する。
 *
 * @param {(generation: number, token: string) => void} onMarker 検証済みマーカーの通知先。
 * @returns {{push: (chunk: string) => string, flush: () => string}}
 */
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
        const limit = Math.min(pending.length, MARKER_PREFIX.length - 1);
        for (let length = limit; length > 0; length -= 1) {
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

      const candidate = pending.slice(MARKER_PREFIX.length, end);
      const match = candidate.match(/^(\d+);([a-f0-9]{64})$/);
      if (!match || pending.slice(0, end + 1).length > MAX_MARKER_LENGTH) {
        output += pending[0];
        pending = pending.slice(1);
        continue;
      }
      const generation = Number(match[1]);
      if (!Number.isSafeInteger(generation) || generation < 1) {
        output += pending[0];
        pending = pending.slice(1);
        continue;
      }
      onMarker(generation, match[2]);
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
