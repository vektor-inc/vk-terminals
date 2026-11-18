'use strict';
// Codex CLI の token_count JSONL から、今日/今週のトークン数を集計する（issue #215）。
//
// usageTracker.js と同じ IO ヘルパ（listRecentFiles / readSliceComplete / formatTokens）を使い、
// sessions/**/*.jsonl を byte offset 差分読みする。state_5.sqlite は使わない。
// 対象の sessions フォルダは個人の CODEX_HOME とタスク専用 CODEX_HOME の両方（issue #638。列挙は utils/codexSessionDirs.js）。
// 同じ実体のファイルが複数の経路で見えても 1 回だけ数えるよう、ファイルは dev / ino で識別する。

const path = require('path');
const {
  listRecentFiles,
  readSliceComplete,
  formatTokens,
} = require('./usageTracker');
const { tokenCountFromTotalUsage, tokenCountPayload } = require('./codexUsage');
const { createCodexSessionDirsResolver, resolvePersonalCodexHome } = require('./utils/codexSessionDirs');

const DAY_MS = 24 * 60 * 60 * 1000;
const CODEX_WEEKLY_WINDOW_MS = 7 * DAY_MS;
const CODEX_SWR_STALE_MS = 10 * 1000;
const CODEX_CLOCK_SKEW_MS = 5 * 60 * 1000;

// 個人の CODEX_HOME の sessions だけを返す（タスク専用 CODEX_HOME を含む列挙は utils/codexSessionDirs.js）。
function defaultCodexSessionDirs() {
  return [path.join(resolvePersonalCodexHome(), 'sessions')];
}

function parseTimestamp(obj, fallbackMs = null) {
  if (!obj || typeof obj !== 'object') return Number.isFinite(fallbackMs) ? fallbackMs : null;
  const raw = typeof obj.timestamp === 'string'
    ? obj.timestamp
    : (obj.payload && typeof obj.payload.timestamp === 'string' ? obj.payload.timestamp : null);
  if (raw) {
    const ts = Date.parse(raw);
    if (Number.isFinite(ts)) return ts;
  }
  return Number.isFinite(fallbackMs) ? fallbackMs : null;
}

function parseTokenCountRecord(obj, fallbackTs = null) {
  const payload = tokenCountPayload(obj);
  if (!payload) return null;
  const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
  const tokens = tokenCountFromTotalUsage(info.total_token_usage);
  if (!Number.isFinite(tokens)) return null;
  const ts = parseTimestamp(obj, fallbackTs);
  if (!Number.isFinite(ts)) return null;
  return { ts, tokens, totalTokens: tokens };
}

function parseCodexJsonl(text, fallbackTs = null) {
  if (!text) return [];
  const out = [];
  for (const line of String(text).split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_e) {
      continue;
    }
    const entry = parseTokenCountRecord(obj, fallbackTs);
    if (entry) out.push(entry);
  }
  return out;
}

