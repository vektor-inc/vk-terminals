'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  comboDisplayValue,
  comboStoredValue,
} = require('../renderer/settingsComboField');

const field = {
  type: 'combo',
  options: [
    { value: '', label: '未設定' },
    { value: 'auto', label: '自動' },
    { value: 'manual', label: 'auto' },
    { value: 'same', label: 'same' },
  ],
};

test('comboDisplayValue: 保存値に対応する表示名を返す', () => {
  assert.equal(comboDisplayValue(field, 'auto'), '自動');
  assert.equal(comboDisplayValue(field, ''), '未設定');
  assert.equal(comboDisplayValue(field, 'same'), 'same');
});

test('comboDisplayValue: 候補に無い値はそのまま表示する', () => {
  assert.equal(comboDisplayValue(field, 'custom-model'), 'custom-model');
});

test('comboStoredValue: 表示名を保存値へ変換する', () => {
  assert.equal(comboStoredValue(field, '自動'), 'auto');
  assert.equal(comboStoredValue(field, '未設定'), '');
  assert.equal(comboStoredValue(field, 'same'), 'same');
});

test('comboStoredValue: 候補に無い手入力値はそのまま返す', () => {
  assert.equal(comboStoredValue(field, 'custom-model'), 'custom-model');
});

test('comboStoredValue: 表示名と別候補の保存値が衝突したら保存値を優先する', () => {
  assert.equal(comboStoredValue(field, 'auto'), 'auto');
});

test('combo 以外のフィールドは値を変換しない', () => {
  const textField = { type: 'text', options: field.options };
  assert.equal(comboDisplayValue(textField, 'auto'), 'auto');
  assert.equal(comboStoredValue(textField, '自動'), '自動');
});
