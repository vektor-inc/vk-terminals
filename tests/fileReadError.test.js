'use strict';
// ファイル読み込みエラーをログへ渡す前の変換（sanitizeFileReadErrorForLog）の単体テスト
// （司の指摘・B-2）。main.js から utils/fileReadError.js へ切り出した際の回帰保護として
// 追加した。SyntaxError のときに元のメッセージを含まない文字列へ丸められること、それ以外は
// 素通しすることだけを確認する。安藤の指摘（A-7）どおり、何がどう漏れるかはここにも
// コミットメッセージにも書かない。テストの入力に使う文字列も鍵らしい見た目の値ではなく
// 無害なダミーにする。

const test = require('node:test');
const assert = require('node:assert/strict');

const { sanitizeFileReadErrorForLog } = require('../utils/fileReadError');

test('sanitizeFileReadErrorForLog: SyntaxError は元のメッセージを含まない文字列に丸められる', () => {
  const e = new SyntaxError('dummy parse error message for test');
  const result = sanitizeFileReadErrorForLog(e);
  assert.equal(typeof result, 'string');
  assert.ok(!result.includes('dummy parse error message for test'), '丸めた結果に元のメッセージが残っている');
  assert.ok(result.includes('SyntaxError'), 'エラー種別（SyntaxError）自体は残ってよい');
});

test('sanitizeFileReadErrorForLog: SyntaxError 以外（例: ENOENT の Error）はそのまま素通しする', () => {
  const e = new Error('dummy io error for test');
  e.code = 'ENOENT';
  assert.equal(sanitizeFileReadErrorForLog(e), e);
});

test('sanitizeFileReadErrorForLog: TypeError など SyntaxError 以外のエラー種別もそのまま素通しする', () => {
  const e = new TypeError('dummy type error for test');
  assert.equal(sanitizeFileReadErrorForLog(e), e);
});

test('sanitizeFileReadErrorForLog: エラーオブジェクトでない値（null 等）はそのまま返す', () => {
  assert.equal(sanitizeFileReadErrorForLog(null), null);
  assert.equal(sanitizeFileReadErrorForLog(undefined), undefined);
});
