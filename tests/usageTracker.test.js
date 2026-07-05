'use strict';
// usageTracker（issue #69）の純粋関数コアのテスト。
// トランスクリプト（~/.claude/projects/**/*.jsonl）の message.usage を集計して
// 5h ブロックの消費状況を求める部分を、fixture JSONL / エントリで固定時刻検証する。
// fs/IO 層（差分読み・SWR キャッシュ）は副作用を持つためここでは扱わない。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  tokensFromUsage,
  parseRecord,
  parseJsonl,
  floorToHourUtc,
  buildBlocks,
  summarize,
  formatTokens,
  formatDuration,
  progressBar,
  describeUsage,
  clampReadStart,
  readSliceComplete,
  SESSION_DURATION_MS,
} = require('../usageTracker');

const HOUR = 60 * 60 * 1000;

// ── tokensFromUsage ──────────────────────────────────────────────────────────
test('tokensFromUsage: input/output/cache 作成/cache 読取 を合算する', () => {
  const usage = {
    input_tokens: 100,
    output_tokens: 50,
    cache_creation_input_tokens: 200,
    cache_read_input_tokens: 300,
  };
  assert.equal(tokensFromUsage(usage), 650);
});

test('tokensFromUsage: 欠損フィールドは 0 扱い / 非オブジェクトは 0', () => {
  assert.equal(tokensFromUsage({ input_tokens: 10 }), 10);
  assert.equal(tokensFromUsage({}), 0);
  assert.equal(tokensFromUsage(null), 0);
  assert.equal(tokensFromUsage(undefined), 0);
  assert.equal(tokensFromUsage('x'), 0);
});

test('tokensFromUsage: 負値は 0 にクランプする（破損 usage 対策・SEC-2）', () => {
  assert.equal(tokensFromUsage({ input_tokens: -100, output_tokens: 50 }), 50);
  assert.equal(tokensFromUsage({ input_tokens: -5, cache_read_input_tokens: -5 }), 0);
});

// ── parseRecord ──────────────────────────────────────────────────────────────
test('parseRecord: assistant+usage 行から ts/tokens/dedupKey を取り出す', () => {
  const obj = {
    timestamp: '2026-07-06T05:00:00.000Z',
    requestId: 'req_1',
    message: { id: 'msg_1', role: 'assistant', usage: { input_tokens: 10, output_tokens: 5 } },
  };
  const e = parseRecord(obj);
  assert.equal(e.ts, Date.parse('2026-07-06T05:00:00.000Z'));
  assert.equal(e.tokens, 15);
  assert.equal(e.dedupKey, 'msg_1:req_1');
});

test('parseRecord: usage 無し・timestamp 無し・不正時刻は null', () => {
  assert.equal(parseRecord({ timestamp: '2026-07-06T05:00:00Z', message: { role: 'user' } }), null);
  assert.equal(parseRecord({ message: { usage: { input_tokens: 1 } } }), null);
  assert.equal(parseRecord({ timestamp: 'not-a-date', message: { usage: {} } }), null);
  assert.equal(parseRecord(null), null);
});

test('parseRecord: message.id か requestId が欠けると dedupKey は null', () => {
  const base = { timestamp: '2026-07-06T05:00:00.000Z', message: { usage: { input_tokens: 1 } } };
  assert.equal(parseRecord({ ...base, requestId: 'req_1' }).dedupKey, null); // id 無し
  assert.equal(parseRecord({ ...base, message: { id: 'msg_1', usage: { input_tokens: 1 } } }).dedupKey, null); // requestId 無し
});

