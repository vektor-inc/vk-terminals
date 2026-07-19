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

const TASK_STATUS_LABELS = Object.freeze({
  'awaiting-approval': '承認待ち',
  ready: '実行待ち',
  'in-progress': '実行中',
  'waiting-input': '入力待ち',
  'waiting-merge': 'マージ待ち',
  done: '完了',
  failed: '失敗',
});

const TASK_STATUS_SELECT_ORDER = Object.freeze([
  'awaiting-approval',
  'ready',
  'in-progress',
  'waiting-input',
  'waiting-merge',
  'done',
  'failed',
]);

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

function getTaskStatusLabel(status) {
  return TASK_STATUS_LABELS[status] || status;
}

function getAllowedTaskStatusSelectActions(status, options = {}) {
  const hasPriorityContract = options.hasPriorityContract !== false;
  return getTaskStatusActions(status)
    .filter((action) => hasPriorityContract || action.confirm !== true);
}

function isTaskStatusSelectOptionDisabled(currentStatus, optionStatus, options = {}) {
  if (optionStatus === currentStatus) return false;
  return !getAllowedTaskStatusSelectActions(currentStatus, options)
    .some((action) => action.to === optionStatus);
}

function getTaskStatusSelectOptions(currentStatus, options = {}) {
  const isKnownStatus = TASK_STATUS_SELECT_ORDER.includes(currentStatus);
  const hasUnknownCurrentStatus = typeof currentStatus === 'string' && currentStatus && !isKnownStatus;
  const statuses = hasUnknownCurrentStatus
    ? Object.freeze([currentStatus, ...TASK_STATUS_SELECT_ORDER])
    : TASK_STATUS_SELECT_ORDER;
  return statuses.map((status) => Object.freeze({
    value: status,
    label: getTaskStatusLabel(status),
    disabled: isTaskStatusSelectOptionDisabled(currentStatus, status, options),
  }));
}

function getTaskStatusTransitionConfirmMessage({ from, to, hasPrUrl } = {}) {
  if (to === 'awaiting-approval') {
    return 'ステータスを「承認待ち」に変更しますか？\n\n実行中のセッションがある場合、再承認で二重起動につながる可能性があります。';
  }
  if (from === 'waiting-merge' && to === 'done') {
    const lines = ['ステータスを「完了」に変更しますか？'];
    if (hasPrUrl) {
      lines.push('', 'PR のマージは行われません（PR は開いたまま残ります）。');
    }
    return lines.join('\n');
  }
  return '';
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
  TASK_STATUS_LABELS,
  TASK_STATUS_SELECT_ORDER,
  TASK_PRIORITY_OPTIONS,
  TASK_SEQUENTIAL_OPTIONS,
  getTaskStatusActions,
  isAllowedTransition,
  getTaskStatusLabel,
  getAllowedTaskStatusSelectActions,
  isTaskStatusSelectOptionDisabled,
  getTaskStatusSelectOptions,
  getTaskStatusTransitionConfirmMessage,
  getTaskPriorityOptions,
  isAllowedTaskPriorityValue,
  getTaskPriorityLabel,
  getTaskSequentialOptions,
  isAllowedTaskSequentialValue,
  getTaskSequentialLabel,
};
