/* global module */

// ─── Waiting detection ────────────────────────────────────────────────────────
const WAITING_PATTERNS = [
  /\[y\/N\]/i, /\[Y\/n\]/i, /\(y\/n\)/i,
  /Press Enter/i,
  /Continue\?/i,
  /Do you want to/i,
  /Would you like/i,
  /Proceed\?/i,
  /\? .{1,60}[›>❯]\s*$/m,  // inquirer / Claude Code prompts
  // Claude Code 承認待ちパターン
  /Yes,?\s+allow/i,
  /No,?\s+don['']t allow/i,
  /Allow\s+(once|always|this)/i,
  /\bAllow\b.{0,40}\?/i,
  /Deny\b/i,
  /Yes\s*\/\s*No/i,
  /❯\s*(Yes|No|Allow|Deny)/,
  /›\s*(Yes|No|Allow|Deny)/,
  /\[\s*A\s*\]llow/i,
  /\[\s*D\s*\]eny/i,
  /approve.*\(y\/n\)/i,
  // NOTE: /permission/i は削除 — Claude Code の UI フッター "bypass permissions on" に誤反応するため
  // 日本語の確認待ちパターン（vk-kore など、Claude が確認を求めて中断する場面で出る文言）
  /ご確認(?:を|ください|お願い)/,
  /続行しますか/,
  /進めて(?:よろしい|よい)/,
  /(?:よろしい|いかが)(?:でしょうか|ですか)[。？?]?\s*$/m,
  // マージ待ちパターン（vk-kore の PR 作成後・マージ判断委譲のタイミング）
  /マージ(?:判断|してください|してもよろしい)/,
  /マージ.{0,30}(?:ご判断|お願い|よろしい|お任せ)/,
  // recap / 追加の確認待ち文言（issue #32）。
  // Claude Code が "※ recap: …承認待ちです。…(disable recaps in /config)" のような
  // 振り返りメッセージを最後に挟むケースで、本文末尾が "承認待ち" や "委任します"
  // のような形になる。これらの「次アクションをユーザーに委ねている」言い回しを拾う。
  /(?:承認|回答|ご判断|ご返答|お返事|ご指示|ご連絡)(?:を)?(?:お)?待ち/,
  /(?:いただけ|いただい)たら.{0,30}(?:委任|お願い|進め|実装)/,
  /(?:お任せ|ご判断)(?:します|ください|いただけ)/,
  // NOTE: /(?:お待ち|待って)(?:しています|います|ます)/ は削除
  //   （issue vektor-inc/vk-orchestrator#212）。
  //   「和田の修正を待っています。」「CI の完了を待っています。」のような、
  //   第三者（サブエージェント・外部処理）の完了待ちを伝える進捗ナレーションに
  //   反応してしまい、AI が動作中でも「入力待ち」が点灯していた。
  //   ユーザー宛ての待ち文言は直上の
  //   /(?:承認|回答|ご判断|ご返答|お返事|ご指示|ご連絡)(?:を)?(?:お)?待ち/ が拾うため、
  //   宛先を限定しない広いパターンは持たない。
  // AskUserQuestion / 数字選択肢の UI 検知（issue #46）。
  // Claude Code の AskUserQuestion は「❯ 1. … / 2. …」の選択肢と
  // 「Enter to select / ↑/↓ to navigate / Esc to cancel」のフッターが固定で出る。
  // 既存パターンは ASCII `?` と `❯ Yes|No|Allow|Deny` しか拾えず取りこぼしていた。
  /Enter\s+to\s+select/i,
  /[↑↓]\/[↑↓]\s+to\s+navigate/,
  /Esc\s+to\s+cancel/i,
  /❯\s*\d+\.\s/,  // `❯ 1. ラベル` 形式（任意ラベルの数字選択肢）
  // 全角「？」で終わる質問文。AskUserQuestion 以外の TUI / 日本語プロンプト
  // でも全角？で末尾するケースを拾うための補助パターン。
  // Claude Code の AskUserQuestion 自体は上の `Enter to select` フッターで
  // 確定検知できるため、ここは網羅性ではなく **誤検知抑制** を優先して
  // `m` フラグ無しでバッファ全体の末尾にのみアンカーする。
  // `m` を付けると `lastLines` バッファ（最大 80 行）に残る過去の質問行に
  // 反応して running 中も waiting に張り付くため、その挙動を避ける。
  /[？]\s*$/,
];

