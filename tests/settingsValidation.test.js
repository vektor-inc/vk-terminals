'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isPatternValid } = require('../renderer/settingsValidation');

// <owner>/<repo> 形式を要求する代表的な pattern。
const REPO_PATTERN = '^[^/\\s]+/[^/\\s]+$';

test('isPatternValid: pattern 未指定は常に valid（後方互換）', () => {
  assert.equal(isPatternValid(undefined, 'anything'), true);
  assert.equal(isPatternValid(null, 'anything'), true);
  assert.equal(isPatternValid('', 'anything'), true);
});

test('isPatternValid: trim 後が空なら valid（空欄許容）', () => {
  assert.equal(isPatternValid(REPO_PATTERN, ''), true);
  assert.equal(isPatternValid(REPO_PATTERN, '   '), true);
  assert.equal(isPatternValid(REPO_PATTERN, undefined), true);
});

test('isPatternValid: pattern に一致する値は valid', () => {
  assert.equal(isPatternValid(REPO_PATTERN, 'vektor-inc/vk-terminals'), true);
});

test('isPatternValid: pattern に一致しない値は invalid', () => {
  assert.equal(isPatternValid(REPO_PATTERN, 'vk-terminals'), false);
  assert.equal(isPatternValid(REPO_PATTERN, 'a/b/c'), false);
});

test('isPatternValid: 検証は trim 後の値で行う（前後空白は無視）', () => {
  // 生値には前後空白があるが、trim 後 'vektor-inc/vk-terminals' は一致する。
  assert.equal(isPatternValid(REPO_PATTERN, '  vektor-inc/vk-terminals  '), true);
});

test('isPatternValid: 壊れた pattern は fail-open で valid 扱い', () => {
  // 不正な正規表現（未閉じの括弧）でも保存不能にしない。
  assert.equal(isPatternValid('([', 'anything'), true);
});
