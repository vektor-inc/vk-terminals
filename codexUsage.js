'use strict';
// Codex CLI の token_count JSONL からレートリミット使用率を取得する（issue #215）。
//
// 設計方針:
//   - oauthUsage.js と同じく、JSONL 1 行の正規化などの純粋関数コアと、
//     sessions フォルダの探索・末尾読み取りの IO 層を分離する。読み取りは utils/codexSessionFs.js 経由で、
//     読む直前に途中のリンクの有無を確かめ、ファイルはリンク非追跡で開く。
//   - 探索する sessions フォルダは、個人の CODEX_HOME とタスク専用 CODEX_HOME の両方（issue #638。
//     列挙は utils/codexSessionDirs.js）。各フォルダの更新時刻が新しい上位数件の rollout の末尾から
//     区分ごとの token_count を集め、レコードの timestamp（無ければファイルの更新時刻）が新しいものを区分ごとに採用する。
//   - 解析するのは token_count レコードだけで、会話本文・保存先のパスは返す値に含めない。
//   - 認証情報や sqlite には触れない。state_5.sqlite は native/CLI 依存が必要なため使わない。
//   - 使用率は payload.rate_limits.{primary,secondary}.used_percent を 0..100 にクランプし、
//     window_minutes で session / weekly を分類する。primary 固定の推測はしない。
//   - resets_at は epoch 秒なので 1000 倍して epoch ms にする。
//   - 失敗・欠落・壊れた JSONL は静かに null を返し、アプリ本体に影響させない。

const path = require('path');
const os = require('os');
const { normalizePercent } = require('./oauthUsage');
const { createTtlMemo, hasExpiredResetCategory } = require('./usageTracker');
const { createCodexSessionDirsResolver } = require('./utils/codexSessionDirs');
const { readdirCanonical, lstatCanonicalFile, readTailCanonical } = require('./utils/codexSessionFs');

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const LATEST_READ_BYTES = 256 * 1024;
// 1 つの sessions フォルダで末尾を読む rollout の数と、探す日フォルダの数の上限（issue #638）。
const MAX_FILES_PER_DIR = 5;
const MAX_DAY_DIRS_PER_DIR = 7;
const CODEX_USAGE_TTL_MS = 60 * 1000;
const CODEX_STICKY_MAX_MS = 15 * 60 * 1000;
const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;

// ─── 純粋関数コア ────────────────────────────────────────────────────────────

function classifyWindow(windowMinutes) {
  if (typeof windowMinutes !== 'number' || !Number.isFinite(windowMinutes) || windowMinutes <= 0) {
    return null;
  }
  return windowMinutes >= WEEKLY_WINDOW_MINUTES ? 'weekly' : 'session';
}

function parseResetAtSeconds(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return v * 1000;
}

function parseRateLimitEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const kind = classifyWindow(entry.window_minutes);
  if (!kind) return null;
  const percent = normalizePercent(entry.used_percent);
  if (percent === null) return null;
  return { kind, value: { percent, resetAtMs: parseResetAtSeconds(entry.resets_at) } };
}

function tokenCountFromTotalUsage(usage) {
  if (!usage || typeof usage !== 'object') return null;
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);
  if (typeof usage.total_tokens === 'number' && Number.isFinite(usage.total_tokens)) return n(usage.total_tokens);
  if (typeof usage.total === 'number' && Number.isFinite(usage.total)) return n(usage.total);

  let hasCodexShape = false;
  let total = 0;
  for (const key of ['input_tokens', 'output_tokens', 'reasoning_output_tokens']) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) {
      hasCodexShape = true;
      total += n(usage[key]);
    }
  }
  if (hasCodexShape) return total;

  for (const key of ['input', 'output', 'reasoning']) {
    if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) {
      hasCodexShape = true;
      total += n(usage[key]);
    }
  }
  return hasCodexShape ? total : null;
}

function tokenCountPayload(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : null;
  if (payload && payload.type === 'token_count') return payload;
  if (obj.type === 'token_count') return payload || obj;
  return null;
}

function parseTokenCountLine(line, nowMs = Date.now()) {
  if (!line) return null;
  let obj = line;
  if (typeof line === 'string') {
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      return null;
    }
  }

  const payload = tokenCountPayload(obj);
  if (!payload) return null;
  const rateLimits = payload.rate_limits && typeof payload.rate_limits === 'object' ? payload.rate_limits : {};
  let session = null;
  let weekly = null;
  for (const key of ['primary', 'secondary']) {
    const parsed = parseRateLimitEntry(rateLimits[key]);
    if (!parsed) continue;
    if (parsed.kind === 'session' && !session) session = parsed.value;
    if (parsed.kind === 'weekly' && !weekly) weekly = parsed.value;
  }
  if (!session && !weekly) return null;

  const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
  const tokens = tokenCountFromTotalUsage(info.total_token_usage);
  return {
    source: 'codex',
    session,
    weekly,
    tokens,
    fetchedAtMs: nowMs,
  };
}

