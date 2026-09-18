'use strict';
// VAPID 鍵（issue #396）の形式検証に関する純粋関数のテスト。main.js（Electron 依存）を
// 経由せず、utils/webPushKeys.js 単体で検証する。安藤のセキュリティレビュー指摘・HIGH-1
// （鍵ファイルが壊れているとアプリが起動不能になる）への対応で追加した。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const webpush = require('web-push');

const {
  isValidVapidPublicKey,
  isValidVapidPrivateKey,
  isValidVapidKeyPair,
  VAPID_PUBLIC_KEY_BYTES,
  VAPID_PRIVATE_KEY_BYTES,
} = require('../utils/webPushKeys');

test('isValidVapidKeyPair: web-push が実際に生成した鍵ペアは true（複数回・回帰確認）', () => {
  for (let i = 0; i < 5; i++) {
    const keys = webpush.generateVAPIDKeys();
    assert.equal(isValidVapidKeyPair(keys), true);
  }
});

test('isValidVapidPublicKey: 65byte の base64url なら true', () => {
  assert.equal(isValidVapidPublicKey(crypto.randomBytes(VAPID_PUBLIC_KEY_BYTES).toString('base64url')), true);
});

test('isValidVapidPublicKey: バイト長がずれていると false', () => {
  assert.equal(isValidVapidPublicKey(crypto.randomBytes(64).toString('base64url')), false);
  assert.equal(isValidVapidPublicKey(crypto.randomBytes(66).toString('base64url')), false);
});

test('isValidVapidPrivateKey: 32byte の base64url なら true', () => {
  assert.equal(isValidVapidPrivateKey(crypto.randomBytes(VAPID_PRIVATE_KEY_BYTES).toString('base64url')), true);
});

test('isValidVapidPrivateKey: バイト長がずれていると false', () => {
  assert.equal(isValidVapidPrivateKey(crypto.randomBytes(31).toString('base64url')), false);
  assert.equal(isValidVapidPrivateKey(crypto.randomBytes(33).toString('base64url')), false);
});

test('isValidVapidKeyPair: 空文字・短い文字列など壊れた値は false（安藤のセキュリティレビュー指摘・HIGH-1 の再現条件）', () => {
  assert.equal(isValidVapidKeyPair({ publicKey: '', privateKey: '' }), false);
  assert.equal(isValidVapidKeyPair({ publicKey: 'x', privateKey: 'y' }), false);
  assert.equal(isValidVapidKeyPair({ publicKey: 'not-base64url!!', privateKey: 'also-not!!' }), false);
});

test('isValidVapidKeyPair: フィールド欠落・非オブジェクトは false', () => {
  assert.equal(isValidVapidKeyPair(null), false);
  assert.equal(isValidVapidKeyPair(undefined), false);
  assert.equal(isValidVapidKeyPair({}), false);
  const valid = webpush.generateVAPIDKeys();
  assert.equal(isValidVapidKeyPair({ publicKey: valid.publicKey }), false);
  assert.equal(isValidVapidKeyPair({ privateKey: valid.privateKey }), false);
});

test('isValidVapidKeyPair: 公開鍵と秘密鍵が入れ替わっていると false（長さが異なるため検知できる）', () => {
  const valid = webpush.generateVAPIDKeys();
  assert.equal(isValidVapidKeyPair({ publicKey: valid.privateKey, privateKey: valid.publicKey }), false);
});
