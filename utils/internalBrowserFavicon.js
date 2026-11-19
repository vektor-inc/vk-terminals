'use strict';

// タブに出すファビコン（サイトの小さなアイコン）を、アプリ本体の側で取得して data URL に変える（issue #644）。
// 画面（renderer）の読み込み制限（CSP の img-src 'self' data:）を広げずに表示するため、
// ページから届いたアイコンの URL を画面に直接読ませない。

const FAVICON_MAX_BYTES = 64 * 1024;
const FAVICON_TIMEOUT_MS = 5000;
// 画面へ渡してよい画像の種類。SVG は <img> では script を実行しないため許可する。
const FAVICON_TYPES = new Set(['image/png', 'image/x-icon', 'image/vnd.microsoft.icon', 'image/gif', 'image/jpeg', 'image/webp', 'image/svg+xml']);

/**
 * 取得してよいファビコンの URL か。HTTP(S) のみで、URL に認証情報を含むものは取得しない。
 *
 * @param {string} url ページから届いたファビコンの URL
 * @returns {boolean} 取得してよいか
 */
function isFaviconUrl(url) {
  if (typeof url !== 'string' || url.length > 2048) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !parsed.username && !parsed.password;
  } catch { return false; }
}

/**
 * ページが知らせたファビコンの候補から、取得するものを 1 つ選ぶ（先頭の取得できる URL）。
 *
 * @param {string[]} favicons Electron の page-favicon-updated が渡す URL の一覧
 * @returns {string} 取得する URL（無ければ空文字）
 */
function pickFaviconUrl(favicons) {
  if (!Array.isArray(favicons)) return '';
  return favicons.find(isFaviconUrl) || '';
}

/**
 * 画像の先頭のバイトから種類を判定する。サーバーの Content-Type が誤っていても表示できるようにし、
 * 画像でない応答（HTML のエラーページなど）は捨てる。
 *
 * @param {Buffer} bytes 応答の本文
 * @param {string} declaredType 応答の Content-Type（引数なし・小文字）
 * @returns {string} 画像の種類（画像と判定できなければ空文字）
 */
function detectFaviconType(bytes, declaredType) {
  const startsWith = signature => signature.every((value, index) => bytes[index] === value);
  if (startsWith([0x89, 0x50, 0x4e, 0x47])) return 'image/png';
  if (startsWith([0x00, 0x00, 0x01, 0x00])) return 'image/x-icon';
  if (startsWith([0x47, 0x49, 0x46, 0x38])) return 'image/gif';
  if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith([0x52, 0x49, 0x46, 0x46]) && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  // SVG は先頭のバイトで判定できないため、サーバーが SVG と宣言し、本文も SVG の要素を含むときだけ受け付ける。
  if (declaredType === 'image/svg+xml' && /<svg[\s>]/i.test(bytes.toString('utf8'))) return 'image/svg+xml';
  return '';
}

/**
 * ファビコンを取得して data URL に変える。取得先・大きさ・待ち時間を制限し、失敗したときは空文字を返す（例外は投げない）。
 *
 * @param {string} url 取得する URL
 * @param {object} options
 * @param {Function} options.fetch fetch 互換の関数（アプリ内ブラウザのセッションの fetch）
 * @param {number} [options.timeoutMs] 待ち時間の上限（ミリ秒）
 * @param {number} [options.maxBytes] 本文の大きさの上限（バイト）
 * @returns {Promise<string>} data URL（失敗時は空文字）
 */
async function fetchFaviconDataUrl(url, { fetch, timeoutMs = FAVICON_TIMEOUT_MS, maxBytes = FAVICON_MAX_BYTES } = {}) {
  if (!isFaviconUrl(url) || typeof fetch !== 'function') return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    // Cookie などの認証情報は送らない（ページの表示には使わない取得のため）。
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit', redirect: 'follow' });
    // リダイレクトで HTTP(S) 以外へ移った応答は使わない。
    if (!response?.ok || (response.url && !isFaviconUrl(response.url))) return '';
    const declaredType = String(response.headers?.get?.('content-type') || '').split(';')[0].trim().toLowerCase();
    if (declaredType && !declaredType.startsWith('image/') && declaredType !== 'application/octet-stream') return '';
    const declaredLength = Number(response.headers?.get?.('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return '';
    const bytes = await readLimited(response, maxBytes, controller);
    if (!bytes || bytes.length === 0) return '';
    const type = detectFaviconType(bytes, declaredType);
    if (!FAVICON_TYPES.has(type)) return '';
    return `data:${type};base64,${bytes.toString('base64')}`;
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

// 本文を上限まで読む。上限を超えたら読み込みを打ち切って null を返す。
async function readLimited(response, maxBytes, controller) {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const buffer = Buffer.from(await response.arrayBuffer());
    return buffer.length > maxBytes ? null : buffer;
  }
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      controller.abort();
      reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

module.exports = { FAVICON_MAX_BYTES, FAVICON_TIMEOUT_MS, isFaviconUrl, pickFaviconUrl, detectFaviconType, fetchFaviconDataUrl };
