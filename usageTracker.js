'use strict';
// Claude のトークン使用量（5 時間レートリミットブロックの消費状況）を、
// ~/.claude/projects/**/*.jsonl のトランスクリプト（message.usage）から集計する（issue #69）。
//
// 設計方針:
//   - 純粋関数コア（トークン集計・ブロック算出・dedup・整形）と fs/IO 層を分離する。
//     純粋関数は `now` を引数で受け取り、時刻をテストで固定できるようにする（node --test 対象）。
//   - fs 層は mtime 6h 窓でファイルを絞り、byte offset 差分読みで巨大 JSONL のフルパースを
//     初回のみに抑え、stale-while-revalidate キャッシュで呼び出しを軽くする。
//   - スナップショットは `source` / `utilization` フィールドを持ち、将来 OAuth usage API へ
//     差し替えられる構造にする（今回 source は 'transcript' 固定）。
//   - 認証情報には一切触れず、失敗時は null を返してアプリ本体に影響を与えない。
//
// ブロック算出は ccusage の blocks アルゴリズム準拠:
//   - 開始 = そのブロック最初の活動タイムスタンプを UTC 正時に floor
//   - 長さ 5h
//   - 直前エントリからの gap が 5h 以上、またはブロック開始から 5h 以上経過で新ブロック

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');

const HOUR_MS = 60 * 60 * 1000;
const SESSION_DURATION_MS = 5 * HOUR_MS; // 5 時間ブロック
const CLOCK_SKEW_MS = 5 * 60 * 1000;     // 未来方向の許容（これを超える未来 ts は除外）
const RECENT_WINDOW_MS = 6 * HOUR_MS;    // mtime でファイルを絞る窓（ブロック 5h + 余裕 1h）
const SWR_STALE_MS = 10 * 1000;          // これより新しいスナップショットはそのまま返す
const MAX_READ_BYTES = 50 * 1024 * 1024; // 1 ファイル 1 回あたりの読取上限（巨大/破損 .jsonl 対策）

// UI 表示ラベル（タイトルバー・モバイルで同一語に統一する。UX レビュー UX-1）。
const PEAK_LABEL = 'ピーク比';
const PEAK_NOTE = 'これまで最も使った5hブロックとの比';

// ─── 純粋関数コア ────────────────────────────────────────────────────────────

/**
 * message.usage から「そのメッセージで消費した総トークン数」を求める。
 * ccusage と同様に input / output / cache 作成 / cache 読取 を合算する。
 * @param {object|null|undefined} usage
 * @returns {number}
 */
function tokensFromUsage(usage) {
  if (!usage || typeof usage !== 'object') return 0;
  // 破損した usage に負値が混じっても合計を過少にしないよう 0 でクランプする。
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, v) : 0);
  return (
    n(usage.input_tokens) +
    n(usage.output_tokens) +
    n(usage.cache_creation_input_tokens) +
    n(usage.cache_read_input_tokens)
  );
}

/**
 * トランスクリプト 1 レコード（JSON.parse 済みオブジェクト）から集計用エントリを取り出す。
 * message.usage を持つ assistant メッセージのみ対象。該当しなければ null。
 * @param {object} obj
 * @returns {{ ts: number, tokens: number, dedupKey: string|null }|null}
 */
function parseRecord(obj) {
  if (!obj || typeof obj !== 'object') return null;
  const msg = obj.message;
  if (!msg || typeof msg !== 'object' || !msg.usage) return null;

  const tsRaw = obj.timestamp;
  if (typeof tsRaw !== 'string') return null;
  const ts = Date.parse(tsRaw);
  if (!Number.isFinite(ts)) return null;

  const tokens = tokensFromUsage(msg.usage);

  // resume による行重複は message.id + requestId で除外する。
  // どちらか欠ける場合は dedup できないので null（＝毎回ユニーク扱い）。
  const id = typeof msg.id === 'string' ? msg.id : '';
  const requestId = typeof obj.requestId === 'string' ? obj.requestId : '';
  const dedupKey = id && requestId ? `${id}:${requestId}` : null;

  return { ts, tokens, dedupKey };
}

