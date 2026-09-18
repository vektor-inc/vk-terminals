'use strict';

// Web Push（issue #396）の購読情報（スマートフォンごとの通知の宛先）に関する純粋関数群。
// main.js から Electron 依存とファイル I/O を切り離してテストしやすくするため、
// utils/apiAuth.js と同じ方針でここへ切り出している。ファイルの読み書き（永続化）は
// main.js 側が担い、このモジュールは「現在のリストと入力」から「次のリスト」を導く
// 計算だけを行う。

const { decodeBase64Url } = require('./base64Url');

// endpoint の長さ上限（安藤のセキュリティレビュー指摘・MEDIUM-4）。実際の値は数百文字程度で、
// 2048 文字は十分な余裕を持たせつつ、過大な値の保存・ログ出力を防ぐ上限。
const MAX_ENDPOINT_LENGTH = 2048;
// keys.p256dh（ECDH 公開鍵。非圧縮 P-256 = 65byte）・keys.auth（16byte の認証シークレット）の
// 期待バイト長（安藤のセキュリティレビュー指摘・MEDIUM-4）。値としての妥当性を見ずに型だけ
// 検証すると、不正な鍵材料の購読が 1 件登録された場合に送信が 404/410 以外の失敗を返し続け、
// 無効判定に当たらないため削除されずエラーログを出し続ける。
const P256DH_KEY_BYTES = 65;
const AUTH_KEY_BYTES = 16;

// 保存する購読情報の件数上限（安藤のセキュリティレビュー指摘・MEDIUM-4）。1台のブラウザ・
// 1利用者を想定した機能のため、20件あれば複数端末で使っても十分な余裕がある。
const MAX_SUBSCRIPTIONS = 20;

// endpoint に許可するホスト名の判定（安藤のセキュリティレビュー指摘・MEDIUM-2）。
// ループバック（127.0.0.0/8・::1）・リンクローカル（169.254.0.0/16・fe80::/10）に加えて
// プライベートアドレス全域（10.0.0.0/8・172.16.0.0/12・192.168.0.0/16・fc00::/7）も弾く。
//
// 【プライベートアドレスまで弾く判断】endpoint は PushManager.subscribe() の戻り値であり、
// 本来ブラウザ自身が Apple/Google/Mozilla 等が運営する公開のプッシュ配信サーバーの URL を
// 生成する。利用者が任意の URL を直接指定できる項目ではないため、正規の使い方でプライベート
// アドレスが来ることは無い。一方 POST /api/push-subscribe は認証済み端末からとはいえ任意の
// JSON ボディを受け取れるため、細工した endpoint（例: クラウドのメタデータサービスや社内
// ネットワークの IP）を登録させ、VK Terminals に「そのアドレスへ繰り返し POST させる」
// 踏み台（SSRF）にされうる。将来「自前のプッシュ配信サーバーを使う」余地は、そのサーバーも
// 公開ドメイン・公開 IP を持つのが通常のため、プライベートアドレス制限とは両立する
// （もし本当に private network 内でホストする要件が出た場合は、明示的な allowlist 設定を
// 別途追加する形にすべきで、既定を緩めるべきではないと判断した）。
// IPv4 射影アドレス（IPv4-mapped IPv6 address, ::ffff:0:0/96）に埋め込まれた IPv4 部分を
// 取り出す（安藤のセキュリティレビュー再指摘・A-1）。
//
// 【回避の実例】`https://[::ffff:127.0.0.1]/x` を渡すと、Node の URL 実装は
// ホスト名を正規化して `[::ffff:7f00:1]`（16進数2グループ表記）にする。以前の実装は
// IPv4 パターン（ドット区切り10進数）にも fe80:/fc00: 系の判定にも一致しないため、
// この表記のまま素通りしていた。`::ffff:10.0.0.1` → `::ffff:a00:1`、
// `::ffff:192.168.0.1` → `::ffff:c0a8:1` も同様。実際に web-push（Node の https.request）は
// このアドレスを IPv4 として解釈して接続するため、表記を変えるだけでプライベート
// アドレス拒否をすり抜けられてしまっていた。
//
// ドット区切り表記（`::ffff:127.0.0.1`）と、URL 正規化後の16進数2グループ表記
// （`::ffff:7f00:1`）の両方が入力として来うるため、両方を展開する。
// @param {string} h 小文字化・ブラケット除去済みのホスト名
// @returns {string|null} 埋め込まれた IPv4 アドレス（ドット区切り10進数）。埋め込みが無ければ null
function extractIPv4MappedAddress(h) {
  const dotted = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (dotted) return dotted[1];

  const hexGroups = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (hexGroups) {
    const g1 = parseInt(hexGroups[1], 16);
    const g2 = parseInt(hexGroups[2], 16);
    return [
      (g1 >> 8) & 0xff,
      g1 & 0xff,
      (g2 >> 8) & 0xff,
      g2 & 0xff,
    ].join('.');
  }
  return null;
}

