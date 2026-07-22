'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  STATUS_ORDER,
  compareStatus,
  getStatusPresentation,
  getStatusRank,
} = require('../renderer/statusPresentation');

test('getStatusPresentation: waiting/running/idle/未知値の表示を返す', () => {
  assert.deepEqual(
    getStatusPresentation('waiting'),
    { label: '入力待ち', ariaLabel: 'ステータス: 入力待ち' }
  );
  assert.deepEqual(
    getStatusPresentation('running'),
    { label: '実行中', ariaLabel: 'ステータス: 実行中' }
  );
  assert.deepEqual(getStatusPresentation('idle'), { label: '', ariaLabel: '' });
  assert.deepEqual(getStatusPresentation('unknown'), { label: '', ariaLabel: '' });
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
