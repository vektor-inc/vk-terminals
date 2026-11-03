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

function exactOption(options, value, getter) {
  return options.find((option) => getter(option) === value);
}

function uniqueComparableOption(options, value, getter) {
  const compared = comparableValue(value);
  const matched = options.filter(
    (option) => comparableValue(getter(option)) === compared
  );
  return matched.length === 1 ? matched[0] : null;
}

function hasAmbiguousLabel(option, options) {
  const label = optionLabel(option);
  if (comparableValue(label) === '') return true;

  // 保存値との完全一致を最優先し、表示名が別候補の保存値へ化けるのを防ぐ。
  const exactValueMatched = exactOption(options, label, optionValue);
  if (exactValueMatched) {
    return optionValue(exactValueMatched) !== optionValue(option);
  }

  // trim 後の保存値照合は一候補だけに決まる場合に限る。
  const comparableValueMatched = uniqueComparableOption(options, label, optionValue);
  if (comparableValueMatched) {
    return optionValue(comparableValueMatched) !== optionValue(option);
  }

  // 表示名も完全一致を優先し、trim 後は一候補だけに決まる場合だけ使う。
  const exactLabelMatches = options.filter((candidate) => optionLabel(candidate) === label);
  if (exactLabelMatches.length > 0) {
    return exactLabelMatches.length !== 1 || exactLabelMatches[0] !== option;
  }
  return uniqueComparableOption(options, label, optionLabel) !== option;
}

function comboDisplayValue(field, rawValue) {
  const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
  const options = comboOptions(field);
  const matched = exactOption(options, value, optionValue)
    || uniqueComparableOption(options, value, optionValue);
  return matched && !hasAmbiguousLabel(matched, options) ? optionLabel(matched) : value;
}

function comboStoredValue(field, rawValue) {
  const value = rawValue === null || rawValue === undefined ? '' : String(rawValue);
  if (value === '') return '';

  const options = comboOptions(field);

  // 保存値との完全一致を優先し、trim 後は一候補だけに決まる場合に限る。
  const valueMatched = exactOption(options, value, optionValue)
    || uniqueComparableOption(options, value, optionValue);
  if (valueMatched) return optionValue(valueMatched);

  const labelOptions = options.filter((option) => !hasAmbiguousLabel(option, options));
  const exactLabelMatches = labelOptions.filter((option) => optionLabel(option) === value);
  const labelMatched = exactLabelMatches.length === 1
    ? exactLabelMatches[0]
    : uniqueComparableOption(labelOptions, value, optionLabel);
  // 候補外の手入力値は、通常の text 欄と同じく入力された空白も含めて保存する。
  return labelMatched ? optionValue(labelMatched) : value;
}

return {
  comboOptions,
  comboDisplayValue,
  comboStoredValue,
};
});
