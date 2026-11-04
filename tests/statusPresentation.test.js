'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS_ORDER,
  compareStatus,
  getStatusPresentation,
  getStatusRank,
  resolvePaneNote,
} = require('../renderer/statusPresentation');

test('getStatusPresentation: waiting/running/idle/未知値の表示を返す', () => {
  assert.deepEqual(
    getStatusPresentation('waiting'),
    { label: '入力待ち', ariaLabel: 'ステータス: 入力待ち', visualStatus: 'waiting' }
  );
  assert.deepEqual(
    getStatusPresentation('running'),
    { label: '実行中', ariaLabel: 'ステータス: 実行中', visualStatus: 'running' }
  );
  assert.deepEqual(getStatusPresentation('idle'), { label: '', ariaLabel: '', visualStatus: 'idle' });
  assert.deepEqual(getStatusPresentation('unknown'), { label: '', ariaLabel: '', visualStatus: 'unknown' });
});

// ─── paneNote（issue #536）─────────────────────────────────────────────────

test('getStatusPresentation: 入力待ち ＞ 完了 ＞ 見守り中 ＞ 実行中 ＞ 表示なし の優先順位で選ぶ', () => {
  // 入力待ちは paneNote があっても必ず最優先。
  assert.equal(getStatusPresentation('waiting', 'done').label, '入力待ち');
  assert.equal(getStatusPresentation('waiting', 'watching').visualStatus, 'waiting');
  // 完了・見守り中は実行中・表示なしより優先する（画面出力が流れても実行中に戻らない）。
  assert.deepEqual(
    getStatusPresentation('running', 'watching'),
    { label: '見守り中', ariaLabel: 'ステータス: 見守り中', visualStatus: 'watching' }
  );
  assert.deepEqual(
    getStatusPresentation('idle', 'done'),
    { label: '完了', ariaLabel: 'ステータス: 完了', visualStatus: 'done' }
  );
  assert.equal(getStatusPresentation('running', 'done').label, '完了');
});

test('getStatusPresentation: paneNote が null・未指定・語彙外なら従来どおり', () => {
  for (const note of [null, undefined, '', 'zzz', 5, {}, '__proto__', 'constructor']) {
    assert.equal(getStatusPresentation('running', note).label, '実行中');
    assert.equal(getStatusPresentation('idle', note).label, '');
  }
});

test('paneNote を足しても STATUS_ORDER・STATUS_RANK（並び順）は変わらない', () => {
  assert.deepEqual(STATUS_ORDER, ['waiting', 'running', 'idle']);
  assert.equal(getStatusRank('watching'), 3);
  assert.equal(getStatusRank('done'), 3);
});

test('resolvePaneNote: 送られた値（watching / done / null）をそのまま反映する', () => {
  assert.equal(resolvePaneNote(null, { provided: true, value: 'watching' }, 'a', 'a'), 'watching');
  assert.equal(resolvePaneNote('watching', { provided: true, value: 'done' }, 'a', 'b'), 'done');
  assert.equal(resolvePaneNote('done', { provided: true, value: null }, 'a', 'a'), null);
});

test('resolvePaneNote: 送られなかったとき、title が同じなら現在値を保つ', () => {
  const none = { provided: false, value: null };
  assert.equal(resolvePaneNote('done', none, 'issue #1', 'issue #1'), 'done');
  assert.equal(resolvePaneNote('watching', none, 'issue #1', 'issue #1'), 'watching');
  assert.equal(resolvePaneNote(null, none, 'issue #1', 'issue #1'), null);
});

test('resolvePaneNote: 送られなかったとき、title が変わったら（別タスク・空への変更を含む）消す', () => {
  const none = { provided: false, value: null };
  assert.equal(resolvePaneNote('done', none, 'issue #1', 'issue #2'), null);
  assert.equal(resolvePaneNote('watching', none, 'issue #1', ''), null);
  assert.equal(resolvePaneNote('done', none, '', 'issue #2'), null);
});

test('resolvePaneNote: 更新指示が不正でも現在値を保ち、現在値が語彙外なら null にする', () => {
  assert.equal(resolvePaneNote('done', undefined, 'a', 'b'), 'done');
  assert.equal(resolvePaneNote('zzz', { provided: false }, 'a', 'a'), null);
});

test('status presentation: waiting > running > idle > unknown の順で rank を返す', () => {
  assert.deepEqual(STATUS_ORDER, ['waiting', 'running', 'idle']);
  assert.equal(getStatusRank('waiting'), 0);
  assert.equal(getStatusRank('running'), 1);
  assert.equal(getStatusRank('idle'), 2);
  assert.equal(getStatusRank('unknown'), 3);
  assert.ok(compareStatus('waiting', 'running') < 0);
  assert.ok(compareStatus('idle', 'unknown') < 0);
});
