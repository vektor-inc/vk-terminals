'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKInternalBrowserLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // 2 列以上でもペイン見出しの操作群が欠けない幅を残す。
  const MIN_PANE_COLUMN_WIDTH = 272;
  function browserAvailableWidth(rootWidth, sidebarWidth, otherWidths = []) {
    return Math.max(0, rootWidth - sidebarWidth - otherWidths.reduce((sum, width) => sum + width, 0));
  }
  function paneReservedWidth(gridMinimumWidth, columns = 1) {
    return Math.max(gridMinimumWidth, 320, Math.max(1, columns) * MIN_PANE_COLUMN_WIDTH);
  }
  function shouldFoldSetupPanel(rootWidth, sidebarWidth, gridMinimumWidth, panelMinimumWidth, columns = 1, browserOpen = true) {
    if (!browserOpen) return rootWidth < 1000;
    return rootWidth - sidebarWidth < 360 + paneReservedWidth(gridMinimumWidth, columns) + panelMinimumWidth;
  }
  function browserWidthMax(availableWidth, columns = 1, windowWidth = availableWidth, gridMinimumWidth = 0) {
    const available = Math.max(0, Math.floor(availableWidth));
    const paneLimit = Math.min(Math.max(0, available - gridMinimumWidth),
      Math.max(360, available - paneReservedWidth(gridMinimumWidth, columns)));
    // トーストの置き場所として画面左側に 96px を残す。
    return Math.min(paneLimit, Math.max(0, Math.floor(windowWidth) - 96));
  }
  function clampBrowserWidth(width, availableWidth, columns = 1, windowWidth = availableWidth, gridMinimumWidth = 0) {
    const max = browserWidthMax(availableWidth, columns, windowWidth, gridMinimumWidth);
    if (max < 360) return max;
    const preferred = Math.min(720, Math.max(480, Math.round(availableWidth * 0.45)));
    return Math.min(max, Math.max(360, Number.isFinite(width) ? Math.round(width) : preferred));
  }
  function shouldWrapToastPhrase(windowWidth, browserWidth) {
    // 32 は renderer/style.css の .vk-toast-layer の max-width（左右の余白 16px × 2）と揃える。
    return windowWidth - browserWidth - 32 < 200;
  }
  return { browserAvailableWidth, shouldFoldSetupPanel, paneReservedWidth, clampBrowserWidth, browserWidthMax, shouldWrapToastPhrase, MIN_PANE_COLUMN_WIDTH };
});
