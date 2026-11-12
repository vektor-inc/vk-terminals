'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKInternalBrowserLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function browserWidthMax(windowWidth) {
    const available = Math.max(0, Math.floor(windowWidth));
    // 利用者の判断により左サイドバーにもトーストを重ね、ページ左側に 96px を残す。
    return Math.max(0, available - 96);
  }
  function clampBrowserWidth(width, windowWidth) {
    const max = browserWidthMax(windowWidth);
    if (max < 360) return max;
    const preferred = Math.min(720, Math.max(480, Math.round(windowWidth * 0.45)));
    return Math.min(max, Math.max(360, Number.isFinite(width) ? Math.round(width) : preferred));
  }
  function shouldWrapToastPhrase(windowWidth, browserWidth) {
    return windowWidth - browserWidth - 32 < 200;
  }
  return { clampBrowserWidth, browserWidthMax, shouldWrapToastPhrase };
});
