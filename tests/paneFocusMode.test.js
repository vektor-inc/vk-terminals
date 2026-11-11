const test = require('node:test');
const assert = require('node:assert/strict');
const { panesToStash, panesToRestore, shouldOpenSidebarForPane } = require('../renderer/paneFocusMode');

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
