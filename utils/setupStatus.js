'use strict';

// セットアップ状況の一覧（issue #456）の純粋関数。
//   - normalizeSetupStatus : 組み込み側の getSetupStatus が返した doctor の結果（外から来た値）を
//                            検証し、項目数・文字数を切り詰めて、画面へ渡してよい形にする。
//   - buildSetupViewModel  : 正規化済みの結果を、パネルが描く並び（自分で入れるもの → セットアップで
//                            設定するもの、必須 → 任意、未充足 → 充足済み）に組み替える。
//   - SETUP_TEXT           : 画面に出す文言（植草案）。
//
// Node（main.js・ユニットテスト）とブラウザ（index.html の <script>）の両方から使える UMD 形式。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSetupStatus = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

// 切り詰めの上限。doctor の結果は外から来た値として扱い、描画前にここで頭打ちにする。
const LIMITS = Object.freeze({
  requirements: 50,
  commandsPerRequirement: 3,
  id: 64,
  group: 40,
  label: 80,
  current: 200,
  hint: 600,
  command: 400,
  os: 24,
});

// 導入コマンド欄（commands: [{ command, os }]）・理由欄（reason）は vk-orchestrator#646 で足される。
// 無い間は説明文（hint）だけを出し、hint からコマンドを抜き出すことはしない。
const KNOWN_REASONS = Object.freeze(['not-installed', 'not-on-path', 'not-authenticated']);

// 画面に出す文言。理由の文言は reason 欄があるときだけ使う。
const SETUP_TEXT = Object.freeze({
  heading: 'VK Orchestrator のセットアップ',
  leadRemaining: (n) => `あと ${n} 件で使えるようになります。上から順に進めてください。`,
  leadComplete: 'セットアップが完了しました',
  leadCompleteDetail: 'すべての必須項目がそろいました。',
  guideOnSetupPane: 'Claude Code が「このフォルダを信頼しますか」と聞いてきたら、Enter で進めてください。',
  startButton: 'セットアップを始める',
  showPaneButton: 'セットアップ用のペインを表示',
  startNeedsClaude: '先に Claude Code を入れてください',
  recheckButton: 'もう一度確認',
  checkingButton: '確認しています…',
  lastChecked: (hhmm) => `最終確認 ${hhmm}`,
  foldButton: '閉じる',
  copyButton: 'コピー',
  copiedButton: 'コピーしました',
  copyFailed: 'コピーできませんでした',
  groupExternal: '自分で入れるもの',
  groupSetup: 'セットアップで設定するもの',
  requiredHeading: (n) => `必須（残り ${n} 件）`,
  requiredHeadingDone: '必須（すべてそろっています）',
  optionalHeading: (n) => `任意（未設定 ${n} 件）`,
  firstStep: 'まずここから',
  setupItemHint: '「セットアップを始める」で設定します。',
  setupItemDetail: '詳しく',
  satisfiedCount: (n) => `そろっている項目 ${n} 件`,
  stateNotInstalled: '入っていません',
  stateNotOnPath: '入っていますが、見つかりません',
  stateNotAuthenticated: 'まだ認証していません',
  notOnPathNote: 'アプリを終了して開き直してください。それでも同じなら、入れた場所を確かめてください。',
  unavailableHeading: 'セットアップ状況を確認できませんでした',
  unavailableTimeout: (seconds) => `確認に ${seconds} 秒以上かかったため、途中で止めました。`,
  unavailableError: '確認用のプログラムを起動できませんでした。',
  unavailableInvalid: '確認結果を読み取れませんでした。',
  copyDetail: '詳細をコピー',
  bandIncomplete: (n) => `セットアップ未完了（残り ${n} 件）`,
  bandUnavailable: 'セットアップ状況を確認できませんでした',
  bandComplete: 'セットアップが完了しました',
  bandOpen: '一覧を開く',
  sidebarStopped: 'セットアップ未完了のため停止中',
  sidebarLink: 'セットアップ状況を見る',
});