/**
 * JSONL テキストをパースして集計用エントリ配列にする。壊れた行はスキップする。
 * @param {string} text
 * @returns {Array<{ts:number,tokens:number,dedupKey:string|null}>}
 */
function parseJsonl(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (_e) {
      continue; // 壊れた行・書き込み途中の行は無視
    }
    const entry = parseRecord(obj);
    if (entry) out.push(entry);
  }
  return out;
}

/** タイムスタンプ（ms）を UTC 正時に切り捨てる。 */
function floorToHourUtc(ms) {
  return Math.floor(ms / HOUR_MS) * HOUR_MS;
}

/**
 * 昇順ソート・dedup 済みのエントリ配列から 5h ブロック列を構築する（ccusage 準拠）。
 * @param {Array<{ts:number,tokens:number}>} entries ts 昇順であること
 * @param {number} [sessionMs]
 * @returns {Array<{startMs:number,endMs:number,tokens:number,lastEntryMs:number,count:number}>}
 */
function buildBlocks(entries, sessionMs = SESSION_DURATION_MS) {
  const blocks = [];
  let current = null;
  for (const e of entries) {
    if (!current) {
      const startMs = floorToHourUtc(e.ts);
      current = { startMs, endMs: startMs + sessionMs, tokens: e.tokens, lastEntryMs: e.ts, count: 1 };
      blocks.push(current);
      continue;
    }
    const sinceBlockStart = e.ts - current.startMs;
    const sinceLastEntry = e.ts - current.lastEntryMs;
    if (sinceBlockStart > sessionMs || sinceLastEntry > sessionMs) {
      const startMs = floorToHourUtc(e.ts);
      current = { startMs, endMs: startMs + sessionMs, tokens: e.tokens, lastEntryMs: e.ts, count: 1 };
      blocks.push(current);
    } else {
      current.tokens += e.tokens;
      current.lastEntryMs = e.ts;
      current.count += 1;
    }
  }
  return blocks;
}

/**
 * 生エントリ配列から使用量スナップショットを作る（純粋）。
 *   - 未来（now + skew 超）の ts を除外（clock skew 対策）
 *   - ts 昇順ソート
 *   - dedupKey で重複除外（先勝ち）
 *   - 5h ブロック化 → 現在アクティブなブロックを特定
 *   - 過去最大比（全ブロック中の最大トークンに対する現ブロックの比）を utilization に入れる
 * アクティブなブロックが無い（無活動が 5h 超 / データ無し）場合は null を返す。
 *
 * @param {Array<{ts:number,tokens:number,dedupKey:string|null}>} rawEntries
 * @param {number} nowMs
 * @param {{ sessionMs?: number, skewMs?: number }} [opts]
 * @returns {null | {
 *   source: string, utilization: number|null, totalTokens: number,
 *   blockStartMs: number, resetAtMs: number, remainingMs: number,
 *   lastEntryMs: number, maxBlockTokens: number, isActive: boolean
 * }}
 */
