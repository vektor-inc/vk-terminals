'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { isAllowedBrowserPermission } = require('../utils/internalBrowserPolicy');
const { createInternalBrowser } = require('../utils/internalBrowser');

const DENIED = ['clipboard-read', 'media', 'notifications', 'geolocation', 'openExternal', 'fullscreen', 'pointerLock', 'midiSysex', 'unknown', '', undefined, null];

test('アプリ内ブラウザはクリップボードへの書き込みだけを許可する', () => {
  assert.equal(isAllowedBrowserPermission('clipboard-sanitized-write'), true);
  for (const permission of DENIED) assert.equal(isAllowedBrowserPermission(permission), false, String(permission));
});

test('アプリ内ブラウザの権限ハンドラはクリップボードへの書き込みだけを許可する', () => {
  const browserSession = new EventEmitter();
  browserSession.webRequest = { onBeforeRequest() {}, onCompleted() {} };
  let requestHandler;
  let checkHandler;
  browserSession.setPermissionRequestHandler = (handler) => { requestHandler = handler; };
  browserSession.setPermissionCheckHandler = (handler) => { checkHandler = handler; };
  const win = { isDestroyed: () => false, webContents: { send() {} }, contentView: { addChildView() {}, removeChildView() {} } };
  createInternalBrowser(win, { WebContentsView: class {}, session: { fromPartition: () => browserSession } });
  const request = (permission) => {
    let granted;
    requestHandler({}, permission, (value) => { granted = value; }, { requestingUrl: 'https://github.com/' });
    return granted;
  };
  // Electron 44 の check handler は (webContents, permission, requestingOrigin, details) で呼ばれ、webContents は null のこともある。
  const check = (permission) => checkHandler(null, permission, 'https://github.com', { requestingUrl: 'https://github.com/' });
  assert.equal(request('clipboard-sanitized-write'), true);
  assert.equal(check('clipboard-sanitized-write'), true);
  for (const permission of DENIED) {
    assert.equal(request(permission), false, String(permission));
    assert.equal(check(permission), false, String(permission));
  }
});