function matchesWaiting(cleanBuffer) {
  return WAITING_PATTERNS.some(p => p.test(cleanBuffer));
}

function normalizeWaitingExcludeCwdPatterns(patterns) {
  if (!Array.isArray(patterns)) return [];
  return patterns
    .filter((pattern) => typeof pattern === 'string')
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');
}

function isWaitingCwdExcluded(cwdFull, patterns) {
  if (typeof cwdFull !== 'string' || cwdFull === '') return false;
  const normalized = normalizeWaitingExcludeCwdPatterns(patterns);
  return normalized.some((pattern) => cwdFull.includes(pattern));
}

// ─── 判定タイミング（静止ゲート / issue vektor-inc/vk-orchestrator#212）──────
// PTY 出力のたびに判定すると、作業中スピナー（経過秒数付き）の再描画途中の
// バッファに対して評価してしまい、進捗ナレーションや描画途中の断片で誤検知しやすい。
// 逆に本物の確認待ちでは相手が止まるため出力が途絶える。この差を判定条件に使い、
// 「最後の出力から一定時間静止したら判定する」形にする。
const WAITING_QUIESCENCE_MS = 1500;
// 入力待ち表示中に限って設ける再判定の上限（ms）。
// 誤検知で入力待ちになったまま出力が延々と流れ続ける（スピナーが回り続ける）と
// 静止が訪れず、再評価の機会が永久に来ない。張り付きから必ず復帰できるよう、
// 入力待ち中だけは静止を待たずにこの間隔で再評価する。
const WAITING_STUCK_RECHECK_MS = 5000;

// 次に waiting 判定を行うまでの待ち時間（ms）を返す。
//   - lastOutputTime: 最後に PTY 出力を受け取った時刻
//   - pendingSince:   前回の判定以降、最初に出力を受け取った時刻（上限判定の起点）
//   - waiting:        現在入力待ち表示中か（上限による強制再判定は入力待ち中のみ）
function waitingCheckDelayMs({
  now,
  lastOutputTime,
  pendingSince,
  waiting = false,
  quiescenceMs = WAITING_QUIESCENCE_MS,
  stuckRecheckMs = WAITING_STUCK_RECHECK_MS,
}) {
  let target = (lastOutputTime || 0) + quiescenceMs;
  if (waiting && pendingSince) target = Math.min(target, pendingSince + stuckRecheckMs);
  return Math.max(0, target - now);
}

// 出力が静止した時点（または入力待ち中の上限到達時）の再評価。
// 戻り値の clearArmed は「次に出力が再開したら入力待ちを解除する」予約フラグ。
//
// なぜ非マッチで即解除しないか:
//   静止時点の lastLines には直近の再描画結果（ダイアログ本体）が残っているため、
//   原則としてそのまま再評価してよい。ただしウィンドウリサイズ等で TUI が再描画すると
//   確認文が別位置で折り返され、一時的にパターンへマッチしなくなることがある
//   （tests の「リサイズ再描画で確認文が折り返された非マッチ例」参照）。
//   ここで即解除すると本物の確認待ちを取りこぼすため、解除は「出力が再開した
//   ＝相手は入力を待たずに動いている」という追加の根拠が得られるまで保留する。
function nextWaitingStateOnQuiescence({ prev, matches, excluded = false }) {
  if (excluded) return { waiting: false, clearArmed: false };
  if (matches) return { waiting: true, clearArmed: false };
  return { waiting: prev === true, clearArmed: prev === true };
}

// PTY 出力を受け取った時点の評価。解除予約済みならここで入力待ちを解除する。
// 予約が無い間は出力があっても解除しない（旧来のスティッキー性を保つ）。
function nextWaitingStateOnOutput({ prev, clearArmed, excluded = false }) {
  if (excluded) return { waiting: false, clearArmed: false };
  if (prev === true && clearArmed === true) return { waiting: false, clearArmed: false };
  return { waiting: prev === true, clearArmed: clearArmed === true };
}

module.exports = {
  WAITING_PATTERNS,
  WAITING_QUIESCENCE_MS,
  WAITING_STUCK_RECHECK_MS,
  isWaitingCwdExcluded,
  matchesWaiting,
  nextWaitingStateOnOutput,
  nextWaitingStateOnQuiescence,
  normalizeWaitingExcludeCwdPatterns,
  waitingCheckDelayMs,
};
