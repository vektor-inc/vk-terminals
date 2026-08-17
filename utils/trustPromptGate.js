'use strict';

// ─── 信頼確認プロンプトへの自動 Enter 送信を許可する条件の判定（issue #371）─────
//
// main.js の promptWatcher（信頼確認の文脈検知時に ptyProcess.write('\r') する処理）は
// 従来 trustHandled（1ペインにつき1回だけ）のガードしか持たず、時間的な制限が無かった。
// issue #371 ではこのモジュールの時間ゲートで発火可能な時間を限定した。issue #373 では
// 後述の isTrustPrompt も併用し、時間窓の内側でも信頼確認以外には発火させない。
//
// これを防ぐため、自動 Enter 送信を次の2条件を両方満たす間だけに限定する（AND 条件）。
//   1. ペイン作成（pty spawn）からの経過時間が TRUST_WINDOW_MS 以内であること
//   2. AI エンジンの起動完了（READY_PATTERN 一致）を検知してから READY_GRACE_MS を
//      超えて経っていないこと（未検知を含む）
//
// 条件2を「ready を検知したら即座に禁止」ではなく「検知してから READY_GRACE_MS の
// 猶予を設ける」形にしているのは、安藤のセキュリティレビュー（issue #371 の
// decision-record に記録済み）指摘への対応。実機の PTY 出力は「起動バナー」
// （READY_PATTERN が一致する文言）と「信頼確認ダイアログ」（isTrustPrompt が一致する
// 文言）が別チャンクで届くことがあり、バナー側のチャンクで ready 判定を即座に確定
// させてしまうと、直後のチャンクで届く信頼確認ダイアログに自動 Enter を送れなくなる。
// これは過去に直した「2つ目以降のターミナルで信頼確認プロンプトが自動承認されず
// 待機状態のままになる」症状（CHANGELOG.md 参照）への逆戻りになるため、チャンク境界に
// 判定が依存しないよう猶予を設けている。
//
// 時刻は呼び出し側から都度渡す（内部で時刻を取得しない）ことで、テストから実時間を
// 待たずに制御できるようにしている。main.js からは Date.now() ではなく、システム時刻の
// 巻き戻り（NTP のステップ補正・手動変更・VM のサスペンド復帰等）の影響を受けない
// 単調増加時計 performance.now() を渡すこと（安藤の指摘・MEDIUM）。

// 信頼確認プロンプトは通常ペイン作成の直後に出るが、低速な環境（初回インストール・
// 低スペック端末など）での初回起動を考慮し、余裕を持たせた値にしている。
// 既存の WATCH_TIMEOUT_MS（initialCommand 送信の待ち上限。10000ms）とは目的が異なる
// 別物のため、値を流用せず独立した定数として持つ。
const TRUST_WINDOW_MS = 30000;

// 起動完了（READY_PATTERN）を検知してから、なお自動 Enter 送信を許可し続ける猶予（ms）。
// 上のコメントのチャンク分割対策のための値。信頼確認ダイアログは起動バナーの直後
// （同じ描画バーストの中）に出るのが通常のため、数秒あれば十分にチャンク分割を
// 吸収できる一方、無制限に許可し続けると issue #371 の本題（時間が経った場面での
// 誤発火）を再び許してしまうため、短い値に留める。
const READY_GRACE_MS = 3000;

// ─── 信頼確認プロンプトの文脈判定（issue #373）──────────────────────────────
// 2026-08-17 の実機 PTY 採取で確認したキー文言:
//   Claude Code 現行 UI: "Quick safety check: Is this a project you created or one you trust?"
//                           / "Yes, I trust this folder"
//   Codex 現行 UI:         "Do you trust the contents of this directory?"
// Claude Code 旧 UI の "Do you trust the files in this folder?" も従来どおり対象にする。
//
// stripAnsiForPattern 後の PTY 出力では、カーソル移動による描画の単語間に空白が残らず
// "Doyoutrust..." のように連結されることがある。そのため単語間の空白は0文字以上として
// 扱い、信頼確認に固有の短い錨を使う。一般的な "Enter to confirm" は信頼確認の文脈を
// 示さないため、パターンへ含めない。
const TRUST_CONTEXT_PATTERNS = [
  /Quick\s*safety\s*check/i,
  /Do\s*you\s*trust[\s\S]{0,40}(?:folder|directory)/i,
  /Yes,\s*I\s*trust\s*(?:the\s*files\s*in\s*)?this\s*(?:folder|directory)/i,
];

/**
 * PTY 出力に、対応対象の信頼確認画面を示す文脈が含まれるか判定する。
 * 時間窓・発火回数は createTrustPromptGate が別に判定し、この関数は文言だけを見る。
 *
 * @param {*} output - stripAnsiForPattern 適用後の累積 PTY 出力。
 * @returns {boolean} 信頼確認の文脈が含まれる場合は true。
 */
function isTrustPrompt(output) {
  if (typeof output !== 'string') return false;
  return TRUST_CONTEXT_PATTERNS.some((pattern) => pattern.test(output));
}

/**
 * 信頼確認プロンプトへの自動 Enter 送信の可否・監視終了の可否を判定するゲートを作る。
 *
 * @param {object} options
 * @param {number} options.spawnTime - ペイン作成（pty spawn）時刻（呼び出し側の時計と同じ単位・原点の値。main.js は performance.now() を使う）
 * @param {number} [options.trustWindowMs] - 自動応答を許可する経過時間の上限（ms）。既定 TRUST_WINDOW_MS
 * @param {number} [options.readyGraceMs] - ready 検知後もなお自動応答を許可する猶予（ms）。既定 READY_GRACE_MS
 * @returns {{
 *   canAutoRespond: (now: number) => boolean,
 *   markTrustHandled: () => void,
 *   markReadyDetected: (now: number) => void,
 *   isReadyDetected: () => boolean,
 *   isTrustHandled: () => boolean,
 *   isWindowOpen: (now: number) => boolean,
 *   shouldStopWatching: (now: number, opts?: { initialCommandPending?: boolean }) => boolean,
 * }}
 */
