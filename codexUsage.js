'use strict';
// Codex CLI の token_count JSONL からレートリミット使用率を取得する（issue #215）。
//
// 設計方針:
//   - oauthUsage.js と同じく、JSONL 1 行の正規化などの純粋関数コアと、
//     sessions フォルダの探索・末尾読み取りの IO 層を分離する。
//   - 探索する sessions フォルダは、個人の CODEX_HOME とタスク専用 CODEX_HOME の両方（issue #638。
//     列挙は utils/codexSessionDirs.js）。各フォルダの最新 rollout の末尾 token_count を比べ、
//     レコードの timestamp（無ければファイルの更新時刻）が新しいものを区分ごとに採用する。
//   - 解析するのは token_count レコードだけで、会話本文・保存先のパスは返す値に含めない。
//   - 認証情報や sqlite には触れない。state_5.sqlite は native/CLI 依存が必要なため使わない。
//   - 使用率は payload.rate_limits.{primary,secondary}.used_percent を 0..100 にクランプし、
//     window_minutes で session / weekly を分類する。primary 固定の推測はしない。
//   - resets_at は epoch 秒なので 1000 倍して epoch ms にする。
//   - 失敗・欠落・壊れた JSONL は静かに null を返し、アプリ本体に影響させない。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const { normalizePercent } = require('./oauthUsage');
const { createTtlMemo, hasExpiredResetCategory } = require('./usageTracker');
const { createCodexSessionDirsResolver } = require('./utils/codexSessionDirs');

const CODEX_SESSIONS_DIR = path.join(os.homedir(), '.codex', 'sessions');
const LATEST_READ_BYTES = 256 * 1024;
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

/**
 * 複数行から最後の有効な token_count を探し、解析結果とそのレコードの timestamp を返す（純粋）。
 * @param {string} text
 * @param {number} [nowMs]
 * @returns {null | { snapshot: object, recordedAtMs: number|null }}
 */
function findLastTokenCountRecord(text, nowMs = Date.now()) {
  if (!text) return null;
  const lines = String(text).split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (_e) {
      continue;
    }
    const snapshot = parseTokenCountLine(obj, nowMs);
    if (snapshot) return { snapshot, recordedAtMs: parseRecordTimestampMs(obj) };
  }
  return null;
}

function extractLastTokenCount(text, nowMs = Date.now()) {
  const found = findLastTokenCountRecord(text, nowMs);
  return found ? found.snapshot : null;
}

/**
 * 複数の保存先から読んだ token_count のうち、session / weekly ごとに最も新しい値を選ぶ（純粋）。
 * 新しさは recordedAtMs（レコードの timestamp。無ければ呼び出し側がファイルの更新時刻を入れる）で比べる。
 * tokens は全体で最も新しい候補の値を使う。
 * @param {Array<{ snapshot: object, recordedAtMs: number|null }>} candidates
 * @param {number} [nowMs]
 * @returns {null | object} parseTokenCountLine と同じ形
 */
