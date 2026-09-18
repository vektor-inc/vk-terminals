'use strict';
// Web Push（issue #396）の宛先登録失敗時、理由文字列を利用者向け文言に変換する
// 純粋関数のテスト（植草の UX レビュー再指摘・U-1）。main.js（Electron 依存）・
// renderer/mobile.js（DOM 依存）を経由せず、utils/pushErrorMessages.js 単体で検証する。

const test = require('node:test');
const assert = require('node:assert/strict');

const { describePushErrorReason, PUSH_ERROR_MESSAGES } = require('../utils/pushErrorMessages');

test('describePushErrorReason: "too many subscriptions" は登録上限の文言を返す', () => {
  assert.equal(
    describePushErrorReason('too many subscriptions'),
    '登録できる端末の数（20台）が上限に達しています。使っていない端末の登録を解除してから、もう一度お試しください。'
  );
});

test('describePushErrorReason: "push notifications unavailable" はサーバー側準備不備の文言を返す', () => {
  assert.equal(
    describePushErrorReason('push notifications unavailable'),
    'この VK Terminals では現在通知を送れません（サーバー側の準備に問題があります）。VK Terminals を再起動しても改善しない場合は、動かしている人に確認してください。'
  );
});

test('describePushErrorReason: 未知の理由・非文字列・未指定は null（呼び出し側が既定のフォールバック文言を出す）', () => {
  assert.equal(describePushErrorReason('something-else'), null);
  assert.equal(describePushErrorReason(''), null);
  assert.equal(describePushErrorReason(undefined), null);
  assert.equal(describePushErrorReason(null), null);
  assert.equal(describePushErrorReason(42), null);
  assert.equal(describePushErrorReason('__proto__'), null); // Object.prototype 汚染の混入防止
});

test('PUSH_ERROR_MESSAGES: 司の差し戻し内容に書かれた文言と完全一致する（言い換えていないことの回帰確認）', () => {
  assert.deepEqual(Object.keys(PUSH_ERROR_MESSAGES).sort(), [
    'push notifications unavailable',
    'too many subscriptions',
  ]);
});
