'use strict';

// タブに出すファビコン（サイトの小さなアイコン）を、アプリ本体の側で取得して data URL に変える（issue #644）。
// 画面（renderer）の読み込み制限（CSP の img-src 'self' data:）を広げずに表示するため、
// ページから届いたアイコンの URL を画面に直接読ませない。

const dns = require('node:dns');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

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

// 外部の宛先として扱わないアドレスの範囲（ループバック・プライベート・リンクローカル・共有アドレス・
// 予約・マルチキャストなど）。IPv4 を埋め込んだ IPv6（::ffff:0:0/96）は BlockList が IPv4 の規則で判定するため、
// IPv6 の側にこの範囲を入れない（入れると IPv4 の判定にも当たり、外部の IPv4 まで止めてしまう）。
const NON_PUBLIC_RANGES = new net.BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) NON_PUBLIC_RANGES.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of [
  ['::', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['100::', 64], ['2001::', 23],
  ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8],
]) NON_PUBLIC_RANGES.addSubnet(address, prefix, 'ipv6');

/**
 * 外部（インターネット側）の IP アドレスか。IP アドレスとして読めないものは外部として扱わない。
 * IPv4 を埋め込んだ IPv6 の形（::ffff:127.0.0.1 など）は、埋め込まれた IPv4 で判定する。
 *
 * @param {string} address IP アドレス（IPv6 は角括弧なし）
 * @returns {boolean} 外部のアドレスか
 */
