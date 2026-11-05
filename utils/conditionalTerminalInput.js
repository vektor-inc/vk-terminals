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

    // 報告済みの識別値が、いまのペインの画面番号と一致する（＝以後 PTY 書き込みが無い）か。
    // 画面出力を伴わない書き込みでは onData が走らず報告が更新されないため、states 側で
    // 「最新ではない」と判別できるようにする（issue #517）。
    isCurrent(termId, snapshot) {
      const id = String(termId);
      const revision = revisions.get(id);
      if (revision === undefined || !snapshot || !Number.isSafeInteger(snapshot.agentGeneration)) return false;
      return identifiersEqual(identifier(id, snapshot.agentGeneration, revision), snapshot.screenIdentifier);
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

// 採り直し対象の書き込み後、出力が無いまま静止したとみなす時間（ms）。
// 通常入力後の再描画待ちは時間では解除せず、可視出力を待つ。
const SILENT_WRITE_QUIET_MS = 800;

/**
 * 自動応答・フォーカス通知・リサイズ後、静止時間が過ぎたら識別値を採り直す。
 * 通常入力・API 入力・自動 Enter 後は、可視出力が届くまで採り直しを抑止する。
 *
 * 出力で予約を取り消し、対象の書き込みごとに静止時間を数え直す。
 * 出力と同じ webContents の IPC で送るため、renderer は先行する terminal:data を
 * 処理してから識別値を更新する。採り直し後の入出力ではガードの番号が進む。
 *
 * @param {object} options
 * @param {object} options.guard - createConditionalTerminalInputGuard の戻り値。
 * @param {(termId: string) => number|undefined} options.getGeneration - 現在の起動世代。
 * @param {(termId: string, snapshot: object) => void} options.send - 採り直した識別値の送信先。
 * @param {number} [options.quietMs] - 静止時間。
 * @param {Function} [options.setTimer] - テスト用に差し替え可能なタイマー。
 * @param {Function} [options.clearTimer] - テスト用に差し替え可能なタイマー解除。
 */
function createSilentWriteRefresher({
  guard,
  getGeneration,
  send,
  quietMs = SILENT_WRITE_QUIET_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  const timers = new Map();
  const awaitingOutput = new Set();

  function cancel(termId) {
    const id = String(termId);
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimer(timer);
    timers.delete(id);
  }

  return {
    // 全 PTY 書き込みで予約を取り消す。採り直し対象でも既存の出力待ちは解除しない。
    noteInput(termId, canRefresh = false) {
      const id = String(termId);
      cancel(id);
      if (!canRefresh) awaitingOutput.add(id);
    },
    noteWrite(termId) {
      const id = String(termId);
      cancel(id);
      if (awaitingOutput.has(id)) return;
      const timer = setTimer(() => {
        timers.delete(id);
        const snapshot = guard.capture(id, getGeneration(id));
        if (snapshot) send(id, snapshot);
      }, quietMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      timers.set(id, timer);
    },
    noteOutput(termId) {
      cancel(termId);
      awaitingOutput.delete(String(termId));
    },
    delete(termId) {
      cancel(termId);
      awaitingOutput.delete(String(termId));
    },
  };
}

/**
 * renderer が報告した画面と同時に採取した識別値を API 状態へ加える。
 *
 * 利用側は screenIdentifierStale が無いことを false と読むこと（最新のときはキー自体を付けない）。
 * 立っている間は識別値が null。採り直し対象の書き込み後は静止時間で更新するが、
 * 通常入力後は可視出力が届くまで採り直さない。
 *
 * @param {object} states - agentGeneration 追加済みのペイン状態。
 * @param {Map<string, object>} snapshots - termId ごとの報告時スナップショット。
 * @param {object} [guard] - 指定時は識別値が最新か照合し、古ければ screenIdentifierStale: true を返す。
 * @returns {object} screenIdentifier を加えた状態。
 */
function mergeConditionalScreenIdentifiers(states, snapshots, guard) {
  if (!states || typeof states !== 'object' || Array.isArray(states)) return states;
  return Object.fromEntries(Object.entries(states).map(([paneId, state]) => {
    if (!state || typeof state !== 'object' || Array.isArray(state)) return [paneId, state];
    const {
      screenIdentifier: _reportedScreenIdentifier,
      screenIdentifierGeneration: _reportedScreenIdentifierGeneration,
      ...publicState
    } = state;
    const snapshot = snapshots.get(String(state.termId));
    const sameGeneration = !!snapshot && snapshot.agentGeneration === state.agentGeneration;
    // 出力を伴わない書き込み（端末問い合わせへの自動応答・リサイズ等）の後は、報告済みの識別値が
    // ガード側で消費済みになり、そのまま返すと Enter が永久に screen-changed になる。
    // 古い値は返さず、最新ではないことを screenIdentifierStale で示す（issue #517）。
    if (sameGeneration && guard && !guard.isCurrent(state.termId, snapshot)) {
      return [paneId, { ...publicState, screenIdentifier: null, screenIdentifierStale: true }];
    }
    const screenIdentifier = sameGeneration ? snapshot.screenIdentifier : null;
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
  createSilentWriteRefresher,
  SILENT_WRITE_QUIET_MS,
};
