const test = require('node:test');
const assert = require('node:assert/strict');
const { panesToStash, panesToRestore } = require('../renderer/paneFocusMode');

test('選択ペイン以外のグリッドだけを格納候補にする', () => {
  assert.deepEqual(panesToStash(['a', 'b', 'c'], 'b'), ['a', 'c']);
});

test('手動復元・削除済みと管理ペインを復元しない', () => {
  const ids = ['a', 'b', 'c'];
  const stashOrder = ['manual', 'a', 'c'];
  const terminals = { a: {}, c: { lock: { close: false } }, manual: {} };
  assert.deepEqual(panesToRestore(ids, stashOrder, terminals), ['a']);
});
