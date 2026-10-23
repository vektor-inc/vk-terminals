'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPaneIdBadgeLabel } = require('../renderer/paneIdBadge');

test('getPaneIdBadgeLabel: 数値の文字列から「ペインid : <番号>」を返す', () => {
  assert.equal(getPaneIdBadgeLabel('6'), 'ペインid : 6');
});

test('getPaneIdBadgeLabel: 数値でも同じ表記になる', () => {
  assert.equal(getPaneIdBadgeLabel(12), 'ペインid : 12');
});

test('getPaneIdBadgeLabel: 別のペインIDに入れ替わると番号も追従する', () => {
  assert.notEqual(getPaneIdBadgeLabel('3'), getPaneIdBadgeLabel('4'));
  assert.equal(getPaneIdBadgeLabel('4'), 'ペインid : 4');
});

test('getPaneIdBadgeLabel: 空・未定義は空文字を返す', () => {
  assert.equal(getPaneIdBadgeLabel(''), '');
  assert.equal(getPaneIdBadgeLabel(undefined), '');
  assert.equal(getPaneIdBadgeLabel(null), '');
});
