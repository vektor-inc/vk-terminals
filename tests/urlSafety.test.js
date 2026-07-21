'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_SAFE_HTTP_URL_LENGTH, isSafeHttpUrl } = require('../renderer/urlSafety');
const mobilePreview = require('../renderer/mobilePreviewText');

test('isSafeHttpUrl: http/https のみ許可する', () => {
  assert.equal(isSafeHttpUrl('http://example.com/path'), true);
  assert.equal(isSafeHttpUrl('https://example.com/path'), true);
  assert.equal(isSafeHttpUrl('javascript:alert(1)'), false);
  assert.equal(isSafeHttpUrl('data:text/html,<p>x</p>'), false);
  assert.equal(isSafeHttpUrl('ftp://example.com/file'), false);
});

test('isSafeHttpUrl: 長さ上限・非文字列・不正 URL を拒否する', () => {
  assert.equal(isSafeHttpUrl('https://example.com/' + 'a'.repeat(MAX_SAFE_HTTP_URL_LENGTH)), false);
  assert.equal(isSafeHttpUrl(null), false);
  assert.equal(isSafeHttpUrl(undefined), false);
  assert.equal(isSafeHttpUrl({ url: 'https://example.com' }), false);
  assert.equal(isSafeHttpUrl('not a url'), false);
  assert.equal(isSafeHttpUrl(''), false);
});

test('mobilePreviewText.isSafeHttpUrl: 共有 URL 判定に委譲する', () => {
  assert.equal(mobilePreview.isSafeHttpUrl('https://example.com'), isSafeHttpUrl('https://example.com'));
  assert.equal(mobilePreview.isSafeHttpUrl('javascript:alert(1)'), isSafeHttpUrl('javascript:alert(1)'));
});
