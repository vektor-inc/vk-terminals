'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  comboOptions,
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

test('comboDisplayValue: 一意な保存値に対応する表示名を返す', () => {
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

test('combo の全候補は表示と保存の往復で元の保存値へ戻る', () => {
  const ambiguousField = {
    type: 'combo',
    options: [
      { value: 'manual', label: 'auto' },
      { value: 'auto', label: '自動' },
      { value: 'a', label: 'X' },
      { value: 'b', label: 'X' },
      { value: 'x', label: '' },
      { value: 'whitespace', label: '   ' },
      { value: 'same', label: 'same' },
    ],
  };

  for (const option of ambiguousField.options) {
    assert.equal(
      comboStoredValue(ambiguousField, comboDisplayValue(ambiguousField, option.value)),
      String(option.value)
    );
  }
});

test('combo の空白だけ異なる保存値も表示と保存の往復で元へ戻る', () => {
  const fields = [
    {
      type: 'combo',
      options: [
        { value: 'auto', label: '自動' },
        { value: ' auto ', label: '手動' },
      ],
    },
    {
      type: 'combo',
      options: [
        { value: 'a' },
        { value: ' a' },
      ],
    },
  ];

  for (const whitespaceField of fields) {
    for (const option of whitespaceField.options) {
      assert.equal(
        comboStoredValue(
          whitespaceField,
          comboDisplayValue(whitespaceField, option.value)
        ),
        option.value
      );
    }
  }
});

test('combo は trim 後に保存値が一候補だけ一致するとき従来どおり変換する', () => {
  const whitespaceField = {
    type: 'combo',
    options: [{ value: 'auto', label: '自動' }],
  };

  assert.equal(comboDisplayValue(whitespaceField, 'auto '), '自動');
  assert.equal(comboStoredValue(whitespaceField, ' 自動 '), 'auto');
});

test('comboStoredValue: 空入力は空の表示名候補より先に空文字として返す', () => {
  assert.equal(comboStoredValue({ type: 'combo', options: [{ value: 'x', label: '' }] }, ''), '');
});

test('comboStoredValue: 照合時だけ前後空白を除き、候補外の手入力値は保持する', () => {
  assert.equal(comboStoredValue(field, '  自動 '), 'auto');
  assert.equal(comboStoredValue(field, ' auto '), 'auto');
  assert.equal(comboStoredValue(field, '  custom-model  '), '  custom-model  ');
});

test('comboOptions: オブジェクト以外の候補を除外する', () => {
  const options = [{ value: 'auto', label: '自動' }, null, 'invalid', 1, []];
  assert.deepEqual(comboOptions({ type: 'combo', options }), [options[0]]);
  assert.equal(comboDisplayValue({ type: 'combo', options }, 'auto'), '自動');
});

test('combo 以外のフィールドは値を変換しない', () => {
  const textField = { type: 'text', options: field.options };
  assert.equal(comboDisplayValue(textField, 'auto'), 'auto');
  assert.equal(comboStoredValue(textField, '自動'), '自動');
});
