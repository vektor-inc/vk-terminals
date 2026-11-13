'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { MAX_SAFE_HTTP_URL_LENGTH, isSafeHttpUrl, normalizeBrowserAddress, resolveBrowserAddress } = require('../renderer/urlSafety');
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

test('アドレス欄は URL、ローカルホスト、検索語を安全な URL に変換する', () => {
  assert.equal(normalizeBrowserAddress(' https://example.com/path?q=1 '), 'https://example.com/path?q=1');
  assert.equal(normalizeBrowserAddress('http://example.com'), 'http://example.com');
  assert.equal(normalizeBrowserAddress('github.com/vektor-inc'), 'https://github.com/vektor-inc');
  assert.equal(normalizeBrowserAddress('example.com:8080/path'), 'https://example.com:8080/path');
  assert.equal(normalizeBrowserAddress('bücher.de'), 'https://bücher.de');
  assert.equal(normalizeBrowserAddress('bücher.de/path'), 'https://bücher.de/path');
  assert.equal(normalizeBrowserAddress('例え.テスト'), 'https://例え.テスト');
  assert.equal(normalizeBrowserAddress('例え.テスト:443/道'), 'https://例え.テスト:443/道');
  assert.equal(normalizeBrowserAddress('localhost:8888/path'), 'http://localhost:8888/path');
  assert.equal(normalizeBrowserAddress('127.0.0.1:8888'), 'http://127.0.0.1:8888');
  assert.equal(normalizeBrowserAddress('WordPress 検索'), 'https://www.google.com/search?q=WordPress%20%E6%A4%9C%E7%B4%A2');
  assert.equal(normalizeBrowserAddress('例え テスト'), 'https://www.google.com/search?q=%E4%BE%8B%E3%81%88%20%E3%83%86%E3%82%B9%E3%83%88');
  assert.equal(normalizeBrowserAddress('example'), 'https://www.google.com/search?q=example');
});

test('アドレス欄は IPv4 アドレスとポート番号付きの 1 語のホスト名を検索に送らない', () => {
  // 社内・ローカルのアドレスは http:// を補った URL として開く。
  assert.equal(normalizeBrowserAddress('192.168.1.10'), 'http://192.168.1.10');
  assert.equal(normalizeBrowserAddress('192.168.1.10:3000/path'), 'http://192.168.1.10:3000/path');
  assert.equal(normalizeBrowserAddress('10.0.0.255?q=1'), 'http://10.0.0.255?q=1');
  assert.equal(normalizeBrowserAddress('myserver:3000'), 'http://myserver:3000');
  assert.equal(normalizeBrowserAddress('myserver:3000/path'), 'http://myserver:3000/path');
  assert.equal(normalizeBrowserAddress('dev-box:8080#top'), 'http://dev-box:8080#top');
  // 既存の localhost とドメインの扱いは変えない。
  assert.equal(normalizeBrowserAddress('localhost'), 'http://localhost');
  assert.equal(normalizeBrowserAddress('127.0.0.1:8888/path'), 'http://127.0.0.1:8888/path');
  assert.equal(normalizeBrowserAddress('github.com/vektor-inc'), 'https://github.com/vektor-inc');
  // ポート番号の無い 1 語は検索語のまま、範囲外の数値は IPv4 アドレスとして扱わない。
  assert.equal(normalizeBrowserAddress('myserver'), 'https://www.google.com/search?q=myserver');
  assert.equal(normalizeBrowserAddress('256.1.1.1'), 'https://www.google.com/search?q=256.1.1.1');
  assert.equal(normalizeBrowserAddress('192.168.1'), 'https://www.google.com/search?q=192.168.1');
  assert.equal(normalizeBrowserAddress('myserver:99999'), null);
  assert.equal(normalizeBrowserAddress('javascript:alert(1)'), `https://www.google.com/search?q=${encodeURIComponent('javascript:alert(1)')}`);
});

test('アドレス欄は危険なスキームを検索し、空欄と不正な URL は開かない', () => {
  for (const value of ['javascript:alert(1)', 'data:text/html,hello', 'file:///etc/passwd', 'ftp://example.com']) {
    assert.equal(normalizeBrowserAddress(value), `https://www.google.com/search?q=${encodeURIComponent(value)}`);
  }
  for (const value of ['https://', ' ', null]) assert.equal(normalizeBrowserAddress(value), null);
  assert.equal(normalizeBrowserAddress('example.com:99999/path'), null);
  assert.equal(normalizeBrowserAddress('a'.repeat(MAX_SAFE_HTTP_URL_LENGTH)), null);
});

test('アドレス欄の失敗理由は候補 URL と検索 URL を分けて判定する', () => {
  assert.equal(resolveBrowserAddress(' ').error, 'empty');
  assert.equal(resolveBrowserAddress(`https://example.com:99999/${'あ'.repeat(300)}`).error, 'invalid');
  assert.equal(resolveBrowserAddress(`https://example.com/${'a'.repeat(MAX_SAFE_HTTP_URL_LENGTH)}`).error, 'too-long');
  assert.equal(resolveBrowserAddress('あ'.repeat(700)).error, 'too-long');
  assert.equal(resolveBrowserAddress('example.com').error, null);
});
