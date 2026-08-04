'use strict';
// CSP（Content Security Policy、issue #324）のポリシー文字列を固定する回帰テスト。
//
// tests/e2e/renderer-isolation.smoke.spec.js の securitypolicyviolation テストは
// script-src と frame-src の2ディレクティブしか実際に踏んで検証していないため、
// default-src / object-src / base-uri / form-action / connect-src / style-src が
// 誰かに削られても green のまま通ってしまう（安藤レビュー指摘）。ここでは
// renderer/index.html の <meta> の content 属性と、utils/csp.js の
// buildMobileCsp() が返すヘッダー文字列そのものを期待値と突き合わせ、
// 全ディレクティブを回帰対象にする。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { buildMobileCsp } = require('../utils/csp');

const INDEX_HTML_PATH = path.join(__dirname, '..', 'renderer', 'index.html');

// renderer/index.html の <meta http-equiv="Content-Security-Policy" content="..."> から
// content 属性の値だけを取り出す。
function readIndexCspMetaContent() {
  const html = fs.readFileSync(INDEX_HTML_PATH, 'utf8');
  const match = html.match(/<meta http-equiv="Content-Security-Policy" content="([^"]+)">/);
  assert.ok(match, 'renderer/index.html に CSP の <meta> タグが見つからない');
  return match[1];
}

// index.html（file:// 直読み込み）向けの CSP。<meta> は frame-ancestors / sandbox /
// report-uri を仕様上無視するため、これらのディレクティブは含めない
// （含めても「効いているつもり」の誤解を生むだけで実効性が無い。renderer/index.html の
// コメント参照）。
const EXPECTED_INDEX_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; font-src 'self'; connect-src 'none'; object-src 'none'; "
  + "base-uri 'none'; form-action 'none'; frame-src 'none'";

// mobile.html（HTTP 配信）向けの CSP。index.html との違いは utils/csp.js の
// buildMobileCsp() のコメントを参照（connect-src が 'self'・frame-ancestors 'none' を持つ）。
const EXPECTED_MOBILE_CSP = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
  + "img-src 'self' data:; font-src 'self'; connect-src 'self'; object-src 'none'; "
  + "base-uri 'none'; form-action 'none'; frame-src 'none'; frame-ancestors 'none'";

test('renderer/index.html の CSP <meta> は期待した全ディレクティブと完全一致する', () => {
  assert.equal(readIndexCspMetaContent(), EXPECTED_INDEX_CSP);
});

test('renderer/index.html の CSP <meta> には frame-ancestors を含めない（<meta> では無視され意味が無いため）', () => {
  assert.doesNotMatch(readIndexCspMetaContent(), /frame-ancestors/);
});

test('buildMobileCsp() は期待した全ディレクティブと完全一致する（frame-ancestors none を含む）', () => {
  assert.equal(buildMobileCsp(), EXPECTED_MOBILE_CSP);
});

test('buildMobileCsp() は frame-src none と frame-ancestors none の両方を持つ（埋め込む／埋め込まれるの両方向を塞ぐ）', () => {
  const csp = buildMobileCsp();
  assert.match(csp, /(?:^|;\s*)frame-src 'none'/);
  assert.match(csp, /(?:^|;\s*)frame-ancestors 'none'/);
});
