'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizeFieldSection, splitFieldsIntoSections } = require('../renderer/settingsSections');

const f = (key, section) => (section === undefined ? { key } : { key, section });

test('section 属性が一つも無い項目列は区分外の 1 塊になる', () => {
  const fields = [f('a'), f('b')];
  assert.deepEqual(splitFieldsIntoSections(fields), [{ section: null, fields }]);
});

test('空配列・配列でない値は空の結果になる', () => {
  assert.deepEqual(splitFieldsIntoSections([]), []);
  assert.deepEqual(splitFieldsIntoSections(undefined), []);
  assert.deepEqual(splitFieldsIntoSections('x'), []);
});

test('section 付きの項目から次の section の手前までが 1 区分になる', () => {
  const parts = splitFieldsIntoSections([
    f('a', { label: '一', description: '説明一' }),
    f('b'),
    f('c', { label: '二' }),
  ]);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[0].section, { label: '一', description: '説明一' });
  assert.deepEqual(parts[0].fields.map((x) => x.key), ['a', 'b']);
  assert.deepEqual(parts[1].section, { label: '二', description: '' });
  assert.deepEqual(parts[1].fields.map((x) => x.key), ['c']);
});

test('先頭に section 無しの項目があれば区分外の塊として先頭に置く', () => {
  const parts = splitFieldsIntoSections([f('a'), f('b', { label: '一' }), f('c')]);
  assert.equal(parts[0].section, null);
  assert.deepEqual(parts[0].fields.map((x) => x.key), ['a']);
  assert.deepEqual(parts[1].fields.map((x) => x.key), ['b', 'c']);
});

test('項目の順序と個数は変わらない', () => {
  const fields = [f('a'), f('b', { label: 'x' }), f('c'), f('d', { label: 'y' }), f('e')];
  const flat = splitFieldsIntoSections(fields).flatMap((p) => p.fields);
  assert.deepEqual(flat, fields);
});

test('型が不正な section は無視して直前の区分（無ければ区分外）に属する', () => {
  const bad = ['文字列', 1, true, [], { label: '' }, { label: '  ' }, { label: 5 }, {}, null];
  for (const section of bad) {
    const parts = splitFieldsIntoSections([{ key: 'a', section }, f('b', { label: '一' }), { key: 'c', section }]);
    assert.equal(parts.length, 2, JSON.stringify(section));
    assert.equal(parts[0].section, null);
    assert.deepEqual(parts[0].fields.map((x) => x.key), ['a']);
    assert.deepEqual(parts[1].fields.map((x) => x.key), ['b', 'c']);
  }
});

test('description が文字列以外なら空として扱う。前後の空白は落とす', () => {
  assert.deepEqual(normalizeFieldSection(f('a', { label: ' 名 ', description: 3 })), { label: '名', description: '' });
  assert.deepEqual(normalizeFieldSection(f('a', { label: '名', description: ' 説明 ' })), { label: '名', description: '説明' });
});

test('継承プロパティの section は読まない', () => {
  const field = Object.create({ section: { label: '継承' } });
  field.key = 'a';
  assert.equal(normalizeFieldSection(field), null);
});

test('不正な項目（null など）があっても落ちず、直前の区分に残る', () => {
  const parts = splitFieldsIntoSections([f('a', { label: '一' }), null, 'x']);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].fields.length, 3);
});
