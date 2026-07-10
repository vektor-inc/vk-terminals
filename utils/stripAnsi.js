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
// CR は TUI の全行書き換え型の再描画として扱う。
// 裸の `\r` は行頭復帰として扱い、後続文字で現在行を列単位に上書きする。
// `\r\n` は改行 1 個にする。バックスペースまでは再現しない簡易実装。
function applyCarriageReturns(str) {
  const lines = [''];
  let col = 0;

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '\r') {
      if (str[i + 1] === '\n') {
        lines.push('');
        col = 0;
        i += 1;
      } else {
        col = 0;
      }
      continue;
    }
    if (ch === '\n') {
      lines.push('');
      col = 0;
      continue;
    }
    const cur = lines[lines.length - 1];
    lines[lines.length - 1] = cur.slice(0, col) + ch + cur.slice(col + 1);
    col += 1;
  }

  return lines.join('\n');
}

const stripAnsiForDisplay = (str) =>
  applyCarriageReturns(str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, ''));

const appendAnsiForDisplay = (buffer, data) =>
  stripAnsiForDisplay(`${buffer || ''}${data || ''}`);

const stripAnsiForPattern = (data) =>
  data
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');

module.exports = {
  appendAnsiForDisplay,
  stripAnsiForDisplay,
  stripAnsiForPattern,
};
