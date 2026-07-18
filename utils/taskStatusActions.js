'use strict';

// vk-orchestrator へ依頼できるタスクステータス遷移の共有定義。
// main 側は IPC 防御、renderer 側はボタン表示に同じ契約を使う。
const TASK_STATUS_ACTIONS = Object.freeze({
  'awaiting-approval': Object.freeze([
    Object.freeze({ label: '承認', to: 'ready' }),
  ]),
  ready: Object.freeze([
    Object.freeze({ label: '保留', to: 'awaiting-approval' }),
    Object.freeze({ label: '取り下げ', to: 'failed' }),
  ]),
  'in-progress': Object.freeze([
    Object.freeze({ label: '差し戻し', to: 'awaiting-approval', confirm: true }),
  ]),
  'waiting-input': Object.freeze([
    Object.freeze({ label: '差し戻し', to: 'awaiting-approval', confirm: true }),
  ]),
  'waiting-merge': Object.freeze([
    Object.freeze({ label: '完了', to: 'done' }),
    Object.freeze({ label: '差し戻し', to: 'awaiting-approval', confirm: true }),
  ]),
  failed: Object.freeze([
    Object.freeze({ label: 'リトライ', to: 'ready' }),
    Object.freeze({ label: '差し戻し', to: 'awaiting-approval', confirm: true }),
  ]),
});

const TASK_PRIORITY_OPTIONS = Object.freeze([
  Object.freeze({ value: 'high', label: '高' }),
  Object.freeze({ value: 'medium', label: '中' }),
  Object.freeze({ value: 'low', label: '低' }),
  Object.freeze({ value: 'none', label: 'なし' }),
]);
const TASK_PRIORITY_VALUES = new Set(TASK_PRIORITY_OPTIONS.map((option) => option.value));

const TASK_SEQUENTIAL_OPTIONS = Object.freeze([
  Object.freeze({ value: 'sequential', label: '直列' }),
  Object.freeze({ value: 'parallel', label: '並列' }),
]);
const TASK_SEQUENTIAL_VALUES = new Set(TASK_SEQUENTIAL_OPTIONS.map((option) => option.value));

function getTaskStatusActions(status) {
  return TASK_STATUS_ACTIONS[status] || [];
}

function isAllowedTransition(from, to) {
  return getTaskStatusActions(from).some((action) => action.to === to);
}

function getTaskPriorityOptions() {
  return TASK_PRIORITY_OPTIONS;
}

function isAllowedTaskPriorityValue(value) {
  return TASK_PRIORITY_VALUES.has(value);
}

function getTaskPriorityLabel(value) {
  return TASK_PRIORITY_OPTIONS.find((option) => option.value === value)?.label || value;
}

function getTaskSequentialOptions() {
  return TASK_SEQUENTIAL_OPTIONS;
}

function isAllowedTaskSequentialValue(value) {
  return TASK_SEQUENTIAL_VALUES.has(value);
}

function getTaskSequentialLabel(value) {
  return TASK_SEQUENTIAL_OPTIONS.find((option) => option.value === value)?.label || value;
}

module.exports = {
  TASK_STATUS_ACTIONS,
  TASK_PRIORITY_OPTIONS,
  TASK_SEQUENTIAL_OPTIONS,
  getTaskStatusActions,
  isAllowedTransition,
  getTaskPriorityOptions,
  isAllowedTaskPriorityValue,
  getTaskPriorityLabel,
  getTaskSequentialOptions,
  isAllowedTaskSequentialValue,
  getTaskSequentialLabel,
};
