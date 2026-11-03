'use strict';

// combo フィールドの表示名と保存値を相互変換する純粋関数。
// あいまいな表示名は使わず、表示と保存の往復で値が別候補へ化けるのを防ぐ
// （issue #504）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSettingsComboField = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

function comboOptions(field) {
  return field && field.type === 'combo' && Array.isArray(field.options)
    ? field.options.filter(
        (option) => option !== null && typeof option === 'object' && !Array.isArray(option)
      )
    : [];
}

function optionValue(option) {
  return String(option.value ?? '');
}

function optionLabel(option) {
  return String(option.label ?? option.value ?? '');
}

function comparableValue(value) {
  return value.trim();
}

function hasAmbiguousLabel(option, options) {
  const label = comparableValue(optionLabel(option));
  if (label === '') return true;

  // 同じ表示名が複数候補にある場合は、逆変換先を一意に決められない。
  const sameLabelCount = options.filter(
    (candidate) => comparableValue(optionLabel(candidate)) === label
  ).length;
  if (sameLabelCount > 1) return true;

  // 自分自身の保存値と同じ表示名は、その値へ安全に戻せる。
  if (comparableValue(optionValue(option)) === label) return false;

  // 別候補の保存値と衝突する表示名は、保存値として解釈されるため使わない。
  return options.some(
    (candidate) => candidate !== option && comparableValue(optionValue(candidate)) === label
  );
}

function comboDisplayValue(field, rawValue) {
  const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
  const options = comboOptions(field);
  const compared = comparableValue(value);
  const matched = options.find((option) => comparableValue(optionValue(option)) === compared);
  return matched && !hasAmbiguousLabel(matched, options) ? optionLabel(matched) : value;
}

function comboStoredValue(field, rawValue) {
  const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
  if (value === '') return '';

  const options = comboOptions(field);
  const compared = comparableValue(value);

  // 前後空白を除いて保存値そのものに一致する場合は、表示名より優先する。
  const valueMatched = options.find(
    (option) => comparableValue(optionValue(option)) === compared
  );
  if (valueMatched) return optionValue(valueMatched);

  const labelMatched = options.find(
    (option) => !hasAmbiguousLabel(option, options)
      && comparableValue(optionLabel(option)) === compared
  );
  // 候補外の手入力値は、通常の text 欄と同じく入力された空白も含めて保存する。
  return labelMatched ? optionValue(labelMatched) : value;
}

return {
  comboOptions,
  comboDisplayValue,
  comboStoredValue,
};
});
