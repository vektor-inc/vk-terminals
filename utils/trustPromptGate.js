'use strict';

// ─── 信頼確認プロンプトへの自動 Enter 送信を許可する条件の判定（issue #371）─────
//
// main.js の promptWatcher（TRUST_PATTERN 検知時に ptyProcess.write('\r') する処理）は
// 従来 trustHandled（1ペインにつき1回だけ）のガードしか持たず、時間的な制限が無かった。
// TRUST_PATTERN には「Enter to confirm」のような一般語も含まれるため、起動から
// どれだけ経っていても、その「1回」が起動直後の信頼確認以外の場面で消費されうる状態
// だった。
//
// これを防ぐため、自動 Enter 送信を次の2条件を両方満たす間だけに限定する（AND 条件）。
//   1. ペイン作成（pty spawn）からの経過時間が TRUST_WINDOW_MS 以内であること
//   2. AI エンジンの起動完了（READY_PATTERN 一致）をまだ検知していないこと
//     （信頼確認は必ず起動完了より前に出るため、ready を検知したら以降は無効化する）
//
// 時刻は呼び出し側から都度渡す（内部で Date.now() を呼ばない）ことで、
// テストから実時間を待たずに制御できるようにしている。

// 信頼確認プロンプトは通常ペイン作成の直後に出るが、低速な環境（初回インストール・
// 低スペック端末など）での初回起動を考慮し、余裕を持たせた値にしている。
// 既存の WATCH_TIMEOUT_MS（initialCommand 送信の待ち上限。10000ms）とは目的が異なる
// 別物のため、値を流用せず独立した定数として持つ。
const TRUST_WINDOW_MS = 30000;

/**
 * 信頼確認プロンプトへの自動 Enter 送信の可否・監視終了の可否を判定するゲートを作る。
 *
 * @param {object} options
 * @param {number} options.spawnTime - ペイン作成（pty spawn）時刻（Date.now() と同じ単位の ms epoch）
 * @param {number} [options.trustWindowMs] - 自動応答を許可する経過時間の上限（ms）。既定 TRUST_WINDOW_MS
 * @returns {{
 *   canAutoRespond: (now: number) => boolean,
 *   markTrustHandled: () => void,
 *   markReadyDetected: () => void,
 *   isReadyDetected: () => boolean,
 *   isTrustHandled: () => boolean,
 *   isWindowOpen: (now: number) => boolean,
 *   shouldStopWatching: (now: number, opts?: { initialCommandPending?: boolean }) => boolean,
 * }}
 */
function createTrustPromptGate({ spawnTime, trustWindowMs = TRUST_WINDOW_MS } = {}) {
  if (typeof spawnTime !== 'number' || Number.isNaN(spawnTime)) {
    throw new TypeError('createTrustPromptGate: spawnTime must be a number');
  }

  let trustHandled = false;
  let readyDetected = false;

  // 経過時間が TRUST_WINDOW_MS 以内かどうか
  function isWindowOpen(now) {
    return (now - spawnTime) <= trustWindowMs;
  }

  // いま TRUST_PATTERN 一致に対して自動 Enter 送信をしてよいか
  // （窓の内側 かつ ready 未検知 かつ 未発火）
  function canAutoRespond(now) {
    return !trustHandled && !readyDetected && isWindowOpen(now);
  }

  // 自動 Enter を送信した（以後は二度と送らない）
  function markTrustHandled() {
    trustHandled = true;
  }

  // AI エンジンの起動完了を検知した（以後、自動 Enter 送信は無効化）
  function markReadyDetected() {
    readyDetected = true;
  }

  function isReadyDetected() {
    return readyDetected;
  }

  function isTrustHandled() {
    return trustHandled;
  }

  // 自動応答の窓が閉じ（ready 検知済み、または経過時間超過）、かつ
  // initialCommand の送信ももう起こらない場合、promptWatcher の監視自体を
  // 終了してよいと判定する。initialCommand が起こりうるかどうかは main.js 側の
  // 事情（sent 済み・isFirstTerminal・config.initialCommand の有無）のため、
  // 呼び出し側から opts.initialCommandPending として渡してもらう。
  function shouldStopWatching(now, opts = {}) {
    const { initialCommandPending = false } = opts;
    const windowClosed = readyDetected || !isWindowOpen(now);
    return windowClosed && !initialCommandPending;
  }

  return {
    canAutoRespond,
    markTrustHandled,
    markReadyDetected,
    isReadyDetected,
    isTrustHandled,
    isWindowOpen,
    shouldStopWatching,
  };
}

module.exports = {
  TRUST_WINDOW_MS,
  createTrustPromptGate,
};
