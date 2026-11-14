const test = require('node:test');
const assert = require('node:assert/strict');
const { createWideState, planWideRestore, layoutBeforeWide, forgetWidePane } = require('../renderer/internalBrowserWideMode');

test('広く表示に入るときは閉鎖保護ペインを含むグリッドの全ペインを記録する', () => {
  // 記録した配列が元の配列と別物で、後から tree を変えても影響しないことも確かめる。
  const order = ['a', 'orchestrator', 'b'];
  const colFr = [2, 1];
  const wide = createWideState(order, colFr, null, 'b');
  assert.deepEqual(wide.stashedIds, ['a', 'orchestrator', 'b']);
  assert.deepEqual(wide.originalOrder, ['a', 'orchestrator', 'b']);
  assert.deepEqual(wide.colFr, [2, 1]);
  assert.equal(wide.rowFr, null);
  assert.equal(wide.focusedPaneId, 'b');
  order.push('c');
  colFr[0] = 9;
  assert.deepEqual(wide.originalOrder, ['a', 'orchestrator', 'b']);
  assert.deepEqual(wide.colFr, [2, 1]);
});

test('解除時は格納したペインだけを元の順で戻し、並びが変わらなければリサイズ比率も戻す', () => {
  // 手動で格納していた manual は戻す対象にしない。
  const wide = createWideState(['a', 'b', 'c'], [1, 2], [3, 1], 'a');
  const terminals = { a: {}, b: {}, c: {}, manual: {} };
  const plan = planWideRestore(wide, ['manual', 'a', 'b', 'c'], terminals);
  assert.deepEqual(plan.restoreIds, ['a', 'b', 'c']);
  assert.deepEqual(plan.sizing, { colFr: [1, 2], rowFr: [3, 1] });
});

test('広く表示中にペインが閉じられた・増えたときは比率を戻さない', () => {
  const terminals = { a: {}, b: {}, c: {}, api: {} };
  // 閉じたペインは戻す対象から外れ、列数が変わるため比率は均等のままにする。
  const closed = createWideState(['a', 'b', 'c'], [1, 2], null, 'a');
  forgetWidePane(closed, 'b');
  const closedPlan = planWideRestore(closed, ['a', 'c'], terminals);
  assert.deepEqual(closedPlan.restoreIds, ['a', 'c']);
  assert.equal(closedPlan.sizing, null);
  // API で増えたペインは末尾に加わってグリッドへ戻る。
  const added = createWideState(['a', 'b'], [1, 2], null, 'a');
  added.stashedIds.push('api');
  const addedPlan = planWideRestore(added, ['a', 'b', 'api'], terminals);
  assert.deepEqual(addedPlan.restoreIds, ['a', 'b', 'api']);
  assert.equal(addedPlan.sizing, null);
});

test('比率を記録していなければ均等のまま戻す', () => {
  const wide = createWideState(['a', 'b'], null, null, 'a');
  const plan = planWideRestore(wide, ['a', 'b'], { a: {}, b: {} });
  assert.deepEqual(plan.restoreIds, ['a', 'b']);
  assert.equal(plan.sizing, null);
  assert.deepEqual(planWideRestore(null, ['a'], { a: {} }), { restoreIds: [], sizing: null });
});

test('格納中のまま残っていないペインと削除済みのペインは戻さない', () => {
  const wide = createWideState(['a', 'b', 'c'], null, null, 'a');
  // b は格納場所から外れ、c は端末が既に無い。
  const plan = planWideRestore(wide, ['a', 'c'], { a: {} });
  assert.deepEqual(plan.restoreIds, ['a']);
});

test('保持役へは広く表示にする前の並びを保存する', () => {
  // 広く表示でないときは今の並びをそのまま保存する。
  assert.deepEqual(layoutBeforeWide(['a'], ['m'], 'a', null), { order: ['a'], stashOrder: ['m'], focusedPaneId: 'a' });
  // 広く表示中は、格納したペインをグリッド側へ、手動で格納していたペインは格納側に残す。
  const wide = createWideState(['a', 'b'], null, null, 'b');
  wide.stashedIds.push('api');
  const saved = layoutBeforeWide([], ['m', 'a', 'b', 'api'], 'api', wide);
  assert.deepEqual(saved, { order: ['a', 'b', 'api'], stashOrder: ['m'], focusedPaneId: 'b' });
  // 広く表示前にフォーカスしていたペインが閉じられていれば、今のフォーカスを使う。
  forgetWidePane(wide, 'b');
  const afterClose = layoutBeforeWide([], ['m', 'a', 'api'], 'a', wide);
  assert.deepEqual(afterClose, { order: ['a', 'api'], stashOrder: ['m'], focusedPaneId: 'a' });
});

test('広く表示でないときは戻す対象の更新を何もしない', () => {
  assert.doesNotThrow(() => forgetWidePane(null, 'a'));
});
