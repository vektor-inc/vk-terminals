'use strict';

// Web Push（issue #396）の購読情報（スマートフォンごとの通知の宛先）に関する純粋関数群。
// main.js から Electron 依存とファイル I/O を切り離してテストしやすくするため、
// utils/apiAuth.js と同じ方針でここへ切り出している。ファイルの読み書き（永続化）は
// main.js 側が担い、このモジュールは「現在のリストと入力」から「次のリスト」を導く
// 計算だけを行う。

// PushManager.subscribe() の戻り値（JSON 化したもの）の形。endpoint はプッシュ配信サーバーが
// 発行する宛先 URL（端末ごとに一意）で、これを購読情報の識別キーとして使う。
// keys.p256dh / keys.auth は暗号化に必要な鍵材料（web-push に渡す際に必須）。
function isValidSubscriptionShape(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (typeof sub.endpoint !== 'string' || !sub.endpoint) return false;
  // endpoint はプッシュ配信サーバーの URL のみ許可する（http(s) 以外・不正な値を保存しない）。
  try {
    const parsed = new URL(sub.endpoint);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
  } catch (_e) {
    return false;
  }
  if (!sub.keys || typeof sub.keys !== 'object') return false;
  if (typeof sub.keys.p256dh !== 'string' || !sub.keys.p256dh) return false;
  if (typeof sub.keys.auth !== 'string' || !sub.keys.auth) return false;
  return true;
}

/**
 * リクエスト由来の生の値を、保存に使う最小限の形へ正規化する。
 * 不正な形（endpoint 欠落・keys 欠落など）は null を返す。余分なプロパティ
 * （expirationTime 等）は保存に不要なため落とす。
 * @param {unknown} raw
 * @returns {{ endpoint: string, keys: { p256dh: string, auth: string } } | null}
 */
function normalizeSubscription(raw) {
  if (!isValidSubscriptionShape(raw)) return null;
  return {
    endpoint: raw.endpoint,
    keys: {
      p256dh: raw.keys.p256dh,
      auth: raw.keys.auth,
    },
  };
}

/**
 * 購読情報を endpoint で一意化して追加・更新する（同じ endpoint が既にあれば置き換える）。
 * ブラウザは同じ端末でも再購読すると別の endpoint を発行しうるため、置換ではなく
 * endpoint 単位の upsert にする。
 * @param {Array<{endpoint:string}>} list 現在の購読情報一覧
 * @param {{endpoint:string}} subscription 追加・更新する購読情報（normalizeSubscription 済みの想定）
 * @returns {Array<{endpoint:string}>} 新しい配列（引数の list は変更しない）
 */
function upsertSubscription(list, subscription) {
  const current = Array.isArray(list) ? list : [];
  if (!subscription || typeof subscription.endpoint !== 'string' || !subscription.endpoint) return current.slice();
  const filtered = current.filter((item) => item && item.endpoint !== subscription.endpoint);
  filtered.push(subscription);
  return filtered;
}

/**
 * 指定した endpoint の購読情報を取り除く。
 * @param {Array<{endpoint:string}>} list
 * @param {string} endpoint
 * @returns {Array<{endpoint:string}>} 新しい配列
 */
function removeSubscriptionByEndpoint(list, endpoint) {
  const current = Array.isArray(list) ? list : [];
  if (typeof endpoint !== 'string' || !endpoint) return current.slice();
  return current.filter((item) => item && item.endpoint !== endpoint);
}

// プッシュ配信サーバーがこれらのステータスコードを返した場合、その購読情報は
// 恒久的に無効（利用者が通知を無効化した・端末の登録を解除した等）とみなして削除する。
// 404 Not Found（存在しない endpoint）・410 Gone（存在したが失効した endpoint）。
// それ以外（一時的なネットワークエラー・5xx 等）は削除せず次回の送信で再試行する。
const EXPIRED_SUBSCRIPTION_STATUS_CODES = new Set([404, 410]);

/**
 * プッシュ配信サーバーからのエラー応答が「この購読情報を削除すべき」ことを示すかを判定する。
 * @param {unknown} statusCode web-push が投げるエラー（WebPushError）の statusCode
 * @returns {boolean}
 */
function isExpiredSubscriptionStatus(statusCode) {
  return typeof statusCode === 'number' && EXPIRED_SUBSCRIPTION_STATUS_CODES.has(statusCode);
}

module.exports = {
  normalizeSubscription,
  upsertSubscription,
  removeSubscriptionByEndpoint,
  isExpiredSubscriptionStatus,
  EXPIRED_SUBSCRIPTION_STATUS_CODES,
};