// ── parseJsonl ───────────────────────────────────────────────────────────────
test('parseJsonl: 壊れた行・空行はスキップし有効行だけ返す', () => {
  const text = [
    '{"timestamp":"2026-07-06T05:00:00.000Z","requestId":"r1","message":{"id":"m1","usage":{"input_tokens":10}}}',
    '',
    'これは壊れたJSON行',
    '{"timestamp":"2026-07-06T05:01:00.000Z","message":{"role":"user"}}',
    '{"timestamp":"2026-07-06T05:02:00.000Z","requestId":"r2","message":{"id":"m2","usage":{"output_tokens":20}}}',
  ].join('\n');
  const entries = parseJsonl(text);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].tokens, 10);
  assert.equal(entries[1].tokens, 20);
});

// ── floorToHourUtc ───────────────────────────────────────────────────────────
test('floorToHourUtc: UTC 正時に切り捨てる', () => {
  const ms = Date.parse('2026-07-06T05:39:38.924Z');
  assert.equal(floorToHourUtc(ms), Date.parse('2026-07-06T05:00:00.000Z'));
});

// ── buildBlocks ──────────────────────────────────────────────────────────────
test('buildBlocks: 5h 以内の連続活動は 1 ブロックに集約（開始は正時 floor）', () => {
  const t0 = Date.parse('2026-07-06T05:30:00.000Z');
  const entries = [
    { ts: t0, tokens: 100 },
    { ts: t0 + HOUR, tokens: 200 },
    { ts: t0 + 2 * HOUR, tokens: 300 },
  ];
  const blocks = buildBlocks(entries);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].startMs, Date.parse('2026-07-06T05:00:00.000Z'));
  assert.equal(blocks[0].endMs, Date.parse('2026-07-06T05:00:00.000Z') + SESSION_DURATION_MS);
  assert.equal(blocks[0].tokens, 600);
  assert.equal(blocks[0].count, 3);
});

test('buildBlocks: 5h 超の gap で新しいブロックに分かれる', () => {
  const t0 = Date.parse('2026-07-06T00:00:00.000Z');
  const entries = [
    { ts: t0, tokens: 100 },
    { ts: t0 + 6 * HOUR, tokens: 200 }, // gap 6h > 5h → 新ブロック
  ];
  const blocks = buildBlocks(entries);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].tokens, 100);
  assert.equal(blocks[1].tokens, 200);
});

test('buildBlocks: ブロック開始から 5h 超のエントリは gap が無くても新ブロック', () => {
  const start = Date.parse('2026-07-06T00:00:00.000Z');
  const entries = [
    { ts: start + 10 * 60 * 1000, tokens: 100 }, // 00:10（開始 floor は 00:00）
    { ts: start + 3 * HOUR, tokens: 100 },        // 同ブロック
    { ts: start + 5 * HOUR + 30 * 60 * 1000, tokens: 100 }, // 開始から 5.5h → 新ブロック
  ];
  const blocks = buildBlocks(entries);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].count, 2);
  assert.equal(blocks[1].count, 1);
});

// ── summarize ────────────────────────────────────────────────────────────────
test('summarize: アクティブブロックのトークン・リセット時刻・過去最大比を返す', () => {
  const blockStart = Date.parse('2026-07-06T05:00:00.000Z');
  // 過去ブロック（最大 1000）＋ 現ブロック（合計 430）
  const past = Date.parse('2026-07-05T00:00:00.000Z');
  const entries = [
    { ts: past, tokens: 1000, dedupKey: 'a 1' },
    { ts: blockStart + 5 * 60 * 1000, tokens: 200, dedupKey: 'b 1' },
    { ts: blockStart + 30 * 60 * 1000, tokens: 230, dedupKey: 'c 1' },
  ];
  const now = blockStart + 60 * 60 * 1000; // 開始から 1h 後
  const snap = summarize(entries, now);
  assert.equal(snap.source, 'transcript');
  assert.equal(snap.totalTokens, 430);
  assert.equal(snap.maxBlockTokens, 1000);
  assert.equal(snap.resetAtMs, blockStart + SESSION_DURATION_MS);
  assert.equal(snap.remainingMs, snap.resetAtMs - now);
  assert.ok(Math.abs(snap.utilization - 0.43) < 1e-9);
  assert.equal(snap.isActive, true);
});

