'use strict';
// oauthUsage（issue #73）の純粋関数コアのテスト。
// 公式 usage API のレスポンス正規化（parseUsageResponse）と認証情報のパース・期限判定を
// 固定時刻・ダミー値のフィクスチャで検証する。IO 層（Keychain / fetch）は副作用を持つため
// ここでは扱わない。フィクスチャのトークン等はすべてダミー値（実トークンは使わない）。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseCredentials,
  isTokenUsable,
  normalizePercent,
  parseResetAt,
  parseUsageResponse,
  isStickyUsable,
  createOauthUsageProvider,
} = require('../oauthUsage');

const NOW = Date.parse('2026-07-06T03:00:00.000Z');

// ── parseCredentials ─────────────────────────────────────────────────────────
test('parseCredentials: claudeAiOauth から accessToken / expiresAt を取り出す', () => {
  const raw = JSON.stringify({
    claudeAiOauth: {
      accessToken: 'dummy-access-token',
      refreshToken: 'dummy-refresh-token',
      expiresAt: NOW + 60 * 60 * 1000,
      scopes: ['user:inference'],
    },
  });
  const cred = parseCredentials(raw);
  assert.equal(cred.accessToken, 'dummy-access-token');
  assert.equal(cred.expiresAtMs, NOW + 60 * 60 * 1000);
  // refreshToken は使わない・返さない（セキュリティ設計）
  assert.equal('refreshToken' in cred, false);
});

test('parseCredentials: パース済みオブジェクトも受け付ける', () => {
  const cred = parseCredentials({ claudeAiOauth: { accessToken: 'dummy-t', expiresAt: 123 } });
  assert.equal(cred.accessToken, 'dummy-t');
  assert.equal(cred.expiresAtMs, 123);
});

test('parseCredentials: 壊れた JSON・構造違い・accessToken 欠落は null', () => {
  assert.equal(parseCredentials('not-json'), null);
  assert.equal(parseCredentials(null), null);
  assert.equal(parseCredentials('{}'), null);
  assert.equal(parseCredentials(JSON.stringify({ claudeAiOauth: {} })), null);
  assert.equal(parseCredentials(JSON.stringify({ claudeAiOauth: { accessToken: '' } })), null);
  assert.equal(parseCredentials(JSON.stringify({ other: { accessToken: 'x' } })), null);
});

test('parseCredentials: expiresAt が数値でない場合は expiresAtMs=null（トークンは保持）', () => {
  const cred = parseCredentials(JSON.stringify({
    claudeAiOauth: { accessToken: 'dummy-t', expiresAt: '2026-07-06' },
  }));
  assert.equal(cred.accessToken, 'dummy-t');
  assert.equal(cred.expiresAtMs, null);
});

// ── isTokenUsable（期限切れ判定）─────────────────────────────────────────────
test('isTokenUsable: 期限内なら true、expiresAt <= now は false（API を叩かずフォールバック）', () => {
  const fresh = { accessToken: 'dummy-t', expiresAtMs: NOW + 1000 };
  const expired = { accessToken: 'dummy-t', expiresAtMs: NOW - 1000 };
  const exact = { accessToken: 'dummy-t', expiresAtMs: NOW };
  assert.equal(isTokenUsable(fresh, NOW), true);
  assert.equal(isTokenUsable(expired, NOW), false);
  assert.equal(isTokenUsable(exact, NOW), false);
});

test('isTokenUsable: cred が null / expiresAt 欠落 / トークン欠落は false', () => {
  assert.equal(isTokenUsable(null, NOW), false);
  assert.equal(isTokenUsable({ accessToken: 'dummy-t', expiresAtMs: null }, NOW), false);
  assert.equal(isTokenUsable({ accessToken: '', expiresAtMs: NOW + 1000 }, NOW), false);
});

// ── normalizePercent（percent 正規化）────────────────────────────────────────
test('normalizePercent: 百分率の浮動小数（17.0 = 17%）をそのまま扱う（0..1 と誤解しない）', () => {
  assert.equal(normalizePercent(17.0), 17.0);
  assert.equal(normalizePercent(0), 0);
  assert.equal(normalizePercent(99.5), 99.5);
});

test('normalizePercent: 0..100 にクランプ・数値以外は null', () => {
  assert.equal(normalizePercent(-5), 0);
  assert.equal(normalizePercent(250), 100);
  assert.equal(normalizePercent('17'), null);
  assert.equal(normalizePercent(NaN), null);
  assert.equal(normalizePercent(null), null);
  assert.equal(normalizePercent(undefined), null);
});

