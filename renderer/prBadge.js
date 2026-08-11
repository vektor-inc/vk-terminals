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

  // 第2引数 options:
  //   - external: 既存オプション。true（既定）で aria-label に「（外部ブラウザ）」を付与する。
  //   - prWaitingMerge（issue #363）: true のとき「マージ待ち」状態（青）で表示する。
  //     この module（renderer 内部限定）だけの名前で、HTTP API（POST /api/set-title の
  //     `waitingMerge` / GET /api/states の `apiWaitingMerge`）とは意図的に揃えていない
  //     （外部との取り決めが必要なのは HTTP API 側の名前のみのため）。
  //     options 経由の追加フィールドのため、既存の呼び出し
  //     `getPrBadgePresentation(bool)` / `getPrBadgePresentation(bool, { external })` は
  //     prWaitingMerge 未指定 → false 扱いとなり、そのまま動作する（後方互換）。
  //   prMerged と prWaitingMerge が同時に true の場合は prMerged を優先する
  //   （マージ済みが最終状態のため）。
  //
  // 可視ラベル文言（バッジ本文）は3状態とも "PR" のまま固定。状態はクラス名・
  // アイコン（aria-hidden）・aria-label・title 用ラベル（titleLabel）でのみ表す。
  function getPrBadgePresentation(prMerged, options) {
    const merged = prMerged === true;
    const hasExternalOption = options && Object.prototype.hasOwnProperty.call(options, 'external');
    const external = hasExternalOption ? options.external === true : true;
    const externalSuffix = external ? '（外部ブラウザ）' : '';
    // merged が true のときは prWaitingMerge を無視する（prMerged 優先）。
    const waitingMerge = !merged && !!(options && options.prWaitingMerge === true);

    let stateClass = '';
    let ariaVerb = 'プルリクエストを開く';
    let icon = '↗';
    let titleLabel = 'PR';
    if (merged) {
      stateClass = ' merged';
      ariaVerb = 'マージ済みのプルリクエストを開く';
      icon = '✓';
      titleLabel = 'マージ済みのPR';
    } else if (waitingMerge) {
      stateClass = ' awaiting-merge';
      ariaVerb = 'マージ待ちのプルリクエストを開く';
      icon = '…';
      titleLabel = 'マージ待ちのPR';
    }

    return {
      className: 'pane-badge pane-task-title-pr' + stateClass,
      ariaLabel: ariaVerb + externalSuffix,
      icon,
      merged,
      waitingMerge,
      // titleLabel: ホバー時ツールチップ用の状態ラベル。呼び出し側で
      // `${titleLabel}\n${url}` の形式に組み立てる（タイトルリンク側の title\nurl 形式に揃える）。
      titleLabel,
    };
  }

  return {
    getPrBadgePresentation,
  };
});