function createTrustPromptGate({ spawnTime, trustWindowMs = TRUST_WINDOW_MS, readyGraceMs = READY_GRACE_MS } = {}) {
  if (typeof spawnTime !== 'number' || Number.isNaN(spawnTime)) {
    throw new TypeError('createTrustPromptGate: spawnTime must be a number');
  }

  let trustHandled = false;
  // ready を検知した時刻。未検知は null（＝猶予の制約を受けない）。
  let readyAt = null;

  // 経過時間が [0, trustWindowMs] の範囲内かどうか。
  // 下限（0）も明示的に見ているのは、時計が巻き戻った場合に経過時間が負になっても
  // 「窓が開いている」と誤判定しない（＝安全側の「窓の外」扱いにする）ため
  // （安藤の指摘・MEDIUM）。
  function isWindowOpen(now) {
    const elapsed = now - spawnTime;
    return elapsed >= 0 && elapsed <= trustWindowMs;
  }

  // ready 未検知、または検知してから readyGraceMs 以内かどうか。
  // 経過時間が負（時計の巻き戻り）になった場合も安全側（猶予の外）へ倒す。
  function isWithinReadyGrace(now) {
    if (readyAt === null) return true;
    const elapsedSinceReady = now - readyAt;
    return elapsedSinceReady >= 0 && elapsedSinceReady <= readyGraceMs;
  }

  // いま信頼確認の文脈一致に対して自動 Enter 送信をしてよいか
  // （窓の内側 かつ ready 猶予内 かつ 未発火）
  function canAutoRespond(now) {
    return !trustHandled && isWindowOpen(now) && isWithinReadyGrace(now);
  }

  // 自動 Enter を送信した（以後は二度と送らない）
  function markTrustHandled() {
    trustHandled = true;
  }

  // AI エンジンの起動完了を検知した時刻を記録する。以後は readyGraceMs の間だけ
  // 自動 Enter 送信を許可し続け、それを過ぎたら禁止する（チャンク分割対策。冒頭コメント参照）。
  // READY_PATTERN は一致した文言がバッファに残り続ける限り複数回一致しうるため、
  // 最初の検知時刻だけを記録する（2回目以降の呼び出しは無視。猶予の起点を後ろへ
  // 引き延ばさない）。
  function markReadyDetected(now) {
    if (typeof now !== 'number' || Number.isNaN(now)) {
      throw new TypeError('markReadyDetected: now must be a number');
    }
    if (readyAt === null) readyAt = now;
  }

  function isReadyDetected() {
    return readyAt !== null;
  }

  function isTrustHandled() {
    return trustHandled;
  }

  // 自動応答の窓が閉じ（経過時間超過、または ready 検知から猶予を超過）、かつ
  // initialCommand の送信ももう起こらない場合、promptWatcher の監視自体を
  // 終了してよいと判定する。initialCommand が起こりうるかどうかは main.js 側の
  // 事情（sent 済み・isFirstTerminal・config.initialCommand の有無）のため、
  // 呼び出し側から opts.initialCommandPending として渡してもらう。
  function shouldStopWatching(now, opts = {}) {
    const { initialCommandPending = false } = opts;
    const windowClosed = !isWindowOpen(now) || !isWithinReadyGrace(now);
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

/**
 * 環境変数由来の値を「正の有限な数値（ミリ秒）」としてパースする。
 * 未設定・空文字・数値に変換できない値・0以下・NaN・Infinity はすべて fallback に倒す
 * （utils/strictBoolFlag.js と同じく「規約から外れる値は安全側の既定値へ倒す」方針）。
 *
 * main.js の VK_TERMINALS_TRUST_WINDOW_MS / VK_TERMINALS_READY_GRACE_MS の解決に使う。
 * e2e テストがこれらの時間窓を短縮し、実時間を待たずに検証できるようにするための入口
 * （安藤の指摘・必須2）。
 *
 * options.max を指定すると、パースできた値が max を超える場合は max に切り詰める
 * （安藤の指摘・MEDIUM・必須1）。この2つの環境変数は e2e が実時間の待ちを「短縮」
 * するためだけの入口であり、上限が無いと逆に時間窓を無制限に「延長」でき、
 * 信頼確認プロンプトへの自動応答をいつまでも許可し続ける状態を作れてしまう
 * （＝この PR が塞ごうとしている防御そのものを、環境変数1つで無効化できてしまう）。
 * main.js はそれぞれの既定値（TRUST_WINDOW_MS / READY_GRACE_MS）を max として渡し、
 * 「既定値以下への短縮のみ」を許可する形にする。
 *
 * @param {*} rawValue - 環境変数由来の値（文字列 or undefined）。
 * @param {number} fallback - パースできなかった場合に返す既定値。
 * @param {object} [options]
 * @param {number} [options.max] - 採用してよい上限（ms）。指定時、パース結果がこれを
 *   超える場合は max に切り詰める。
 * @returns {number}
 */
function resolvePositiveFiniteMs(rawValue, fallback, options = {}) {
  const { max } = options;
  if (rawValue === undefined || rawValue === null || rawValue === '') return fallback;
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  if (typeof max === 'number' && parsed > max) return max;
  return parsed;
}

module.exports = {
  TRUST_WINDOW_MS,
  READY_GRACE_MS,
  createTrustPromptGate,
  isTrustPrompt,
  resolvePositiveFiniteMs,
};
