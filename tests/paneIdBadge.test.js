'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { getPaneIdBadgeLabel } = require('../renderer/paneIdBadge');

test('getPaneIdBadgeLabel: 数値の文字列から「ペイン <番号>」を返す', () => {
  assert.equal(getPaneIdBadgeLabel('6'), 'ペイン 6');
});

test('getPaneIdBadgeLabel: 数値でも同じ表記になる', () => {
  assert.equal(getPaneIdBadgeLabel(12), 'ペイン 12');
});

test('getPaneIdBadgeLabel: 別のペインIDに入れ替わると番号も追従する', () => {
  assert.notEqual(getPaneIdBadgeLabel('3'), getPaneIdBadgeLabel('4'));
  assert.equal(getPaneIdBadgeLabel('4'), 'ペイン 4');
});

test('getPaneIdBadgeLabel: ターミナル未生成（terminals[paneId] が無い）想定の t?.termId は空文字', () => {
  const t = undefined;
  assert.equal(getPaneIdBadgeLabel(t?.termId), '');
  assert.equal(getPaneIdBadgeLabel({ cwd: '~' }.termId), '');
});

test('getPaneIdBadgeLabel: terminals エントリの termId から作る（pane-3 形式の paneId は使わない）', () => {
  const terminals = { 'pane-3': { termId: 6 } };
  assert.equal(getPaneIdBadgeLabel(terminals['pane-3']?.termId), 'ペイン 6');
});

test('getPaneIdBadgeLabel: 空・未定義は空文字を返す', () => {
  assert.equal(getPaneIdBadgeLabel(''), '');
  assert.equal(getPaneIdBadgeLabel(undefined), '');
  assert.equal(getPaneIdBadgeLabel(null), '');
});
