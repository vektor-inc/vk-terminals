'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { extractUrlMatches, trimTrailingPunctuation } = require('../renderer/urlLinkify');

test('extractUrlMatches: 単純な http(s) URL を 1 件拾う', () => {
  const url = 'https://example.com/path';
  const text = `見てください ${url} です`;
  const expectedStart = text.indexOf(url);
  assert.deepEqual(extractUrlMatches(text), [
    { url, start: expectedStart, end: expectedStart + url.length },
  ]);
  const httpOnly = extractUrlMatches('http://example.com');
  assert.equal(httpOnly.length, 1);
  assert.equal(httpOnly[0].url, 'http://example.com');
});

test('extractUrlMatches: http/https 以外のスキームは拾わない', () => {
  assert.deepEqual(extractUrlMatches('ftp://example.com/file'), []);
  assert.deepEqual(extractUrlMatches('javascript:alert(1)'), []);
  assert.deepEqual(extractUrlMatches('file:///etc/passwd'), []);
  // "xhttp://" のように scheme の前に別の文字が続く場合、"http://" 部分は拾われるが
  // isSafeHttpUrl 的には正しい http(s) URL のため対象になる（scheme 直前の境界までは
  // 見ない設計。@xterm/addon-web-links の既定正規表現も同様の性質を持つ）。
  const withPrefix = extractUrlMatches('xhttps://example.com');
  assert.equal(withPrefix.length, 1);
  assert.equal(withPrefix[0].url, 'https://example.com');
});

test('extractUrlMatches: 1 行に複数 URL があればすべて拾う', () => {
  const text = '一次情報は https://example.com/a と https://example.com/b を参照。';
  const matches = extractUrlMatches(text);
  assert.equal(matches.length, 2);
  assert.equal(matches[0].url, 'https://example.com/a');
  assert.equal(matches[1].url, 'https://example.com/b');
  // start/end が実際の text の位置と一致すること
  for (const m of matches) {
    assert.equal(text.slice(m.start, m.end), m.url);
  }
});

test('extractUrlMatches: 末尾の日本語句読点を URL に含めない', () => {
  assert.deepEqual(extractUrlMatches('詳しくはこちら：https://example.com/foo。').map((m) => m.url), [
    'https://example.com/foo',
  ]);
  assert.deepEqual(extractUrlMatches('こちらです→https://example.com/bar、続きます').map((m) => m.url), [
    'https://example.com/bar',
  ]);
});

test('extractUrlMatches: 末尾の半角記号（, . : ;）を URL に含めない', () => {
  assert.equal(extractUrlMatches('参照: https://example.com/a,')[0].url, 'https://example.com/a');
  assert.equal(extractUrlMatches('参照 https://example.com/a.')[0].url, 'https://example.com/a');
  assert.equal(extractUrlMatches('参照 https://example.com/a;')[0].url, 'https://example.com/a');
  // URL 自体の一部としての ':'（ポート番号）は残る
  assert.equal(extractUrlMatches('サーバー http://example.com:8080/path です')[0].url, 'http://example.com:8080/path');
});

test('extractUrlMatches: 対応の取れていない末尾の閉じカッコを URL に含めない', () => {
  assert.equal(
    extractUrlMatches('（詳細は https://example.com/foo ）を参照')[0].url,
    'https://example.com/foo',
  );
  assert.equal(
    extractUrlMatches('(see https://example.com/foo)')[0].url,
    'https://example.com/foo',
  );
  assert.equal(
    extractUrlMatches('「参考: https://example.com/foo」')[0].url,
    'https://example.com/foo',
  );
  // 記号が連続していても 1 文字ずつ削って正しく処理する
  assert.equal(
    extractUrlMatches('(see https://example.com/foo)。')[0].url,
    'https://example.com/foo',
  );
});

test('extractUrlMatches: URL 自体に含まれる対応の取れた括弧は壊さない（Wikipedia 形式）', () => {
  const text = 'https://en.wikipedia.org/wiki/Foo_(disambiguation)';
  assert.equal(extractUrlMatches(text)[0].url, text);

  // 文中に埋め込まれていても、対応が取れていれば保持する
  const withTail = extractUrlMatches(
    `参照: https://en.wikipedia.org/wiki/Foo_(disambiguation) を見てください`,
  );
  assert.equal(withTail[0].url, 'https://en.wikipedia.org/wiki/Foo_(disambiguation)');

  // URL を囲む地の文の括弧と、URL 自体が持つ対応の取れた括弧が混在するケース。
  // 外側の "))" のうち 1 個だけ地の文由来として切り落とし、URL 内で対応の取れた
  // "(bar)" は残す。
  const nested = extractUrlMatches('(see https://example.com/foo(bar))');
  assert.equal(nested[0].url, 'https://example.com/foo(bar)');
});

test('extractUrlMatches: URL の直後に区切り無しで日本語が続いても取り込まない', () => {
  const matches = extractUrlMatches('詳しくはhttps://example.comをご確認ください');
  assert.equal(matches.length, 1);
  assert.equal(matches[0].url, 'https://example.com');
});

test('extractUrlMatches: 引用符・山括弧・バッククォートで囲われた URL はそこで区切る', () => {
  assert.equal(extractUrlMatches('"https://example.com/a"')[0].url, 'https://example.com/a');
  assert.equal(extractUrlMatches("'https://example.com/a'")[0].url, 'https://example.com/a');
  assert.equal(extractUrlMatches('<https://example.com/a>')[0].url, 'https://example.com/a');
  assert.equal(extractUrlMatches('`https://example.com/a`')[0].url, 'https://example.com/a');
});

test('extractUrlMatches: 空・非文字列・URL を含まないテキストは空配列', () => {
  assert.deepEqual(extractUrlMatches(''), []);
  assert.deepEqual(extractUrlMatches('ただのログ出力です'), []);
  assert.deepEqual(extractUrlMatches(null), []);
  assert.deepEqual(extractUrlMatches(undefined), []);
  assert.deepEqual(extractUrlMatches(12345), []);
});

test('extractUrlMatches: 末尾記号を全部落として不正 URL になるものは弾く', () => {
  // "," を全部削ると "https://" だけが残り、isSafeHttpUrl が false を返すため除外される
  assert.deepEqual(extractUrlMatches('https://,,,'), []);
});

test('trimTrailingPunctuation: 単体でも記号の組み合わせを正しく処理する', () => {
  assert.equal(trimTrailingPunctuation('https://example.com'), 'https://example.com');
  assert.equal(trimTrailingPunctuation('https://example.com.'), 'https://example.com');
  assert.equal(trimTrailingPunctuation('https://example.com)。'), 'https://example.com');
  assert.equal(
    trimTrailingPunctuation('https://en.wikipedia.org/wiki/Foo_(disambiguation)'),
    'https://en.wikipedia.org/wiki/Foo_(disambiguation)',
  );
});
