'use strict';

// base64url（RFC 4648 §5。'+' '/' の代わりに '-' '_' を使い、パディング '=' を付けない
// 符号化）のデコードだけを行う小さいユーティリティ。Web Push 関連の値
// （VAPID 鍵・購読情報の鍵材料 p256dh/auth）はすべてこの形式で表現されるため、
// utils/webPushKeys.js と utils/webPushSubscriptions.js の両方から共通で使う
// （issue #396 安藤のセキュリティレビュー対応）。

/**
 * base64url 文字列をデコードする。文字集合（英数字・'-'・'_'）に一致しない文字列は
 * 不正とみなし null を返す（Buffer.from は緩く、想定外の文字を黙って無視するため、
 * 事前にパターンで弾く）。
 * @param {unknown} value
 * @returns {Buffer|null}
 */
function decodeBase64Url(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(base64, 'base64');
  } catch (_e) {
    return null;
  }
}

module.exports = {
  decodeBase64Url,
};