function isPrivateOrLoopbackHostname(hostname) {
  let h = typeof hostname === 'string' ? hostname.toLowerCase() : '';
  if (!h) return true; // 空はどのみち URL パースで弾かれるはずだが、念のため安全側に倒す。
  // URL#hostname は IPv6 アドレスをブラケット付き（"[::1]"）で返すため、判定前に外す。
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);
  if (h === 'localhost') return true;

  const ipv4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 0) return true; // 0.0.0.0/8
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    return false;
  }

  // IPv4 射影アドレス（::ffff:a.b.c.d 系）は埋め込まれた IPv4 部分で判定し直す（A-1）。
  const mappedIPv4 = extractIPv4MappedAddress(h);
  if (mappedIPv4) return isPrivateOrLoopbackHostname(mappedIPv4);

  // IPv6（ブラケットは上で除去済み）。
  if (h === '::1' || h === '::') return true; // loopback / unspecified
  // fe80::/10 link-local。先頭16bitは "fe80"〜"febf" の範囲全体（第2バイトの上位2bitが
  // "10" となる 0x80〜0xbf）を覆う必要がある。以前は "fe80:" の前方一致のみだったため、
  // 同じ /10 の上半分（例: "febf::1"）を取りこぼしていた（安藤のセキュリティレビュー
  // 再指摘・A-1）。
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  if (/^f[cd][0-9a-f]{0,2}:/.test(h)) return true; // fc00::/7 unique local
  return false;
}
// 【拒否リスト方式の限界】この関数は拒否リスト方式であり完全ではない（例:
// 100.64.0.0/10 の CGNAT 共有アドレス空間、192.0.0.0/24 の IETF Protocol Assignments
// 等は今も通る）。目的は「主要な内部アドレスを塞ぐ」ことであり、全てのプライベート・
// 特殊用途アドレス空間を網羅することは求めていない（司からの差し戻し・A-1 の修正方針に
// 明記）。

// PushManager.subscribe() の戻り値（JSON 化したもの）の形。endpoint はプッシュ配信サーバーが
// 発行する宛先 URL（端末ごとに一意）で、これを購読情報の識別キーとして使う。
// keys.p256dh / keys.auth は暗号化に必要な鍵材料（web-push に渡す際に必須）。
function isValidSubscriptionShape(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (typeof sub.endpoint !== 'string' || !sub.endpoint) return false;
  if (sub.endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  // endpoint は https の URL のみ許可する（安藤のセキュリティレビュー指摘・MEDIUM-2）。
  // Web Push の仕様上、正規のプッシュ配信サーバーはすべて https のみで、http: に正規の
  // 用途は無い。node の https.request をそのまま使う web-push の実装では、http: の
  // endpoint を渡しても TLS ハンドシェイクを試みてしまい実際には機能しない
  // （PR 本文に記載の実機確認結果）。
  let parsed;
  try {
    parsed = new URL(sub.endpoint);
  } catch (_e) {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  if (isPrivateOrLoopbackHostname(parsed.hostname)) return false;
  if (!sub.keys || typeof sub.keys !== 'object') return false;
  if (!isValidP256dhKey(sub.keys.p256dh)) return false;
  if (!isValidAuthKey(sub.keys.auth)) return false;
  return true;
}

/**
 * @param {unknown} key base64url 文字列（65byte を期待）
 * @returns {boolean}
 */
function isValidP256dhKey(key) {
  const buf = decodeBase64Url(key);
  return !!buf && buf.length === P256DH_KEY_BYTES;
}

/**
 * @param {unknown} key base64url 文字列（16byte を期待）
 * @returns {boolean}
 */
function isValidAuthKey(key) {
  const buf = decodeBase64Url(key);
  return !!buf && buf.length === AUTH_KEY_BYTES;
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

/**
 * 新しい endpoint を追加してよいか（保存件数の上限に達していないか）を判定する
 * （安藤のセキュリティレビュー指摘・MEDIUM-4）。既存 endpoint の更新（置き換え）は
 * 件数が増えないため、上限に関わらず常に許可する。
 * @param {Array<{endpoint:string}>} list 現在の購読情報一覧
 * @param {string} endpoint 追加しようとしている endpoint
 * @param {number} [maxCount] 上限件数（既定 MAX_SUBSCRIPTIONS）
 * @returns {boolean}
 */
function canAddSubscription(list, endpoint, maxCount = MAX_SUBSCRIPTIONS) {
  const current = Array.isArray(list) ? list : [];
  const isExistingEndpoint = current.some((item) => item && item.endpoint === endpoint);
  if (isExistingEndpoint) return true;
  return current.length < maxCount;
}

module.exports = {
  MAX_ENDPOINT_LENGTH,
  P256DH_KEY_BYTES,
  AUTH_KEY_BYTES,
  MAX_SUBSCRIPTIONS,
  isPrivateOrLoopbackHostname,
  isValidP256dhKey,
  isValidAuthKey,
  normalizeSubscription,
  upsertSubscription,
  removeSubscriptionByEndpoint,
  canAddSubscription,
  isExpiredSubscriptionStatus,
  EXPIRED_SUBSCRIPTION_STATUS_CODES,
};
