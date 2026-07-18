'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  getTaskStatusActions,
  isAllowedTransition,
  getTaskPriorityOptions,
  getTaskPriorityLabel,
  getTaskSequentialOptions,
  getTaskSequentialLabel,
  isAllowedTaskPriorityValue,
  isAllowedTaskSequentialValue,
} = require('../utils/taskStatusActions');

test('タスクステータスごとの許可操作を返す', () => {
  assert.deepEqual(getTaskStatusActions('awaiting-approval'), [
    { label: '承認', to: 'ready' },
  ]);
  assert.deepEqual(getTaskStatusActions('ready'), [
    { label: '保留', to: 'awaiting-approval' },
    { label: '取り下げ', to: 'failed' },
  ]);
  assert.deepEqual(getTaskStatusActions('in-progress'), [
    { label: '差し戻し', to: 'awaiting-approval', confirm: true },
  ]);
  assert.deepEqual(getTaskStatusActions('waiting-input'), [
    { label: '差し戻し', to: 'awaiting-approval', confirm: true },
  ]);
  assert.deepEqual(getTaskStatusActions('waiting-merge'), [
    { label: '完了', to: 'done' },
    { label: '差し戻し', to: 'awaiting-approval', confirm: true },
  ]);
  assert.deepEqual(getTaskStatusActions('failed'), [
    { label: 'リトライ', to: 'ready' },
    { label: '差し戻し', to: 'awaiting-approval', confirm: true },
  ]);
  assert.deepEqual(getTaskStatusActions('unknown'), []);
});

test('定義済み遷移だけを許可する', () => {
  assert.equal(isAllowedTransition('awaiting-approval', 'ready'), true);
  assert.equal(isAllowedTransition('ready', 'awaiting-approval'), true);
  assert.equal(isAllowedTransition('ready', 'failed'), true);
  assert.equal(isAllowedTransition('in-progress', 'awaiting-approval'), true);
  assert.equal(isAllowedTransition('waiting-input', 'awaiting-approval'), true);
  assert.equal(isAllowedTransition('waiting-merge', 'done'), true);
  assert.equal(isAllowedTransition('waiting-merge', 'awaiting-approval'), true);
  assert.equal(isAllowedTransition('failed', 'ready'), true);
  assert.equal(isAllowedTransition('failed', 'awaiting-approval'), true);

  assert.equal(isAllowedTransition('in-progress', 'ready'), false);
  assert.equal(isAllowedTransition('ready', 'done'), false);
  assert.equal(isAllowedTransition('waiting-input', 'ready'), false);
});

test('優先度の選択肢と許可値を返す', () => {
  assert.deepEqual(getTaskPriorityOptions(), [
    { value: 'high', label: '高' },
    { value: 'medium', label: '中' },
    { value: 'low', label: '低' },
    { value: 'none', label: 'なし' },
  ]);
  assert.equal(isAllowedTaskPriorityValue('high'), true);
  assert.equal(isAllowedTaskPriorityValue('medium'), true);
  assert.equal(isAllowedTaskPriorityValue('low'), true);
  assert.equal(isAllowedTaskPriorityValue('none'), true);
  assert.equal(isAllowedTaskPriorityValue(null), false);
  assert.equal(isAllowedTaskPriorityValue(''), false);
  assert.equal(isAllowedTaskPriorityValue('urgent'), false);
  assert.equal(getTaskPriorityLabel('high'), '高');
  assert.equal(getTaskPriorityLabel('unknown'), 'unknown');
});

test('直列/並列の選択肢と許可値を返す', () => {
  assert.deepEqual(getTaskSequentialOptions(), [
    { value: 'sequential', label: '直列' },
    { value: 'parallel', label: '並列' },
  ]);
  assert.equal(isAllowedTaskSequentialValue('sequential'), true);
  assert.equal(isAllowedTaskSequentialValue('parallel'), true);
  assert.equal(isAllowedTaskSequentialValue(true), false);
  assert.equal(isAllowedTaskSequentialValue(''), false);
  assert.equal(isAllowedTaskSequentialValue('serial'), false);
  assert.equal(getTaskSequentialLabel('sequential'), '直列');
  assert.equal(getTaskSequentialLabel('unknown'), 'unknown');
});
