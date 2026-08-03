'use strict';
// HTTP API のアクセストークン認証（issue #313）の純粋関数テスト。
// main.js（Electron 依存）を経由せず、utils/apiAuth.js 単体で検証する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  generateApiToken,
  isValidApiTokenFormat,
  timingSafeEqualStrings,
  isLoopbackHost,
  shouldRequireAuth,
  parseCookieHeader,
  extractTokenFromRequest,
  isAuthorizedRequest,
  deriveCookieToken,
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

test('isValidApiTokenFormat: generateApiToken() の出力は true', () => {
  assert.equal(isValidApiTokenFormat(generateApiToken()), true);
});

test('isValidApiTokenFormat: 短い・推測しやすい値や不正な形式は false（issue #313 レビュー対応・中-4）', () => {
  assert.equal(isValidApiTokenFormat('1234'), false);
  assert.equal(isValidApiTokenFormat(''), false);
  assert.equal(isValidApiTokenFormat('a'.repeat(63)), false); // 63文字（1文字不足）
  assert.equal(isValidApiTokenFormat('a'.repeat(65)), false); // 65文字（1文字超過）
  assert.equal(isValidApiTokenFormat('G'.repeat(64)), false); // 16進以外の文字
  assert.equal(isValidApiTokenFormat('A'.repeat(64)), false); // 大文字（小文字16進のみ許容）
  assert.equal(isValidApiTokenFormat(null), false);
  assert.equal(isValidApiTokenFormat(undefined), false);
  assert.equal(isValidApiTokenFormat(1234), false);
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

test('timingSafeEqualStrings: 256文字を超える入力は throw せず false（長さ上限）', () => {
  const token = generateApiToken();
  const tooLong = 'a'.repeat(257);
  assert.doesNotThrow(() => {
    assert.equal(timingSafeEqualStrings(tooLong, token), false);
    assert.equal(timingSafeEqualStrings(token, tooLong), false);
    assert.equal(timingSafeEqualStrings(tooLong, tooLong), false);
  });
});

test('isLoopbackHost: 127.0.0.1 / 127.0.0.0-8 全体 / ::1 / IPv4 射影は true', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('127.1.2.3'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true);
});

test('isLoopbackHost: 0.0.0.0 / :: / 空文字 / 通常の IP は false', () => {
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('::'), false);
  assert.equal(isLoopbackHost(''), false);
  assert.equal(isLoopbackHost('100.101.102.103'), false);
  assert.equal(isLoopbackHost(undefined), false);
});

test('shouldRequireAuth: actualHost が 127.0.0.1 なら不要（requireAlways 未指定）', () => {
  assert.equal(shouldRequireAuth({ actualHost: '127.0.0.1' }), false);
});

test('shouldRequireAuth: actualHost がループバック系（::1 / 127.0.0.2）なら不要', () => {
  assert.equal(shouldRequireAuth({ actualHost: '::1' }), false);
  assert.equal(shouldRequireAuth({ actualHost: '127.0.0.2' }), false);
});

test('shouldRequireAuth: actualHost が 127.0.0.1 以外（0.0.0.0 / :: 含む）なら必須', () => {
  assert.equal(shouldRequireAuth({ actualHost: '100.101.102.103' }), true);
  assert.equal(shouldRequireAuth({ actualHost: '0.0.0.0' }), true);
  assert.equal(shouldRequireAuth({ actualHost: '::' }), true);
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
  const result = parseCookieHeader('a=1; vk_terminals_token=abc123; b=2');
  assert.equal(result.a, '1');
  assert.equal(result.vk_terminals_token, 'abc123');
  assert.equal(result.b, '2');
});

test('parseCookieHeader: 未指定・空文字はプロパティを持たない', () => {
  assert.deepEqual(Object.keys(parseCookieHeader(undefined)), []);
  assert.deepEqual(Object.keys(parseCookieHeader('')), []);
});

test('parseCookieHeader: プロトタイプを持たないオブジェクトを返す（__proto__ 汚染対策）', () => {
  const result = parseCookieHeader('a=1');
  assert.equal(Object.getPrototypeOf(result), null);
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
  assert.match(header, /HttpOnly/);
  assert.match(header, /SameSite=Strict/);
  assert.match(header, new RegExp(`Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}\\b`));
  assert.equal(AUTH_COOKIE_MAX_AGE_SECONDS, 60 * 60 * 24 * 365);
});

