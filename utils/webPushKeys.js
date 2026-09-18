'use strict';

// VAPID 鍵（issue #396。送信元を証明する鍵のペア）の形式検証。main.js から Electron 依存を
// 切り離してテストしやすくするため、utils/apiAuth.js と同じ方針でここへ切り出している。
//
// 安藤のセキュリティレビュー指摘（HIGH-1）: 保存済み鍵ファイルが壊れていても
// 「空でない文字列か」だけの検証だと通ってしまい、webpush.setVapidDetails() が
// ファイル読み込み時点（main.js のトップレベル）で例外を投げてアプリごと起動不能になる。
// generateVAPIDKeys() が返す鍵の実体（非圧縮 P-256 公開鍵・32byte 秘密鍵）まで検証し、
// 壊れていることを起動前に検知できるようにする。

const { decodeBase64Url } = require('./base64Url');

// 非圧縮 P-256 公開鍵は 0x04 プレフィックス + X 座標32byte + Y 座標32byte = 65byte。
const VAPID_PUBLIC_KEY_BYTES = 65;
// P-256 の秘密鍵（スカラー値）は 32byte。
const VAPID_PRIVATE_KEY_BYTES = 32;

/**
 * @param {unknown} key base64url 文字列
 * @returns {boolean}
 */
function isValidVapidPublicKey(key) {
  const buf = decodeBase64Url(key);
  return !!buf && buf.length === VAPID_PUBLIC_KEY_BYTES;
}

/**
 * @param {unknown} key base64url 文字列
 * @returns {boolean}
 */
function isValidVapidPrivateKey(key) {
  const buf = decodeBase64Url(key);
  return !!buf && buf.length === VAPID_PRIVATE_KEY_BYTES;
}

/**
 * 鍵ペア（{ publicKey, privateKey }）の両方が正しい形式かを判定する。
 * @param {unknown} raw
 * @returns {boolean}
 */
function isValidVapidKeyPair(raw) {
  return !!raw && typeof raw === 'object'
    && isValidVapidPublicKey(raw.publicKey)
    && isValidVapidPrivateKey(raw.privateKey);
}

module.exports = {
  VAPID_PUBLIC_KEY_BYTES,
  VAPID_PRIVATE_KEY_BYTES,
  isValidVapidPublicKey,
  isValidVapidPrivateKey,
  isValidVapidKeyPair,
};
