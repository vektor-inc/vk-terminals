'use strict';

// combo フィールドの表示名と保存値を相互変換する純粋関数。
// 保存値との完全一致を表示名より優先し、候補同士が衝突しても既存の保存値を
// 意図せず別候補へ変換しない（issue #504）。
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
    ? field.options
    : [];
}

function comboDisplayValue(field, rawValue) {
  const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
  const matched = comboOptions(field).find((option) => String(option.value ?? '') === value);
  return matched ? String(matched.label ?? matched.value ?? '') : value;
}

function comboStoredValue(field, rawValue) {
  const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
  const options = comboOptions(field);

  // 保存値そのものが入力されている場合は、同じ文字列を表示名に持つ別候補より優先する。
  const valueMatched = options.find((option) => String(option.value ?? '') === value);
  if (valueMatched) return String(valueMatched.value ?? '');

  const labelMatched = options.find(
    (option) => String(option.label ?? option.value ?? '') === value
  );
  return labelMatched ? String(labelMatched.value ?? '') : value;
}

return {
  comboDisplayValue,
  comboStoredValue,
};
});
