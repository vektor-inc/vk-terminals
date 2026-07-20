'use strict';
// Codex CLI の token_count JSONL から、今日/今週のトークン数を集計する（issue #215）。
//
// usageTracker.js と同じ IO ヘルパ（listRecentFiles / readSliceComplete / formatTokens）を使い、
// ~/.codex/sessions/**/*.jsonl を byte offset 差分読みする。state_5.sqlite は使わない。

const path = require('path');
const os = require('os');
const {
  listRecentFiles,
  readSliceComplete,
  formatTokens,
} = require('./usageTracker');
const { tokenCountFromTotalUsage } = require('./codexUsage');

const DAY_MS = 24 * 60 * 60 * 1000;
const CODEX_WEEKLY_WINDOW_MS = 7 * DAY_MS;
const CODEX_SWR_STALE_MS = 10 * 1000;
const CODEX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function defaultCodexSessionDirs() {
  return [path.join(os.homedir(), '.codex', 'sessions')];
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
  if (!obj || typeof obj !== 'object' || obj.type !== 'token_count') return null;
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : {};
  const info = payload.info && typeof payload.info === 'object' ? payload.info : {};
  const tokens = tokenCountFromTotalUsage(info.total_token_usage);
  if (!Number.isFinite(tokens)) return null;
  const ts = parseTimestamp(obj, fallbackTs);
  if (!Number.isFinite(ts)) return null;
  return { ts, tokens };
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

function aggregateTokenCounts(entries, nowMs, opts = {}) {
  if (!Array.isArray(entries) || entries.length === 0) return null;
  const skewMs = opts.skewMs != null ? opts.skewMs : CODEX_CLOCK_SKEW_MS;
  const weeklyWindowMs = opts.weeklyWindowMs || CODEX_WEEKLY_WINDOW_MS;
  const todayStartMs = opts.todayStartMs != null ? opts.todayStartMs : startOfLocalDay(nowMs);
  const weeklyStartMs = opts.weeklyStartMs != null ? opts.weeklyStartMs : nowMs - weeklyWindowMs;
  const upper = nowMs + skewMs;
  let todayTokens = 0;
  let weeklyTokens = 0;
  let count = 0;

  for (const e of entries) {
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
  const getDirs = typeof options.getDirs === 'function'
    ? options.getDirs
    : () => (Array.isArray(options.dirs) && options.dirs.length ? options.dirs : defaultCodexSessionDirs());
  const windowMs = options.windowMs || CODEX_WEEKLY_WINDOW_MS;
  const staleMs = options.staleMs != null ? options.staleMs : CODEX_SWR_STALE_MS;
  const skewMs = options.skewMs != null ? options.skewMs : CODEX_CLOCK_SKEW_MS;

  const fileCache = new Map();
  let lastSnapshot = null;
  let lastSnapshotAt = 0;
  let refreshing = null;

  async function refresh() {
    const now = Date.now();
    let dirs;
    try {
      dirs = getDirs();
    } catch (_e) {
      dirs = defaultCodexSessionDirs();
    }
    if (!Array.isArray(dirs) || dirs.length === 0) dirs = defaultCodexSessionDirs();

    const files = await listRecentFiles(dirs, now, windowMs);
    const alive = new Set();
    const allEntries = [];

    for (const f of files) {
      alive.add(f.path);
      let cached = fileCache.get(f.path);
      if (!cached || cached.offset > f.size) {
        cached = { offset: 0, entries: [] };
        fileCache.set(f.path, cached);
      }
      if (f.size > cached.offset) {
        try {
          const { text, consumed } = await readSliceComplete(f.path, cached.offset, f.size);
          if (text) {
            const newEntries = parseCodexJsonl(text, f.mtimeMs);
            if (newEntries.length) cached.entries = cached.entries.concat(newEntries);
          }
          cached.offset = consumed;
        } catch (_e) {
          // 読み取り失敗はこのファイルだけスキップ（次回再試行）
        }
      }
      if (cached.entries.length) allEntries.push(...cached.entries);
    }

    for (const key of fileCache.keys()) {
      if (!alive.has(key)) fileCache.delete(key);
    }

    lastSnapshot = aggregateTokenCounts(allEntries, now, { skewMs, weeklyWindowMs: windowMs });
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
    const now = Date.now();
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
  startOfLocalDay,
  aggregateTokenCounts,
  createCodexUsageTracker,
  defaultCodexSessionDirs,
  CODEX_WEEKLY_WINDOW_MS,
  CODEX_SWR_STALE_MS,
  CODEX_CLOCK_SKEW_MS,
};
