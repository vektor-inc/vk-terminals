'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isFieldVisible } = require('../renderer/settingsVisibility');

test('isFieldVisible: visibleWhen 未指定は常に visible', () => {
  assert.equal(isFieldVisible({ key: 'target' }, { mode: 'basic' }), true);
  assert.equal(isFieldVisible({ key: 'target', visibleWhen: undefined }, { mode: 'basic' }), true);
});

test('isFieldVisible: hide:true は一致したら hidden、不一致なら visible', () => {
  const field = { key: 'target', visibleWhen: { key: 'mode', value: 'advanced', hide: true } };

  assert.equal(isFieldVisible(field, { mode: 'advanced' }), false);
  assert.equal(isFieldVisible(field, { mode: 'basic' }), true);
});

test('isFieldVisible: hide:false は一致したら visible、不一致なら hidden', () => {
  const field = { key: 'target', visibleWhen: { key: 'mode', value: 'advanced', hide: false } };

  assert.equal(isFieldVisible(field, { mode: 'advanced' }), true);
  assert.equal(isFieldVisible(field, { mode: 'basic' }), false);
});

test('isFieldVisible: hide 省略は positive 条件として扱う', () => {
  const field = { key: 'target', visibleWhen: { key: 'mode', value: 'advanced' } };

  assert.equal(isFieldVisible(field, { mode: 'advanced' }), true);
  assert.equal(isFieldVisible(field, { mode: 'basic' }), false);
});

test('isFieldVisible: 配列はどれかが hide 評価なら hidden', () => {
  const field = {
    key: 'target',
    visibleWhen: [
      { key: 'mode', value: 'advanced' },
      { key: 'disabled', value: true, hide: true },
    ],
  };

  assert.equal(isFieldVisible(field, { mode: 'advanced', disabled: true }), false);
});

test('isFieldVisible: 配列は全条件が通過したら visible', () => {
  const field = {
    key: 'target',
    visibleWhen: [
      { key: 'mode', value: 'advanced' },
      { key: 'disabled', value: true, hide: true },
    ],
  };

  assert.equal(isFieldVisible(field, { mode: 'advanced', disabled: false }), true);
});

test('isFieldVisible: 参照 key 欠落は不一致扱い', () => {
  assert.equal(
    isFieldVisible({ key: 'target', visibleWhen: { key: 'mode', value: 'advanced' } }, {}),
    false
  );
  assert.equal(
    isFieldVisible({ key: 'target', visibleWhen: { key: 'mode', value: 'advanced', hide: true } }, {}),
    true
  );
});

test('isFieldVisible: boolean と文字列の型混在でも String 比較で一致する', () => {
  assert.equal(
    isFieldVisible({ key: 'target', visibleWhen: { key: 'enabled', value: 'true' } }, { enabled: true }),
    true
  );
  assert.equal(
    isFieldVisible({ key: 'target', visibleWhen: { key: 'enabled', value: true } }, { enabled: 'true' }),
    true
  );
});

test('isFieldVisible: 壊れた visibleWhen は fail-open で visible', () => {
  assert.equal(isFieldVisible({ key: 'target', visibleWhen: 'mode=advanced' }, { mode: 'basic' }), true);
  assert.equal(isFieldVisible({ key: 'target', visibleWhen: { value: 'advanced' } }, { mode: 'basic' }), true);
  assert.equal(isFieldVisible({ key: 'target', visibleWhen: [null, 'broken'] }, { mode: 'basic' }), true);
});
