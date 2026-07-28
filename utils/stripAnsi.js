// ANSI エスケープシーケンス除去ユーティリティ
//
// 用途が「表示用」と「パターンマッチング用」で要件が異なるため、
// 単一の関数に統合せず用途別に複数の関数をエクスポートする。
//
// - stripAnsiForDisplay: renderer 側（xterm 表示・WAITING_PATTERNS 判定）用。
//   CR の行頭復帰を反映し、ESC<single-char>（CSI/OSC 以外の単発 ESC シーケンス）も除去する。
//   CSI は `[A-Za-z]` で終端する一般的な範囲のみを対象にする。
//
// - stripAnsiForPattern: main.js 側（信頼確認 / READY パターン検知）用。
//   CR→LF 変換や ESC<single-char> 除去は不要。
//   CSI の終端文字を非英字（`[@-~]`）まで含めて広く除去する（PR #10 対応）。
//   OSC は `\d+;...` 形式のみを対象にする。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKStripAnsi = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

// terminalDisplay は Node では require、ブラウザでは先に読み込まれた
// window.VKTerminalDisplay から受け取る（index.html の <script> 順で保証する）。
const { applyDisplayControls } = (typeof require === 'function')
  ? require('../renderer/terminalDisplay')
  : self.VKTerminalDisplay;

const stripAnsiForDisplay = (str) => applyDisplayControls(str);

const appendAnsiForDisplay = (buffer, data) =>
  stripAnsiForDisplay(`${buffer || ''}${data || ''}`);

const stripAnsiForPattern = (data) =>
  data
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

return {
  appendAnsiForDisplay,
  stripAnsiForDisplay,
  stripAnsiForPattern,
};
});
