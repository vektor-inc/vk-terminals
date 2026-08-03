'use strict';

// HTTP API（既定 13847 番ポート）へのアクセストークン認証（issue #313）に関する
// 純粋関数群。main.js から Electron 依存を切り離してテストしやすくするため、
// このファイルは Node 標準の crypto にのみ依存する。

const crypto = require('crypto');

// トークンは crypto.randomBytes で生成する暗号論的に安全な乱数（32byte = 256bit）を
// 16進文字列（64文字固定長）にしたもの。固定長にしておくことで、
// timingSafeEqualStrings の「長さが違う場合の扱い」の判断がシンプルになる。
const API_TOKEN_BYTES = 32;

// Cookie 認証で使う Cookie 名。
const AUTH_COOKIE_NAME = 'vk_terminals_token';

// Cookie の有効期限（365日）。認証が通るたびに付け直す（ローリング更新）。
const AUTH_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

/**
 * アクセストークンを新規生成する。
 * crypto.randomBytes（暗号論的に安全な乱数）を使い、利用者に安全な文字列を
 * 考えさせない。
 * @returns {string} 64文字の16進文字列（256bit相当）
 */
function generateApiToken() {
  return crypto.randomBytes(API_TOKEN_BYTES).toString('hex');
}

/**
 * トークン同士を、文字列長に関わらず同じ時間で比較する。
 * 通常の `===` 比較は不一致箇所までの時間差でトークンを推測されうるため使わない。
 * crypto.timingSafeEqual は長さが異なる Buffer を渡すと throw するため、
 * 長さ違いの場合は同じ長さのダミー比較を行ってから false を返す（早期 return で
 * 分岐時間が短くなることを避ける）。トークン長は generateApiToken の出力で固定
 * されており公開情報同然のため、長さの一致有無だけが分かることは実質的な
 * 情報漏えいにならない。
 * @param {string} a
 * @param {string} b
 * @returns {boolean} 完全一致すれば true
 */
function timingSafeEqualStrings(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a === '' || b === '') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // 分岐後も同程度の時間を使う
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 現在の状況から認証を必須にするかどうかを判定する。
 * 判定は「設定ファイルに書かれた値」ではなく「実際に待ち受けに成功したアドレス」
 * （actualHost）で行う（必須条件・issue #313）。理由:
 *   (a) 設定を保存しても待ち受け先は再起動するまで切り替わらない
 *   (b) Tailscale の IP に繋げない場合、127.0.0.1 へ自動フォールバックする仕組みがある
 * 待ち受け開始前で actualHost が未確定（空文字）の間は、安全側に倒して認証必須とする。
 * requireAlways（config.json の apiRequireAuthAlways）が true の場合は、
 * `tailscale serve --bg` のように apiHost が 127.0.0.1 のまま外部公開される
 * ケースに対応するため、待ち受けアドレスに関わらず認証必須にする。
 * @param {{ actualHost?: string, requireAlways?: boolean }} params
 * @returns {boolean} 認証必須なら true
 */
function shouldRequireAuth({ actualHost, requireAlways } = {}) {
  if (requireAlways) return true;
  const host = typeof actualHost === 'string' ? actualHost.trim() : '';
  if (!host) return true; // 未確定（起動直後の一瞬）は認証必須側に倒す
  return host !== '127.0.0.1';
}

/**
 * `Cookie:` ヘッダを `{ name: value }` のオブジェクトへ分解する。
 * @param {string|undefined} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookieHeader(cookieHeader) {
  const cookies = {};
  if (typeof cookieHeader !== 'string' || !cookieHeader) return cookies;
  cookieHeader.split(';').forEach((part) => {
    const idx = part.indexOf('=');
    if (idx === -1) return;
    const name = part.slice(0, idx).trim();
    const rawValue = part.slice(idx + 1).trim();
    if (!name) return;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch (_e) {
      cookies[name] = rawValue;
    }
  });
  return cookies;
}

/**
 * リクエストからトークンを取り出す。
 * `Authorization: Bearer <token>` ヘッダ（curl・スクリプト経路）を優先し、
 * 無ければ Cookie（スマホのブラウザ経路）を見る。
 * @param {import('http').IncomingMessage} req
 * @returns {{ token: string, source: 'header'|'cookie'|'none' }}
 */
