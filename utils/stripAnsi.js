// ANSI エスケープシーケンス除去ユーティリティ
//
// 用途が「表示用」と「パターンマッチング用」で要件が異なるため、
// 単一の関数に統合せず用途別に複数の関数をエクスポートする。
//
// - stripAnsiForDisplay: renderer 側（xterm 表示・WAITING_PATTERNS 判定）用。
//   CR を LF に正規化し、ESC<single-char>（CSI/OSC 以外の単発 ESC シーケンス）も除去する。
//   CSI は `[A-Za-z]` で終端する一般的な範囲のみを対象にする。
//
// - stripAnsiForPattern: main.js 側（信頼確認 / READY パターン検知）用。
//   CR→LF 変換や ESC<single-char> 除去は不要。
//   CSI の終端文字を非英字（`[@-~]`）まで含めて広く除去する（PR #10 対応）。
//   OSC は `\d+;...` 形式のみを対象にする。

const stripAnsiForDisplay = (str) =>
  str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\r/g, '\n'); // \r を \n に変換して行バッファに乗せる

const stripAnsiForPattern = (data) =>
  data
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

module.exports = {
  stripAnsiForDisplay,
  stripAnsiForPattern,
};
