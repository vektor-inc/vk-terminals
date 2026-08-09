'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  extractUrlMatches,
  trimTrailingPunctuation,
  getUrlHost,
  hasUserInfo,
  isAcceptableUrlHost,
} = require('../renderer/urlLinkify');
const { MAX_SAFE_HTTP_URL_LENGTH } = require('../renderer/urlSafety');

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

// ─── ユーザー情報付き URL（なりすまし対策）（安藤レビュー指摘・MEDIUM） ──────────────
test('hasUserInfo: user:pass@host / user@host 形式を検出する', () => {
  assert.equal(hasUserInfo('https://github.com@evil.example/login'), true);
  assert.equal(hasUserInfo('https://user:pass@host.com/'), true);
  assert.equal(hasUserInfo('https://token@github.com/x'), true);
  assert.equal(hasUserInfo('https://example.com/path'), false);
});

test('extractUrlMatches: ユーザー情報付き URL はなりすましの恐れがあるためリンク化しない', () => {
  // 見た目上は github.com への URL に見えても、実際のホストは evil.example になる
  // （@ より前がユーザー情報として解釈されるため）。
  assert.deepEqual(extractUrlMatches('https://github.com@evil.example/login'), []);
  assert.deepEqual(extractUrlMatches('アクセストークン付き: https://token@github.com/x を開く'), []);
});

test('extractUrlMatches: 折り返しをまたいで偶然できる「ユーザー情報付き URL」も弾く', () => {
  // terminalLinkProvider.js が折り返し行を連結した結果、行末の "https://github.com" と
  // 次行頭の "@evil.example/x"（例えば前景色を背景色と同じにして不可視にできる）が
  // 1 本の文字列として渡ってくるケースを想定したテスト。
  const merged = 'https://github.com@evil.example/x';
  assert.deepEqual(extractUrlMatches(merged), []);
});

// ─── ホスト名にドットが無い候補の除外（ローカル開発サーバは許可）（安藤レビュー指摘・LOW） ──
test('isAcceptableUrlHost: localhost・IPv4・IPv6 リテラルは許可する', () => {
  assert.equal(isAcceptableUrlHost('http://localhost:8888/'), true);
  assert.equal(isAcceptableUrlHost('http://127.0.0.1:3000/'), true);
  assert.equal(isAcceptableUrlHost('http://[::1]:8080/path'), true);
});

test('isAcceptableUrlHost: ドットを含まない一般ホスト名は弾く', () => {
  assert.equal(isAcceptableUrlHost('https://-'), false);
  assert.equal(isAcceptableUrlHost('https://g'), false);
});

test('extractUrlMatches: ローカル開発サーバの URL はリンク化する', () => {
  assert.equal(extractUrlMatches('サーバー起動: http://localhost:8888/ です')[0].url, 'http://localhost:8888/');
  assert.equal(extractUrlMatches('http://127.0.0.1:3000/api')[0].url, 'http://127.0.0.1:3000/api');
  assert.equal(extractUrlMatches('http://[::1]:8080/path')[0].url, 'http://[::1]:8080/path');
});

test('extractUrlMatches: 非 ASCII ドメインが途中で切れてドット無しになったものは弾く', () => {
  // "https://götest.com" は ö が候補文字集合に含まれないため "https://g" として
  // 切り出されるが、ホスト名にドットが無いため除外される（開いても無意味なページになる）。
  assert.deepEqual(extractUrlMatches('https://götest.com'), []);
  assert.deepEqual(extractUrlMatches('参照: https://-/foo です'), []);
});

test('extractUrlMatches: 大文字スキーム（HTTPS://）も拾う', () => {
  assert.equal(extractUrlMatches('参照 HTTPS://EXAMPLE.COM/A です')[0].url, 'HTTPS://EXAMPLE.COM/A');
});

test('extractUrlMatches: MAX_SAFE_HTTP_URL_LENGTH（2048文字）を超える URL は弾く', () => {
  const tooLong = `https://example.com/${'a'.repeat(MAX_SAFE_HTTP_URL_LENGTH)}`;
  assert.deepEqual(extractUrlMatches(tooLong), []);
});

// ─── ツールチップ表示用のホスト取得 ──────────────────────────────────────────────
test('getUrlHost: ポート込みのホストを返す。解析失敗時は空文字', () => {
  assert.equal(getUrlHost('https://github.com@evil.example/login'), 'evil.example');
  assert.equal(getUrlHost('http://127.0.0.1:3000/'), '127.0.0.1:3000');
  assert.equal(getUrlHost('not a url'), '');
});

test('getUrlHost: パーセントエンコードされたホストも解決後の実ホストを返す', () => {
  // "%67ithub.com" は new URL() 側でデコードされ実際には github.com を指す。
  // ツールチップに出す host は「表示テキストに惑わされない実際の行き先」である
  // ことの確認（安藤レビュー指摘）。
  assert.equal(getUrlHost('https://%67ithub.com/'), 'github.com');
});

test('trimTrailingPunctuation: 大量の閉じカッコが連続しても正しく全部削り切る（性能改善の回帰確認）', () => {
  // 以前は 1 文字削るたびに slice + 再カウントしており O(n^2) だった
  // （安藤レビュー指摘・LOW）。件数を増やしても正しく末尾を全部削り切れることを確認する。
  const url = 'https://example.com/a';
  const closing = ')'.repeat(2000);
  assert.equal(trimTrailingPunctuation(url + closing), url);
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
