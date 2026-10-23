// ペインヘッダーのペインIDバッジに表示する文言を組み立てる。
//
// Node（require）とブラウザ（index.html の <script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKPaneIdBadge = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ペインID（main.js の nextId で振られる数値の文字列）から、バッジの表示文言を返す。
  // 例: '6' -> 'ペインid : 6'。ID が空・未定義のときは空文字を返す。
  function getPaneIdBadgeLabel(paneId) {
    if (paneId === undefined || paneId === null || String(paneId) === '') return '';
    return `ペインid : ${paneId}`;
  }

  return { getPaneIdBadgeLabel };
});
