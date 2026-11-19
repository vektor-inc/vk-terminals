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

const MAX_REDIRECTS = 5;

/**
 * 自分の端末や社内ネットワークを指すホスト名か（ループバック・プライベート・リンクローカルの IP アドレス、
 * localhost や .local などの名前、ドットを含まない 1 語のホスト名）。
 *
 * @param {string} hostname URL の hostname（IPv6 は角括弧付きでもよい）
 * @returns {boolean} 端末・社内側の宛先か
 */
function isLocalHostname(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!host) return true;
  if (/(^|\.)(localhost|local|internal|lan|home\.arpa)$/.test(host)) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = v4.slice(1, 3).map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::' || host === '::1' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host) || host.startsWith('::ffff:');
  return !host.includes('.');
}

/**
 * 表示中のページから、このファビコンを取りに行ってよいか。
 * 端末・社内側の宛先は、ページ自身が同じホストにあるときだけ許す（外部のページから内側へは取りに行かない）。
 *
 * @param {string} url 取得する URL
 * @param {string} pageUrl ファビコンを知らせたページの URL
 * @returns {boolean} 取得してよいか
 */
function isAllowedFaviconTarget(url, pageUrl) {
  if (!isFaviconUrl(url)) return false;
  const { hostname } = new URL(url);
  if (!isLocalHostname(hostname)) return true;
  if (!isFaviconUrl(pageUrl)) return false;
  return new URL(pageUrl).hostname === hostname;
}

/**
 * ファビコンを取得して data URL に変える。取得先・大きさ・待ち時間を制限し、失敗したときは空文字を返す（例外は投げない）。
 * リダイレクトは自分でたどり、送る前に毎回取得先を確かめる。終わり方によらず、残った通信は打ち切る。
 *
 * @param {string} url 取得する URL
 * @param {object} options
 * @param {Function} options.fetch fetch 互換の関数（アプリ内ブラウザのセッションの fetch）
 * @param {string} [options.pageUrl] ファビコンを知らせたページの URL（isAllowedFaviconTarget を参照）
 * @param {number} [options.timeoutMs] 待ち時間の上限（ミリ秒）
 * @param {number} [options.maxBytes] 本文の大きさの上限（バイト）
 * @returns {Promise<string>} data URL（失敗時は空文字）
 */
async function fetchFaviconDataUrl(url, { fetch, pageUrl = '', timeoutMs = FAVICON_TIMEOUT_MS, maxBytes = FAVICON_MAX_BYTES } = {}) {
  if (typeof fetch !== 'function') return '';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = url;
    let response;
    for (let hop = 0; ; hop++) {
      if (!isAllowedFaviconTarget(target, pageUrl)) return '';
      // Cookie などの認証情報は送らない（ページの表示には使わない取得のため）。
      response = await fetch(target, { signal: controller.signal, credentials: 'omit', redirect: 'manual' });
      if (!response || response.status < 300 || response.status >= 400) break;
      const location = response.headers?.get?.('location');
      if (!location || hop >= MAX_REDIRECTS) return '';
      response.body?.cancel?.().catch(() => {});
      target = new URL(location, target).href;
    }
    if (!response?.ok) return '';
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
    // 途中で断った応答の本文も読み続けさせない。
    controller.abort();
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

module.exports = { FAVICON_MAX_BYTES, FAVICON_TIMEOUT_MS, isFaviconUrl, isLocalHostname, isAllowedFaviconTarget, pickFaviconUrl, detectFaviconType, fetchFaviconDataUrl };
