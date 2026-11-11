const test = require('node:test');
const assert = require('node:assert/strict');
const { panesToStash, panesToRestore } = require('../renderer/paneFocusMode');

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
