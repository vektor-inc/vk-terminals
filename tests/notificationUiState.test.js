'use strict';
// モバイルページの「🔔 通知」カード（issue #396）の表示状態判定に関する純粋関数のテスト。
// ブラウザ API（Notification / ServiceWorker / PushManager）を経由せず、
// utils/notificationUiState.js 単体で検証する。

const test = require('node:test');
const assert = require('node:assert/strict');

const { determineNotificationUiState, NOTIFICATION_UI_STATES } = require('../utils/notificationUiState');

const BASE = { isSecureContext: true, supported: true, permission: 'default', hasSubscription: false };

test('NOTIFICATION_UI_STATES: 5状態がすべて定義されている', () => {
  assert.deepEqual(
    [...NOTIFICATION_UI_STATES].sort(),
    ['denied', 'granted-registered', 'insecure', 'not-requested', 'unsupported'].sort()
  );
});

test('isSecureContext: false は他の条件によらず insecure が最優先', () => {
  assert.equal(determineNotificationUiState({ ...BASE, isSecureContext: false }), 'insecure');
  assert.equal(
    determineNotificationUiState({ ...BASE, isSecureContext: false, permission: 'granted', hasSubscription: true }),
    'insecure'
  );
});

test('supported: false は unsupported（isSecureContext: true が前提でも）', () => {
  assert.equal(determineNotificationUiState({ ...BASE, supported: false }), 'unsupported');
});

test('permission: denied は denied', () => {
  assert.equal(determineNotificationUiState({ ...BASE, permission: 'denied' }), 'denied');
});

test('permission: granted かつ hasSubscription: true は granted-registered', () => {
  assert.equal(
    determineNotificationUiState({ ...BASE, permission: 'granted', hasSubscription: true }),
    'granted-registered'
  );
});

test('permission: granted だが hasSubscription: false は not-requested（「停止」後に許可だけ残る状態）', () => {
  assert.equal(
    determineNotificationUiState({ ...BASE, permission: 'granted', hasSubscription: false }),
    'not-requested'
  );
});

test('permission: default は not-requested', () => {
  assert.equal(determineNotificationUiState({ ...BASE, permission: 'default' }), 'not-requested');
});

test('permission: undefined（Notification 未定義側の呼び出し）は not-requested 側に倒す', () => {
  assert.equal(determineNotificationUiState({ ...BASE, permission: undefined }), 'not-requested');
});

test('優先順位: insecure > unsupported > denied > granted-registered > not-requested', () => {
  // insecure が unsupported より優先されることを確認
  assert.equal(
    determineNotificationUiState({ isSecureContext: false, supported: false, permission: 'denied', hasSubscription: false }),
    'insecure'
  );
  // unsupported が denied より優先されることを確認
  assert.equal(
    determineNotificationUiState({ isSecureContext: true, supported: false, permission: 'denied', hasSubscription: false }),
    'unsupported'
  );
});