function sanitizeText(value, max) {
  if (typeof value !== 'string') return null;
  // 制御文字（改行・タブ・ANSI の ESC を含む）は空白 1 つにまとめる。
  const flat = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  if (!flat) return '';
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// 導入コマンドは「コピーして貼る」ための文字列。切り詰めると別のコマンドになってしまうため、
// 長すぎるもの・複数行のもの・文字列でないものは欄ごと捨てる（説明文だけを出す側へ倒す）。
function sanitizeCommands(rawCommands) {
  if (!Array.isArray(rawCommands)) return [];
  const commands = [];
  for (const entry of rawCommands) {
    if (commands.length >= LIMITS.commandsPerRequirement) break;
    if (!entry || typeof entry !== 'object') continue;
    const command = entry.command;
    if (typeof command !== 'string') continue;
    const trimmed = command.trim();
    if (!trimmed || trimmed.length > LIMITS.command) continue;
    if (/[\u0000-\u001f\u007f]/.test(trimmed)) continue;
    const os = sanitizeText(entry.os, LIMITS.os);
    commands.push({ command: trimmed, os: os || '' });
  }
  return commands;
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/**
 * 組み込み側が返した doctor の結果を、画面へ渡してよい形に正規化する。
 * 形が不正なもの（配列でない・必須の項目が欠けている・summary と食い違う）は
 * { ok: false } を返す。呼び出し側はこれを「セットアップ済み」ではなく「確認できませんでした」として扱う。
 *
 * @param {*} raw getSetupStatus の戻り値（外から来た値）
 * @returns {{ ok: true, status: { requirements: object[], summary: { allRequiredOk: boolean, total: number|null, requiredCount: number|null, requiredOkCount: number|null } } } | { ok: false }}
 */
function normalizeSetupStatus(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false };
  if (!Array.isArray(raw.requirements)) return { ok: false };
  const rawSummary = raw.summary;
  if (!rawSummary || typeof rawSummary !== 'object' || typeof rawSummary.allRequiredOk !== 'boolean') {
    return { ok: false };
  }

  const truncated = raw.requirements.length > LIMITS.requirements;
  const requirements = [];
  for (const item of raw.requirements.slice(0, LIMITS.requirements)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { ok: false };
    const id = sanitizeText(item.id, LIMITS.id);
    const label = sanitizeText(item.label, LIMITS.label);
    if (!id || !label || typeof item.ok !== 'boolean') return { ok: false };
    const reason = KNOWN_REASONS.includes(item.reason) ? item.reason : null;
    requirements.push({
      id,
      label,
      group: sanitizeText(item.group, LIMITS.group) || '',
      required: item.required === true,
      ok: item.ok,
      current: sanitizeText(item.current, LIMITS.current) || '',
      hint: sanitizeText(item.hint, LIMITS.hint) || '',
      // 'external' 以外（A / B / C / manifest など）はすべて「セットアップで設定するもの」に寄せる。
      target: item.target === 'external' ? 'external' : 'setup',
      commands: sanitizeCommands(item.commands),
      reason,
    });
  }

  // summary と項目の食い違いは、どちらが正しいか決められないので確認できなかった扱いにする
  // （項目を切り詰めたときは件数が合わないため、この照合はしない）。
  if (!truncated) {
    const hasMissingRequired = requirements.some((r) => r.required && !r.ok);
    if (rawSummary.allRequiredOk === true && hasMissingRequired) return { ok: false };
    if (rawSummary.allRequiredOk === false && !hasMissingRequired) return { ok: false };
  }

  return {
    ok: true,
    status: {
      requirements,
      summary: {
        allRequiredOk: rawSummary.allRequiredOk,
        total: nonNegativeInteger(rawSummary.total),
        requiredCount: nonNegativeInteger(rawSummary.requiredCount),
        requiredOkCount: nonNegativeInteger(rawSummary.requiredOkCount),
      },
    },
  };
}

function stateTextForReason(reason) {
  if (reason === 'not-installed') return SETUP_TEXT.stateNotInstalled;
  if (reason === 'not-on-path') return SETUP_TEXT.stateNotOnPath;
  if (reason === 'not-authenticated') return SETUP_TEXT.stateNotAuthenticated;
  return '';
}

function buildRowView(row, { isFirstStep }) {
  const isExternal = row.target === 'external';
  return {
    id: row.id,
    label: row.label,
    required: row.required,
    ok: row.ok,
    current: row.current,
    commands: row.commands,
    // reason 欄が無いときは状態の文言を出さない（hint から推測しない）。
    stateText: stateTextForReason(row.reason),
    showNotOnPathNote: row.reason === 'not-on-path',
    // 「自分で入れるもの」は hint をそのまま出す。「セットアップで設定するもの」は設定ファイルの
    // 書き換え方などが書かれているため、既定では固定の案内にして、元の文は「詳しく」に畳む。
    hint: isExternal ? row.hint : '',
    useSetupHint: !isExternal && !row.ok,
    detailHint: isExternal ? '' : row.hint,
    isFirstStep,
  };
}

function buildGroupView(key, title, rows, claudeFirst) {
  const split = (required) => {
    const subset = rows.filter((r) => r.required === required);
    const pending = subset.filter((r) => !r.ok);
    const satisfied = subset.filter((r) => r.ok);
    return { pending, satisfied };
  };
  const toViews = (list) => list.map((r) => buildRowView(r, {
    isFirstStep: claudeFirst && r.id === 'claude' && !r.ok,
  }));
  const required = split(true);
  const optional = split(false);
  // Claude Code の行は、未充足なら必須の先頭へ置く（「まずここから」）。
  const requiredPending = [...required.pending].sort((a, b) => {
    const aFirst = claudeFirst && a.id === 'claude' ? 0 : 1;
    const bFirst = claudeFirst && b.id === 'claude' ? 0 : 1;
    return aFirst - bFirst;
  });
  return {
    key,
    title,
    required: { pending: toViews(requiredPending), satisfied: toViews(required.satisfied) },
    optional: { pending: toViews(optional.pending), satisfied: toViews(optional.satisfied) },
    isEmpty: rows.length === 0,
  };
}

/**
 * 正規化済みの結果から、パネルが描く並びを作る。
 * @param {{ requirements: object[], summary: { allRequiredOk: boolean } }} status normalizeSetupStatus が返した status
 */
function buildSetupViewModel(status) {
  const rows = status.requirements;
  const claudeRow = rows.find((r) => r.id === 'claude') || null;
  const remaining = rows.filter((r) => r.required && !r.ok).length;
  const external = rows.filter((r) => r.target === 'external');
  const setup = rows.filter((r) => r.target !== 'external');
  return {
    allRequiredOk: status.summary.allRequiredOk,
    remaining,
    claudeOk: !!(claudeRow && claudeRow.ok),
    groups: [
      buildGroupView('external', SETUP_TEXT.groupExternal, external, true),
      buildGroupView('setup', SETUP_TEXT.groupSetup, setup, false),
    ].filter((g) => !g.isEmpty),
  };
}

/** 「HH:MM」（ローカル時刻）。 */
function formatCheckedTime(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 確認できなかった理由の文言。 */
function unavailableReasonText(result) {
  if (result && result.reason === 'timeout') {
    return SETUP_TEXT.unavailableTimeout(Number.isFinite(result.timeoutSeconds) ? result.timeoutSeconds : 20);
  }
  if (result && result.reason === 'invalid') return SETUP_TEXT.unavailableInvalid;
  return SETUP_TEXT.unavailableError;
}

return {
  LIMITS,
  KNOWN_REASONS,
  SETUP_TEXT,
  normalizeSetupStatus,
  buildSetupViewModel,
  formatCheckedTime,
  unavailableReasonText,
};
});
