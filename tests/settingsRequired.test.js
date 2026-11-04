'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { isFieldRequired } = require('../renderer/settingsVisibility');

const whenGithub = { key: 'queue.backend', value: 'github' };

test('isFieldRequired: required:true は常に必須', () => {
  assert.equal(isFieldRequired({ key: 'a', required: true }, {}), true);
  assert.equal(isFieldRequired({ key: 'a', required: true }, { b: 'x' }), true);
});

test('isFieldRequired: required も requiredWhen も無い定義は必須ではない（互換性）', () => {
  assert.equal(isFieldRequired({ key: 'a' }, {}), false);
  assert.equal(isFieldRequired({ key: 'a', required: false }, {}), false);
});

test('isFieldRequired: requiredWhen は条件が成り立つときだけ必須', () => {
  const field = { key: 'token', requiredWhen: whenGithub };
  assert.equal(isFieldRequired(field, { 'queue.backend': 'github' }), true);
  assert.equal(isFieldRequired(field, { 'queue.backend': 'local' }), false);
  assert.equal(isFieldRequired(field, {}), false);
});

test('isFieldRequired: 条件の切り替えで即座に判定が変わる', () => {
  const field = { key: 'token', requiredWhen: whenGithub };
  assert.equal(isFieldRequired(field, { 'queue.backend': 'local' }), false);
  assert.equal(isFieldRequired(field, { 'queue.backend': 'github' }), true);
});

test('isFieldRequired: requiredWhen は配列(AND)と anyOf(OR)に対応', () => {
  const and = { key: 'a', requiredWhen: [whenGithub, { key: 'mode', value: 'x' }] };
  assert.equal(isFieldRequired(and, { 'queue.backend': 'github', mode: 'x' }), true);
  assert.equal(isFieldRequired(and, { 'queue.backend': 'github', mode: 'y' }), false);
  const or = { key: 'a', requiredWhen: { anyOf: [whenGithub, { key: 'mode', value: 'x' }] } };
  assert.equal(isFieldRequired(or, { 'queue.backend': 'local', mode: 'x' }), true);
  assert.equal(isFieldRequired(or, { 'queue.backend': 'local', mode: 'y' }), false);
});

test('isFieldRequired: 非表示の項目は必須扱いにしない', () => {
  const hidden = { key: 'a', required: true, visibleWhen: { key: 'mode', value: 'adv' } };
  assert.equal(isFieldRequired(hidden, { mode: 'basic' }), false);
  assert.equal(isFieldRequired(hidden, { mode: 'adv' }), true);
  const whenHidden = { key: 'a', requiredWhen: whenGithub, visibleWhen: { key: 'mode', value: 'adv' } };
  assert.equal(isFieldRequired(whenHidden, { 'queue.backend': 'github', mode: 'basic' }), false);
  assert.equal(isFieldRequired(whenHidden, { 'queue.backend': 'github', mode: 'adv' }), true);
});

test('isFieldRequired: boolean は必須扱いにしない', () => {
  assert.equal(isFieldRequired({ key: 'a', type: 'boolean', required: true }, {}), false);
});

test('isFieldRequired: 壊れた requiredWhen は必須扱いにしない', () => {
  assert.equal(isFieldRequired({ key: 'a', requiredWhen: { value: 'x' } }, {}), false);
  assert.equal(isFieldRequired({ key: 'a', requiredWhen: 'github' }, {}), false);
  assert.equal(isFieldRequired(null, {}), false);
});
