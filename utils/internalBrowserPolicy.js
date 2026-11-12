'use strict';

const { isSafeHttpUrl } = require('../renderer/urlSafety');
const { clampBrowserWidth } = require('./internalBrowserLayout');

const PARTITION = 'persist:vk-terminals-internal-browser';

function validateBrowserBounds(rect, windowBounds) {
  if (!rect || !windowBounds) return null;
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (!values.every(Number.isFinite)) return null;
  const [x, y, width, height] = values.map(Math.round);
  if (x < 0 || y < 0 || width < 0 || height < 0 || x + width > windowBounds.width || y + height > windowBounds.height) return null;
  return { x, y, width, height };
}

function isBrowserUrl(url) {
  return isSafeHttpUrl(url);
}

module.exports = { PARTITION, clampBrowserWidth, validateBrowserBounds, isBrowserUrl };
