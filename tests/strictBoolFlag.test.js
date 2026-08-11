'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseStrictBoolFlag } = require('../utils/strictBoolFlag');

// POST /api/set-title の prMerged / waitingMerge（issue #44 / #363）が共有する
// 真偽値パーサ。厳密な true のときだけ true、それ以外はすべて false に倒す。

test('parseStrictBoolFlag: 厳密な true のみ true を返す', () => {
  assert.equal(parseStrictBoolFlag(true), true);
});

test('parseStrictBoolFlag: false は false を返す', () => {
  assert.equal(parseStrictBoolFlag(false), false);
});

test('parseStrictBoolFlag: 未指定（undefined）は false を返す（後方互換の担保）', () => {
  assert.equal(parseStrictBoolFlag(undefined), false);
});

test('parseStrictBoolFlag: 文字列 "true" は false を返す', () => {
  assert.equal(parseStrictBoolFlag('true'), false);
});

test('parseStrictBoolFlag: null・数値・オブジェクト等の非 boolean 値も false を返す', () => {
  assert.equal(parseStrictBoolFlag(null), false);
  assert.equal(parseStrictBoolFlag(1), false);
  assert.equal(parseStrictBoolFlag(0), false);
  assert.equal(parseStrictBoolFlag({}), false);
  assert.equal(parseStrictBoolFlag([]), false);
});