function startOfLocalDay(ms) {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function updateSessionTokenSummary(summary, entry) {
  if (!entry || !Number.isFinite(entry.ts) || !Number.isFinite(entry.tokens)) return summary;
  const tokens = Math.max(0, entry.tokens);
  if (!summary || !Number.isFinite(summary.tokens) || tokens > summary.tokens) {
    return { ts: entry.ts, tokens };
  }
  if (tokens === summary.tokens && (!Number.isFinite(summary.ts) || entry.ts > summary.ts)) {
    return { ts: entry.ts, tokens };
  }
  return summary;
}

function summarizeSessionTokenCounts(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  let summary = null;
  for (const entry of entries) {
    summary = updateSessionTokenSummary(summary, entry);
  }
  return summary;
}

/**
 * ファイルの識別キーを返す。dev / ino があれば実体で識別し（別の経路から見える同じファイルを 1 つにする）、無ければパスを使う。
 * @param {{ path: string, dev?: number, ino?: number }} f
 * @returns {string}
 */
function fileIdentityKey(f) {
  if (f && Number.isFinite(f.dev) && Number.isFinite(f.ino) && f.ino !== 0) return `inode:${f.dev}:${f.ino}`;
  return `path:${f && f.path}`;
}

/**
 * 同じ記録（timestamp と累積トークン数が同じ）のセッション集計を 1 つにする（純粋）。
 * 同じ rollout が別のファイルとして複製されている場合に二重に数えないため。
 * @param {Array<{ ts: number, tokens: number }>} summaries
 * @returns {Array<{ ts: number, tokens: number }>}
 */
function dedupeSessionSummaries(summaries) {
  if (!Array.isArray(summaries)) return [];
  const seen = new Set();
  const out = [];
  for (const s of summaries) {
    if (!s || !Number.isFinite(s.ts) || !Number.isFinite(s.tokens)) continue;
    const key = `${s.ts}:${s.tokens}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function aggregateTokenCounts(sessionSummaries, nowMs, opts = {}) {
  if (!Array.isArray(sessionSummaries) || sessionSummaries.length === 0) return null;
  const skewMs = opts.skewMs != null ? opts.skewMs : CODEX_CLOCK_SKEW_MS;
  const weeklyWindowMs = opts.weeklyWindowMs || CODEX_WEEKLY_WINDOW_MS;
  const todayStartMs = opts.todayStartMs != null ? opts.todayStartMs : startOfLocalDay(nowMs);
  const weeklyStartMs = opts.weeklyStartMs != null ? opts.weeklyStartMs : nowMs - weeklyWindowMs;
  const upper = nowMs + skewMs;
  let todayTokens = 0;
  let weeklyTokens = 0;
  let count = 0;

  for (const e of sessionSummaries) {
    if (!e || !Number.isFinite(e.ts) || !Number.isFinite(e.tokens) || e.ts > upper) continue;
    if (e.ts >= weeklyStartMs) weeklyTokens += Math.max(0, e.tokens);
    if (e.ts >= todayStartMs) todayTokens += Math.max(0, e.tokens);
    count += 1;
  }
  if (count === 0) return null;
  return {
    source: 'codex-jsonl',
    todayTokens,
    weeklyTokens,
    todayText: formatTokens(todayTokens),
    weeklyText: formatTokens(weeklyTokens),
    fetchedAtMs: nowMs,
  };
}

function createCodexUsageTracker(options = {}) {
  // getDirs は配列か、配列を返す Promise のどちらを返してもよい。
  const defaultGetDirs = createCodexSessionDirsResolver();
  const getDirs = typeof options.getDirs === 'function'
    ? options.getDirs
    : () => (Array.isArray(options.dirs) && options.dirs.length ? options.dirs : defaultGetDirs());
  const windowMs = options.windowMs || CODEX_WEEKLY_WINDOW_MS;
  const staleMs = options.staleMs != null ? options.staleMs : CODEX_SWR_STALE_MS;
  const skewMs = options.skewMs != null ? options.skewMs : CODEX_CLOCK_SKEW_MS;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;

  const fileCache = new Map();
  let lastSnapshot = null;
  let lastSnapshotAt = 0;
  let refreshing = null;

  async function refresh() {
    const now = clock();
    // 列挙の失敗・保存先が 1 つも無い場合は、集計対象なし（null）として扱う。
    let dirs;
    try {
      dirs = await getDirs();
    } catch (_e) {
      dirs = [];
    }
    if (!Array.isArray(dirs)) dirs = [];

    const files = await listRecentFiles(dirs, now, windowMs);
    const alive = new Set();
    const sessionSummaries = [];

    for (const f of files) {
      // 同じ実体のファイルが複数の経路で見えた場合は、最初の 1 つだけ読む。
      const key = fileIdentityKey(f);
      if (alive.has(key)) continue;
      alive.add(key);
      let cached = fileCache.get(key);
      if (!cached || cached.offset > f.size) {
        cached = { offset: 0, summary: null };
        fileCache.set(key, cached);
      }
      if (f.size > cached.offset) {
        try {
          const { text, consumed } = await readSliceComplete(f.path, cached.offset, f.size);
          if (text) {
            const newEntries = parseCodexJsonl(text, f.mtimeMs);
            for (const entry of newEntries) {
              cached.summary = updateSessionTokenSummary(cached.summary, entry);
            }
          }
          cached.offset = consumed;
        } catch (_e) {
          // 読み取り失敗はこのファイルだけスキップ（次回再試行）
        }
      }
      if (cached.summary) sessionSummaries.push(cached.summary);
    }

    for (const key of fileCache.keys()) {
      if (!alive.has(key)) fileCache.delete(key);
    }

    lastSnapshot = aggregateTokenCounts(dedupeSessionSummaries(sessionSummaries), now, { skewMs, weeklyWindowMs: windowMs });
    lastSnapshotAt = now;
    return lastSnapshot;
  }

  function scheduleRefresh() {
    if (refreshing) return refreshing;
    refreshing = refresh()
      .catch((_e) => { /* 失敗は無視 */ })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  function getSnapshot() {
    const now = clock();
    if (lastSnapshot !== null && now - lastSnapshotAt < staleMs) return lastSnapshot;
    scheduleRefresh();
    return lastSnapshot;
  }

  async function warmup() {
    try {
      await refresh();
    } catch (_e) {
      // warmup 失敗は無視
    }
    return lastSnapshot;
  }

  function getDescribed() {
    return getSnapshot();
  }

  return { getSnapshot, getDescribed, warmup, refresh, scheduleRefresh };
}

module.exports = {
  parseTimestamp,
  parseTokenCountRecord,
  parseCodexJsonl,
  updateSessionTokenSummary,
  summarizeSessionTokenCounts,
  startOfLocalDay,
  aggregateTokenCounts,
  fileIdentityKey,
  dedupeSessionSummaries,
  createCodexUsageTracker,
  defaultCodexSessionDirs,
  CODEX_WEEKLY_WINDOW_MS,
  CODEX_SWR_STALE_MS,
  CODEX_CLOCK_SKEW_MS,
};
