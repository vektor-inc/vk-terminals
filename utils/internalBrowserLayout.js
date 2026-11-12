'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKInternalBrowserLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // 見出しの操作群 173px、状態 59px、左右 padding 16px、gap 8px と余裕 16px。
  const MIN_PANE_COLUMN_WIDTH = 272;
  function browserWidthMax(windowWidth, columns = 1) {
    const available = Math.max(0, Math.floor(windowWidth));
    // 両立不能な狭さではサイドバーの操作可能な下限を優先する。
    return Math.min(available, Math.max(360, available - Math.max(320, Math.max(1, columns) * MIN_PANE_COLUMN_WIDTH)));
  }
  function clampBrowserWidth(width, windowWidth, columns = 1) {
    const max = browserWidthMax(windowWidth, columns);
    if (max < 360) return max;
    const preferred = Math.min(720, Math.max(480, Math.round(windowWidth * 0.45)));
    return Math.min(max, Math.max(360, Number.isFinite(width) ? Math.round(width) : preferred));
  }
  return { clampBrowserWidth, browserWidthMax, MIN_PANE_COLUMN_WIDTH };
});
