'use strict';
// Web Push（issue #396）の購読情報（端末ごとの通知の宛先）に関する純粋関数のテスト。
// main.js（Electron 依存・ファイル I/O）を経由せず、utils/webPushSubscriptions.js 単体で検証する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  normalizeSubscription,
  upsertSubscription,
  removeSubscriptionByEndpoint,
  isExpiredSubscriptionStatus,
} = require('../utils/webPushSubscriptions');

const VALID_SUB = {
  endpoint: 'https://fcm.googleapis.com/fcm/send/abc123',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
};

test('normalizeSubscription: 正しい形の購読情報はそのまま（余分なフィールドを落として）返す', () => {
  const withExtra = { ...VALID_SUB, expirationTime: null, extra: 'ignored' };
  const result = normalizeSubscription(withExtra);
  assert.deepEqual(result, VALID_SUB);
  assert.equal('expirationTime' in result, false);
  assert.equal('extra' in result, false);
});

test('normalizeSubscription: endpoint が欠落・空文字なら null', () => {
  assert.equal(normalizeSubscription({ keys: VALID_SUB.keys }), null);
  assert.equal(normalizeSubscription({ endpoint: '', keys: VALID_SUB.keys }), null);
});

test('normalizeSubscription: endpoint が http(s) 以外のスキームなら null', () => {
  assert.equal(normalizeSubscription({ endpoint: 'javascript:alert(1)', keys: VALID_SUB.keys }), null);
  assert.equal(normalizeSubscription({ endpoint: 'ftp://example.com/x', keys: VALID_SUB.keys }), null);
});

test('normalizeSubscription: endpoint がパース不能な文字列なら null', () => {
  assert.equal(normalizeSubscription({ endpoint: 'not a url', keys: VALID_SUB.keys }), null);
});

test('normalizeSubscription: keys.p256dh / keys.auth が欠落していれば null', () => {
  assert.equal(normalizeSubscription({ endpoint: VALID_SUB.endpoint, keys: { auth: 'a' } }), null);
  assert.equal(normalizeSubscription({ endpoint: VALID_SUB.endpoint, keys: { p256dh: 'p' } }), null);
  assert.equal(normalizeSubscription({ endpoint: VALID_SUB.endpoint }), null);
});

test('normalizeSubscription: null・undefined・非オブジェクトは null', () => {
  assert.equal(normalizeSubscription(null), null);
  assert.equal(normalizeSubscription(undefined), null);
  assert.equal(normalizeSubscription('string'), null);
  assert.equal(normalizeSubscription(42), null);
});

test('upsertSubscription: 新規 endpoint は追加される', () => {
  const result = upsertSubscription([], VALID_SUB);
  assert.deepEqual(result, [VALID_SUB]);
});

test('upsertSubscription: 同じ endpoint は置き換えられる（重複登録しない）', () => {
  const older = { endpoint: VALID_SUB.endpoint, keys: { p256dh: 'old', auth: 'old' } };
  const result = upsertSubscription([older], VALID_SUB);
  assert.equal(result.length, 1);
  assert.deepEqual(result[0], VALID_SUB);
});

test('upsertSubscription: 別の endpoint はどちらも残る', () => {
  const other = { endpoint: 'https://example.com/other', keys: { p256dh: 'x', auth: 'y' } };
  const result = upsertSubscription([other], VALID_SUB);
  assert.equal(result.length, 2);
});

test('upsertSubscription: 元の配列は変更しない（イミュータブル）', () => {
  const list = [];
  upsertSubscription(list, VALID_SUB);
  assert.equal(list.length, 0);
});

test('removeSubscriptionByEndpoint: 指定した endpoint だけを取り除く', () => {
  const other = { endpoint: 'https://example.com/other', keys: { p256dh: 'x', auth: 'y' } };
  const result = removeSubscriptionByEndpoint([VALID_SUB, other], VALID_SUB.endpoint);
  assert.deepEqual(result, [other]);
});

test('removeSubscriptionByEndpoint: 存在しない endpoint を指定しても変化しない（冪等）', () => {
  const result = removeSubscriptionByEndpoint([VALID_SUB], 'https://example.com/unknown');
  assert.deepEqual(result, [VALID_SUB]);
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
