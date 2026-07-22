// PR バッジの表示情報を PC サイドバーとモバイルで共有する。
//
// Node（require）とブラウザ（mobile.html の <script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKPrBadge = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function getPrBadgePresentation(prMerged, options) {
    const merged = prMerged === true;
    const hasExternalOption = options && Object.prototype.hasOwnProperty.call(options, 'external');
    const external = hasExternalOption ? options.external === true : true;
    const externalSuffix = external ? '（外部ブラウザ）' : '';
    return {
      className: 'pane-badge pane-task-title-pr' + (merged ? ' merged' : ''),
      ariaLabel: (merged
        ? 'マージ済みのプルリクエストを開く'
        : 'プルリクエストを開く') + externalSuffix,
      icon: merged ? '✓' : '↗',
      merged,
    };
  }

  return {
    getPrBadgePresentation,
  };
});
