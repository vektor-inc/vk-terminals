// モバイルページの「🔔 通知」カード（issue #396）が、5 状態のうちどれを表示すべきかを
// 判定する純粋ロジック。DOM 操作（renderer/mobile.js）とは分離し、Node（テスト）と
// ブラウザ（mobile.html が <script> で読み込み）の両方から使える UMD 形式にする
// （utils/widgetContract.js と同じ方針）。
//
// 判定の優先順位（司・植草が決めた画面設計。issue #396 コメント参照）:
//   1. HTTPS で開かれていない（isSecureContext === false）        → 'insecure'
//   2. 通知に対応していないブラウザ（Notification/serviceWorker/PushManager が無い）
//                                                                  → 'unsupported'
//   3. ブラウザ側で通知を拒否済み（Notification.permission === 'denied'）
//                                                                  → 'denied'
//   4. 許可済み、かつこの端末が購読登録済み（permission === 'granted' && hasSubscription）
//                                                                  → 'granted-registered'
//   5. それ以外（まだ許可を求めていない。または許可済みだが未登録）→ 'not-requested'
//
// 「停止」を押した直後は Notification.permission が 'granted' のまま残る仕様のため
// （issue #396: ブラウザの許可自体は取り消されない）、5 の判定は permission ではなく
// hasSubscription（購読情報の有無）だけで granted-registered と区別する。これにより
// 「停止」後は未許可時と同じ 'not-requested' 表示に戻り、許可済みかどうかで文言を
// 変えないという要件を満たす。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKNotificationUiState = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NOTIFICATION_UI_STATES = Object.freeze([
    'not-requested',
    'granted-registered',
    'denied',
    'insecure',
    'unsupported',
  ]);

  /**
   * @param {{ isSecureContext: boolean, supported: boolean,
   *           permission: 'default'|'granted'|'denied'|undefined,
   *           hasSubscription: boolean }} params
   * @returns {'not-requested'|'granted-registered'|'denied'|'insecure'|'unsupported'}
   */
  function determineNotificationUiState(params) {
    var p = params || {};
    if (p.isSecureContext === false) return 'insecure';
    if (!p.supported) return 'unsupported';
    if (p.permission === 'denied') return 'denied';
    if (p.permission === 'granted' && p.hasSubscription) return 'granted-registered';
    return 'not-requested';
  }

  return {
    NOTIFICATION_UI_STATES: NOTIFICATION_UI_STATES,
    determineNotificationUiState: determineNotificationUiState,
  };
});
