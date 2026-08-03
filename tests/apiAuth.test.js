'use strict';
// HTTP API のアクセストークン認証（issue #313）の純粋関数テスト。
// main.js（Electron 依存）を経由せず、utils/apiAuth.js 単体で検証する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateApiToken,
  timingSafeEqualStrings,
  shouldRequireAuth,
  parseCookieHeader,
  extractTokenFromRequest,
  isAuthorizedRequest,
  buildAuthCookieHeader,
  isAuthExemptPath,
  evaluateTokenRegistration,
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_MAX_AGE_SECONDS,
} = require('../utils/apiAuth');

test('generateApiToken: 64文字の16進文字列を生成する', () => {
  const token = generateApiToken();
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 64);
  assert.match(token, /^[0-9a-f]{64}$/);
});

test('generateApiToken: 呼び出すたびに異なる値になる', () => {
  const a = generateApiToken();
  const b = generateApiToken();
  assert.notEqual(a, b);
});

test('timingSafeEqualStrings: 完全一致で true', () => {
  const token = generateApiToken();
  assert.equal(timingSafeEqualStrings(token, token), true);
});

test('timingSafeEqualStrings: 不一致（同じ長さ）で false', () => {
  const a = 'a'.repeat(64);
  const b = 'b'.repeat(64);
  assert.equal(timingSafeEqualStrings(a, b), false);
});

test('timingSafeEqualStrings: 長さが違う場合も throw せず false', () => {
  assert.doesNotThrow(() => {
    assert.equal(timingSafeEqualStrings('short', 'a'.repeat(64)), false);
  });
  assert.equal(timingSafeEqualStrings('a'.repeat(64), 'short'), false);
});

test('timingSafeEqualStrings: 空文字・非文字列は false', () => {
  assert.equal(timingSafeEqualStrings('', ''), false);
  assert.equal(timingSafeEqualStrings('', 'a'), false);
  assert.equal(timingSafeEqualStrings('a', ''), false);
  assert.equal(timingSafeEqualStrings(undefined, 'a'), false);
  assert.equal(timingSafeEqualStrings('a', null), false);
});

test('shouldRequireAuth: actualHost が 127.0.0.1 なら不要（requireAlways 未指定）', () => {
  assert.equal(shouldRequireAuth({ actualHost: '127.0.0.1' }), false);
});

test('shouldRequireAuth: actualHost が 127.0.0.1 以外なら必須', () => {
  assert.equal(shouldRequireAuth({ actualHost: '100.101.102.103' }), true);
  assert.equal(shouldRequireAuth({ actualHost: '0.0.0.0' }), true);
});

test('shouldRequireAuth: actualHost が空文字（待ち受け確定前）は安全側で必須', () => {
  assert.equal(shouldRequireAuth({ actualHost: '' }), true);
  assert.equal(shouldRequireAuth({}), true);
});

test('shouldRequireAuth: requireAlways が true なら actualHost が 127.0.0.1 でも必須', () => {
  assert.equal(shouldRequireAuth({ actualHost: '127.0.0.1', requireAlways: true }), true);
});

test('shouldRequireAuth: requireAlways が false/未指定なら従来どおり actualHost で判定', () => {
  assert.equal(shouldRequireAuth({ actualHost: '127.0.0.1', requireAlways: false }), false);
});

test('parseCookieHeader: 複数 Cookie を分解する', () => {
  assert.deepEqual(
    parseCookieHeader('a=1; vk_terminals_token=abc123; b=2'),
    { a: '1', vk_terminals_token: 'abc123', b: '2' },
  );
});

test('parseCookieHeader: 未指定・空文字は空オブジェクト', () => {
  assert.deepEqual(parseCookieHeader(undefined), {});
  assert.deepEqual(parseCookieHeader(''), {});
});

test('extractTokenFromRequest: Authorization: Bearer ヘッダを優先する', () => {
  const req = { headers: { authorization: 'Bearer mytoken', cookie: `${AUTH_COOKIE_NAME}=cookietoken` } };
  assert.deepEqual(extractTokenFromRequest(req), { token: 'mytoken', source: 'header' });
});