test('summarize: 重複エントリ（同一 message.id+requestId）は集計されない', () => {
  const t = Date.parse('2026-07-06T05:00:00.000Z');
  const entries = [
    { ts: t, tokens: 100, dedupKey: 'dup 1' },
    { ts: t + 1000, tokens: 100, dedupKey: 'dup 1' }, // 重複 → 無視
    { ts: t + 2000, tokens: 50, dedupKey: 'uniq 1' },
  ];
  const snap = summarize(entries, t + 3000);
  assert.equal(snap.totalTokens, 150);
});

test('summarize: dedupKey が null のエントリは重複除外されない', () => {
  const t = Date.parse('2026-07-06T05:00:00.000Z');
  const entries = [
    { ts: t, tokens: 100, dedupKey: null },
    { ts: t + 1000, tokens: 100, dedupKey: null },
  ];
  const snap = summarize(entries, t + 2000);
  assert.equal(snap.totalTokens, 200);
});

test('summarize: 未来（now+skew 超）のタイムスタンプは除外する', () => {
  const now = Date.parse('2026-07-06T05:00:00.000Z');
  const entries = [
    { ts: now - 60 * 1000, tokens: 100, dedupKey: 'a 1' },
    { ts: now + 60 * 60 * 1000, tokens: 999, dedupKey: 'future 1' }, // 1h 未来 → 除外
  ];
  const snap = summarize(entries, now);
  assert.equal(snap.totalTokens, 100);
});

test('summarize: 最終活動から 5h 超（非アクティブ）なら null', () => {
  const t = Date.parse('2026-07-06T00:00:00.000Z');
  const entries = [{ ts: t, tokens: 100, dedupKey: 'a 1' }];
  const now = t + 6 * HOUR; // 最終活動から 6h → もう current block ではない
  assert.equal(summarize(entries, now), null);
});

test('summarize: 空配列・全除外は null', () => {
  assert.equal(summarize([], Date.now()), null);
  const now = Date.parse('2026-07-06T05:00:00.000Z');
  assert.equal(summarize([{ ts: now + 10 * HOUR, tokens: 10, dedupKey: null }], now), null);
});

// ── 整形ヘルパ ───────────────────────────────────────────────────────────────
test('formatTokens: M / k / 素の数値', () => {
  assert.equal(formatTokens(12_300_000), '12.3M');
  assert.equal(formatTokens(2_000_000), '2M');
  assert.equal(formatTokens(820_000), '820k');
  assert.equal(formatTokens(500), '500');
  assert.equal(formatTokens(0), '0');
});

test('formatDuration: 時分 / 分のみ / まもなく', () => {
  assert.equal(formatDuration(87 * 60 * 1000), '1h27m');
  assert.equal(formatDuration(27 * 60 * 1000), '27m');
  assert.equal(formatDuration(0), 'まもなく');
  assert.equal(formatDuration(-100), 'まもなく');
});

test('progressBar: 比率を 5 マスの ▰▱ にする', () => {
  assert.equal(progressBar(0), '▱▱▱▱▱');
  assert.equal(progressBar(0.43), '▰▰▱▱▱'); // round(2.15)=2
  assert.equal(progressBar(1), '▰▰▰▰▰');
  assert.equal(progressBar(2), '▰▰▰▰▰'); // クランプ
});

// ── describeUsage ────────────────────────────────────────────────────────────
test('describeUsage: null スナップショットは null', () => {
  assert.equal(describeUsage(null, Date.now()), null);
});

