'use strict';

// 設定ダイアログのテキスト系フィールドを pattern（正規表現文字列）で検証する純粋関数。
// descriptor 側（vk-orchestrator）が text フィールドに付与する `pattern` を GUI 側で
// 消費し、保存前に形式チェックする。DOM に依存しないためユニットテストしやすい。
//
// 判定方針:
//   - pattern が無い（文字列でない/空文字）フィールドは常に valid（後方互換）。
//   - 値は trim してから検証する。反映先（保存処理側）が trim 済みの値を見るため、
//     生値のまま検証すると前後空白のせいで実際の反映結果と食い違う。
//   - trim 後が空文字なら valid 扱い（空欄は許容。必須チェックは本関数の責務外）。
//   - pattern が壊れた正規表現でも保存不能にしない（fail-open）。生成に失敗したら
//     警告だけ出して valid として扱う。
//
// @param {string} pattern  検証に使う正規表現文字列（descriptor 由来）。
// @param {*} rawValue      入力欄の生値（通常は input.value）。
// @return {boolean}        検証を通れば true。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSettingsValidation = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

function isPatternValid(pattern, rawValue) {
  // pattern を持たないフィールドは検証対象外。
  if (typeof pattern !== 'string' || pattern === '') return true;

  // 反映先が trim 済みの値を見るため、検証も trim 後の値で行う。
  const value = typeof rawValue === 'string' ? rawValue.trim() : '';

  // 空欄は許容（打鍵前・未入力を弾かない）。
  if (value === '') return true;

  let re;
  try {
    re = new RegExp(pattern);
  } catch (_e) {
    // 壊れた pattern で保存不能にならないよう valid 扱い（fail-open）。
    // 環境によっては console が無いこともあるため存在チェックしてから警告する。
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[settings] 不正な pattern のため検証をスキップしました:', pattern);
    }
    return true;
  }

  return re.test(value);
}

return {
  isPatternValid,
};
});