function summarize(rawEntries, nowMs, opts = {}) {
  const sessionMs = opts.sessionMs || SESSION_DURATION_MS;
  const skewMs = opts.skewMs != null ? opts.skewMs : CLOCK_SKEW_MS;

  if (!Array.isArray(rawEntries) || rawEntries.length === 0) return null;

  const limit = nowMs + skewMs;
  const filtered = rawEntries.filter((e) => e && Number.isFinite(e.ts) && e.ts <= limit);
  if (filtered.length === 0) return null;

  filtered.sort((a, b) => a.ts - b.ts);

  const seen = new Set();
  const deduped = [];
  for (const e of filtered) {
    if (e.dedupKey) {
      if (seen.has(e.dedupKey)) continue;
      seen.add(e.dedupKey);
    }
    deduped.push(e);
  }

  const blocks = buildBlocks(deduped, sessionMs);
  if (blocks.length === 0) return null;

  const maxBlockTokens = blocks.reduce((m, b) => Math.max(m, b.tokens), 0);

  // 直近のブロックがアクティブか判定（開始 5h 以内かつ最終活動から 5h 以内）。
  const last = blocks[blocks.length - 1];
  const isActive = nowMs < last.endMs && nowMs - last.lastEntryMs < sessionMs;
  if (!isActive) return null;

  const utilization = maxBlockTokens > 0 ? last.tokens / maxBlockTokens : null;

  return {
    source: 'transcript',
    utilization,
    totalTokens: last.tokens,
    blockStartMs: last.startMs,
    resetAtMs: last.endMs,
    remainingMs: Math.max(0, last.endMs - nowMs),
    lastEntryMs: last.lastEntryMs,
    maxBlockTokens,
    isActive: true,
  };
}

// ─── 表示整形（純粋・tz 依存部は Date のローカル表現） ─────────────────────────

/** トークン数を "12.3M" / "820k" / "500" 形式に整形する。 */
function formatTokens(n) {
  if (!Number.isFinite(n) || n < 0) n = 0;
  if (n >= 1e6) {
    const s = (n / 1e6).toFixed(1).replace(/\.0$/, '');
    return `${s}M`;
  }
  if (n >= 1e3) {
    return `${Math.round(n / 1e3)}k`;
  }
  return String(Math.round(n));
}

