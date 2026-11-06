'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const mobileSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'mobile.js'), 'utf8');

test('管理ペインの閉じる判断・文言とモバイル初回並びは displayStatus を参照する', () => {
  assert.match(appSource, /shouldConfirmClose\(confirmClosePref, _t\?\.displayStatus \|\| 'idle'\)/);
  assert.match(appSource, /getStatusPresentation\(t\?\.displayStatus, t\?\.apiPaneNote\)/);
  assert.match(mobileSource, /getStatusRank\(terms\[a\]\.displayStatus \|\| terms\[a\]\.status\)/);
  assert.match(mobileSource, /getStatusRank\(terms\[b\]\.displayStatus \|\| terms\[b\]\.status\)/);
});

test('running のタイマーは裏の作業を保持し、API status と終了後の表示を再計算する', () => {
  const vm = require('node:vm');
  const { deriveStatus, deriveDisplayStatus } = require('../renderer/statusState');
  const start = appSource.indexOf('function clearRunningIdleTimer');
  const end = appSource.indexOf('function isPaneDisplayWaiting', start);
  let now = 10000;
  let callback;
  let redraws = 0;
  const pane = { status: 'running', displayStatus: 'running', backgroundWorkRunning: true, lastOutputTime: 9000, lastInputTime: 0 };
  const context = {
    terminals: { pane }, deriveStatus, deriveDisplayStatus,
    Date: { now: () => now }, Math,
    RUNNING_IDLE_TIMEOUT_MS: 1500, RUNNING_INPUT_GUARD_MS: 200,
    setTimeout: fn => { callback = fn; return 1; }, clearTimeout: () => {},
    isPaneDisplayWaiting: () => false, updatePaneStatus: () => { redraws++; },
  };
  vm.createContext(context);
  vm.runInContext(appSource.slice(start, end), context);
  context.armRunningIdleTimer('pane');
  now = 10501; callback();
  assert.equal(pane.status, 'idle');
  assert.equal(pane.displayStatus, 'running');
  const before = redraws;
  context.recomputeStatus('pane');
  assert.equal(redraws, before);
  pane.backgroundWorkRunning = false;
  context.recomputeStatus('pane');
  assert.equal(pane.displayStatus, 'idle');
  assert.ok(redraws > before);
});


test('モバイルの閉じる確認はペイン名とバッジの解決済みラベルを保つ', async () => {
  const vm = require('node:vm');
  const statusPresentation = require('../renderer/statusPresentation');
  const start = mobileSource.indexOf('async function closeTerm(');
  const end = mobileSource.indexOf('\n}\n', start) + 2;
  let message;
  const context = { cards: {}, statusPresentation, window: { confirm: value => { message = value; return false; } } };
  vm.createContext(context);
  vm.runInContext(mobileSource.slice(start, end), context);
  // キャンセルしてAPIへ進まず、実際の確認文だけを検証する。
  for (const label of ['完了', '見守り中', '入力待ち', '実行中']) {
    context.cards.pane = { statusLabel: label, backgroundWorkRunning: true };
    await context.closeTerm('pane', '作業ペイン');
    assert.equal(message, '「作業ペイン」\n' + statusPresentation.getCloseConfirmation(label, true));
  }
});
