'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTaskStatusActions,
  isAllowedTransition,
} = require('../utils/taskStatusActions');

test('タスクステータスごとの許可操作を返す', () => {
  assert.deepEqual(getTaskStatusActions('awaiting-approval'), [
    { label: '承認', to: 'ready' },
  ]);
  assert.deepEqual(getTaskStatusActions('ready'), [
    { label: '保留', to: 'awaiting-approval' },
    { label: '取り下げ', to: 'failed' },
  ]);
  assert.deepEqual(getTaskStatusActions('waiting-merge'), [
    { label: '完了', to: 'done' },
  ]);
  assert.deepEqual(getTaskStatusActions('failed'), [
    { label: 'リトライ', to: 'ready' },
  ]);
  assert.deepEqual(getTaskStatusActions('in-progress'), []);
  assert.deepEqual(getTaskStatusActions('unknown'), []);
});

test('定義済み遷移だけを許可する', () => {
  assert.equal(isAllowedTransition('awaiting-approval', 'ready'), true);
  assert.equal(isAllowedTransition('ready', 'awaiting-approval'), true);
  assert.equal(isAllowedTransition('ready', 'failed'), true);
  assert.equal(isAllowedTransition('waiting-merge', 'done'), true);
  assert.equal(isAllowedTransition('failed', 'ready'), true);

  assert.equal(isAllowedTransition('in-progress', 'ready'), false);
  assert.equal(isAllowedTransition('ready', 'done'), false);
  assert.equal(isAllowedTransition('waiting-input', 'ready'), false);
});
