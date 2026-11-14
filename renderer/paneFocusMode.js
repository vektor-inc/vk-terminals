// ペインの一時的な単独表示で格納・復元する対象を決める。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKPaneFocusMode = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // ペインヘッダーの 385px コンテナ判定より広い領域を確保する。
  const MIN_FOCUSED_PANE_WIDTH = 386;

  function shouldOpenSidebarForPane(viewportWidth, sidebarWidth) {
    return viewportWidth - sidebarWidth >= MIN_FOCUSED_PANE_WIDTH;
  }

  // 操作開始時にグリッドにいた他のペインだけを記録する。
  function panesToStash(order, selectedId, terminals) {
    return order.filter(id => id !== selectedId && terminals[id]?.lock?.close !== false);
  }

  // 手動復元・削除済みのペインと、API で閉鎖が保護された管理ペインは戻さない。
  function panesToRestore(stashedIds, stashOrder, terminals) {
    return stashedIds.filter(id => stashOrder.includes(id) && terminals[id] && terminals[id].lock?.close !== false);
  }

  // 単独表示の開始時の並び（originalOrder）の順に組み直す。開始後に増えたペインは末尾に残す。
  function orderBeforeFocusMode(originalOrder, order) {
    const known = order.filter(id => originalOrder.includes(id))
      .sort((a, b) => originalOrder.indexOf(a) - originalOrder.indexOf(b));
    return [...known, ...order.filter(id => !originalOrder.includes(id))];
  }

  return { panesToStash, panesToRestore, shouldOpenSidebarForPane, orderBeforeFocusMode };
});
