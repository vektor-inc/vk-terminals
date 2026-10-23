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

  // 引数 termId は main.js の nextId で振られる番号（renderer の terminals[paneId].termId）。
  // 画面側の paneId（'pane-3' 形式）ではない。例: 6 -> 'ペインid : 6'。
  // termId が空・未定義のときは空文字を返す（呼び出し側はバッジを hidden にする）。
  function getPaneIdBadgeLabel(termId) {
    if (termId === undefined || termId === null || String(termId) === '') return '';
    return `ペインid : ${termId}`;
  }

  return { getPaneIdBadgeLabel };
});
