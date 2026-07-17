'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_CONFIRM_CLOSE,
  normalizeConfirmClose,
  shouldConfirmClose,
} = require('../utils/closeConfirm');

test('normalizeConfirmClose: 有効値はそのまま返す', () => {
  assert.equal(normalizeConfirmClose('never'), 'never');
  assert.equal(normalizeConfirmClose('busy'), 'busy');
  assert.equal(normalizeConfirmClose('always'), 'always');
});

test('normalizeConfirmClose: 未指定・不正値は既定 busy に落ちる', () => {
  assert.equal(DEFAULT_CONFIRM_CLOSE, 'busy');
  assert.equal(normalizeConfirmClose(undefined), 'busy');
  assert.equal(normalizeConfirmClose(null), 'busy');
  assert.equal(normalizeConfirmClose(''), 'busy');
  assert.equal(normalizeConfirmClose('ALWAYS'), 'busy');
  assert.equal(normalizeConfirmClose(true), 'busy');
  assert.equal(normalizeConfirmClose(123), 'busy');
});

test('shouldConfirmClose: never はどの status でも確認しない', () => {
  assert.equal(shouldConfirmClose('never', 'idle'), false);
  assert.equal(shouldConfirmClose('never', 'running'), false);
  assert.equal(shouldConfirmClose('never', 'waiting'), false);
});

test('shouldConfirmClose: always はどの status でも確認する', () => {
  assert.equal(shouldConfirmClose('always', 'idle'), true);
  assert.equal(shouldConfirmClose('always', 'running'), true);
  assert.equal(shouldConfirmClose('always', 'waiting'), true);
});

test('shouldConfirmClose: busy は running / waiting のみ確認する', () => {
  assert.equal(shouldConfirmClose('busy', 'idle'), false);
  assert.equal(shouldConfirmClose('busy', 'running'), true);
  assert.equal(shouldConfirmClose('busy', 'waiting'), true);
});

test('shouldConfirmClose: 不正 mode は busy として扱う', () => {
  assert.equal(shouldConfirmClose(undefined, 'running'), true);
  assert.equal(shouldConfirmClose('sometimes', 'waiting'), true);
  assert.equal(shouldConfirmClose('sometimes', 'idle'), false);
});

test('shouldConfirmClose: 未知の status は busy では確認しない（idle 相当）', () => {
  assert.equal(shouldConfirmClose('busy', undefined), false);
  assert.equal(shouldConfirmClose('busy', 'unknown'), false);
});
