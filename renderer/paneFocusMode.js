// ペインの一時的な単独表示で格納・復元する対象を決める。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKPaneFocusMode = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // 操作開始時にグリッドにいた他のペインだけを記録する。
  function panesToStash(order, selectedId) {
    return order.filter(id => id !== selectedId);
  }

  // 手動復元・削除済みのペインと、API で閉鎖が保護された管理ペインは戻さない。
  function panesToRestore(stashedIds, stashOrder, terminals) {
    return stashedIds.filter(id => stashOrder.includes(id) && terminals[id] && terminals[id].lock?.close !== false);
  }

  return { panesToStash, panesToRestore };
});
