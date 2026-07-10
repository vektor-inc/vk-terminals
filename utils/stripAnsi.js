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
// `\r\n` は改行 1 個にする。
// erase-in-line CSI は列位置に応じて反映するが、カーソル横移動 CSI までは再現しない簡易実装。
function applyDisplayControls(str) {
  const lines = [''];
  let col = 0;

  const writeChar = (ch) => {
    let cur = lines[lines.length - 1];
    if (col > cur.length) {
      cur += ' '.repeat(col - cur.length);
    }
    lines[lines.length - 1] = cur.slice(0, col) + ch + cur.slice(col + 1);
    col += 1;
  };

  const eraseInLine = (mode) => {
    const cur = lines[lines.length - 1];
    if (mode === '2') {
      lines[lines.length - 1] = '';
      return;
    }
    if (mode === '1') {
      lines[lines.length - 1] = ' '.repeat(col) + cur.slice(col);
      return;
    }
    lines[lines.length - 1] = cur.slice(0, col);
  };

  for (let i = 0; i < str.length; i += 1) {
    const ch = str[i];
    if (ch === '\x1b') {
      const next = str[i + 1];
      if (next === '[') {
        let j = i + 2;
        while (j < str.length && !/[\x40-\x7e]/.test(str[j])) {
          j += 1;
        }
        if (j >= str.length) {
          break;
        }
        const params = str.slice(i + 2, j);
        const final = str[j];
        if (final === 'K') {
          eraseInLine(params === '' ? '0' : params);
        }
        i = j;
        continue;
      }
      if (next === ']') {
        let j = i + 2;
        while (j < str.length) {
          if (str[j] === '\x07') {
            break;
          }
          if (str[j] === '\x1b' && str[j + 1] === '\\') {
            j += 1;
            break;
          }
          j += 1;
        }
        if (j >= str.length) {
          break;
        }
        i = j;
        continue;
      }
      if (next === 'P' || next === 'X' || next === '^' || next === '_') {
        let j = i + 2;
        while (j < str.length) {
          if (str[j] === '\x07') {
            break;
          }
          if (str[j] === '\x1b' && str[j + 1] === '\\') {
            j += 1;
            break;
          }
          j += 1;
        }
        if (j >= str.length) {
          break;
        }
        i = j;
        continue;
      }
      if (next) {
        i += 1;
      }
      continue;
    }
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
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(ch)) {
      continue;
    }
    writeChar(ch);
  }

  return lines.join('\n');
}

const stripAnsiForDisplay = (str) => applyDisplayControls(str);

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