/**
 * JSONL 1 行のレコードの timestamp（ISO 文字列）を epoch ms で返す。無い・壊れている場合は null。
 * @param {object} obj
 * @returns {number|null}
 */
function parseRecordTimestampMs(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const raw = typeof obj.timestamp === 'string'
    ? obj.timestamp
    : (obj.payload && typeof obj.payload.timestamp === 'string' ? obj.payload.timestamp : null);
  if (!raw) return null;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? ts : null;
}

function extractLastTokenCount(text, nowMs = Date.now()) {
  if (!text) return null;
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    const parsed = parseTokenCountLine(line, nowMs);
    if (parsed) return parsed;
  }
  return null;
}

/**
 * 複数行を末尾から読み、session / weekly / tokens ごとに最も後ろの値とそのレコードの timestamp を集める（純粋）。
 * 末尾のレコードが片方の区分しか持たない場合も、直前のレコードからもう片方を拾う。両方そろった時点で止める。
 * @param {string} text
 * @param {number} [nowMs]
 * @returns {null | { session: Cat|null, weekly: Cat|null, tokens: Cat|null }} Cat は { value, recordedAtMs: number|null }
 */
function collectLatestCategories(text, nowMs = Date.now()) {
  if (!text) return null;
  const found = { session: null, weekly: null, tokens: null };
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0 && !(found.session && found.weekly); i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    const snapshot = parseTokenCountLine(obj, nowMs);
    if (!snapshot) continue;
    const recordedAtMs = parseRecordTimestampMs(obj);
    if (!found.session && snapshot.session) found.session = { value: snapshot.session, recordedAtMs };
    if (!found.weekly && snapshot.weekly) found.weekly = { value: snapshot.weekly, recordedAtMs };
    if (!found.tokens) found.tokens = { value: snapshot.tokens, recordedAtMs };
  }
  return found.session || found.weekly ? found : null;
}

/**
 * 複数のファイル・保存先から集めた区分ごとの値のうち、session / weekly / tokens ごとに最も新しいものを選ぶ（純粋）。
 * 新しさは recordedAtMs（レコードの timestamp。無ければ呼び出し側がファイルの更新時刻を入れる）で比べ、
 * 同じ時刻なら先に渡された候補（個人の CODEX_HOME が先頭）を優先する。
 * @param {Array<null | { session: Cat|null, weekly: Cat|null, tokens: Cat|null }>} candidates collectLatestCategories の結果
 * @param {number} [nowMs]
 * @returns {null | object} parseTokenCountLine と同じ形
 */
function selectLatestRateLimits(candidates, nowMs = Date.now()) {
  if (!Array.isArray(candidates)) return null;
  const tsOf = (cat) => (Number.isFinite(cat.recordedAtMs) ? cat.recordedAtMs : -Infinity);
  const pick = (kind) => {
    let best = null;
    for (const c of candidates) {
      const cat = c && typeof c === 'object' ? c[kind] : null;
      if (!cat || typeof cat !== 'object') continue;
      if (!best || tsOf(cat) > tsOf(best)) best = cat;
    }
    return best;
  };
  const session = pick('session');
  const weekly = pick('weekly');
  if (!session && !weekly) return null;
  const tokens = pick('tokens');
  return {
    source: 'codex',
    session: session ? session.value : null,
    weekly: weekly ? weekly.value : null,
    tokens: tokens && Number.isFinite(tokens.value) ? tokens.value : null,
    fetchedAtMs: nowMs,
  };
}

function isStickyUsable(snapshot, nowMs, maxMs) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.source !== 'codex') return false;
  if (!Number.isFinite(snapshot.fetchedAtMs)) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxMs)) return false;
  const elapsed = nowMs - snapshot.fetchedAtMs;
  return elapsed >= 0 && elapsed <= maxMs;
}