/** 残り時間（ms）を "1h27m" / "27m" / "まもなく" 形式に整形する。 */
function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'まもなく';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h${m}m`;
  if (m > 0) return `${m}m`;
  return 'まもなく';
}

/** 比率（0..1）を n マス（既定 5）の ▰▱ バーにする。 */
function progressBar(ratio, total = 5) {
  const r = Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0;
  const filled = Math.round(r * total);
  return '▰'.repeat(filled) + '▱'.repeat(Math.max(0, total - filled));
}

/** ローカル時刻の HH:MM 文字列。 */
function formatClock(ms) {
  const d = new Date(ms);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/**
 * スナップショットを UI 表示用の文字列群に整形する（タイトルバー / モバイル共通）。
 * @param {ReturnType<typeof summarize>} snapshot
 * @param {number} nowMs
 * @returns {null | object}
 */
function describeUsage(snapshot, nowMs) {
  if (!snapshot) return null;
  const remainingMs = Math.max(0, snapshot.resetAtMs - nowMs);
  const tokensText = formatTokens(snapshot.totalTokens);
  const resetText = formatClock(snapshot.resetAtMs);
  const remainingText = formatDuration(remainingMs);
  const hasUtil = typeof snapshot.utilization === 'number' && Number.isFinite(snapshot.utilization);
  const percent = hasUtil ? Math.round(snapshot.utilization * 100) : null;
  const percentText = percent != null ? `${percent}%` : null;
  const bar = hasUtil ? progressBar(snapshot.utilization) : null;

  // 「ピーク比」ラベルは PEAK_LABEL に一元化し、タイトルバー・モバイル・バーで同一語にする（UX-1）。
  // タイトルバーは重要度順（トークン量 → ピーク比 → リセット時刻）。狭幅では末尾（リセット）から
  // 欠けるので、割合を時刻より前に置く（UX-2）。
  const peakText = percentText ? `${PEAK_LABEL}${percentText}` : null;
  const titleText = peakText
    ? `⚡ ${tokensText} tok · ${peakText} · リセット ${resetText}`
    : `⚡ ${tokensText} tok · リセット ${resetText}`;
  // モバイルは字数に余裕があるので「トークン」と明示する（任意対応）。
  const mobileText = `5hブロック: ${tokensText} トークン · リセット ${resetText}（残り${remainingText}）`;
  // バー行のラベル。utilization 無しのときは null（モバイル側で行ごと出さない）。
  const barText = peakText;

  return {
    source: snapshot.source,
    isActive: snapshot.isActive,
    utilization: snapshot.utilization,
    totalTokens: snapshot.totalTokens,
    resetAtMs: snapshot.resetAtMs,
    remainingMs,
    tokensText,
    resetText,
    remainingText,
    percentText,
    barRatio: hasUtil ? snapshot.utilization : 0,
    bar,
    titleText,
    mobileText,
    barText,
    peakLabel: PEAK_LABEL,
    peakNote: PEAK_NOTE,
  };
}

// ─── fs / IO 層（stale-while-revalidate キャッシュ付き） ──────────────────────

/** 既定の Claude projects ディレクトリ。 */
function defaultProjectsDirs() {
  return [path.join(os.homedir(), '.claude', 'projects')];
}

/**
 * dirs 配下（1〜数階層）の *.jsonl のうち、mtime が now-windowMs 以降のものを列挙する。
 * @returns {Promise<Array<{path:string,size:number,mtimeMs:number}>>}
 */
async function listRecentFiles(dirs, nowMs, windowMs) {
  const threshold = nowMs - windowMs;
  const results = [];

  async function walk(dir, depth) {
    if (depth > 4) return; // 想定外に深い階層は打ち切り（projects/<encoded>/<uuid>.jsonl 相当）
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch (_e) {
      return; // dir 欠落・権限無し等は無視
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        try {
          const st = await fsp.stat(full);
          if (st.mtimeMs >= threshold) {
            results.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
          }
        } catch (_e) {
          // stat 失敗は無視
        }
      }
    }
  }

  for (const dir of dirs) {
    await walk(dir, 0);
  }
  return results;
}

/**
 * 読み取り開始位置を「1 回あたり maxBytes まで」にクランプする（純粋・SEC-1）。
 * [start, end) が maxBytes を超える場合は末尾 maxBytes だけを読むよう start を前進させる。
 * こうすることで巨大/破損 .jsonl でも Buffer 確保量が maxBytes を超えず、かつ現在ブロックに
 * 効く最新行（末尾）を優先して取り込める。先頭が行途中になった分は JSON.parse 失敗で捨てられる。
 * @returns {number} 実際に読み始めるバイトオフセット
 */
function clampReadStart(start, end, maxBytes = MAX_READ_BYTES) {
  if (end - start > maxBytes) return end - maxBytes;
  return start;
}

/**
 * ファイルの [start, end) バイトを読み、最後の改行までの完全な行だけを返す。
 * 書き込み途中の末尾（改行未満）は捨て、consumed に「確定した末尾オフセット」を返す。
 * 1 回の読取は maxBytes までにクランプする（clampReadStart 参照）。
 * @returns {Promise<{text:string, consumed:number}>}
 */
async function readSliceComplete(filePath, start, end, maxBytes = MAX_READ_BYTES) {
  const effStart = clampReadStart(start, end, maxBytes);
  const len = end - effStart;
  if (len <= 0) return { text: '', consumed: end };
  const fh = await fsp.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, effStart);
    const chunk = buf.subarray(0, bytesRead);
    const lastNl = chunk.lastIndexOf(0x0a); // '\n'
    if (lastNl === -1) {
      return { text: '', consumed: effStart }; // 完全な行がまだ無い（読み始め位置は確定）
    }
    const consumedBytes = lastNl + 1;
    return { text: chunk.subarray(0, consumedBytes).toString('utf8'), consumed: effStart + consumedBytes };
  } finally {
    await fh.close();
  }
}

/**
 * usageTracker のインスタンス。差分読みキャッシュとスナップショットを内包する。
 * main プロセスから 1 個だけ生成して使う。
 */
function createUsageTracker(options = {}) {
  const getDirs = typeof options.getDirs === 'function'
    ? options.getDirs
    : () => (Array.isArray(options.dirs) && options.dirs.length ? options.dirs : defaultProjectsDirs());
  const sessionMs = options.sessionMs || SESSION_DURATION_MS;
  const skewMs = options.skewMs != null ? options.skewMs : CLOCK_SKEW_MS;
  const windowMs = options.windowMs || RECENT_WINDOW_MS;
  const staleMs = options.staleMs != null ? options.staleMs : SWR_STALE_MS;

  // path -> { offset: number, entries: Array }
  const fileCache = new Map();
  let lastSnapshot = null;
  let lastSnapshotAt = 0;
  let refreshing = null; // 進行中の refresh Promise（多重起動防止）

  async function refresh() {
    const now = Date.now();
    let dirs;
    try {
      dirs = getDirs();
    } catch (_e) {
      dirs = defaultProjectsDirs();
    }
    if (!Array.isArray(dirs) || dirs.length === 0) dirs = defaultProjectsDirs();

    const files = await listRecentFiles(dirs, now, windowMs);
    const alive = new Set();
    const allEntries = [];

    for (const f of files) {
      alive.add(f.path);
      let cached = fileCache.get(f.path);
      if (!cached || cached.offset > f.size) {
        // 未読 or ローテーション/切り詰め → 先頭から読み直す
        cached = { offset: 0, entries: [] };
        fileCache.set(f.path, cached);
      }
      if (f.size > cached.offset) {
        try {
          const { text, consumed } = await readSliceComplete(f.path, cached.offset, f.size);
          if (text) {
            const newEntries = parseJsonl(text);
            if (newEntries.length) cached.entries = cached.entries.concat(newEntries);
          }
          cached.offset = consumed;
        } catch (_e) {
          // 読み取り失敗はこのファイルをスキップ（次回再試行）
        }
      }
      if (cached.entries.length) allEntries.push(...cached.entries);
    }

    // 窓から外れたファイルのキャッシュは破棄（メモリ肥大防止）
    for (const key of fileCache.keys()) {
      if (!alive.has(key)) fileCache.delete(key);
    }

    lastSnapshot = summarize(allEntries, now, { sessionMs, skewMs });
    lastSnapshotAt = now;
    return lastSnapshot;
  }

  function scheduleRefresh() {
    if (refreshing) return refreshing;
    refreshing = refresh()
      .catch((_e) => { /* 失敗は無視（lastSnapshot は据え置き） */ })
      .finally(() => { refreshing = null; });
    return refreshing;
  }

  /**
   * 現在のスナップショットを返す（stale-while-revalidate）。
   * 十分に新しければ即返し、古ければバックグラウンドで再計算しつつ直近値を返す。
   */
  function getSnapshot() {
    const now = Date.now();
    if (lastSnapshot !== null && now - lastSnapshotAt < staleMs) {
      return lastSnapshot;
    }
    scheduleRefresh();
    return lastSnapshot; // 初回は null（warmup で埋める）
  }

  /** 起動時などに 1 度だけ同期的に温めるための await 可能な初期化。 */
  async function warmup() {
    try {
      await refresh();
    } catch (_e) {
      // warmup 失敗は無視
    }
    return lastSnapshot;
  }

  /** 表示用に整形したスナップショットを返す。無ければ null。 */
  function getDescribed() {
    return describeUsage(getSnapshot(), Date.now());
  }

  return { getSnapshot, getDescribed, warmup, refresh, scheduleRefresh };
}

module.exports = {
  // 純粋関数コア（テスト対象）
  tokensFromUsage,
  parseRecord,
  parseJsonl,
  floorToHourUtc,
  buildBlocks,
  summarize,
  // 整形
  formatTokens,
  formatDuration,
  progressBar,
  describeUsage,
  // fs 層
  createUsageTracker,
  listRecentFiles,
  readSliceComplete,
  clampReadStart,
  defaultProjectsDirs,
  // 定数
  SESSION_DURATION_MS,
  RECENT_WINDOW_MS,
  CLOCK_SKEW_MS,
  MAX_READ_BYTES,
  PEAK_LABEL,
  PEAK_NOTE,
};
