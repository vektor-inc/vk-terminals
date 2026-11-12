'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { missingSavedPaneCount, chooseUntrackedPaneIdentity } = require('../utils/paneHolderRestorePlan');

test('保存済み3件のうち1件が終了し、新規1件があっても不足は1件', () => {
  assert.equal(missingSavedPaneCount(3, 2), 1);
  assert.equal(missingSavedPaneCount(2, 3), 0);
});

test('保存済みの paneId との重なりを避ける', () => {
  const chosen = chooseUntrackedPaneIdentity('7', new Set(['1', '2']), new Set(['pane-7', 'pane-8']), 8);
  assert.deepEqual(chosen, { id: '9', paneId: 'pane-9', nextId: 10, renumbered: true });
});

test('termId が重なれば次の番号を割り当てる', () => {
  const chosen = chooseUntrackedPaneIdentity('2', new Set(['2']), new Set(['pane-2']), 5);
  assert.deepEqual(chosen, { id: '5', paneId: 'pane-5', nextId: 6, renumbered: true });
});
