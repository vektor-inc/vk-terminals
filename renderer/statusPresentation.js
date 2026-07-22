// ペイン status の表示ラベル・aria・並び順を共有する。
//
// Node（require）とブラウザ（mobile.html の <script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKStatusPresentation = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const STATUS_ORDER = Object.freeze(['waiting', 'running', 'idle']);
  const STATUS_RANK = Object.freeze({
    waiting: 0,
    running: 1,
    idle: 2,
  });

  function getStatusPresentation(status) {
    if (status === 'waiting') return { label: '入力待ち', ariaLabel: 'ステータス: 入力待ち' };
    if (status === 'running') return { label: '実行中', ariaLabel: 'ステータス: 実行中' };
    return { label: '', ariaLabel: '' };
  }

  function getStatusRank(status) {
    return STATUS_RANK[status] != null ? STATUS_RANK[status] : STATUS_ORDER.length;
  }

  function compareStatus(a, b) {
    return getStatusRank(a) - getStatusRank(b);
  }

  return {
    STATUS_ORDER,
    STATUS_RANK,
    compareStatus,
    getStatusPresentation,
    getStatusRank,
  };
});
