'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const mobileSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'mobile.js'), 'utf8');

test('管理ペインの閉じる判断・文言とモバイル初回並びは displayStatus を参照する', () => {
  assert.match(appSource, /shouldConfirmClose\(confirmClosePref, _t\?\.displayStatus \|\| 'idle'\)/);
  assert.match(appSource, /getStatusPresentation\(t\?\.displayStatus\)/);
  assert.match(mobileSource, /getStatusRank\(terms\[a\]\.displayStatus \|\| terms\[a\]\.status\)/);
  assert.match(mobileSource, /getStatusRank\(terms\[b\]\.displayStatus \|\| terms\[b\]\.status\)/);
});

test('running のタイマー満了時は API 用・表示用 status のどちらも変わらなければ再描画しない', () => {
  const start = appSource.indexOf('function armRunningIdleTimer');
  const end = appSource.indexOf('\nfunction recomputeStatus', start);
  const body = appSource.slice(start, end);
  assert.match(body, /let changed = false;/);
  assert.match(body, /if \(changed\) updatePaneStatus\(paneId\);/);
  assert.doesNotMatch(body, /\n\s*updatePaneStatus\(paneId\);/);
});
