'use strict';

// HTTP API の Host ヘッダ許可リスト検証（issue #322）。
// Electron に依存しない純粋関数として切り出し、Node 標準以外には依存しない。

const { isLoopbackHost } = require('./loopbackHost');

const WILDCARD_HOSTS = new Set(['0.0.0.0', '::']);

/**
 * 比較用にホスト名・IP アドレスを正規化する。
 * @param {unknown} value
 * @returns {string}
 */
function normalizeHost(value) {
  if (typeof value !== 'string') return '';
  let host = value.trim().toLowerCase();
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  // DNS 名の末尾ドットは同じ名前の完全修飾表現なので、比較時は取り除く。
  if (host.endsWith('.') && !host.includes(':')) {
    host = host.slice(0, -1);
  }
  return host;
}

/**
 * Host ヘッダからポートを除いたホスト部を取り出す。
 * IPv6 リテラルは `[::1]:13847` の角括弧を外す。曖昧な形式は安全側に倒して拒否する。
 * @param {unknown} hostHeader
 * @returns {string}
 */
function parseHostHeader(hostHeader) {
  if (typeof hostHeader !== 'string') return '';
  const value = hostHeader.trim();
  if (!value) return '';

  if (value.startsWith('[')) {
    const match = value.match(/^\[([^\]]+)\](?::\d+)?$/);
    return match ? normalizeHost(match[1]) : '';
  }

  const colonIndex = value.lastIndexOf(':');
  if (colonIndex !== -1) {
    // IPv6 の Host ヘッダには角括弧が必須。コロンが複数ある形式は受理しない。
    if (value.indexOf(':') !== colonIndex) return '';
    const port = value.slice(colonIndex + 1);
    if (!/^\d+$/.test(port)) return '';
    return normalizeHost(value.slice(0, colonIndex));
  }

  return normalizeHost(value);
}

/**
 * HTTP API リクエストの Host ヘッダが安全な接続先を示しているか判定する。
 * @param {{ hostHeader?: unknown, apiHost?: unknown, actualHost?: unknown }} params
 * @returns {boolean}
 */
function isAllowedApiHost({ hostHeader, apiHost, actualHost } = {}) {
  const configuredHost = normalizeHost(apiHost);
  const requestHost = parseHostHeader(hostHeader);
  // Host が無い・空・複数値（配列）・不正形式の場合は、待ち受け設定に関係なく拒否する。
  if (!requestHost) return false;

  // 全インターフェース待ち受けでは、クライアントが到達に使う LAN IP 等を列挙できない。
  // この構成は既存の shouldRequireAuth() によりアクセストークン認証が必須になるため、
  // README に記載済みの LAN 公開を壊さないよう Host 許可リスト検証は通す。
  if (WILDCARD_HOSTS.has(configuredHost)) return true;

  if (isLoopbackHost(requestHost) || requestHost === 'localhost') return true;

  const allowedHosts = new Set([
    configuredHost,
    normalizeHost(actualHost),
  ].filter(Boolean));
  return allowedHosts.has(requestHost);
}

module.exports = {
  isAllowedApiHost,
  normalizeHost,
  parseHostHeader,
};