// Codex は使わない限りログが更新されず、TTL 内で取り直しても同じ古い値が返り続ける
// （renderer 側で言う「未確認」表示）。session / weekly は独立に判定し、片方だけ
// resetAtMs を過ぎているケースも扱う（issue #399）。
/**
 * session / weekly のうち、resetAtMs を過ぎている区分に expired: true を付与する（純粋）。
 * resetAtMs が null（判定不能）の区分は対象外。新しい値（resetAtMs が未来）に更新された
 * 区分は expired を付けない＝通常表示に戻る。
 * @param {null | { session?: object|null, weekly?: object|null }} snapshot
 * @param {number} nowMs
 * @returns {null | object} snapshot と同じ形。session / weekly は該当すれば { ...cat, expired: true }
 */
function markExpiredCategories(snapshot, nowMs) {
  if (!snapshot || typeof snapshot !== 'object') return snapshot;
  const mark = (cat) => (
    cat && typeof cat === 'object' && Number.isFinite(cat.resetAtMs) && cat.resetAtMs <= nowMs
      ? { ...cat, expired: true }
      : cat
  );
  return { ...snapshot, session: mark(snapshot.session), weekly: mark(snapshot.weekly) };
}

// ─── IO 層 ──────────────────────────────────────────────────────────────────

function sortDesc(a, b) {
  return String(b).localeCompare(String(a), undefined, { numeric: true });
}

async function listNumberedDirs(parentDir, pattern) {
  return (await readdirCanonical(parentDir))
    .filter((ent) => ent.isDirectory() && pattern.test(ent.name))
    .map((ent) => ent.name)
    .sort(sortDesc);
}

/**
 * sessions フォルダから、更新時刻が新しい rollout ファイルを最大 maxFiles 件返す（新しい順）。
 * rollout はセッション開始日のフォルダに置かれ、長いセッションは古い日のフォルダで更新され続けるため、
 * 日付の新しい maxDays 個の日フォルダをまとめて見てから更新時刻で並べる。リンクは辿らない。
 * @param {string} baseDir 実パスの sessions フォルダ
 * @param {{ maxFiles?: number, maxDays?: number }} [opts]
 * @returns {Promise<Array<{ path: string, mtimeMs: number }>>}
 */
async function findRecentSessionFiles(baseDir = CODEX_SESSIONS_DIR, opts = {}) {
  const maxFiles = opts.maxFiles || MAX_FILES_PER_DIR;
  const maxDays = opts.maxDays || MAX_DAY_DIRS_PER_DIR;
  const files = [];
  let daysSeen = 0;
  outer:
  for (const y of await listNumberedDirs(baseDir, /^\d{4}$/)) {
    const yearDir = path.join(baseDir, y);
    for (const m of await listNumberedDirs(yearDir, /^\d{1,2}$/)) {
      const monthDir = path.join(yearDir, m);
      for (const d of await listNumberedDirs(monthDir, /^\d{1,2}$/)) {
        if (daysSeen >= maxDays) break outer;
        daysSeen += 1;
        const dayDir = path.join(monthDir, d);
        for (const ent of await readdirCanonical(dayDir)) {
          if (!ent.isFile() || !/^rollout-.*\.jsonl$/.test(ent.name)) continue;
          const full = path.join(dayDir, ent.name);
          const st = await lstatCanonicalFile(full);
          if (st) files.push({ path: full, mtimeMs: st.mtimeMs, name: ent.name });
        }
      }
    }
  }
  files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || sortDesc(a.name, b.name));
  return files.slice(0, maxFiles).map(({ path: p, mtimeMs }) => ({ path: p, mtimeMs }));
}

async function findLatestSessionFile(baseDir = CODEX_SESSIONS_DIR) {
  const files = await findRecentSessionFiles(baseDir, { maxFiles: 1 });
  return files.length ? files[0].path : null;
}

async function readTail(filePath, maxBytes = LATEST_READ_BYTES) {
  return readTailCanonical(filePath, maxBytes);
}

let defaultSessionDirsResolver = null;

function defaultGetSessionDirs() {
  if (!defaultSessionDirsResolver) defaultSessionDirsResolver = createCodexSessionDirsResolver();
  return defaultSessionDirsResolver();
}

/**
 * 1 つの sessions フォルダの、更新時刻が新しい上位数件の rollout から、区分ごとの最新値を読む。
 * timestamp の無い旧形式のレコードは、そのファイルの更新時刻で新しさを比べる。失敗したファイルは除く。
 * @returns {Promise<Array<{ session, weekly, tokens }>>} collectLatestCategories の結果の配列
 */
