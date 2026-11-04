'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PANE_NOTES, parsePaneNoteUpdate } = require('../utils/paneNote');

// POST /api/set-title の paneNote（issue #536）のパーサ。

test('parsePaneNoteUpdate: watching / done は受理する', () => {
  assert.deepEqual(parsePaneNoteUpdate({ paneNote: 'watching' }), { provided: true, value: 'watching' });
  assert.deepEqual(parsePaneNoteUpdate({ paneNote: 'done' }), { provided: true, value: 'done' });
  assert.deepEqual(PANE_NOTES, ['watching', 'done']);
});

test('parsePaneNoteUpdate: null は「明示的に消す」として受理する', () => {
  assert.deepEqual(parsePaneNoteUpdate({ paneNote: null }), { provided: true, value: null });
});

test('parsePaneNoteUpdate: 項目が送られなかった場合は現在値を変えない（provided: false）', () => {
  assert.deepEqual(parsePaneNoteUpdate({ termId: '1', title: 'x' }), { provided: false, value: null });
  assert.deepEqual(parsePaneNoteUpdate({ paneNote: undefined }), { provided: false, value: null });
});

test('parsePaneNoteUpdate: 語彙外・型違いは無視する（provided: false）', () => {
  for (const bad of ['zzz', 'Watching', ' done', 'done ', '', 5, true, false, [], ['done'], {}, '__proto__', 'constructor']) {
    assert.deepEqual(parsePaneNoteUpdate({ paneNote: bad }), { provided: false, value: null });
  }
});

test('parsePaneNoteUpdate: ボディがオブジェクトでなくても壊れない', () => {
  for (const body of [null, undefined, 'x', 5, []]) {
    assert.deepEqual(parsePaneNoteUpdate(body), { provided: false, value: null });
  }
});
