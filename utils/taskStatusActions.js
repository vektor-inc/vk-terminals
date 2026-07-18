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
  'waiting-merge': Object.freeze([
    Object.freeze({ label: '完了', to: 'done' }),
  ]),
  failed: Object.freeze([
    Object.freeze({ label: 'リトライ', to: 'ready' }),
  ]),
});

function getTaskStatusActions(status) {
  return TASK_STATUS_ACTIONS[status] || [];
}

function isAllowedTransition(from, to) {
  return getTaskStatusActions(from).some((action) => action.to === to);
}

module.exports = {
  TASK_STATUS_ACTIONS,
  getTaskStatusActions,
  isAllowedTransition,
};
