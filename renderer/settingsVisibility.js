'use strict';

// 設定ダイアログのフィールド表示を visibleWhen descriptor で判定する純粋関数。
// descriptor 側（vk-orchestrator など）が付与する表示条件を GUI 側で消費し、
// DOM に依存しない形でユニットテストできるようにする。
//
// 判定方針:
//   - visibleWhen が無いフィールドは常に表示（後方互換）。
//   - 条件値の比較は String(現在値) === String(value) で行う。
//   - 参照先 key が存在しない、または現在値が undefined の場合は不一致として扱う。
//   - hide: true は一致時に隠す。hide 省略/false は一致時に表示し、不一致なら隠す。
//   - 配列指定では、いずれかの条件が隠す評価になったら非表示（AND セマンティクス）。
//   - 壊れた visibleWhen/条件は保存不能や全体非表示にしない（fail-open）。
//
// @param {Object} field          設定フィールド descriptor。
// @param {Object} values         現在のフォーム値。key => 現在値。
// @return {boolean}              表示する場合は true。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSettingsVisibility = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

function isFieldVisible(field, values) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return true;
  const visibleWhen = field.visibleWhen;

  // visibleWhen 未指定は従来どおり常に表示。
  if (visibleWhen === undefined || visibleWhen === null) return true;

  const conditions = Array.isArray(visibleWhen) ? visibleWhen : [visibleWhen];
  if (conditions.length === 0) return true;

  for (const condition of conditions) {
    if (!isConditionVisible(condition, values)) return false;
  }

  return true;
}

function isConditionVisible(condition, values) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return true;
  if (typeof condition.key !== 'string' || condition.key.trim() === '') return true;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return true;

  const currentValue = values[condition.key];
  const matched = currentValue !== undefined && String(currentValue) === String(condition.value);

  if (condition.hide === true) {
    return !matched;
  }

  return matched;
}

return {
  isFieldVisible,
};
});
