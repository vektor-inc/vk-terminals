'use strict';
// Web Push（issue #396）の購読情報（端末ごとの通知の宛先）に関する純粋関数のテスト。
// main.js（Electron 依存・ファイル I/O）を経由せず、utils/webPushSubscriptions.js 単体で検証する。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const {
  normalizeSubscription,
  upsertSubscription,
  removeSubscriptionByEndpoint,
  canAddSubscription,
  isExpiredSubscriptionStatus,
  isPrivateOrLoopbackHostname,
  isValidP256dhKey,
  isValidAuthKey,
  MAX_ENDPOINT_LENGTH,
  MAX_SUBSCRIPTIONS,
} = require('../utils/webPushSubscriptions');

// p256dh は 65byte（非圧縮 P-256 公開鍵）・auth は 16byte（認証シークレット）の
// base64url エンコード。実際のブラウザが生成する PushSubscription.toJSON() と
// 同じバイト長にしないと、安藤のセキュリティレビュー指摘（MEDIUM-4）で追加した
// 長さ検証に弾かれる。
function makeP256dh() {
  return crypto.randomBytes(65).toString('base64url');
}
function makeAuth() {
  return crypto.randomBytes(16).toString('base64url');
}

const VALID_KEYS = { p256dh: makeP256dh(), auth: makeAuth() };
const VALID_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: VALID_KEYS,
};

test('normalizeSubscription: 正しい形の購読情報はそのまま（余分なフィールドを落として）返す', () => {
  const withExtra = { ...VALID_SUB, expirationTime: null, extra: 'ignored' };
  const result = normalizeSubscription(withExtra);
  assert.deepEqual(result, VALID_SUB);
  assert.equal('expirationTime' in result, false);
  assert.equal('extra' in result, false);
});

test('normalizeSubscription: endpoint が欠落・空文字なら null', () => {
  assert.equal(normalizeSubscription({ keys: VALID_KEYS }), null);
  assert.equal(normalizeSubscription({ endpoint: '', keys: VALID_KEYS }), null);
});

test('normalizeSubscription: endpoint が https 以外のスキームなら null（http も含む）', () => {
  assert.equal(normalizeSubscription({ endpoint: 'javascript:alert(1)', keys: VALID_KEYS }), null);
  assert.equal(normalizeSubscription({ endpoint: 'ftp://example.com/x', keys: VALID_KEYS }), null);
  // http は Web Push の仕様上 https 以外に正規の用途が無いため不可（安藤のセキュリティ
  // レビュー指摘・MEDIUM-2）。
  assert.equal(normalizeSubscription({ endpoint: 'http://fcm.googleapis.com/fcm/send/abc', keys: VALID_KEYS }), null);
});

test('normalizeSubscription: endpoint がループバック・プライベートアドレスなら null（安藤のセキュリティレビュー指摘・MEDIUM-2）', () => {
  assert.equal(normalizeSubscription({ endpoint: 'https://127.0.0.1/x', keys: VALID_KEYS }), null);
  assert.equal(normalizeSubscription({ endpoint: 'https://localhost/x', keys: VALID_KEYS }), null);
  assert.equal(normalizeSubscription({ endpoint: 'https://169.254.169.254/x', keys: VALID_KEYS }), null); // クラウドのメタデータサービス
  assert.equal(normalizeSubscription({ endpoint: 'https://10.0.0.5/x', keys: VALID_KEYS }), null);
  assert.equal(normalizeSubscription({ endpoint: 'https://172.16.0.1/x', keys: VALID_KEYS }), null);
  assert.equal(normalizeSubscription({ endpoint: 'https://192.168.1.1/x', keys: VALID_KEYS }), null);
  assert.equal(normalizeSubscription({ endpoint: 'https://[::1]/x', keys: VALID_KEYS }), null);
});

