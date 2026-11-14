// アプリ内ブラウザの「広く表示」で格納・復元・保存する対象を決める（issue #613）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKInternalBrowserWideMode = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  // 広く表示に入る時点の状態を記録する。閉鎖保護ペインも格納するため、
  // ペインの広く表示（paneFocusMode.panesToStash）と違ってグリッドの全ペインを対象にする。
  function createWideState(order, colFr, rowFr, focusedPaneId) {
    const originalOrder = Array.isArray(order) ? order.slice() : [];
    return {
      stashedIds: originalOrder.slice(),
      originalOrder,
      colFr: Array.isArray(colFr) ? colFr.slice() : null,
      rowFr: Array.isArray(rowFr) ? rowFr.slice() : null,
      focusedPaneId: focusedPaneId || null,
    };
  }

  // 戻すペインと、手動リサイズ比率を戻せるかを決める。
  // 格納中のまま残っているペインだけを記録順に戻す。並びが広く表示前と完全に同じときだけ
  // 比率を戻す（ペインの増減で列数・行数が変わると比率の意味が変わるため）。
  function planWideRestore(wide, stashOrder, terminals) {
    if (!wide) return { restoreIds: [], sizing: null };
    const stashed = Array.isArray(stashOrder) ? stashOrder : [];
    const restoreIds = wide.stashedIds.filter(id => stashed.includes(id) && terminals && terminals[id]);
    const sameOrder = restoreIds.length === wide.originalOrder.length
      && restoreIds.every((id, index) => id === wide.originalOrder[index]);
    const sizing = sameOrder && (wide.colFr || wide.rowFr) ? { colFr: wide.colFr, rowFr: wide.rowFr } : null;
    return { restoreIds, sizing };
  }

  // 保持役へ保存する並びを返す。広く表示中は、広く表示にする前の並びとして保存し、
  // 再起動後にペインが全部格納されたままにならないようにする。
  function layoutBeforeWide(order, stashOrder, focusedPaneId, wide) {
    const grid = Array.isArray(order) ? order : [];
    const stashed = Array.isArray(stashOrder) ? stashOrder : [];
    if (!wide) return { order: grid.slice(), stashOrder: stashed.slice(), focusedPaneId };
    const restoreIds = wide.stashedIds.filter(id => stashed.includes(id));
    const focusTarget = [...grid, ...restoreIds].includes(wide.focusedPaneId) ? wide.focusedPaneId : focusedPaneId;
    return {
      order: [...grid, ...restoreIds],
      stashOrder: stashed.filter(id => !restoreIds.includes(id)),
      focusedPaneId: focusTarget,
    };
  }

  // 広く表示中に閉じたペイン・API で格納指定されたペインを戻す対象から外す。
  function forgetWidePane(wide, paneId) {
    if (!wide) return;
    wide.stashedIds = wide.stashedIds.filter(id => id !== paneId);
  }

  return { createWideState, planWideRestore, layoutBeforeWide, forgetWidePane };
});