test('describeUsage: タイトル / モバイル / バー文字列を組み立てる', () => {
  const now = Date.parse('2026-07-06T05:00:00.000Z');
  const snap = {
    source: 'transcript',
    utilization: 0.43,
    totalTokens: 12_300_000,
    resetAtMs: now + 87 * 60 * 1000,
    remainingMs: 87 * 60 * 1000,
    isActive: true,
  };
  const d = describeUsage(snap, now);
  assert.equal(d.tokensText, '12.3M');
  assert.equal(d.remainingText, '1h27m');
  assert.equal(d.percentText, '43%');
  assert.equal(d.bar, '▰▰▱▱▱');
  // ラベルはタイトル・モバイル・バーで「ピーク比」に統一（UX-1）。
  assert.ok(d.titleText.includes('12.3M tok'));
  assert.ok(d.titleText.includes('ピーク比43%'));
  assert.equal(d.barText, 'ピーク比43%');
  assert.ok(!d.titleText.includes('目安'));
  assert.ok(!d.barText.includes('過去最大比'));
  // タイトルは重要度順（トークン量 → ピーク比 → リセット時刻）。ピーク比がリセットより前（UX-2）。
  assert.ok(d.titleText.indexOf('ピーク比') < d.titleText.indexOf('リセット'));
  // モバイルは「トークン」明示・残り時間つき。
  assert.ok(d.mobileText.includes('12.3M トークン'));
  assert.ok(d.mobileText.includes('残り1h27m'));
});

test('describeUsage: utilization が null なら ピーク比・バーを伏せる', () => {
  const now = Date.parse('2026-07-06T05:00:00.000Z');
  const snap = { source: 'transcript', utilization: null, totalTokens: 1000, resetAtMs: now + HOUR, isActive: true };
  const d = describeUsage(snap, now);
  assert.equal(d.percentText, null);
  assert.equal(d.barText, null);
  assert.equal(d.bar, null);
  assert.ok(!d.titleText.includes('ピーク比'));
  // リセット時刻は残る（トークン量とリセットのみ）。
  assert.ok(d.titleText.includes('リセット'));
});

// ── clampReadStart（SEC-1: 1 回の読取上限） ──────────────────────────────────
test('clampReadStart: 上限内はそのまま / 超過なら末尾 maxBytes に切り詰める', () => {
  assert.equal(clampReadStart(0, 100, 1000), 0);        // 上限内
  assert.equal(clampReadStart(0, 5000, 1000), 4000);    // 末尾 1000 のみ → start=end-max
  assert.equal(clampReadStart(200, 1200, 1000), 200);   // ちょうど上限
  assert.equal(clampReadStart(200, 1300, 1000), 300);   // 超過 → 前進
});

// ── readSliceComplete（fs: 差分読み・改行境界・上限） ──────────────────────────
test('readSliceComplete: 完全な行だけ返し consumed が改行直後を指す', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkt-usage-'));
  const file = path.join(dir, 'a.jsonl');
  try {
    // 2 行完結 + 改行未満の書き込み途中行
    const content = 'line1\nline2\npartial';
    fs.writeFileSync(file, content);
    const size = fs.statSync(file).size;
    const { text, consumed } = await readSliceComplete(file, 0, size);
    assert.equal(text, 'line1\nline2\n');            // partial は含まない
    assert.equal(consumed, Buffer.byteLength('line1\nline2\n')); // 改行直後
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readSliceComplete: maxBytes 超過時は末尾のみ読む（Buffer 確保を上限内に抑える）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkt-usage-'));
  const file = path.join(dir, 'big.jsonl');
  try {
    // "AAAA\n" を多数 + 末尾に "TAIL\n"。maxBytes を小さくして末尾だけ拾えることを確認。
    const body = 'AAAA\n'.repeat(100) + 'TAIL\n';
    fs.writeFileSync(file, body);
    const size = fs.statSync(file).size;
    const { text, consumed } = await readSliceComplete(file, 0, size, 12); // 末尾 12 バイトのみ
    // 読取は maxBytes 以内に収まり（＝Buffer 確保も上限内）、末尾の完全行は取れる。
    assert.ok(Buffer.byteLength(text) <= 12);
    assert.ok(text.includes('TAIL'));
    assert.equal(consumed, size); // 末尾まで消費（改行で終わっているため）
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
