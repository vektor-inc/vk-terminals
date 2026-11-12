'use strict';

// ペイン内 URL のクリックはページを直接開かず、開き先メニューへ渡す。
// Node と renderer の両方で使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKTerminalLinkPolicy = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function isMacPlatform(platformOverride) {
    const platform = typeof platformOverride === 'string'
      ? platformOverride : ((typeof navigator !== 'undefined' && navigator.platform) || '');
    return /Mac|iPhone|iPod|iPad/i.test(platform);
  }

  function isLinkOpenModifierPressed(event, isMac) {
    if (!event) return false;
    const mac = typeof isMac === 'boolean' ? isMac : isMacPlatform();
    return mac ? !!event.metaKey : !!event.ctrlKey;
  }

  const TERMINAL_LINK_CLICK_MODES = ['click', 'modifier'];
  const DEFAULT_TERMINAL_LINK_CLICK_MODE = 'click';
  function normalizeTerminalLinkClickMode(value) {
    return TERMINAL_LINK_CLICK_MODES.includes(value) ? value : DEFAULT_TERMINAL_LINK_CLICK_MODE;
  }

  function isDragDistance(from, to, threshold) {
    if (!from || !to) return false;
    return Math.hypot(to.x - from.x, to.y - from.y) > threshold;
  }

  function createTerminalLinkHandlers(deps) {
    const { openUrl, showTooltip, hideTooltip, isMac, getClickMode, wasDragged } = deps || {};
    if (typeof wasDragged !== 'function') {
      console.warn('[VKTerminalLinkPolicy] wasDragged が渡されていません。ドラッグ選択のガードが働きません。');
    }
    return {
      activate(event, url) {
        // 文字選択と主ボタン以外の操作ではメニューを出さない。
        if (event && typeof event.button === 'number' && event.button !== 0) return;
        if (event && typeof event.detail === 'number' && event.detail > 1) return;
        if (typeof wasDragged === 'function' && wasDragged()) return;

        // modifier 設定は修飾キー付きのときだけメニューを許す。
        const mode = normalizeTerminalLinkClickMode(typeof getClickMode === 'function' ? getClickMode() : undefined);
        if (mode === 'modifier' && !isLinkOpenModifierPressed(event, isMac)) return;
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (typeof openUrl === 'function') openUrl(url, event);
      },
      hover(event, url) { if (typeof showTooltip === 'function') showTooltip(event, url); },
      leave(event, url) { if (typeof hideTooltip === 'function') hideTooltip(event, url); },
    };
  }

  return {
    isMacPlatform, isLinkOpenModifierPressed, TERMINAL_LINK_CLICK_MODES,
    DEFAULT_TERMINAL_LINK_CLICK_MODE, normalizeTerminalLinkClickMode,
    isDragDistance, createTerminalLinkHandlers,
  };
});
