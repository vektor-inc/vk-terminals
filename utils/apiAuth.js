'use strict';

// HTTP API（既定 13847 番ポート）へのアクセストークン認証（issue #313）に関する
// 純粋関数群。main.js から Electron 依存を切り離してテストしやすくするため、
// このファイルは Node 標準の crypto にのみ依存する。

const crypto = require('crypto');
const { isLoopbackHost } = require('./loopbackHost');

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

// generateApiToken() の出力形式（16進 64 文字）に一致する文字列だけを判定する。
const API_TOKEN_FORMAT_PATTERN = new RegExp(`^[0-9a-f]{${API_TOKEN_BYTES * 2}}$`);

/**
 * 文字列が generateApiToken() の出力形式（16進 64 文字）に一致するかを判定する。
 * config.json の apiToken は利用者が直接編集できる設定キーのため、「1234」のような
 * 短く推測しやすい値に書き換えられていても、空文字でなければそのまま採用してしまう
 * 実装は総当たりで突破されうる（issue #313 レビュー対応・中-4）。既存トークンを
 * 読み込む際はこの関数で形式を確認し、一致しない場合は再生成すべきと判断する。
 * @param {unknown} token
 * @returns {boolean}
 */
function isValidApiTokenFormat(token) {
  return typeof token === 'string' && API_TOKEN_FORMAT_PATTERN.test(token);
}

// タイミングセーフ比較を行う前の長さ上限。トークン自体は 64 文字固定だが、
// リクエスト側（Authorization ヘッダ・Cookie・?token= クエリ）は攻撃者が任意長の
// 文字列を送れるため、上限を設けずに Buffer 変換すると無駄に大きな割り当てを
// 強いられうる（軽微な DoS 耐性）。長さそのものは公開情報同然のため、上限超過を
// 理由にした早期 return はタイミング上の情報漏えいにならない。
const MAX_COMPARABLE_TOKEN_LENGTH = 256;

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
  if (a.length > MAX_COMPARABLE_TOKEN_LENGTH || b.length > MAX_COMPARABLE_TOKEN_LENGTH) return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA); // 分岐後も同程度の時間を使う
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ループバックアドレスの判定は utils/loopbackHost.js（isLoopbackHost）に集約している。
// renderer/app.js の `apiHost` 入力欄の即時案内（getApiHostAuthNotice）とここで
// 判定基準が分かれていると、画面上の案内と実際の認証要否がずれるため（issue #313
// レビュー対応・PR #315 指摘）、両方が同じ関数を参照する。

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
  return !isLoopbackHost(host);
}

/**
 * `Cookie:` ヘッダを `{ name: value }` のオブジェクトへ分解する。
 * @param {string|undefined} cookieHeader
 * @returns {Record<string, string>}
 */
function parseCookieHeader(cookieHeader) {
  // __proto__ 等のキーが渡っても Object.prototype を汚染しないよう、プロトタイプの
  // 無いオブジェクトを器にする（settingsTargets.js の hasUnsafeKeySegment と同じ考え方）。
  const cookies = Object.create(null);
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

// 認証を課さない GET パス（issue #313 レビュー対応・重大-2）。
//   - `/api/health`: ヘルスチェック用途。
//   - それ以外はいずれも「ページ本体を構成する静的ファイル」で、アプリに同梱された
//     固定の内容のみを返し、利用者データを一切含まない（誰が読んでも実害が無い）。
//     ここを免除しないと、未登録・Cookie 失効の端末がブラウザでモバイルページを
//     開いた際にページの HTML/CSS/JS 自体が読み込めず、`{"error":"unauthorized"}` という
//     生の JSON しか出せない（画面側の JS が 401 を検知して確定文言を出す、という
//     設計そのものが成立しない）。データを返す `/api/*` はここに載せず、引き続き
//     すべて認証対象のままにする。
const AUTH_EXEMPT_GET_PATHS = new Set([
  '/api/health',
  '/',
  '/index.html',
  '/mobile.css',
  '/shared.css',
  '/mobile.js',
  '/widgetContract.js',
  '/widgetView.js',
  '/terminalDisplay.js',
  '/urlSafety.js',
  '/prBadge.js',
  '/statusPresentation.js',
  '/mobilePreviewText.js',
]);

/**
 * このメソッド・パスの組が認証不要かどうかを判定する。main.js の認証ゲートはこの
 * 関数だけを見て免除可否を決める。「免除はここだけ」という前提をこの 1 か所（と
 * 対応するテスト）だけで担保する。
 * @param {string} method
 * @param {string} pathname
 * @returns {boolean}
 */
function isAuthExemptPath(method, pathname) {
  return method === 'GET' && AUTH_EXEMPT_GET_PATHS.has(pathname);
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
  isValidApiTokenFormat,
  timingSafeEqualStrings,
  isLoopbackHost,
  shouldRequireAuth,
  parseCookieHeader,
  extractTokenFromRequest,
  isAuthorizedRequest,
  buildAuthCookieHeader,
  isAuthExemptPath,
  evaluateTokenRegistration,
};
