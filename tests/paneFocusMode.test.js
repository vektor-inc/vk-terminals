const test = require('node:test');
const assert = require('node:assert/strict');
const { panesToStash, panesToRestore, shouldOpenSidebarForPane, orderBeforeFocusMode } = require('../renderer/paneFocusMode');

test('ペイン幅を確保できるときだけサイドバーを開く', () => {
  assert.equal(shouldOpenSidebarForPane(390, 240), false);
  assert.equal(shouldOpenSidebarForPane(600, 270), false);
  assert.equal(shouldOpenSidebarForPane(1400, 330), true);
  assert.equal(shouldOpenSidebarForPane(626, 240), true);
  assert.equal(shouldOpenSidebarForPane(625, 240), false);
});

test('選択ペインと閉鎖保護ペインは格納候補にしない', () => {
  const terminals = { a: {}, b: {}, c: { lock: { close: false } }, d: { lock: { close: true } } };
  assert.deepEqual(panesToStash(['a', 'b', 'c', 'd'], 'b', terminals), ['a', 'd']);
});

test('手動復元・削除済みと管理ペインを復元しない', () => {
  const ids = ['a', 'b', 'c'];
  const stashOrder = ['manual', 'a', 'c'];
  const terminals = { a: {}, c: { lock: { close: false } }, manual: {} };
  assert.deepEqual(panesToRestore(ids, stashOrder, terminals), ['a']);
});

test('単独表示の開始時の並びに組み直し、開始後に増えたペインは末尾に残す', () => {
  // [a, b, c] で c を単独表示し、a・b が末尾に戻った [c, a, b] を元の並びに直す。
  assert.deepEqual(orderBeforeFocusMode(['a', 'b', 'c'], ['c', 'a', 'b']), ['a', 'b', 'c']);
  // 開始後に増えた new は末尾、閉じられた b は含めない。
  assert.deepEqual(orderBeforeFocusMode(['a', 'b', 'c'], ['c', 'new', 'a']), ['a', 'c', 'new']);
});
