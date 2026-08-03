// 新規ペインで起動する claude のモデル指定を検証し、ペインへ書き込む起動コマンドを組み立てる。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKClaudeModel = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_CLAUDE_MODEL_LENGTH = 64;

  // 許可リスト方式。英数字・`.`・`_`・`-`・`[`・`]` のみを 64 文字まで許可し、先頭は英数字に限る。
  // 「危ない文字を除く」方式は抜けが出るため、通す文字を列挙して想定外を自動的に落とす。
  // `[` `]` を許可するのは claude-opus-5[1m] のようなモデル名があるため。zsh ではこれが
  // ファイル名展開の記号になるので、書き込み時はシングルクォートで囲んで無効化する。
  // シングルクォートは許可文字に含めないため、クォートの脱出は成立しない。
  const CLAUDE_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-\[\]]{0,63}$/;

  function isValidClaudeModel(value) {
    if (typeof value !== 'string') return false;
    if (value.length > MAX_CLAUDE_MODEL_LENGTH) return false;
    return CLAUDE_MODEL_PATTERN.test(value);
  }

  // ペインへ書き込む claude の起動コマンド（末尾の改行は含めない）を返す。
  // 未指定・不正値では例外を投げず、従来どおりの素の `claude` へ倒す（安全側の既定）。
  function buildClaudeLaunchCommand(model) {
    if (!isValidClaudeModel(model)) return 'claude';
    return `claude --model '${model}'`;
  }

  return {
    MAX_CLAUDE_MODEL_LENGTH,
    CLAUDE_MODEL_PATTERN,
    isValidClaudeModel,
    buildClaudeLaunchCommand,
  };
});
