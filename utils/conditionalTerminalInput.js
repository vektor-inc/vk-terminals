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

// PTY へ書き込んだあと、新しい出力が無いまま静止したとみなすまでの時間（ms）。
// 選択肢の移動など画面を変える入力は、Codex / Claude Code が数十〜数百 ms で再描画するのが通常で、
// 再描画が来れば出力側が識別値を更新するため、この時間内に出力が無い＝画面が変わらなかった
// （端末問い合わせへの自動応答など）とみなせる。短すぎると遅れて届く再描画より先に採り直して
// 古い画面で Enter を許してしまい、長すぎると条件付き Enter の待ちが延びるため、1 秒弱とする。
const SILENT_WRITE_QUIET_MS = 800;

/**
 * 出力を伴わない PTY 書き込み（自動応答・フォーカス通知・リサイズ）の後、静止時間が過ぎたら識別値を採り直して
 * renderer へ送る（issue #517）。
 *
 * 競合の防ぎ方: 採り直すのは「最後の書き込み以降に PTY 出力が一度も無く、静止時間が過ぎた」ときだけ
 * （出力で noteOutput が予約を取り消し、書き込みのたびに予約を数え直す）。送信は出力と同じ
 * webContents の IPC なので、それ以前に送った terminal:data は renderer が先に処理し終えており、
 * renderer の lastLines と新しい識別値が食い違わない。採り直し後に書き込み・出力があれば番号が進み、
 * その識別値は照合で拒否される。
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

  function cancel(termId) {
    const id = String(termId);
    const timer = timers.get(id);
    if (timer === undefined) return;
    clearTimer(timer);
    timers.delete(id);
  }

  return {
    noteWrite(termId) {
      const id = String(termId);
      cancel(id);
      const timer = setTimer(() => {
        timers.delete(id);
        const snapshot = guard.capture(id, getGeneration(id));
        if (snapshot) send(id, snapshot);
      }, quietMs);
      if (timer && typeof timer.unref === 'function') timer.unref();
      timers.set(id, timer);
    },
    noteOutput: cancel,
    delete: cancel,
  };
}

/**
 * renderer が報告した画面と同時に採取した識別値を API 状態へ加える。
 *
 * 利用側は screenIdentifierStale が無いことを false と読むこと（最新のときはキー自体を付けない）。
 * 立っている間は識別値が null で、出力の無い書き込みの後は静止時間（SILENT_WRITE_QUIET_MS）を
 * 過ぎると自動で採り直され、再び識別値が返る。
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
