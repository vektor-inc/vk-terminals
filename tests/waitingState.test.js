'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  matchesWaiting,
  nextWaitingState,
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
