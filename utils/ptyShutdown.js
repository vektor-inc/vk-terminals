'use strict';

// ─── アプリ終了時、PTY の終了通知を待ってから終了処理を続ける（issue #409）────────
// node-pty（1.1.0）の終了通知は ThreadSafeFunction 経由で JS の onExit コールバックを
// 呼び出す。アプリ終了処理（Node 環境破棄 = FreeEnvironment）が先に始まってしまうと、
// この呼び出しが JS を呼べず C++ 側で例外→terminate し、Electron プロセスが SIGABRT で
// 落ちる（クラッシュレポート 13 件で同一スタックを確認済み）。
// 対策として、kill() を送るだけで終了を進めていた従来の cleanupPtys() をやめ、
// 生きている pty それぞれの onExit が届く（＝プロセスが本当に終わった）まで
// 上限つきで待ってから終了処理を続行する。
//
// 上限（GRACE_MS）は 1.5 秒とした。シェルやその配下（claude/codex 等の CLI）が
// SIGHUP/SIGTERM を受けてから後始末して終了するまでの猶予として、e2e で多数の
// ペインを連続開閉しても待ち時間が体感できるほど伸びない一方、通常のシェル終了には
// 十分な長さ（既存の DEFAULT_TERM_GRACE_MS 系の待ち時間と同オーダー）として選んだ。
// 上限を超えて生きているものは SIGKILL で強制終了し、その終了通知も
// 短時間（FORCE_MS = 500ms）だけ待つ。SIGKILL は原則即座に処理されるため、
// GRACE_MS よりかなり短い値で十分と判断した。
const DEFAULT_GRACE_MS = 1500;
const DEFAULT_FORCE_MS = 500;

/**
 * 単一の pty プロセスへ kill を送り、onExit 通知が届くまで待つ。
 * 上限（graceMs）を超えても生きていれば SIGKILL を送り、追加で forceMs だけ待って
 * 諦める（諦めた場合も reject はしない。呼び出し元は「終了処理を続けてよいか」だけを
 * 知りたいため、待ちきれなかったこと自体では失敗にしない）。
 * @param {{kill: Function, onExit: Function}} ptyProcess node-pty の IPty 互換オブジェクト
 * @param {object} [opts]
 * @param {number} [opts.graceMs] 通常終了（kill()）を待つ上限（既定 1500ms）
 * @param {number} [opts.forceMs] SIGKILL 後に追加で待つ上限（既定 500ms）
 * @param {Function} [opts.setTimeout] 差し替え用（テストで実時間を待たないため。既定はグローバル setTimeout）
 * @param {Function} [opts.clearTimeout] 差し替え用（既定はグローバル clearTimeout）
 * @returns {Promise<void>} 終了通知を受け取るか、待ちきれず諦めた時点で解決する
 */
function waitForPtyExit(ptyProcess, opts = {}) {
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_MS;
  const forceMs = opts.forceMs ?? DEFAULT_FORCE_MS;
  const scheduleTimeout = opts.setTimeout ?? setTimeout;
  const cancelTimeout = opts.clearTimeout ?? clearTimeout;

  return new Promise((resolve) => {
    let settled = false;
    let disposable = null;
    let graceTimer = null;
    let forceTimer = null;

    // onExit・タイムアウトのどちらが先に来ても、後始末を一度だけ行って解決する。
    const finish = () => {
      if (settled) return;
      settled = true;
      if (graceTimer) cancelTimeout(graceTimer);
      if (forceTimer) cancelTimeout(forceTimer);
      if (disposable && typeof disposable.dispose === 'function') {
        try { disposable.dispose(); } catch (_e) { /* 後始末失敗は無視 */ }
      }
      resolve();
    };

    try {
      disposable = ptyProcess.onExit(() => finish());
    } catch (_e) {
      // onExit を持たない／呼べないオブジェクトは終了を追跡できないため、
      // 待たずに進める（呼び出し元の終了処理を止めないことを優先する）。
      finish();
      return;
    }

    try {
      ptyProcess.kill();
    } catch (_e) { /* 既に終了している等は無視 */ }

    graceTimer = scheduleTimeout(() => {
      try { ptyProcess.kill('SIGKILL'); } catch (_e) { /* 既に終了している等は無視 */ }
      forceTimer = scheduleTimeout(finish, forceMs);
    }, graceMs);
  });
}

/**
 * 複数の pty プロセスの終了をまとめて待つ。0件なら待たずに即解決する。
 * @param {Iterable<{kill: Function, onExit: Function}>} ptyProcesses
 * @param {object} [opts] waitForPtyExit と同じオプション
 * @returns {Promise<void>}
 */
async function waitForAllPtysExit(ptyProcesses, opts = {}) {
  const list = Array.from(ptyProcesses);
  if (list.length === 0) return;
  await Promise.all(list.map((p) => waitForPtyExit(p, opts)));
}

module.exports = {
  DEFAULT_GRACE_MS,
  DEFAULT_FORCE_MS,
  waitForPtyExit,
  waitForAllPtysExit,
};
