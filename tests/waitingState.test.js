'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isWaitingCwdExcluded,
  matchesWaiting,
  nextWaitingState,
  normalizeWaitingExcludeCwdPatterns,
} = require('../renderer/waitingState');

test('nextWaitingState: 入力待ちは出力再評価で false に戻さず保持する', () => {
  assert.equal(nextWaitingState({ prev: true, matches: false }), true);
});

test('nextWaitingState: 非待機からマッチしたら入力待ちになる', () => {
  assert.equal(nextWaitingState({ prev: false, matches: true }), true);
});

test('nextWaitingState: 非待機でマッチしなければ非待機のまま', () => {
  assert.equal(nextWaitingState({ prev: false, matches: false }), false);
});

test('nextWaitingState: 入力待ち中にマッチし続けたら入力待ちのまま', () => {
  assert.equal(nextWaitingState({ prev: true, matches: true }), true);
});

test('nextWaitingState: 除外対象 cwd ではマッチしても入力待ちにならない', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-orchestrator/tasks', ['vk-orchestrator']);

  assert.equal(excluded, true);
  assert.equal(nextWaitingState({ prev: false, matches: true, excluded }), false);
});

test('nextWaitingState: 除外対象 cwd では既存の入力待ちも解除する', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-orchestrator/tasks', ['vk-orchestrator']);

  assert.equal(nextWaitingState({ prev: true, matches: true, excluded }), false);
});

test('nextWaitingState: 除外パターンに一致しない cwd では従来どおり入力待ちになる', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-terminals', ['vk-orchestrator']);

  assert.equal(excluded, false);
  assert.equal(nextWaitingState({ prev: false, matches: true, excluded }), true);
});

test('nextWaitingState: 除外パターン未設定時は従来どおり sticky に入力待ちを保持する', () => {
  const excluded = isWaitingCwdExcluded('/work/vk-orchestrator/tasks', undefined);

  assert.equal(excluded, false);
  assert.equal(nextWaitingState({ prev: true, matches: false, excluded }), true);
});

test('normalizeWaitingExcludeCwdPatterns: 文字列以外・空白のみの値を除外する', () => {
  assert.deepEqual(
    normalizeWaitingExcludeCwdPatterns([' vk-orchestrator ', '', '  ', 42, null, '/tmp/task']),
    ['vk-orchestrator', '/tmp/task'],
  );
});

test('matchesWaiting: 日本語の確認待ち文言を検知する', () => {
  assert.equal(matchesWaiting('作業が完了しました。ご確認をお願いします。'), true);
});

test('matchesWaiting: リサイズ再描画で確認文が折り返された非マッチ例は false', () => {
  const resizedRedraw = [
    '作業が完了しました。ご確認',
    'をお願いします。',
    '✻ Worked for 2m 14s',
  ].join('\n');
  assert.equal(matchesWaiting(resizedRedraw), false);
});
