'use strict';

const { isSafeHttpUrl, isHttpUrl } = require('../renderer/urlSafety');
const { clampBrowserWidth } = require('./internalBrowserLayout');

const HELP_URL = 'vk-terminals-help://guide/';
function isHelpUrl(url) {
  return typeof url === 'string' && /^vk-terminals-help:\/\/guide\/(?:#.*)?$/i.test(url);
}

const PARTITION = 'persist:vk-terminals-internal-browser';

function validateBrowserBounds(rect, windowBounds) {
  if (!rect || !windowBounds) return null;
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every(Number.isFinite)) return null;
  if (![windowBounds.width, windowBounds.height].every(Number.isFinite)) return null;
  if (rect.x < 0 || rect.y < 0 || rect.width < 0 || rect.height < 0 ||
      rect.x + rect.width > windowBounds.width + 1 || rect.y + rect.height > windowBounds.height + 1) return null;
  const [x, y, width, height] = values.map(Math.round);
  // 拡大表示時の小数の計算誤差と、座標と大きさを別々に丸めた際の 1px のはみ出しを収める。
  return { x, y, width: Math.max(0, Math.min(width, windowBounds.width - x)), height: Math.max(0, Math.min(height, windowBounds.height - y)) };
}

function isBrowserUrl(url) { return isSafeHttpUrl(url); }
function isNavigationUrl(url) { return isHttpUrl(url) || isHelpUrl(url); }

module.exports = { HELP_URL, isHelpUrl, PARTITION, clampBrowserWidth, validateBrowserBounds, isBrowserUrl, isNavigationUrl };
