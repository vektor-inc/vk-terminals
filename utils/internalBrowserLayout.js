'use strict';
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKInternalBrowserLayout = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function clampBrowserWidth(width, windowWidth) {
    const max = Math.max(0, Math.floor(windowWidth) - 320);
    if (max < 360) return max;
    const preferred = Math.min(720, Math.max(480, Math.round(windowWidth * 0.45)));
    return Math.min(max, Math.max(360, Number.isFinite(width) ? Math.round(width) : preferred));
  }
  return { clampBrowserWidth };
});
