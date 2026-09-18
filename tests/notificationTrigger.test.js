'use strict';
// Web Push 通知（issue #396）の送信契機（状態が変わった瞬間の検知）と通知文面の
// 組み立てに関する純粋関数のテスト。main.js（Electron 依存）を経由せず、
// utils/notificationTrigger.js 単体で検証する。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  derivePaneNotificationState,
  computeNotificationEvents,
  buildNotificationPayload,
} = require('../utils/notificationTrigger');

function pane(overrides) {
  return {
    termId: '1',
    cwd: '/Users/dev/project',
    status: 'idle',
    apiWaitingMerge: false,
    displayTitle: '',
    apiTitle: '',
    taskTitle: '',
    ...overrides,
  };
}

test('derivePaneNotificationState: status が waiting なら waiting: true', () => {
  const result = derivePaneNotificationState(pane({ status: 'waiting' }), []);
  assert.equal(result.waiting, true);
  assert.equal(result.waitingMerge, false);
});

test('derivePaneNotificationState: apiWaitingMerge が true なら waitingMerge: true', () => {
  const result = derivePaneNotificationState(pane({ apiWaitingMerge: true }), []);
  assert.equal(result.waitingMerge, true);
});

test('derivePaneNotificationState: waitingExcludeCwdPatterns に一致する cwd は waiting も waitingMerge も false になる（externalWaiting 経由でも除外する）', () => {
  const result = derivePaneNotificationState(
    pane({ cwd: '/Users/dev/orchestrator-worktree', status: 'waiting', apiWaitingMerge: true }),
    ['orchestrator-worktree']
  );
  assert.equal(result.waiting, false);
  assert.equal(result.waitingMerge, false);
});

test('derivePaneNotificationState: 除外パターンに一致しない cwd は通常どおり判定する', () => {
  const result = derivePaneNotificationState(
    pane({ cwd: '/Users/dev/other-project', status: 'waiting' }),
    ['orchestrator-worktree']
  );
  assert.equal(result.waiting, true);
});

test('computeNotificationEvents: 入力待ちでない→入力待ちの遷移だけがイベントになる', () => {
  const states = { 'pane-1': pane({ termId: '1', status: 'waiting' }) };
  const { events } = computeNotificationEvents({ prevSnapshot: {}, states, excludePatterns: [] });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'waiting');
  assert.equal(events[0].termId, '1');
});

test('computeNotificationEvents: 既に waiting だったペインが waiting のままなら再通知しない（連発防止）', () => {
  const states = { 'pane-1': pane({ termId: '1', status: 'waiting' }) };
  const prevSnapshot = { '1': { waiting: true, waitingMerge: false } };
  const { events } = computeNotificationEvents({ prevSnapshot, states, excludePatterns: [] });
  assert.equal(events.length, 0);
});

test('computeNotificationEvents: waiting → 非waiting → waiting と再度変化すれば、その都度イベントになる', () => {
  const excludePatterns = [];
  let snapshot = {};
  const step1 = computeNotificationEvents({
    prevSnapshot: snapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'waiting' }) },
    excludePatterns,
  });
  snapshot = step1.nextSnapshot;
  assert.equal(step1.events.length, 1);

  const step2 = computeNotificationEvents({
    prevSnapshot: snapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'idle' }) },
    excludePatterns,
  });
  snapshot = step2.nextSnapshot;
  assert.equal(step2.events.length, 0); // 解除は通知しない

  const step3 = computeNotificationEvents({
    prevSnapshot: snapshot,
    states: { 'pane-1': pane({ termId: '1', status: 'waiting' }) },
    excludePatterns,
  });
  assert.equal(step3.events.length, 1); // 再度 waiting になったら再通知する
});

test('computeNotificationEvents: マージ待ちでない→マージ待ちの遷移もイベントになる（waiting とは独立）', () => {
  const states = { 'pane-1': pane({ termId: '1', status: 'idle', apiWaitingMerge: true }) };
  const { events } = computeNotificationEvents({ prevSnapshot: {}, states, excludePatterns: [] });
  assert.equal(events.length, 1);
  assert.equal(events[0].kind, 'merge');
});

test('computeNotificationEvents: 同一ペインで waiting と merge が同時に新規発生すれば2件のイベントになる', () => {
  const states = { 'pane-1': pane({ termId: '1', status: 'waiting', apiWaitingMerge: true }) };
  const { events } = computeNotificationEvents({ prevSnapshot: {}, states, excludePatterns: [] });
  assert.equal(events.length, 2);
  const kinds = events.map((e) => e.kind).sort();
  assert.deepEqual(kinds, ['merge', 'waiting']);
});

test('computeNotificationEvents: 除外パターンに一致するペインは waiting になってもイベントを出さない', () => {
  const states = { 'pane-1': pane({ termId: '1', cwd: '/x/orchestrator', status: 'waiting' }) };
  const { events } = computeNotificationEvents({ prevSnapshot: {}, states, excludePatterns: ['orchestrator'] });
  assert.equal(events.length, 0);
});

test('computeNotificationEvents: states から消えた termId は nextSnapshot からも消える（ペインを閉じた場合の GC）', () => {
  const step1 = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '1', status: 'waiting' }) },
    excludePatterns: [],
  });
  assert.ok('1' in step1.nextSnapshot);
  const step2 = computeNotificationEvents({
    prevSnapshot: step1.nextSnapshot,
    states: {},
    excludePatterns: [],
  });
  assert.deepEqual(step2.nextSnapshot, {});
});

test('computeNotificationEvents: paneLabel は displayTitle を優先し、無ければ既定名 "Terminal <termId>"', () => {
  const withTitle = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '3', status: 'waiting', displayTitle: 'PR #123 の対応' }) },
    excludePatterns: [],
  });
  assert.equal(withTitle.events[0].paneLabel, 'PR #123 の対応');

  const withoutTitle = computeNotificationEvents({
    prevSnapshot: {},
    states: { 'pane-1': pane({ termId: '3', status: 'waiting' }) },
    excludePatterns: [],
  });
  assert.equal(withoutTitle.events[0].paneLabel, 'Terminal 3');
});

test('buildNotificationPayload: waiting イベントの本文は「入力待ちになりました。」', () => {
  const payload = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: 'My Pane' });
  assert.equal(payload.title, 'My Pane');
  assert.equal(payload.body, '入力待ちになりました。');
  assert.equal(payload.tag, 'vkt-1-waiting');
});

test('buildNotificationPayload: merge イベントの本文は「マージ待ちになりました。」', () => {
  const payload = buildNotificationPayload({ termId: '2', kind: 'merge', paneLabel: 'My Pane' });
  assert.equal(payload.body, 'マージ待ちになりました。');
  assert.equal(payload.tag, 'vkt-2-merge');
});

test('buildNotificationPayload: tag は termId と種別の組み合わせで、別ペイン・別種別なら異なる（上書きが混線しない）', () => {
  const a = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: 'A' });
  const b = buildNotificationPayload({ termId: '1', kind: 'merge', paneLabel: 'A' });
  const c = buildNotificationPayload({ termId: '2', kind: 'waiting', paneLabel: 'B' });
  assert.notEqual(a.tag, b.tag);
  assert.notEqual(a.tag, c.tag);
});

test('buildNotificationPayload: 同じペイン・同じ種別なら常に同じ tag（同一通知は上書きされる）', () => {
  const first = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: 'A' });
  const second = buildNotificationPayload({ termId: '1', kind: 'waiting', paneLabel: 'A（更新後）' });
  assert.equal(first.tag, second.tag);
});