function isPublicAddress(address) {
  const family = net.isIP(String(address || ''));
  if (family === 0) return false;
  const lower = String(address).toLowerCase();
  const mapped = family === 6 && lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPublicAddress(mapped[1]);
  return !NON_PUBLIC_RANGES.check(lower, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * 名前解決した結果を確かめてから、その IP アドレスに接続させる lookup 関数を作る（http/https の lookup オプション用）。
 * 解決したアドレスが 1 つでも外部でなければ接続しない。接続先は確かめたアドレスそのもので、接続時に名前解決し直さない。
 *
 * @param {object} options
 * @param {boolean} options.allowNonPublic 端末・社内側のアドレスへの接続も許すか
 * @param {Function} [options.resolve] dns.lookup 互換の関数（(hostname, { all: true }, callback)。テストで差し替える）
 * @returns {Function} net.connect の lookup 互換の関数
 */
function createCheckedLookup({ allowNonPublic, resolve = dns.lookup }) {
  return (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const family = typeof options === 'number' ? options : options?.family;
    resolve(hostname, { all: true, family: family || 0 }, (error, addresses) => {
      if (error) { callback(error); return; }
      const list = (Array.isArray(addresses) ? addresses : []).filter(entry => net.isIP(String(entry?.address || '')));
      if (list.length === 0) { callback(Object.assign(new Error('favicon host has no address'), { code: 'ENOTFOUND' })); return; }
      if (!allowNonPublic && !list.every(entry => isPublicAddress(entry.address))) {
        callback(Object.assign(new Error('favicon host is not public'), { code: 'EFAVICONBLOCKED' }));
        return;
      }
      const checked = list.map(entry => ({ address: entry.address, family: net.isIP(entry.address) }));
      if (options?.all) callback(null, checked);
      else callback(null, checked[0].address, checked[0].family);
    });
  };
}

/**
 * ファビコン 1 件を GET する（リダイレクトはたどらない）。接続先は createCheckedLookup で確かめた IP アドレスに固定し、
 * IP アドレスを直接書いた URL は名前解決を経ないため、ここで同じ条件で確かめる。Cookie などの認証情報は付けない。
 *
 * @param {string} url 取得する URL（HTTP(S)）
 * @param {object} options
 * @param {AbortSignal} options.signal 打ち切り用
 * @param {boolean} options.allowNonPublic 端末・社内側のアドレスへの接続も許すか
 * @param {Function} [options.resolve] dns.lookup 互換の関数（テストで差し替える）
 * @returns {Promise<{status: number, ok: boolean, headers: {get: Function}, body: import('stream').Readable}>}
 */
function requestFavicon(url, { signal, allowNonPublic, resolve }) {
  return new Promise((resolvePromise, reject) => {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !allowNonPublic && !isPublicAddress(host)) {
      reject(Object.assign(new Error('favicon host is not public'), { code: 'EFAVICONBLOCKED' }));
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.request(parsed, {
      method: 'GET',
      signal,
      agent: false,
      lookup: createCheckedLookup({ allowNonPublic, resolve }),
      headers: { accept: 'image/*,*/*;q=0.8', 'accept-encoding': 'identity' },
    }, incoming => {
      const status = incoming.statusCode || 0;
      resolvePromise({
        status,
        ok: status >= 200 && status < 300,
        headers: { get: name => { const value = incoming.headers[String(name).toLowerCase()]; return value === undefined ? null : String(value); } },
        body: incoming,
      });
    });
    request.on('error', reject);
    request.end();
  });
}

/**
 * ファビコンを取得して data URL に変える。取得先・大きさ・待ち時間を制限し、失敗したときは空文字を返す（例外は投げない）。
 * リダイレクトは自分でたどり、送る前に毎回取得先を確かめる（URL の形と、名前解決した後のアドレスの両方）。
 * 終わり方によらず、残った通信は打ち切る。
 *
 * @param {string} url 取得する URL
 * @param {object} options
 * @param {string} [options.pageUrl] ファビコンを知らせたページの URL（isAllowedFaviconTarget を参照）
 * @param {number} [options.timeoutMs] 待ち時間の上限（ミリ秒）
 * @param {number} [options.maxBytes] 本文の大きさの上限（バイト）
 * @param {Function} [options.resolve] dns.lookup 互換の関数（テストで差し替える）
 * @param {Function} [options.transport] 1 件の GET を行う関数（requestFavicon と同じ形。テストで差し替える）
 * @returns {Promise<string>} data URL（失敗時は空文字）
 */
async function fetchFaviconDataUrl(url, { pageUrl = '', timeoutMs = FAVICON_TIMEOUT_MS, maxBytes = FAVICON_MAX_BYTES, resolve, transport = requestFavicon } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let target = url;
    let response;
    for (let hop = 0; ; hop++) {
      if (!isAllowedFaviconTarget(target, pageUrl)) return '';
      // 端末・社内側のアドレスへつなぐのは、ローカルのページが自分のホストのアイコンを取るときだけ。
      const allowNonPublic = isLocalHostname(new URL(target).hostname);
      response = await transport(target, { signal: controller.signal, allowNonPublic, resolve });
      if (!response || response.status < 300 || response.status >= 400) break;
      const location = response.headers?.get?.('location');
      if (!location || hop >= MAX_REDIRECTS) return '';
      discardBody(response);
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

// リダイレクトの応答など、使わない本文を捨てる。
function discardBody(response) {
  const body = response?.body;
  if (typeof body?.destroy === 'function') body.destroy();
  else body?.cancel?.().catch(() => {});
}

// 本文を上限まで読む。上限を超えたら読み込みを打ち切って null を返す。
// 本文は Node のストリーム（requestFavicon）と、fetch 互換の ReadableStream（テスト）の両方を受け付ける。
async function readLimited(response, maxBytes, controller) {
  const body = response.body;
  const reader = typeof body?.getReader === 'function' ? body.getReader() : null;
  const chunks = [];
  let total = 0;
  const push = value => {
    total += value.byteLength;
    if (total > maxBytes) return false;
    chunks.push(Buffer.from(value));
    return true;
  };
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!push(value)) {
        controller.abort();
        reader.cancel().catch(() => {});
        return null;
      }
    }
    return Buffer.concat(chunks);
  }
  if (body && typeof body[Symbol.asyncIterator] === 'function') {
    for await (const value of body) {
      if (!push(value)) {
        controller.abort();
        body.destroy?.();
        return null;
      }
    }
    return Buffer.concat(chunks);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  return buffer.length > maxBytes ? null : buffer;
}

module.exports = {
  FAVICON_MAX_BYTES, FAVICON_TIMEOUT_MS, isFaviconUrl, isLocalHostname, isAllowedFaviconTarget, isPublicAddress, createCheckedLookup, requestFavicon, pickFaviconUrl, detectFaviconType, fetchFaviconDataUrl,
};
