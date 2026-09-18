'use strict';
// base64url デコードの純粋関数テスト。utils/webPushKeys.js・utils/webPushSubscriptions.js の
// 両方が使う共通ユーティリティ（issue #396）。

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const { decodeBase64Url } = require('../utils/base64Url');

test('decodeBase64Url: 往復（encode→decode）でバイト列が一致する', () => {
  const original = crypto.randomBytes(32);
  const encoded = original.toString('base64url');
  const decoded = decodeBase64Url(encoded);
  assert.ok(decoded);
  assert.equal(Buffer.compare(decoded, original), 0);
});

test('decodeBase64Url: "-" "_" を含む base64url も正しくデコードする', () => {
  // 標準 base64 の "+" "/" に対応する文字が混じるまで試行する。
  let found = false;
  for (let i = 0; i < 50 && !found; i++) {
    const buf = crypto.randomBytes(24);
    const encoded = buf.toString('base64url');
    if (/[-_]/.test(encoded)) {
      found = true;
      assert.equal(Buffer.compare(decodeBase64Url(encoded), buf), 0);
    }
  }
  assert.ok(found, 'テスト条件（-_ を含む値）に到達できなかった');
});

test('decodeBase64Url: 許可されない文字（"+" "/" "=" 等）を含む文字列は null', () => {
  assert.equal(decodeBase64Url('abc+def'), null);
  assert.equal(decodeBase64Url('abc/def'), null);
  assert.equal(decodeBase64Url('abc='), null);
  assert.equal(decodeBase64Url('abc def'), null);
});

test('decodeBase64Url: 空文字・非文字列は null', () => {
  assert.equal(decodeBase64Url(''), null);
  assert.equal(decodeBase64Url(null), null);
  assert.equal(decodeBase64Url(undefined), null);
  assert.equal(decodeBase64Url(42), null);
});
