'use strict';

// 設定ディスクリプタの項目列を「区分」へまとめる純粋関数（issue #421）。
//
// 項目に付ける `section: { label, description? }` は「この項目から次の区分の手前までが
// 1 つの区分」を表す。fields 配列へ { type: 'heading' } のような擬似項目を挟む方式は、
// 属性を知らない古い VK Terminals で空の入力欄として描かれてしまうため採らない。
// 項目の属性なら、古い版は未知の属性を無視して区切りの無い従来表示に戻るだけで済む。
//
// section は外部ディスクリプタ（VK_TERMINALS_SETTINGS）から渡るため信頼できない入力として扱い、
// 型が不正なものは無視する（その項目は直前の区分に属する／区分が無ければ区分外）。
// label / description は呼び出し側で必ずテキストとして挿入すること（HTML 化しない）。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（settingsVisibility.js と同じ）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSettingsSections = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

// 有効な section なら { label, description } を、無効なら null を返す。
// label は空白だけでない文字列が必須。description は任意で、文字列以外は空として扱う。
function normalizeFieldSection(field) {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
  if (!Object.prototype.hasOwnProperty.call(field, 'section')) return null;
  const section = field.section;
  if (!section || typeof section !== 'object' || Array.isArray(section)) return null;
  if (typeof section.label !== 'string' || section.label.trim() === '') return null;
  const description = typeof section.description === 'string' ? section.description.trim() : '';
  return { label: section.label.trim(), description };
}

// 項目列を [{ section: null | { label, description }, fields: [...] }] へまとめる。
// 先頭の section 無し項目は section: null の塊（区分外）になる。項目の順序・個数は変えない。
function splitFieldsIntoSections(fields) {
  const parts = [];
  for (const field of Array.isArray(fields) ? fields : []) {
    const section = normalizeFieldSection(field);
    if (section || parts.length === 0) {
      parts.push({ section, fields: [field] });
    } else {
      parts[parts.length - 1].fields.push(field);
    }
  }
  return parts;
}

return {
  normalizeFieldSection,
  splitFieldsIntoSections,
};
});
