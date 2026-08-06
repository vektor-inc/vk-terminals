'use strict';

// 設定ダイアログの lines 型フィールド（改行区切りリスト）を textarea に表示する際の、
// エスケープ前テキストを決める純粋関数（issue #339）。
//
// 保存側（settingsTargets.js の coerceFieldValue）は raw が配列でなければ文字列として
// 扱い改行で分割する。表示側（renderer/app.js の renderSettingsField）は従来「配列でなければ
// 空文字」としており、設定ファイルに文字列で書かれた workspace.search_paths などが
// 設定画面で空欄に見え、そのまま保存すると値が消える不具合があった。保存側・表示側の
// 扱いを揃えるため、この判定だけを DOM に依存しない形へ切り出してユニットテストできるようにする。
//
// 判定方針:
//   - 配列はそのまま改行連結して表示する（従来どおり）。
//   - 文字列はその内容をそのまま表示する（今回の修正対象）。
//   - 配列・文字列以外（数値・真偽値・オブジェクト・null・undefined）は、パスや
//     オーナー名として意味を持たない値をそのまま表示すると壊れた値を見せることになるため
//     空欄にする（従来どおり）。
//
// @param {*} value  設定値（descriptor から読み込んだ現在値）。
// @return {string}  textarea に表示するテキスト（escText でエスケープする前の値）。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSettingsLinesField = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

function linesFieldDisplayText(value) {
  if (Array.isArray(value)) return value.join('\n');
  if (typeof value === 'string') return value;
  return '';
}

return {
  linesFieldDisplayText,
};
});
