// Web Push（issue #396）の宛先登録に失敗したとき、サーバーが返す機械可読な理由文字列
// （{"error": "..."}）を、利用者向けの文言に変換する純粋ロジック。DOM 操作
// （renderer/mobile.js）とは分離し、Node（テスト）とブラウザ（mobile.html が <script> で
// 読み込み）の両方から使える UMD 形式にする（utils/notificationUiState.js と同じ方針）。
//
// 【なぜこれが要るか（植草の UX レビュー再指摘・U-1）】以前は宛先登録の API が失敗を
// 返したとき（HTTP 400 / 503）、サーバーの応答本文（{"error": "..."}）を読まず
// 「通知の登録に失敗しました: HTTP 400」とだけ表示していた。「登録できる端末が
// 20台に達している」ことも「サーバー側で通知の準備に失敗している」ことも利用者に
// 伝わらず、次に何をすればよいか判断できなかった。
//
// main.js が実際に返す理由文字列（POST /api/push-subscribe・GET /api/push-public-key）:
//   - 'too many subscriptions'         : utils/webPushSubscriptions.js の
//                                         canAddSubscription() が false のとき（400）
//   - 'push notifications unavailable' : ensurePushReady() が false のとき（503）
// この2つ以外・応答本文が読めない/JSON でない場合は理由不明として扱い、呼び出し側
// （mobile.js）が既存どおり「通知の登録に失敗しました: HTTP <番号>」を表示する
// （司の差し戻し指示: 未知の値は現状どおりでよい。押す前に状態を先読みする6つ目の
// UI 状態は今回は作らない）。

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKPushErrorMessages = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 司の差し戻し内容に書かれた文言をそのまま使う（言い換えない）。
  var PUSH_ERROR_MESSAGES = Object.freeze({
    'too many subscriptions':
      '登録できる端末の数（20台）が上限に達しています。使っていない端末の登録を解除してから、もう一度お試しください。',
    'push notifications unavailable':
      'この VK Terminals では現在通知を送れません（サーバー側の準備に問題があります）。VK Terminals を再起動しても改善しない場合は、動かしている人に確認してください。',
  });

  /**
   * サーバーが返した理由文字列（応答本文の error フィールド）から、利用者向けの
   * 文言を返す。既知の理由でなければ null を返す（呼び出し側が既定のフォールバック
   * 文言を出す）。
   * @param {unknown} reason
   * @returns {string|null}
   */
  function describePushErrorReason(reason) {
    if (typeof reason === 'string' && Object.prototype.hasOwnProperty.call(PUSH_ERROR_MESSAGES, reason)) {
      return PUSH_ERROR_MESSAGES[reason];
    }
    return null;
  }

  return {
    PUSH_ERROR_MESSAGES: PUSH_ERROR_MESSAGES,
    describePushErrorReason: describePushErrorReason,
  };
});