// ── parseResetAt ─────────────────────────────────────────────────────────────
test('parseResetAt: TZ 付き ISO8601 を epoch ms にする・不正は null', () => {
  assert.equal(parseResetAt('2026-07-06T15:00:00+09:00'), Date.parse('2026-07-06T06:00:00.000Z'));
  assert.equal(parseResetAt('not-a-date'), null);
  assert.equal(parseResetAt(''), null);
  assert.equal(parseResetAt(null), null);
  assert.equal(parseResetAt(12345), null);
});

// ── parseUsageResponse（正常系: limits[] 主）─────────────────────────────────
const LIMITS_FIXTURE = {
  five_hour: { utilization: 11.0, resets_at: '2026-07-06T08:00:00+00:00' },
  seven_day: { utilization: 33.0, resets_at: '2026-07-10T09:59:00+00:00' },
  limits: [
    { kind: 'session', percent: 17.0, severity: 'ok', resets_at: '2026-07-06T08:00:00+00:00', is_active: true },
    { kind: 'weekly_all', percent: 42.5, severity: 'ok', resets_at: '2026-07-10T09:59:00+00:00', is_active: true },
    { kind: 'weekly_scoped', percent: 5.0, severity: 'ok', resets_at: '2026-07-10T09:59:00+00:00', is_active: true },
  ],
};

test('parseUsageResponse: limits[] からセッション（session）と週間（weekly_all）を取り出す', () => {
  const r = parseUsageResponse(LIMITS_FIXTURE, NOW);
  assert.equal(r.source, 'oauth');
  // limits の percent が five_hour/seven_day の utilization より優先される
  assert.equal(r.session.percent, 17.0);
  assert.equal(r.session.resetAtMs, Date.parse('2026-07-06T08:00:00+00:00'));
  assert.equal(r.weekly.percent, 42.5);
  assert.equal(r.weekly.resetAtMs, Date.parse('2026-07-10T09:59:00+00:00'));
  assert.equal(r.fetchedAtMs, NOW);
});

test('parseUsageResponse: weekly_scoped（特定モデル枠）は無視する', () => {
  const r = parseUsageResponse({
    limits: [
      { kind: 'weekly_scoped', percent: 88.0, resets_at: '2026-07-10T09:59:00+00:00' },
      { kind: 'session', percent: 10.0, resets_at: '2026-07-06T08:00:00+00:00' },
    ],
  }, NOW);
  assert.equal(r.session.percent, 10.0);
  assert.equal(r.weekly, null); // weekly_all が無いので週間は無し（0% 捏造しない）
});

// ── parseUsageResponse（正常系: five_hour / seven_day 代替）──────────────────
test('parseUsageResponse: limits が無ければ five_hour / seven_day で代替する', () => {
  const r = parseUsageResponse({
    five_hour: { utilization: 17.0, resets_at: '2026-07-06T08:00:00+00:00' },
    seven_day: { utilization: 42.5, resets_at: '2026-07-10T09:59:00+00:00' },
  }, NOW);
  // utilization も百分率の浮動小数（17.0 = 17%）。0.17 に変換したり 1700 にしない
  assert.equal(r.session.percent, 17.0);
  assert.equal(r.weekly.percent, 42.5);
  assert.equal(r.session.resetAtMs, Date.parse('2026-07-06T08:00:00+00:00'));
});

test('parseUsageResponse: limits にセッションだけある場合、週間は seven_day で補完する', () => {
  const r = parseUsageResponse({
    seven_day: { utilization: 60.0, resets_at: '2026-07-10T09:59:00+00:00' },
    limits: [{ kind: 'session', percent: 25.0, resets_at: '2026-07-06T08:00:00+00:00' }],
  }, NOW);
  assert.equal(r.session.percent, 25.0);
  assert.equal(r.weekly.percent, 60.0);
});

// ── parseUsageResponse（異常系）──────────────────────────────────────────────
test('parseUsageResponse: null・非オブジェクト・空・構造違いは null', () => {
  assert.equal(parseUsageResponse(null, NOW), null);
  assert.equal(parseUsageResponse(undefined, NOW), null);
  assert.equal(parseUsageResponse('text', NOW), null);
  assert.equal(parseUsageResponse([], NOW), null);
  assert.equal(parseUsageResponse({}, NOW), null);
  assert.equal(parseUsageResponse({ limits: 'broken' }, NOW), null);
  assert.equal(parseUsageResponse({ limits: [], five_hour: {}, seven_day: {} }, NOW), null);
  // percent が数値として取れない項目は採用しない（0% で見せない）
  assert.equal(parseUsageResponse({ limits: [{ kind: 'session', percent: 'high' }] }, NOW), null);
});

