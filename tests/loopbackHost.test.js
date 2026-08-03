'use strict';
// ループバック判定（utils/loopbackHost.js）の純粋関数テスト（issue #313 / PR #315 レビュー対応）。

const test = require('node:test');
const assert = require('node:assert/strict');

const { isLoopbackHost, isLoopbackDisplayValue } = require('../utils/loopbackHost');

test('isLoopbackHost: 127.0.0.1 / 127.0.0.0-8 全体 / ::1 / IPv4 射影は true', () => {
  assert.equal(isLoopbackHost('127.0.0.1'), true);
  assert.equal(isLoopbackHost('127.0.0.2'), true);
  assert.equal(isLoopbackHost('127.1.2.3'), true);
  assert.equal(isLoopbackHost('::1'), true);
  assert.equal(isLoopbackHost('::ffff:127.0.0.1'), true);
});

test('isLoopbackHost: 0.0.0.0 / :: / 空文字 / 通常の IP / localhost は false', () => {
  assert.equal(isLoopbackHost('0.0.0.0'), false);
  assert.equal(isLoopbackHost('::'), false);
  assert.equal(isLoopbackHost(''), false);
  assert.equal(isLoopbackHost('100.101.102.103'), false);
  assert.equal(isLoopbackHost(undefined), false);
  // isLoopbackHost() は main.js が実際に bind したアドレス（IP リテラル）だけを
  // 受け取る前提。名前解決が必要な 'localhost' をここに含めると、shouldRequireAuth()
  // の判定（認証ゲートそのもの）まで緩んでしまうため、意図的に false のまま
  // （画面側の即時案内だけ isLoopbackDisplayValue で別に判定する）。
  assert.equal(isLoopbackHost('localhost'), false);
});

test('isLoopbackDisplayValue: isLoopbackHost が true を返す値はすべて true', () => {
  assert.equal(isLoopbackDisplayValue('127.0.0.1'), true);
  assert.equal(isLoopbackDisplayValue('127.0.0.2'), true);
  assert.equal(isLoopbackDisplayValue('::1'), true);
  assert.equal(isLoopbackDisplayValue('::ffff:127.0.0.1'), true);
});

test('isLoopbackDisplayValue: localhost は大小文字・前後空白を問わず true（画面の案内専用の拡張）', () => {
  assert.equal(isLoopbackDisplayValue('localhost'), true);
  assert.equal(isLoopbackDisplayValue('LOCALHOST'), true);
  assert.equal(isLoopbackDisplayValue('  localhost  '), true);
});

test('isLoopbackDisplayValue: 0.0.0.0 / :: / 空文字 / 通常の IP / localhost 以外のホスト名は false', () => {
  assert.equal(isLoopbackDisplayValue('0.0.0.0'), false);
  assert.equal(isLoopbackDisplayValue('::'), false);
  assert.equal(isLoopbackDisplayValue(''), false);
  assert.equal(isLoopbackDisplayValue('100.101.102.103'), false);
  assert.equal(isLoopbackDisplayValue(undefined), false);
  assert.equal(isLoopbackDisplayValue('example.local'), false);
});
