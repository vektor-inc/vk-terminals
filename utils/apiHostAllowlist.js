'use strict';

// HTTP API の Host ヘッダ許可リスト検証（issue #322）。
// Electron に依存しない純粋関数として切り出し、Node 標準以外には依存しない。

const { isLoopbackHost } = require('./loopbackHost');

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
    // 角括弧は IPv6 リテラル専用。localhost や IPv4 を囲った形式は受理しない。
    return match && match[1].includes(':') ? normalizeHost(match[1]) : '';
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
 * アクセストークン認証が必須なら認証側で保護されるため、有効な形式の Host は通す。
 * 認証が不要な場合だけ、ループバック・設定値・実際の待ち受け先と照合する。
 * @param {{ hostHeader?: unknown, apiHost?: unknown, actualHost?: unknown, authRequired?: boolean }} params
 * @returns {boolean}
 */
function isAllowedApiHost({ hostHeader, apiHost, actualHost, authRequired } = {}) {
  const configuredHost = normalizeHost(apiHost);
  const requestHost = parseHostHeader(hostHeader);
  // Host が無い・空・複数値（配列）・不正形式の場合は、認証の要否に関係なく拒否する。
  if (!requestHost) return false;

  // 認証必須の構成では、外部公開に使う MagicDNS 名や .local 名を事前に列挙できない。
  // DNS リバインディング経由では本アプリのトークンを提示できず認証で拒否されるため、
  // 有効な形式であることだけを確認して許可リスト照合は省略する。
  // shouldRequireAuth() は待ち受け先の未確定時も true（認証側の安全側）を返すが、ここでは
  // 照合省略という緩い側に働く。リクエストは待ち受け開始後にしか届かない前提に依存する。
  if (authRequired) return true;

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