async function loadLatestRecordsFromDir(baseDir, nowMs) {
  const out = [];
  let files;
  try {
    files = await findRecentSessionFiles(baseDir);
  } catch (_e) {
    return out;
  }
  for (const file of files) {
    try {
      const found = collectLatestCategories(await readTail(file.path, LATEST_READ_BYTES), nowMs);
      if (!found) continue;
      for (const kind of ['session', 'weekly', 'tokens']) {
        const cat = found[kind];
        if (cat && !Number.isFinite(cat.recordedAtMs)) found[kind] = { ...cat, recordedAtMs: file.mtimeMs };
      }
      out.push(found);
    } catch (_e) {
      // 読めないファイルは除く
    }
  }
  return out;
}

/**
 * sessions フォルダを列挙し、各フォルダの最新 token_count から session / weekly の最新値を選んで返す。
 * options.baseDir があればそのフォルダだけ、options.getSessionDirs があればその結果、
 * どちらも無ければ個人とタスク専用の CODEX_HOME（utils/codexSessionDirs.js）を対象にする。
 * 1 つのフォルダの失敗（削除済み・権限エラー）は他のフォルダの結果に影響させない。
 * @returns {Promise<null | object>}
 */
async function loadCodexUsageSnapshot(options = {}) {
  try {
    let dirs;
    if (options.baseDir) {
      dirs = [options.baseDir];
    } else if (typeof options.getSessionDirs === 'function') {
      dirs = await options.getSessionDirs();
    } else {
      dirs = await defaultGetSessionDirs();
    }
    if (!Array.isArray(dirs) || dirs.length === 0) return null;
    const nowMs = Date.now();
    const perDir = await Promise.all(dirs.map((dir) => loadLatestRecordsFromDir(dir, nowMs)));
    return selectLatestRateLimits(perDir.flat(), nowMs);
  } catch (_e) {
    return null;
  }
}

/**
 * Codex usage のプロバイダ。60 秒 TTL キャッシュ（createTtlMemo 流用）でログの探索・
 * 読み取りを抑制する。main プロセスから 1 個だけ生成して使う。
 *
 * リセット時刻を過ぎた値を TTL 内で持ち続けないための bypass（issue #399）:
 *   直近成功値（lastGood）の session / weekly のいずれかの resetAtMs が現在時刻以前なら、
 *   TTL が残っていても memo を invalidate して取り直す。Codex は使わない限りログが更新
 *   されず取り直しても同じ古い値が返り続けるため、bypass の連打を防ぐ意味でも 1 回
 *   bypass したら次の bypass までは最低 ttlMs は空ける。
 *   返す値には markExpiredCategories で session / weekly ごとに expired フラグを付ける
 *   （resetAtMs が現在時刻以前の区分のみ。片方だけ期限切れのケースもある）。
 */
function createCodexUsageProvider(options = {}) {
  const ttlMs = options.ttlMs != null ? options.ttlMs : CODEX_USAGE_TTL_MS;
  const stickyMaxMs = options.stickyMaxMs != null ? options.stickyMaxMs : CODEX_STICKY_MAX_MS;
  const clock = options.clock || Date.now;
  const load = typeof options.load === 'function'
    ? options.load
    : () => loadCodexUsageSnapshot({ getSessionDirs: options.getSessionDirs });
  let lastGood = null;
  let lastBypassAt = -Infinity;
  const memo = createTtlMemo(() => Promise.resolve(load()).catch(() => null), ttlMs, clock);
  return {
    get: async () => {
      const now = clock();
      if (hasExpiredResetCategory(lastGood, now) && now - lastBypassAt >= ttlMs) {
        memo.invalidate();
        lastBypassAt = now;
      }
      const fresh = await memo();
      if (fresh) {
        lastGood = fresh;
        return markExpiredCategories(fresh, clock());
      }
      if (isStickyUsable(lastGood, clock(), stickyMaxMs)) {
        return markExpiredCategories({ ...lastGood, stale: true }, clock());
      }
      return null;
    },
  };
}

module.exports = {
  classifyWindow,
  parseResetAtSeconds,
  parseRateLimitEntry,
  tokenCountFromTotalUsage,
  tokenCountPayload,
  parseTokenCountLine,
  extractLastTokenCount,
  parseRecordTimestampMs,
  collectLatestCategories,
  selectLatestRateLimits,
  isStickyUsable,
  markExpiredCategories,
  findRecentSessionFiles,
  findLatestSessionFile,
  readTail,
  loadCodexUsageSnapshot,
  createCodexUsageProvider,
  CODEX_SESSIONS_DIR,
  LATEST_READ_BYTES,
  MAX_FILES_PER_DIR,
  MAX_DAY_DIRS_PER_DIR,
  CODEX_USAGE_TTL_MS,
  CODEX_STICKY_MAX_MS,
  WEEKLY_WINDOW_MINUTES,
};
