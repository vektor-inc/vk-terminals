'use strict';

// セットアップ状況の確認（issue #456）を、上限時間つき・同時 1 本で実行する。
// getSetupStatus は組み込み側（例: VK Orchestrator）が渡す非同期関数で、doctor の結果を返す。
// vk-terminals は doctor を自分で起動しない。Electron に依存しないので tests/setupStatusCheck.test.js で検証する。

const { normalizeSetupStatus } = require('./setupStatus');

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_DETAIL_MESSAGE_LENGTH = 300;

function describeError(error) {
  const message = error && typeof error.message === 'string' ? error.message : String(error);
  const flat = message.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return flat.length > MAX_DETAIL_MESSAGE_LENGTH ? `${flat.slice(0, MAX_DETAIL_MESSAGE_LENGTH - 1)}…` : flat;
}

/**
 * @param {object} options
 * @param {(arg: { signal: AbortSignal }) => Promise<*>} options.getSetupStatus
 * @param {number} [options.timeoutMs] 待ち時間の上限（既定 20 秒）
 * @param {() => number} [options.now]
 * @returns {{ check: () => Promise<object>, isRunning: () => boolean }}
 *   check() の戻り値は { ok: true, status, checkedAt } か
 *   { ok: false, reason: 'timeout'|'error'|'invalid', timeoutSeconds, detail, checkedAt }。
 */
function createSetupStatusChecker({ getSetupStatus, timeoutMs = DEFAULT_TIMEOUT_MS, now = Date.now }) {
  let inFlight = null;

  function failure(reason, extra = {}) {
    const checkedAt = now();
    const lines = [
      `reason: ${reason}`,
      ...(extra.message ? [`message: ${extra.message}`] : []),
      `checked at: ${new Date(checkedAt).toISOString()}`,
    ];
    return {
      ok: false,
      reason,
      timeoutSeconds: Math.round(timeoutMs / 1000),
      detail: lines.join('\n'),
      checkedAt,
    };
  }

  async function run() {
    const controller = new AbortController();
    let timer = null;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        // 時間切れ。組み込み側に中断を知らせ、待つのをやめる（次の確認は新しく始められる）。
        controller.abort();
        resolve({ timedOut: true });
      }, timeoutMs);
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve()
          .then(() => getSetupStatus({ signal: controller.signal }))
          .then((value) => ({ value })),
        timeout,
      ]);
      if (outcome.timedOut) return failure('timeout');
      const normalized = normalizeSetupStatus(outcome.value);
      if (!normalized.ok) return failure('invalid');
      return { ok: true, status: normalized.status, checkedAt: now() };
    } catch (error) {
      return failure('error', { message: describeError(error) });
    } finally {
      clearTimeout(timer);
    }
  }

  function check() {
    // 実行中に呼ばれたら、新しく始めず同じ確認の結果を返す（同時に走らせるのは 1 本だけ）。
    if (inFlight) return inFlight;
    inFlight = run().finally(() => { inFlight = null; });
    return inFlight;
  }

  return { check, isRunning: () => inFlight !== null };
}

module.exports = { DEFAULT_TIMEOUT_MS, createSetupStatusChecker };
