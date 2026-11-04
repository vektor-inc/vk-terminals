'use strict';

// 設定ダイアログのフィールド状態を descriptor の条件で判定する純粋関数。
// descriptor 側（vk-orchestrator など）が付与する visibleWhen / disabledWhen を
// GUI 側で消費し、DOM に依存しない形でユニットテストできるようにする。
//
// 判定方針:
//   - 条件値の比較は String(現在値) === String(value) で行う。
//   - 参照先 key が存在しない、または現在値が undefined の場合は不一致として扱う。
//   - hide: true は一致時に false。hide 省略/false は一致時に true。
//   - 配列直下は従来どおり AND、anyOf 配下は OR として評価する。
//   - requiredWhen は visibleWhen と同じ書式・同じ評価で、成り立つときだけ必須扱いにする。
//     全要素が壊れているときは必須扱いにしない。AND の一部だけ壊れている場合は、
//     壊れた要素を除いた残りの条件で判定する。hide: true は一致の反転として扱う。
//   - 壊れた条件は保存不能や全体非表示にしない（fail-open）。表示は true、無効化は false。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSettingsVisibility = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

function evaluateSimpleCondition(condition, values) {
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return null;
  if (typeof condition.key !== 'string' || condition.key.trim() === '') return null;
  if (!values || typeof values !== 'object' || Array.isArray(values)) return null;

  // 継承プロパティは設定値として扱わない。参照先 key が無い場合の既存仕様に合わせ、
  // positive 条件は不一致、hide:true は非表示条件に不一致として扱う。
  if (!Object.prototype.hasOwnProperty.call(values, condition.key)) {
    return condition.hide === true;
  }
  const currentValue = values[condition.key];
  const matched = currentValue !== undefined && String(currentValue) === String(condition.value);
  return condition.hide === true ? !matched : matched;
}

const MAX_CONDITION_DEPTH = 5;

// 戻り値 null は壊れた条件を表す。AND では通過、OR では不一致として扱いつつ、
// 全要素が壊れていた場合だけ呼び出し元の fail-open 既定値へ戻せるよう区別する。
function evaluateCondition(condition, values, depth = 0) {
  if (depth > MAX_CONDITION_DEPTH) return null;
  if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return null;
  if (Object.prototype.hasOwnProperty.call(condition, 'anyOf')) {
    if (!Array.isArray(condition.anyOf) || condition.anyOf.length === 0) return null;
    const results = condition.anyOf
      .map((candidate) => evaluateCondition(candidate, values, depth + 1))
      .filter((result) => result !== null);
    return results.length > 0 ? results.some(Boolean) : null;
  }
  return evaluateSimpleCondition(condition, values);
}

function evaluateConditions(rawConditions, values, fallback) {
  if (rawConditions === undefined || rawConditions === null) return fallback;
  const conditions = Array.isArray(rawConditions) ? rawConditions : [rawConditions];
  if (conditions.length === 0) return fallback;

  const results = conditions
    .map((condition) => evaluateCondition(condition, values))
    .filter((result) => result !== null);
  return results.length > 0 ? results.every(Boolean) : fallback;
}

function isFieldVisible(field, values) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return true;
  return evaluateConditions(field.visibleWhen, values, true);
}

function isFieldDisabled(field, values) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
  return evaluateConditions(field.disabledWhen, values, false);
}

// 必須扱いにするか。required: true は常に必須、requiredWhen は条件が成り立つときだけ必須。
// 真偽値の項目と、非表示の項目は必須扱いにしない。
function isFieldRequired(field, values) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
  if (field.type === 'boolean') return false;
  if (!isFieldVisible(field, values)) return false;
  if (field.required === true) return true;
  return evaluateConditions(field.requiredWhen, values, false);
}

return {
  isFieldVisible,
  isFieldDisabled,
  isFieldRequired,
};
});
