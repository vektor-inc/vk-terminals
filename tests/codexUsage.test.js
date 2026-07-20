'use strict';
// Codex 使用量（issue #215）の純粋関数コアを固定時刻・ダミー JSONL で検証する。
// ~/.codex の実データには触れず、provider は load 注入で TTL/sticky を確認する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  classifyWindow,
  parseTokenCountLine,
  extractLastTokenCount,
  isStickyUsable,
  createCodexUsageProvider,
} = require('../codexUsage');
const {
  parseTokenCountRecord,
  parseCodexJsonl,
  aggregateTokenCounts,
} = require('../codexUsageTracker');

const NOW = Date.parse('2026-07-06T03:00:00.000Z');

function tokenCountLine({ primary, secondary, total = 1234, timestamp = '2026-07-06T02:00:00.000Z' } = {}) {
  return JSON.stringify({
    type: 'token_count',
    timestamp,
    payload: {
      rate_limits: { primary, secondary },
      info: {
        total_token_usage: {
          input: 100,
          cached: 200,
          output: 300,
          reasoning: 400,
          total,
        },
      },
    },
  });
}

test('classifyWindow: 300分は session、10080分以上は weekly として分類する', () => {
  assert.equal(classifyWindow(300), 'session');
  assert.equal(classifyWindow(10079), 'session');
  assert.equal(classifyWindow(10080), 'weekly');
  assert.equal(classifyWindow(10081), 'weekly');
  assert.equal(classifyWindow(0), null);
  assert.equal(classifyWindow('300'), null);
});

test('parseTokenCountLine: used_percent をクランプし resets_at 秒を ms に変換する', () => {
  const r = parseTokenCountLine(tokenCountLine({
    primary: { used_percent: 61.5, window_minutes: 300, resets_at: 1783306800 },
    secondary: { used_percent: 250, window_minutes: 10080, resets_at: 1783900000 },
  }), NOW);

  assert.equal(r.source, 'codex');
  assert.equal(r.session.percent, 61.5);
  assert.equal(r.session.resetAtMs, 1783306800 * 1000);
  assert.equal(r.weekly.percent, 100);
  assert.equal(r.weekly.resetAtMs, 1783900000 * 1000);
  assert.equal(r.tokens, 1234);
  assert.equal(r.fetchedAtMs, NOW);
});

test('parseTokenCountLine: primary のみでも window_minutes に従って分類する', () => {
  const sessionOnly = parseTokenCountLine(tokenCountLine({
    primary: { used_percent: 12, window_minutes: 300, resets_at: 1783306800 },
  }), NOW);
  assert.equal(sessionOnly.session.percent, 12);
  assert.equal(sessionOnly.weekly, null);

  const weeklyOnly = parseTokenCountLine(tokenCountLine({
    primary: { used_percent: 44, window_minutes: 10080, resets_at: 1783900000 },
  }), NOW);
  assert.equal(weeklyOnly.session, null);
  assert.equal(weeklyOnly.weekly.percent, 44);
});

test('parseTokenCountLine: primary/secondary 欠落・壊れ行・token_count 以外は null', () => {
  assert.equal(parseTokenCountLine('not-json', NOW), null);
  assert.equal(parseTokenCountLine(JSON.stringify({ type: 'event' }), NOW), null);
  assert.equal(parseTokenCountLine(JSON.stringify({ type: 'token_count', payload: { rate_limits: {} } }), NOW), null);
  assert.equal(parseTokenCountLine(tokenCountLine({
    primary: { used_percent: '61', window_minutes: 300, resets_at: 1783306800 },
  }), NOW), null);
});

test('extractLastTokenCount: 複数行から最後の有効な token_count を返し壊れ行をスキップする', () => {
  const text = [
    tokenCountLine({ primary: { used_percent: 10, window_minutes: 300, resets_at: 1783306800 }, total: 111 }),
    '{"type":"token_count",',
    JSON.stringify({ type: 'message', payload: {} }),
    tokenCountLine({ primary: { used_percent: 22, window_minutes: 300, resets_at: 1783310000 }, total: 222 }),
    '',
  ].join('\n');
  const r = extractLastTokenCount(text, NOW);
  assert.equal(r.session.percent, 22);
  assert.equal(r.tokens, 222);
});

