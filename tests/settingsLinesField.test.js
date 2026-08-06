'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { linesFieldDisplayText } = require('../renderer/settingsLinesField');

test('linesFieldDisplayText: 配列は改行連結して表示する（従来どおり）', () => {
  assert.equal(linesFieldDisplayText(['/path/a', '/path/b']), '/path/a\n/path/b');
});

test('linesFieldDisplayText: 空配列は空文字になる（従来どおり）', () => {
  assert.equal(linesFieldDisplayText([]), '');
});

test('linesFieldDisplayText: 文字列はその内容をそのまま表示する（issue #339）', () => {
  // 設定ファイルに workspace.search_paths を文字列で書いた場合の再現。
  assert.equal(linesFieldDisplayText('/Users/me/projects'), '/Users/me/projects');
  assert.equal(linesFieldDisplayText('/a\n/b'), '/a\n/b');
});

test('linesFieldDisplayText: 文字列でも配列でもない値は空欄にする', () => {
  // パスやオーナー名として意味を持たない値をそのまま表示すると壊れた値を見せることになるため、
  // 数値・真偽値・オブジェクト・null・undefined はすべて空文字にする。
  assert.equal(linesFieldDisplayText(123), '');
  assert.equal(linesFieldDisplayText(true), '');
  assert.equal(linesFieldDisplayText({ a: 1 }), '');
  assert.equal(linesFieldDisplayText(null), '');
  assert.equal(linesFieldDisplayText(undefined), '');
});
