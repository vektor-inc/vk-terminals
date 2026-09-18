'use strict';

// Web Push 通知（issue #396）の送信契機（状態が変わった瞬間の検知）と通知文面の組み立てを行う
// 純粋関数群。main.js から Electron 依存を切り離してテストしやすくするため、
// utils/apiAuth.js と同じ方針でここへ切り出している。
//
// main.js は ipcMain.on('terminal:report-states', ...)（renderer から 2 秒間隔で届く状態
// スナップショット）のたびに computeNotificationEvents() を呼び、返ってきた events を
// 送信のトリガーとして使う。ファイル I/O・実際の送信（web-push）はここでは行わない。

const { isWaitingCwdExcluded } = require('../renderer/waitingState');

/**
 * renderer から届く states（terminal:report-states の payload）1 件分から、
 * 「入力待ち」「マージ待ち」の現在値を、waitingExcludeCwdPatterns による除外を
 * 反映したうえで導出する。
 *
 * status（'idle' | 'running' | 'waiting'）は renderer 側の deriveStatus が
 * localWaiting（cwd 除外を反映済み）と externalWaiting（POST /api/set-status 由来、
 * cwd 除外は未反映）の OR で決めているため、ここで cwd 除外を再度掛けないと、
 * 除外対象ペインが externalWaiting 経由で waiting 表示になった場合に通知してしまう
 * （issue #396 の必須条件）。apiWaitingMerge（POST /api/set-title 由来）も同様に
 * cwd 除外が未反映のため、ここで掛ける。
 * @param {object} paneState cachedStates[paneId] 相当の1エントリ
 * @param {string[]} excludePatterns waitingExcludeCwdPatterns（正規化前でも可）
 * @returns {{ waiting: boolean, waitingMerge: boolean }}
 */
function derivePaneNotificationState(paneState, excludePatterns) {
  const t = paneState || {};
  const excluded = isWaitingCwdExcluded(typeof t.cwd === 'string' ? t.cwd : '', excludePatterns);
  if (excluded) return { waiting: false, waitingMerge: false };
  return {
    waiting: t.status === 'waiting',
    waitingMerge: !!t.apiWaitingMerge,
  };
}

/**
 * termId（cachedStates のキーである paneId ではなく、ペインの安定した識別子）を取り出す。
 * termId が無い場合は paneId をそのまま使う（後方互換のフォールバック）。
 * @param {string} paneId
 * @param {object} paneState
 * @returns {string}
 */
function resolveTermId(paneId, paneState) {
  const t = paneState || {};
  return t.termId != null ? String(t.termId) : String(paneId);
}

/**
 * 通知に使うペイン名を決める。displayTitle（apiTitle || taskTitle の main 側計算済み値）を
 * 優先し、無ければ既定の表示名 "Terminal <termId>" にフォールバックする
 * （issue #396: モバイルページのカード表示・PC 側と同じ既定名の付け方に合わせる）。
 * @param {object} paneState
 * @param {string} termId
 * @returns {string}
 */
function resolvePaneLabel(paneState, termId) {
  const t = paneState || {};
  const label = (typeof t.displayTitle === 'string' && t.displayTitle.trim())
    || (typeof t.apiTitle === 'string' && t.apiTitle.trim())
    || (typeof t.taskTitle === 'string' && t.taskTitle.trim())
    || '';
  return label || `Terminal ${termId}`;
}

/**
 * 前回のスナップショット（termId → { waiting, waitingMerge }）と今回の states を比較し、
 * 「入力待ちでない→入力待ち」「マージ待ちでない→マージ待ち」の遷移が起きたペインだけを
 * イベントとして返す（issue #396 必須条件・値を受け取るたびに送ると通知が連発するため）。
 * 併せて、次回の比較に使うスナップショットも返す（呼び出し側が状態を持ち回す）。
 *
 * states に存在しなくなった termId（ペインを閉じた等）は次回スナップショットに残らない
 * （自然に GC される）。
 * @param {{ prevSnapshot: Record<string, {waiting:boolean, waitingMerge:boolean}>,
 *           states: Record<string, object>, excludePatterns: string[] }} params
 * @returns {{ events: Array<{termId:string, kind:'waiting'|'merge', paneLabel:string}>,
 *             nextSnapshot: Record<string, {waiting:boolean, waitingMerge:boolean}> }}
 */
function computeNotificationEvents({ prevSnapshot, states, excludePatterns }) {
  const prev = prevSnapshot && typeof prevSnapshot === 'object' ? prevSnapshot : {};
  const nextSnapshot = {};
  const events = [];

  Object.keys(states || {}).forEach((paneId) => {
    const paneState = states[paneId];
    if (!paneState) return;
    const termId = resolveTermId(paneId, paneState);
    const current = derivePaneNotificationState(paneState, excludePatterns);
    const previous = prev[termId] || { waiting: false, waitingMerge: false };

    if (!previous.waiting && current.waiting) {
      events.push({ termId, kind: 'waiting', paneLabel: resolvePaneLabel(paneState, termId) });
    }
    if (!previous.waitingMerge && current.waitingMerge) {
      events.push({ termId, kind: 'merge', paneLabel: resolvePaneLabel(paneState, termId) });
    }
    nextSnapshot[termId] = current;
  });

  return { events, nextSnapshot };
}

// 通知本文（issue #396: ペイン名と種別以外の情報は載せない）。
const NOTIFICATION_BODY_TEXT = {
  waiting: '入力待ちになりました。',
  merge: 'マージ待ちになりました。',
};

/**
 * computeNotificationEvents() が返した 1 件のイベントから、Web Push の通知ペイロード
 * （Service Worker の push イベントハンドラがそのまま showNotification に渡す形）を組み立てる。
 * tag は termId と種別を組み合わせた値にし、同じペイン・同じ種別の通知は OS 側で
 * 上書きされる（issue #396: 通知が積み重なって鳴り続けないようにする）。
 * @param {{ termId: string, kind: 'waiting'|'merge', paneLabel: string }} event
 * @returns {{ title: string, body: string, tag: string }}
 */
function buildNotificationPayload(event) {
  const kind = event && event.kind === 'merge' ? 'merge' : 'waiting';
  const termId = event && event.termId != null ? String(event.termId) : '';
  const title = (event && event.paneLabel) || `Terminal ${termId}`;
  return {
    title,
    body: NOTIFICATION_BODY_TEXT[kind],
    tag: `vkt-${termId}-${kind}`,
  };
}

module.exports = {
  derivePaneNotificationState,
  computeNotificationEvents,
  buildNotificationPayload,
};