test('parseUsageResponse: percent は 0..100 にクランプ・resets_at 不正は resetAtMs=null', () => {
  const r = parseUsageResponse({
    limits: [
      { kind: 'session', percent: 250.0, resets_at: 'broken-date' },
      { kind: 'weekly_all', percent: -3.0, resets_at: null },
    ],
  }, NOW);
  assert.equal(r.session.percent, 100);
  assert.equal(r.session.resetAtMs, null);
  assert.equal(r.weekly.percent, 0);
  assert.equal(r.weekly.resetAtMs, null);
});

test('parseUsageResponse: セッションのみ・週間のみでも成立する', () => {
  const sOnly = parseUsageResponse({ five_hour: { utilization: 5.0 } }, NOW);
  assert.equal(sOnly.session.percent, 5.0);
  assert.equal(sOnly.session.resetAtMs, null);
  assert.equal(sOnly.weekly, null);

  const wOnly = parseUsageResponse({ seven_day: { utilization: 70.0 } }, NOW);
  assert.equal(wOnly.session, null);
  assert.equal(wOnly.weekly.percent, 70.0);
});

// ── isStickyUsable（直近成功値のスティッキー表示判定）────────────────────────
test('isStickyUsable: 有効な oauth スナップショットが期限内なら true', () => {
  const snapshot = { source: 'oauth', session: { percent: 12, resetAtMs: null }, weekly: null, fetchedAtMs: NOW };
  assert.equal(isStickyUsable(snapshot, NOW + 1000, 5000), true);
});

test('isStickyUsable: 期限超過・null・fetchedAtMs 欠落/非数値は false', () => {
  const base = { source: 'oauth', session: { percent: 12, resetAtMs: null }, weekly: null, fetchedAtMs: NOW };
  assert.equal(isStickyUsable(base, NOW + 5001, 5000), false);
  assert.equal(isStickyUsable(null, NOW, 5000), false);
  assert.equal(isStickyUsable({ source: 'oauth', session: null, weekly: null }, NOW, 5000), false);
  assert.equal(isStickyUsable({ source: 'oauth', session: null, weekly: null, fetchedAtMs: '1000' }, NOW, 5000), false);
});

// ── createOauthUsageProvider（60s TTL キャッシュ・load 注入）─────────────────
test('createOauthUsageProvider: TTL 内は load を 1 回しか呼ばず、TTL 超過で再取得する', async () => {
  let now = NOW;
  let calls = 0;
  const provider = createOauthUsageProvider({
    ttlMs: 60000,
    clock: () => now,
    load: async () => {
      calls += 1;
      return { source: 'oauth', session: { percent: calls, resetAtMs: null }, weekly: null, fetchedAtMs: now };
    },
  });
  const a = await provider.get();
  const b = await provider.get();
  assert.equal(calls, 1);
  assert.equal(a.session.percent, 1);
  assert.equal(b.session.percent, 1);

  now += 60001; // TTL 超過
  const c = await provider.get();
  assert.equal(calls, 2);
  assert.equal(c.session.percent, 2);
});

test('createOauthUsageProvider: load の失敗（reject）は null に落ち、例外を漏らさない', async () => {
  const provider = createOauthUsageProvider({
    ttlMs: 60000,
    clock: () => NOW,
    load: async () => { throw new Error('network down'); },
  });
  assert.equal(await provider.get(), null);
});

test('createOauthUsageProvider: 一時失敗時は stickyMaxMs 以内だけ直近成功値を stale として返す', async () => {
  let now = NOW;
  let calls = 0;
  const firstSnapshot = {
    source: 'oauth',
    session: { percent: 25, resetAtMs: NOW + 60 * 60 * 1000 },
    weekly: null,
    fetchedAtMs: NOW,
  };
  const provider = createOauthUsageProvider({
    ttlMs: 1000,
    stickyMaxMs: 5000,
    clock: () => now,
    load: async () => {
      calls += 1;
      return calls === 1 ? firstSnapshot : null;
    },
  });

  const fresh = await provider.get();
  assert.equal(fresh.source, 'oauth');
  assert.equal(fresh.session.percent, 25);
  assert.equal(fresh.stale, undefined);

  now += 1001; // TTL 超過後の再取得が null でも stickyMaxMs 以内なら直近成功値を使う
  const stale = await provider.get();
  assert.equal(calls, 2);
  assert.equal(stale.source, 'oauth');
  assert.equal(stale.session.percent, 25);
  assert.equal(stale.stale, true);

  now = NOW + 5001; // stickyMaxMs 超過後はフォールバックへ渡すため null
  const expired = await provider.get();
  assert.equal(calls, 3);
  assert.equal(expired, null);
});