test('extractTokenFromRequest: ヘッダが無ければ Cookie を見る', () => {
  const req = { headers: { cookie: `${AUTH_COOKIE_NAME}=cookietoken` } };
  assert.deepEqual(extractTokenFromRequest(req), { token: 'cookietoken', source: 'cookie' });
});

test('extractTokenFromRequest: どちらも無ければ none', () => {
  assert.deepEqual(extractTokenFromRequest({ headers: {} }), { token: '', source: 'none' });
  assert.deepEqual(extractTokenFromRequest({}), { token: '', source: 'none' });
});

test('isAuthorizedRequest: 正しいトークン（ヘッダ）で true', () => {
  const token = generateApiToken();
  const req = { headers: { authorization: `Bearer ${token}` } };
  assert.equal(isAuthorizedRequest(req, token), true);
});

test('isAuthorizedRequest: 正しいトークン（Cookie）で true', () => {
  const token = generateApiToken();
  const req = { headers: { cookie: `${AUTH_COOKIE_NAME}=${token}` } };
  assert.equal(isAuthorizedRequest(req, token), true);
});

test('isAuthorizedRequest: 誤ったトークンは false', () => {
  const token = generateApiToken();
  const req = { headers: { authorization: 'Bearer wrong-token' } };
  assert.equal(isAuthorizedRequest(req, token), false);
});

test('isAuthorizedRequest: トークン未提示は false', () => {
  const token = generateApiToken();
  assert.equal(isAuthorizedRequest({ headers: {} }, token), false);
});

test('isAuthorizedRequest: expectedToken が空・未設定なら常に false', () => {
  assert.equal(isAuthorizedRequest({ headers: { authorization: 'Bearer x' } }, ''), false);
  assert.equal(isAuthorizedRequest({ headers: { authorization: 'Bearer x' } }, undefined), false);
});

test('buildAuthCookieHeader: HttpOnly / SameSite=Strict / 365日を含む', () => {
  const token = generateApiToken();
  const header = buildAuthCookieHeader(token);
  assert.match(header, new RegExp(`^${AUTH_COOKIE_NAME}=${token}; `));
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, new RegExp(`Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}\\b`));
  assert.equal(AUTH_COOKIE_MAX_AGE_SECONDS, 60 * 60 * 24 * 365);
});

test('isAuthExemptPath: GET /api/health だけが true', () => {
  assert.equal(isAuthExemptPath('GET', '/api/health'), true);
});

test('isAuthExemptPath: 他のパス・メソッドはすべて false（/api/health 以外は認証対象）', () => {
  assert.equal(isAuthExemptPath('GET', '/'), false);
  assert.equal(isAuthExemptPath('GET', '/api/states'), false);
  assert.equal(isAuthExemptPath('GET', '/api/widgets'), false);
  assert.equal(isAuthExemptPath('POST', '/api/health'), false);
  assert.equal(isAuthExemptPath('GET', '/mobile.js'), false);
});

test('evaluateTokenRegistration: 正しいトークンはリダイレクト先 "/" を返す（トークンが残らない）', () => {
  const token = generateApiToken();
  const result = evaluateTokenRegistration(token, token);
  assert.equal(result.authorized, true);
  assert.equal(result.redirectLocation, '/');
  // リダイレクト先にトークンそのものは含まれない（issue #313 必須条件）。
  assert.equal(result.redirectLocation.includes(token), false);
  assert.equal(result.redirectLocation.includes('token'), false);
});

test('evaluateTokenRegistration: 誤ったトークンは認証失敗（redirectLocation は null）', () => {
  const token = generateApiToken();
  const result = evaluateTokenRegistration('wrong-token', token);
  assert.equal(result.authorized, false);
  assert.equal(result.redirectLocation, null);
});

test('evaluateTokenRegistration: トークン未指定（空文字）も認証失敗', () => {
  const token = generateApiToken();
  const result = evaluateTokenRegistration('', token);
  assert.equal(result.authorized, false);
  assert.equal(result.redirectLocation, null);
});