function selectLatestRateLimits(candidates, nowMs = Date.now()) {
  if (!Array.isArray(candidates)) return null;
  const valid = candidates.filter((c) => c && c.snapshot && typeof c.snapshot === 'object');
  if (valid.length === 0) return null;
  const tsOf = (c) => (Number.isFinite(c.recordedAtMs) ? c.recordedAtMs : -Infinity);
  // 同じ時刻なら先に渡された候補（個人の CODEX_HOME が先頭）を優先するため、安定ソートで新しい順に並べる。
  const sorted = valid.slice().sort((a, b) => tsOf(b) - tsOf(a));
  const pick = (kind) => {
    const hit = sorted.find((c) => c.snapshot[kind]);
    return hit ? hit.snapshot[kind] : null;
  };
  const session = pick('session');
  const weekly = pick('weekly');
  if (!session && !weekly) return null;
  const newest = sorted[0].snapshot;
  return {
    source: 'codex',
    session,
    weekly,
    tokens: Number.isFinite(newest.tokens) ? newest.tokens : null,
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

async function safeReaddir(dir, opts = {}) {
  try {
    return await fsp.readdir(dir, opts);
  } catch (_e) {
    return [];
  }
}

async function latestRolloutFileInDay(dayDir) {
  const entries = await safeReaddir(dayDir, { withFileTypes: true });
  const files = [];
  for (const ent of entries) {
    if (!ent.isFile() || !/^rollout-.*\.jsonl$/.test(ent.name)) continue;
    const full = path.join(dayDir, ent.name);
    try {
      const st = await fsp.stat(full);
      files.push({ path: full, mtimeMs: st.mtimeMs, name: ent.name });
    } catch (_e) {
      // stat 失敗は無視
    }
  }
  files.sort((a, b) => (b.mtimeMs - a.mtimeMs) || sortDesc(a.name, b.name));
  return files.length ? files[0].path : null;
}

async function findLatestSessionFile(baseDir = CODEX_SESSIONS_DIR) {
  const years = (await safeReaddir(baseDir, { withFileTypes: true }))
    .filter((ent) => ent.isDirectory() && /^\d{4}$/.test(ent.name))
    .map((ent) => ent.name)
    .sort(sortDesc);
  for (const y of years) {
    const yearDir = path.join(baseDir, y);
    const months = (await safeReaddir(yearDir, { withFileTypes: true }))
      .filter((ent) => ent.isDirectory() && /^\d{1,2}$/.test(ent.name))
      .map((ent) => ent.name)
      .sort(sortDesc);
    for (const m of months) {
      const monthDir = path.join(yearDir, m);
      const days = (await safeReaddir(monthDir, { withFileTypes: true }))
        .filter((ent) => ent.isDirectory() && /^\d{1,2}$/.test(ent.name))
        .map((ent) => ent.name)
        .sort(sortDesc);
      for (const d of days) {
        const latest = await latestRolloutFileInDay(path.join(monthDir, d));
        if (latest) return latest;
      }
    }
  }
  return null;
}

async function readTail(filePath, maxBytes = LATEST_READ_BYTES) {
  let st;
  try {
    st = await fsp.stat(filePath);
  } catch (_e) {
    return '';
  }
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return '';
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNl = text.indexOf('\n');
      text = firstNl >= 0 ? text.slice(firstNl + 1) : '';
    }
    return text;
  } finally {
    await fh.close();
  }
}

let defaultSessionDirsResolver = null;

function defaultGetSessionDirs() {
  if (!defaultSessionDirsResolver) defaultSessionDirsResolver = createCodexSessionDirsResolver();
  return defaultSessionDirsResolver();
}

/**
 * 1 つの sessions フォルダの最新 rollout から、最後の token_count とその新しさを読む。失敗は null。
 * @returns {Promise<null | { snapshot: object, recordedAtMs: number|null }>}
 */
async function loadLatestRecordFromDir(baseDir, options, nowMs) {
  try {
    const filePath = typeof options.findLatestSessionFile === 'function'
      ? await options.findLatestSessionFile(baseDir)
      : await findLatestSessionFile(baseDir);
    if (!filePath) return null;
    const text = typeof options.readTail === 'function'
      ? await options.readTail(filePath, LATEST_READ_BYTES)
      : await readTail(filePath, LATEST_READ_BYTES);
    const found = findLastTokenCountRecord(text, nowMs);
    if (!found) return null;
    if (Number.isFinite(found.recordedAtMs)) return found;
    // timestamp の無い旧形式のレコードは、ファイルの更新時刻で新しさを比べる。
    let mtimeMs = null;
    try {
      mtimeMs = (await fsp.stat(filePath)).mtimeMs;
    } catch (_e) {
      mtimeMs = null;
    }
    return { snapshot: found.snapshot, recordedAtMs: mtimeMs };
  } catch (_e) {
    return null;
  }
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
    const candidates = await Promise.all(dirs.map((dir) => loadLatestRecordFromDir(dir, options, nowMs)));
    return selectLatestRateLimits(candidates, nowMs);
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
  findLastTokenCountRecord,
  selectLatestRateLimits,
  isStickyUsable,
  markExpiredCategories,
  findLatestSessionFile,
  readTail,
  loadCodexUsageSnapshot,
  createCodexUsageProvider,
  CODEX_SESSIONS_DIR,
  LATEST_READ_BYTES,
  CODEX_USAGE_TTL_MS,
  CODEX_STICKY_MAX_MS,
  WEEKLY_WINDOW_MINUTES,
};
