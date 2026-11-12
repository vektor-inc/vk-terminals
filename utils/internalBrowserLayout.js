'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKInternalBrowserLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // 2 列以上でもペイン見出しの操作群が欠けない幅を残す。
  const MIN_PANE_COLUMN_WIDTH = 272;
  function browserWidthMax(availableWidth, columns = 1, windowWidth = availableWidth) {
    const available = Math.max(0, Math.floor(availableWidth));
    // ペイン領域が足りないときはブラウザの操作可能な下限を優先する。
    const paneLimit = Math.min(available, Math.max(360, available - Math.max(320, Math.max(1, columns) * MIN_PANE_COLUMN_WIDTH)));
    // 利用者の判断でトーストを左サイドバーにも重ね、画面左側に 96px を残す。
    return Math.min(paneLimit, Math.max(0, Math.floor(windowWidth) - 96));
  }
  function clampBrowserWidth(width, availableWidth, columns = 1, windowWidth = availableWidth) {
    const max = browserWidthMax(availableWidth, columns, windowWidth);
    if (max < 360) return max;
    const preferred = Math.min(720, Math.max(480, Math.round(availableWidth * 0.45)));
    return Math.min(max, Math.max(360, Number.isFinite(width) ? Math.round(width) : preferred));
  }
  function shouldWrapToastPhrase(windowWidth, browserWidth) {
    return windowWidth - browserWidth - 32 < 200;
  }
  return { clampBrowserWidth, browserWidthMax, shouldWrapToastPhrase, MIN_PANE_COLUMN_WIDTH };
});