test('isStickyUsable: codex スナップショットが sticky 期限内なら true', () => {
  const snapshot = { source: 'codex', session: { percent: 12, resetAtMs: null }, weekly: null, fetchedAtMs: NOW };
  assert.equal(isStickyUsable(snapshot, NOW + 1000, 5000), true);
  assert.equal(isStickyUsable(snapshot, NOW + 5001, 5000), false);
  assert.equal(isStickyUsable({ ...snapshot, source: 'oauth' }, NOW + 1000, 5000), false);
  assert.equal(isStickyUsable(null, NOW, 5000), false);
});

test('createCodexUsageProvider: TTL 内は load を共有し、TTL 超過で再取得する', async () => {
  let now = NOW;
  let calls = 0;
  const provider = createCodexUsageProvider({
    ttlMs: 60000,
    clock: () => now,
    load: async () => {
      calls += 1;
      return { source: 'codex', session: { percent: calls, resetAtMs: null }, weekly: null, fetchedAtMs: now };
    },
  });

  const a = await provider.get();
  const b = await provider.get();
  assert.equal(calls, 1);
  assert.equal(a.session.percent, 1);
  assert.equal(b.session.percent, 1);

  now += 60001;
  const c = await provider.get();
  assert.equal(calls, 2);
  assert.equal(c.session.percent, 2);
});

test('createCodexUsageProvider: 一時失敗時は stickyMaxMs 以内だけ直近成功値を stale として返す', async () => {
  let now = NOW;
  let calls = 0;
  const first = { source: 'codex', session: { percent: 25, resetAtMs: null }, weekly: null, fetchedAtMs: NOW };
  const provider = createCodexUsageProvider({
    ttlMs: 1000,
    stickyMaxMs: 5000,
    clock: () => now,
    load: async () => {
      calls += 1;
      return calls === 1 ? first : null;
    },
  });

  assert.equal((await provider.get()).stale, undefined);
  now += 1001;
  const stale = await provider.get();
  assert.equal(stale.stale, true);
  assert.equal(stale.session.percent, 25);

  now = NOW + 5001;
  assert.equal(await provider.get(), null);
});

test('parseTokenCountRecord / parseCodexJsonl: total_token_usage をトークン数として取り出す', () => {
  const obj = JSON.parse(tokenCountLine({
    primary: { used_percent: 1, window_minutes: 300, resets_at: 1783306800 },
    total: 4321,
  }));
  const entry = parseTokenCountRecord(obj);
  assert.equal(entry.tokens, 4321);
  assert.equal(entry.ts, Date.parse('2026-07-06T02:00:00.000Z'));

  const text = [
    'broken',
    JSON.stringify({ type: 'token_count', payload: { info: { total_token_usage: { input: 10, cached: 20, output: 30, reasoning: 40 } } } }),
  ].join('\n');
  const entries = parseCodexJsonl(text, NOW);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].tokens, 100);
  assert.equal(entries[0].ts, NOW);
});

test('aggregateTokenCounts: 今日と今週（7日）の合計を固定窓で集計する', () => {
  const entries = [
    { ts: NOW - 8 * 24 * 60 * 60 * 1000, tokens: 1000 },
    { ts: Date.parse('2026-07-05T23:00:00.000Z'), tokens: 2000 },
    { ts: Date.parse('2026-07-06T01:00:00.000Z'), tokens: 3000 },
    { ts: NOW + 60 * 60 * 1000, tokens: 9999 },
  ];
  const r = aggregateTokenCounts(entries, NOW, {
    todayStartMs: Date.parse('2026-07-06T00:00:00.000Z'),
    weeklyStartMs: NOW - 7 * 24 * 60 * 60 * 1000,
    skewMs: 0,
  });
  assert.equal(r.todayTokens, 3000);
  assert.equal(r.weeklyTokens, 5000);
  assert.equal(r.todayText, '3k');
  assert.equal(r.weeklyText, '5k');
});
