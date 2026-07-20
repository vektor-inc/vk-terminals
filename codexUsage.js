'use strict';
// Codex CLI の token_count JSONL からレートリミット使用率を取得する（issue #215）。
//
// 設計方針:
//   - oauthUsage.js と同じく、JSONL 1 行の正規化などの純粋関数コアと、
//     ~/.codex/sessions の探索・末尾読み取りの IO 層を分離する。
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
const { createTtlMemo } = require('./usageTracker');

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

function isStickyUsable(snapshot, nowMs, maxMs) {
  if (!snapshot || typeof snapshot !== 'object' || snapshot.source !== 'codex') return false;
  if (!Number.isFinite(snapshot.fetchedAtMs)) return false;
  if (!Number.isFinite(nowMs) || !Number.isFinite(maxMs)) return false;
  const elapsed = nowMs - snapshot.fetchedAtMs;
  return elapsed >= 0 && elapsed <= maxMs;
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

async function loadCodexUsageSnapshot(options = {}) {
  try {
    const baseDir = options.baseDir || CODEX_SESSIONS_DIR;
    const filePath = typeof options.findLatestSessionFile === 'function'
      ? await options.findLatestSessionFile(baseDir)
      : await findLatestSessionFile(baseDir);
    if (!filePath) return null;
    const text = typeof options.readTail === 'function'
      ? await options.readTail(filePath, LATEST_READ_BYTES)
      : await readTail(filePath, LATEST_READ_BYTES);
    return extractLastTokenCount(text, Date.now());
  } catch (_e) {
    return null;
  }
}

function createCodexUsageProvider(options = {}) {
  const ttlMs = options.ttlMs != null ? options.ttlMs : CODEX_USAGE_TTL_MS;
  const stickyMaxMs = options.stickyMaxMs != null ? options.stickyMaxMs : CODEX_STICKY_MAX_MS;
  const clock = options.clock || Date.now;
  const load = typeof options.load === 'function' ? options.load : loadCodexUsageSnapshot;
  let lastGood = null;
  const memo = createTtlMemo(() => Promise.resolve(load()).catch(() => null), ttlMs, clock);
  return {
    get: async () => {
      const fresh = await memo();
      if (fresh) {
        lastGood = fresh;
        return fresh;
      }
      if (isStickyUsable(lastGood, clock(), stickyMaxMs)) {
        return { ...lastGood, stale: true };
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
  isStickyUsable,
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
