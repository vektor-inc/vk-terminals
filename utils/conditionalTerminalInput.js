'use strict';

const crypto = require('crypto');

/**
 * 画面確認後の Enter を、同じペイン・画面・起動世代にだけ送るための状態を作る。
 *
 * @param {object} [options] - テスト時に秘密値を固定するためのオプション。
 * @param {Buffer|string} [options.secret] - 画面識別値の HMAC 秘密値。
 * @returns {object} ペインごとの画面世代を管理するガード。
 */
function createConditionalTerminalInputGuard(options = {}) {
  const secret = options.secret || crypto.randomBytes(32);
  const revisions = new Map();

  // 外部から revision を推測・改ざんできない識別値へ変換する。
  function identifier(termId, generation, revision) {
    return crypto
      .createHmac('sha256', secret)
      .update(JSON.stringify([String(termId), generation, revision]))
      .digest('base64url');
  }

  function identifiersEqual(actual, expected) {
    if (typeof expected !== 'string') return false;
    const actualBuffer = Buffer.from(actual);
    const expectedBuffer = Buffer.from(expected);
    return actualBuffer.length === expectedBuffer.length
      && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
  }

  return {
    initialize(termId) {
      revisions.set(String(termId), 0);
    },

    delete(termId) {
      revisions.delete(String(termId));
    },

    markChanged(termId) {
      const id = String(termId);
      const revision = revisions.get(id);
      if (revision === undefined) return false;
      revisions.set(id, revision + 1);
      return true;
    },

    capture(termId, generation) {
      const id = String(termId);
      const revision = revisions.get(id);
      if (revision === undefined || !Number.isSafeInteger(generation)) return null;
      return {
        agentGeneration: generation,
        screenIdentifier: identifier(id, generation, revision),
      };
    },

    writeEnter(request, dependencies) {
      const id = String(request.termId);
      const ptyProcess = dependencies.getPty(id);
      if (!ptyProcess || !revisions.has(id)) {
        return { ok: false, reason: 'pane-not-found' };
      }

      // 同じ JavaScript ターン内で世代と画面を照合し、識別値を消費してから書き込む。
      const currentGeneration = dependencies.getGeneration(id);
      if (request.expectedGeneration !== currentGeneration) {
        return { ok: false, reason: 'generation-changed', currentGeneration };
      }
      const revision = revisions.get(id);
      const currentIdentifier = identifier(id, currentGeneration, revision);
      if (!identifiersEqual(currentIdentifier, request.expectedScreenIdentifier)) {
        return { ok: false, reason: 'screen-changed', currentGeneration };
      }

      revisions.set(id, revision + 1);
      try {
        ptyProcess.write('\r');
      } catch (_error) {
        return { ok: false, reason: 'input-failed', currentGeneration };
      }
      return { ok: true, termId: id };
    },
  };
}

/**
 * renderer が報告した画面と同時に採取した識別値を API 状態へ加える。
 *
 * @param {object} states - agentGeneration 追加済みのペイン状態。
 * @param {Map<string, object>} snapshots - termId ごとの報告時スナップショット。
 * @returns {object} screenIdentifier を加えた状態。
 */
function mergeConditionalScreenIdentifiers(states, snapshots) {
  if (!states || typeof states !== 'object' || Array.isArray(states)) return states;
  return Object.fromEntries(Object.entries(states).map(([paneId, state]) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return [paneId, state];
    const {
      screenIdentifier: _reportedScreenIdentifier,
      screenIdentifierGeneration: _reportedScreenIdentifierGeneration,
      ...publicState
    } = state;
    const snapshot = snapshots.get(String(state.termId));
    const screenIdentifier = snapshot && snapshot.agentGeneration === state.agentGeneration
      ? snapshot.screenIdentifier
      : null;
    return [paneId, { ...publicState, screenIdentifier }];
  }));
}

/**
 * POST /api/send のうち、明示的な条件付き Enter 要求だけを検証する。
 *
 * @param {object} value - JSON から復元した入力要求。
 * @returns {object} 通常入力・検証エラー・条件付き要求のいずれか。
 */
function validateConditionalEnterRequest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !Object.prototype.hasOwnProperty.call(value, 'expected')) {
    return { conditional: false };
  }
  const expected = value.expected;
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) {
    return { conditional: true, ok: false, error: 'expected must be an object' };
  }
  if (value.input !== '\r') {
    return { conditional: true, ok: false, error: 'conditional input must be one Enter' };
  }
  if (!Number.isSafeInteger(expected.agentGeneration) || expected.agentGeneration < 0) {
    return { conditional: true, ok: false, error: 'expected.agentGeneration must be a non-negative integer' };
  }
  if (typeof expected.screenIdentifier !== 'string'
    || !/^[A-Za-z0-9_-]{43}$/.test(expected.screenIdentifier)) {
    return { conditional: true, ok: false, error: 'expected.screenIdentifier is invalid' };
  }
  return {
    conditional: true,
    ok: true,
    request: {
      termId: String(value.termId),
      expectedGeneration: expected.agentGeneration,
      expectedScreenIdentifier: expected.screenIdentifier,
    },
  };
}

module.exports = {
  createConditionalTerminalInputGuard,
  mergeConditionalScreenIdentifiers,
  validateConditionalEnterRequest,
};
