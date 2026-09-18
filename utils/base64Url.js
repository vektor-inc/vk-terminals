'use strict';

// base64url（RFC 4648 §5。'+' '/' の代わりに '-' '_' を使い、パディング '=' を付けない
// 符号化）のデコードだけを行う小さいユーティリティ。Web Push 関連の値
// （VAPID 鍵・購読情報の鍵材料 p256dh/auth）はすべてこの形式で表現されるため、
// utils/webPushKeys.js と utils/webPushSubscriptions.js の両方から共通で使う
// （issue #396 安藤のセキュリティレビュー対応）。

/**
 * base64url 文字列をデコードする。文字集合（英数字・'-'・'_'、末尾のパディング '=' 0〜2個）に
 * 一致しない文字列は不正とみなし null を返す（Buffer.from は緩く、想定外の文字を黙って
 * 無視するため、事前にパターンで弾く）。
 *
 * 【末尾 '=' を許す理由（安藤のセキュリティレビュー再指摘・A-2）】Push API の仕様上は
 * パディング無しが標準で主要ブラウザも無しで生成するが、パディングの有無自体に安全上の
 * 意味は無く、本来の関門はデコード後のバイト長検証（isValidP256dhKey 等）である。
 * 以前はパディング付きの値を一律で不正として拒否していたため、この関数は VAPID 鍵ファイル
 * の検証（utils/webPushKeys.js）にも使われる関係で、外部要因（手動編集・別ツールでの
 * 生成等）でパディング付きの鍵が置かれた場合に「壊れている」と誤判定され、新しい鍵で
 * 上書き＝登録済み端末が全滅する経路があった。
 * @param {unknown} value
 * @returns {Buffer|null}
 */
function decodeBase64Url(value) {
  if (typeof value !== 'string' || value === '') return null;
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
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