test('normalizeSubscription: 公開のプッシュ配信サーバーの endpoint は通る', () => {
  assert.ok(normalizeSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc', keys: VALID_KEYS }));
  assert.ok(normalizeSubscription({ endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/xyz', keys: VALID_KEYS }));
});

test('normalizeSubscription: endpoint が長さ上限を超えると null（安藤のセキュリティレビュー指摘・MEDIUM-4）', () => {
  const longEndpoint = 'https://fcm.googleapis.com/fcm/send/' + 'a'.repeat(MAX_ENDPOINT_LENGTH);
  assert.equal(normalizeSubscription({ endpoint: longEndpoint, keys: VALID_KEYS }), null);
});

test('normalizeSubscription: endpoint がパース不能な文字列なら null', () => {
  assert.equal(normalizeSubscription({ endpoint: 'not a url', keys: VALID_KEYS }), null);
});

test('normalizeSubscription: keys.p256dh / keys.auth が欠落していれば null', () => {
  assert.equal(normalizeSubscription({ endpoint: VALID_SUB.endpoint, keys: { auth: VALID_KEYS.auth } }), null);
  assert.equal(normalizeSubscription({ endpoint: VALID_SUB.endpoint, keys: { p256dh: VALID_KEYS.p256dh } }), null);
  assert.equal(normalizeSubscription({ endpoint: VALID_SUB.endpoint }), null);
});

test('normalizeSubscription: keys.p256dh / keys.auth の長さが不正なら null（安藤のセキュリティレビュー指摘・MEDIUM-4）', () => {
  assert.equal(normalizeSubscription({ endpoint: VALID_SUB.endpoint, keys: { p256dh: 'too-short', auth: VALID_KEYS.auth } }), null);
  assert.equal(normalizeSubscription({ endpoint: VALID_SUB.endpoint, keys: { p256dh: VALID_KEYS.p256dh, auth: 'too-short' } }), null);
  // 不正な鍵材料が 1 件でも入ると、送信が 404/410 以外の失敗を返し続けて削除されず
  // エラーログを出し続ける、という指摘の再現条件（形の似た文字列を弾けるか）。
  assert.equal(normalizeSubscription({ endpoint: VALID_SUB.endpoint, keys: { p256dh: 'p256dh-value', auth: 'auth-value' } }), null);
});

test('normalizeSubscription: null・undefined・非オブジェクトは null', () => {
  assert.equal(normalizeSubscription(null), null);
  assert.equal(normalizeSubscription(undefined), null);
  assert.equal(normalizeSubscription('string'), null);
  assert.equal(normalizeSubscription(42), null);
});

test('isValidP256dhKey / isValidAuthKey: 期待バイト長ちょうどなら true、ずれていれば false', () => {
  assert.equal(isValidP256dhKey(makeP256dh()), true);
  assert.equal(isValidP256dhKey(crypto.randomBytes(64).toString('base64url')), false);
  assert.equal(isValidAuthKey(makeAuth()), true);
  assert.equal(isValidAuthKey(crypto.randomBytes(17).toString('base64url')), false);
});

test('isPrivateOrLoopbackHostname: ループバック・リンクローカル・プライベートアドレスを判定する', () => {
  assert.equal(isPrivateOrLoopbackHostname('127.0.0.1'), true);
  assert.equal(isPrivateOrLoopbackHostname('169.254.1.1'), true);
  assert.equal(isPrivateOrLoopbackHostname('10.1.2.3'), true);
  assert.equal(isPrivateOrLoopbackHostname('172.31.255.255'), true);
  assert.equal(isPrivateOrLoopbackHostname('172.32.0.1'), false); // 172.16.0.0/12 の範囲外
  assert.equal(isPrivateOrLoopbackHostname('192.168.0.1'), true);
  assert.equal(isPrivateOrLoopbackHostname('::1'), true);
  assert.equal(isPrivateOrLoopbackHostname('fe80::1'), true);
  assert.equal(isPrivateOrLoopbackHostname('fc00::1'), true);
  // URL#hostname は IPv6 をブラケット付き（"[::1]"）で返すため、そのままでも判定できる必要がある
  // （new URL('https://[::1]/x').hostname === '[::1]' で実際に確認したうえでの回帰テスト）。
  assert.equal(isPrivateOrLoopbackHostname('[::1]'), true);
  assert.equal(isPrivateOrLoopbackHostname('[fe80::1]'), true);
  assert.equal(isPrivateOrLoopbackHostname('fcm.googleapis.com'), false);
  assert.equal(isPrivateOrLoopbackHostname('8.8.8.8'), false);
});

test('upsertSubscription: 新規 endpoint は追加される', () => {
  const result = upsertSubscription([], VALID_SUB);
  assert.deepEqual(result, [VALID_SUB]);
});

test('upsertSubscription: 同じ endpoint は置き換えられる（重複登録しない）', () => {
  const older = { endpoint: VALID_SUB.endpoint, keys: { p256dh: makeP256dh(), auth: makeAuth() } };
  const result = upsertSubscription([older], VALID_SUB);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], VALID_SUB);
});

test('upsertSubscription: 別の endpoint はどちらも残る', () => {
  const other = { endpoint: 'https://example.com/other', keys: { p256dh: makeP256dh(), auth: makeAuth() } };
  const result = upsertSubscription([other], VALID_SUB);
  assert.equal(result.length, 2);
});

test('upsertSubscription: 元の配列は変更しない（イミュータブル）', () => {
  const list = [];
  upsertSubscription(list, VALID_SUB);
  assert.equal(list.length, 0);
});

test('removeSubscriptionByEndpoint: 指定した endpoint だけを取り除く', () => {
  const other = { endpoint: 'https://example.com/other', keys: { p256dh: makeP256dh(), auth: makeAuth() } };
  const result = removeSubscriptionByEndpoint([VALID_SUB, other], VALID_SUB.endpoint);
  assert.deepEqual(result, [other]);
});

test('removeSubscriptionByEndpoint: 存在しない endpoint を指定しても変化しない（冪等）', () => {
  const result = removeSubscriptionByEndpoint([VALID_SUB], 'https://example.com/unknown');
  assert.deepEqual(result, [VALID_SUB]);
});

test('canAddSubscription: 上限未満なら新規 endpoint も追加できる', () => {
  assert.equal(canAddSubscription([], VALID_SUB.endpoint, 20), true);
});

test('canAddSubscription: 上限に達していると新規 endpoint は追加できない（安藤のセキュリティレビュー指摘・MEDIUM-4）', () => {
  const list = Array.from({ length: 20 }, (_v, i) => ({ endpoint: `https://example.com/${i}`, keys: VALID_KEYS }));
  assert.equal(canAddSubscription(list, 'https://example.com/new', 20), false);
});

test('canAddSubscription: 上限に達していても既存 endpoint の更新は常に許可する', () => {
  const list = Array.from({ length: 20 }, (_v, i) => ({ endpoint: `https://example.com/${i}`, keys: VALID_KEYS }));
  assert.equal(canAddSubscription(list, 'https://example.com/5', 20), true);
});

test('MAX_SUBSCRIPTIONS: 既定値は 20', () => {
  assert.equal(MAX_SUBSCRIPTIONS, 20);
});

test('isExpiredSubscriptionStatus: 404 / 410 は true（削除対象）', () => {
  assert.equal(isExpiredSubscriptionStatus(404), true);
  assert.equal(isExpiredSubscriptionStatus(410), true);
});

test('isExpiredSubscriptionStatus: それ以外のステータス・非数値は false（一時的なエラーとして保持）', () => {
  assert.equal(isExpiredSubscriptionStatus(500), false);
  assert.equal(isExpiredSubscriptionStatus(400), false);
  assert.equal(isExpiredSubscriptionStatus(200), false);
  assert.equal(isExpiredSubscriptionStatus(undefined), false);
  assert.equal(isExpiredSubscriptionStatus('404'), false);
});