// Cookie はポートを区別しない（RFC 6265）ため、apiHost を Tailscale IP にすると
// 同じホストの別ポートで動く別サービスへもブラウザが Cookie を送ってしまう。
// トークン本体をそのまま Cookie に載せないための導出値化（PR #315 安藤のセキュリティ
// レビュー指摘・必須-5）を、値そのもので検証する。
test('buildAuthCookieHeader: Cookie の値はトークン本体ではなく、deriveCookieToken の導出値', () => {
  const token = generateApiToken();
  const header = buildAuthCookieHeader(token);
  const derived = deriveCookieToken(token);
  assert.match(header, new RegExp(`^${AUTH_COOKIE_NAME}=${derived}; `));
  assert.doesNotMatch(header, new RegExp(`^${AUTH_COOKIE_NAME}=${token}(;|$)`));
});

test('deriveCookieToken: 同じトークンからは常に同じ値、異なるトークンからは異なる値', () => {
  const tokenA = generateApiToken();
  const tokenB = generateApiToken();
  assert.equal(deriveCookieToken(tokenA), deriveCookieToken(tokenA));
  assert.notEqual(deriveCookieToken(tokenA), deriveCookieToken(tokenB));
  // トークン本体（64文字16進）とは異なる文字列であること（同一視できないことの確認）。
  assert.notEqual(deriveCookieToken(tokenA), tokenA);
});

test('isAuthorizedRequest: Cookie に導出値（deriveCookieToken）を積んでも true', () => {
  const token = generateApiToken();
  const req = { headers: { cookie: `${AUTH_COOKIE_NAME}=${deriveCookieToken(token)}` } };
  assert.equal(isAuthorizedRequest(req, token), true);
});

test('isAuthorizedRequest: 別トークンの導出値では false（誤ったトークンの導出値を偽装されても通らない）', () => {
  const token = generateApiToken();
  const otherToken = generateApiToken();
  const req = { headers: { cookie: `${AUTH_COOKIE_NAME}=${deriveCookieToken(otherToken)}` } };
  assert.equal(isAuthorizedRequest(req, token), false);
});

test('isAuthExemptPath: GET /api/health は true', () => {
  assert.equal(isAuthExemptPath('GET', '/api/health'), true);
});

test('isAuthExemptPath: ページ本体を構成する静的ファイルは true（issue #313 レビュー対応・重大-2）', () => {
  // 未登録・Cookie 失効の端末でもページ自体は読み込め、画面側の JS が /api/* の 401 を
  // 検知して確定文言を出せる必要があるため、これらは認証不要にする。
  assert.equal(isAuthExemptPath('GET', '/'), true);
  assert.equal(isAuthExemptPath('GET', '/index.html'), true);
  assert.equal(isAuthExemptPath('GET', '/mobile.css'), true);
  assert.equal(isAuthExemptPath('GET', '/shared.css'), true);
  assert.equal(isAuthExemptPath('GET', '/mobile.js'), true);
  assert.equal(isAuthExemptPath('GET', '/widgetContract.js'), true);
  assert.equal(isAuthExemptPath('GET', '/widgetView.js'), true);
  assert.equal(isAuthExemptPath('GET', '/terminalDisplay.js'), true);
  assert.equal(isAuthExemptPath('GET', '/urlSafety.js'), true);
  assert.equal(isAuthExemptPath('GET', '/prBadge.js'), true);
  assert.equal(isAuthExemptPath('GET', '/statusPresentation.js'), true);
  assert.equal(isAuthExemptPath('GET', '/mobilePreviewText.js'), true);
});

test('isAuthExemptPath: データを返す /api/* はすべて false（唯一の例外は /api/health）', () => {
  assert.equal(isAuthExemptPath('GET', '/api/states'), false);
  assert.equal(isAuthExemptPath('GET', '/api/widgets'), false);
  assert.equal(isAuthExemptPath('POST', '/api/send'), false);
  assert.equal(isAuthExemptPath('POST', '/api/set-title'), false);
  assert.equal(isAuthExemptPath('POST', '/api/new-pane'), false);
});

test('isAuthExemptPath: メソッドが GET 以外なら免除パスでも false', () => {
  assert.equal(isAuthExemptPath('POST', '/api/health'), false);
  assert.equal(isAuthExemptPath('POST', '/'), false);
});

test('isAuthExemptPath: 未知のパスは false', () => {
  assert.equal(isAuthExemptPath('GET', '/unknown.js'), false);
  assert.equal(isAuthExemptPath('GET', '/favicon.ico'), false);
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
