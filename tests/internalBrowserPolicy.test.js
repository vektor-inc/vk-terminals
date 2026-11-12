'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { PARTITION, clampBrowserWidth, validateBrowserBounds, isBrowserUrl } = require('../utils/internalBrowserPolicy');
const { navigationUrl } = require('../utils/internalBrowser');

test('専用 persist パーティションと HTTP(S) URL の制限', () => {
  assert.equal(PARTITION, 'persist:vk-terminals-internal-browser');
  assert.equal(isBrowserUrl('https://github.com/login'), true);
  assert.equal(isBrowserUrl('http://example.com'), true);
  assert.equal(isBrowserUrl('file:///etc/passwd'), false);
  assert.equal(isBrowserUrl('javascript:alert(1)'), false);
});

test('Electron の新旧ナビゲーションイベントから URL を取り出す', () => {
  assert.equal(navigationUrl('https://github.com'), 'https://github.com');
  assert.equal(navigationUrl({ url: 'https://github.com/login' }), 'https://github.com/login');
  assert.equal(navigationUrl({}), undefined);
});

test('幅は既定値とペイン残幅でクランプする', () => {
  assert.equal(clampBrowserWidth(NaN, 1400), 630);
  assert.equal(clampBrowserWidth(100, 1400), 360);
  assert.equal(clampBrowserWidth(1500, 800), 480);
});

test('WebContentsView の座標は有限なウィンドウ内の矩形だけを受け入れる', () => {
  const windowBounds = { width: 800, height: 600 };
  assert.deepEqual(validateBrowserBounds({ x: 400, y: 40, width: 400, height: 560 }, windowBounds), { x: 400, y: 40, width: 400, height: 560 });
  assert.equal(validateBrowserBounds({ x: 400, y: 40, width: 401, height: 560 }, windowBounds), null);
  assert.equal(validateBrowserBounds({ x: NaN, y: 40, width: 400, height: 560 }, windowBounds), null);
  assert.equal(validateBrowserBounds({ x: -1, y: 40, width: 400, height: 560 }, windowBounds), null);
});
