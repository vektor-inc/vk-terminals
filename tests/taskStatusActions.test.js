'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  TASK_STATUS_SELECT_ORDER,
  getTaskStatusActions,
  isAllowedTransition,
  getTaskStatusLabel,
  getTaskStatusSelectOptions,
  isTaskStatusSelectOptionDisabled,
  getTaskStatusTransitionConfirmMessage,
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

test('ステータス select はライフサイクル順で現在値と遷移可否を返す', () => {
  assert.deepEqual(TASK_STATUS_SELECT_ORDER, [
    'awaiting-approval',
    'ready',
    'in-progress',
    'waiting-input',
    'waiting-merge',
    'done',
    'failed',
  ]);
  assert.equal(getTaskStatusLabel('waiting-merge'), 'マージ待ち');
  assert.equal(getTaskStatusLabel('unknown'), 'unknown');

  assert.deepEqual(getTaskStatusSelectOptions('waiting-merge'), [
    { value: 'awaiting-approval', label: '承認待ち', disabled: false },
    { value: 'ready', label: '実行待ち', disabled: true },
    { value: 'in-progress', label: '実行中', disabled: true },
    { value: 'waiting-input', label: '入力待ち', disabled: true },
    { value: 'waiting-merge', label: 'マージ待ち', disabled: false },
    { value: 'done', label: '完了', disabled: false },
    { value: 'failed', label: '失敗', disabled: true },
  ]);
  assert.deepEqual(getTaskStatusSelectOptions('custom-status'), [
    { value: 'custom-status', label: 'custom-status', disabled: false },
    { value: 'awaiting-approval', label: '承認待ち', disabled: true },
    { value: 'ready', label: '実行待ち', disabled: true },
    { value: 'in-progress', label: '実行中', disabled: true },
    { value: 'waiting-input', label: '入力待ち', disabled: true },
    { value: 'waiting-merge', label: 'マージ待ち', disabled: true },
    { value: 'done', label: '完了', disabled: true },
    { value: 'failed', label: '失敗', disabled: true },
  ]);
});

test('旧契約タスクでは確認付きステータス遷移を select 上で disabled にする', () => {
  assert.equal(isTaskStatusSelectOptionDisabled('in-progress', 'awaiting-approval'), false);
  assert.equal(isTaskStatusSelectOptionDisabled('in-progress', 'awaiting-approval', {
    hasPriorityContract: false,
  }), true);
  assert.equal(isTaskStatusSelectOptionDisabled('failed', 'ready', {
    hasPriorityContract: false,
  }), false);
  assert.equal(isTaskStatusSelectOptionDisabled('failed', 'awaiting-approval', {
    hasPriorityContract: false,
  }), true);
});

test('ステータス変更の確認文言を遷移先と PR 有無で出し分ける', () => {
  assert.equal(
    getTaskStatusTransitionConfirmMessage({ from: 'waiting-merge', to: 'done', hasPrUrl: true }),
    'ステータスを「完了」に変更しますか？\n\nPR のマージは行われません（PR は開いたまま残ります）。'
  );
  assert.equal(
    getTaskStatusTransitionConfirmMessage({ from: 'waiting-merge', to: 'done', hasPrUrl: false }),
    'ステータスを「完了」に変更しますか？'
  );
  assert.equal(
    getTaskStatusTransitionConfirmMessage({ from: 'waiting-input', to: 'awaiting-approval' }),
    'ステータスを「承認待ち」に変更しますか？\n\n実行中のセッションがある場合、再承認で二重起動につながる可能性があります。'
  );
  assert.equal(getTaskStatusTransitionConfirmMessage({ from: 'awaiting-approval', to: 'ready' }), '');
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