function extractTokenFromRequest(req) {
  const headers = (req && req.headers) || {};
  const authHeader = headers['authorization'];
  if (typeof authHeader === 'string') {
    const m = authHeader.match(/^Bearer\s+(.+)$/i);
    if (m && m[1].trim()) return { token: m[1].trim(), source: 'header' };
  }
  const cookies = parseCookieHeader(headers['cookie']);
  if (cookies[AUTH_COOKIE_NAME]) return { token: cookies[AUTH_COOKIE_NAME], source: 'cookie' };
  return { token: '', source: 'none' };
}

/**
 * リクエストが正しいトークンを提示しているか判定する（timing-safe）。
 * @param {import('http').IncomingMessage} req
 * @param {string} expectedToken 現在有効なアクセストークン
 * @returns {boolean}
 */
function isAuthorizedRequest(req, expectedToken) {
  if (typeof expectedToken !== 'string' || !expectedToken) return false;
  const { token } = extractTokenFromRequest(req);
  if (!token) return false;
  return timingSafeEqualStrings(token, expectedToken);
}

/**
 * 認証 Cookie の `Set-Cookie` ヘッダ値を組み立てる。
 * HttpOnly・SameSite=Strict を付け、有効期限は 365 日（呼び出す都度、この関数を
 * 使って付け直すことでローリング更新になる）。
 * @param {string} token
 * @returns {string}
 */
function buildAuthCookieHeader(token) {
  const encoded = encodeURIComponent(token);
  return `${AUTH_COOKIE_NAME}=${encoded}; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Strict`;
}

/**
 * このメソッド・パスの組が「認証不要」の唯一の例外（GET /api/health）かどうかを判定する。
 * main.js のルーティングはこの関数を「/api/health の早期応答」判定にも使うことで、
 * 「認証不要な経路はここだけ」という前提をこの 1 か所（と対応するテスト）だけで担保する。
 * @param {string} method
 * @param {string} pathname
 * @returns {boolean}
 */
function isAuthExemptPath(method, pathname) {
  return method === 'GET' && pathname === '/api/health';
}

/**
 * `GET /?token=<トークン>`（スマホ初回登録経路）を評価する。
 * 正しいトークンなら「トークンを取り除いた `/` へリダイレクトする」判定を返す
 * （ブックマーク・履歴にトークンが残らないようにするため）。誤ったトークンなら
 * 認証失敗を返す。main.js のルーティングとこの関数のテストの両方が同じ実装を
 * 参照することで、リダイレクト先にトークンが残らないことを保証する。
 * @param {string} providedToken リクエストの `?token=` クエリ値
 * @param {string} expectedToken 現在有効なアクセストークン
 * @returns {{ authorized: true, redirectLocation: string } | { authorized: false, redirectLocation: null }}
 */
function evaluateTokenRegistration(providedToken, expectedToken) {
  if (timingSafeEqualStrings(providedToken, expectedToken)) {
    return { authorized: true, redirectLocation: '/' };
  }
  return { authorized: false, redirectLocation: null };
}

module.exports = {
  API_TOKEN_BYTES,
  AUTH_COOKIE_NAME,
  AUTH_COOKIE_MAX_AGE_SECONDS,
  generateApiToken,
  timingSafeEqualStrings,
  shouldRequireAuth,
  parseCookieHeader,
  extractTokenFromRequest,
  isAuthorizedRequest,
  buildAuthCookieHeader,
  isAuthExemptPath,
  evaluateTokenRegistration,
};
