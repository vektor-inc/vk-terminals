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
// erase-in-line CSI と基本的なカーソル移動 CSI は表示位置へ反映する。
function applyDisplayControls(str) {
  const MAX_ROWS = 500;
  const MAX_COLS = 1000;
  const lines = [''];
  let row = 0;
  let col = 0;

  const clampRow = (nextRow) => Math.min(MAX_ROWS - 1, Math.max(0, nextRow));
  const clampCol = (nextCol) => Math.min(MAX_COLS, Math.max(0, nextCol));

  const ensureRow = (nextRow) => {
    row = clampRow(nextRow);
    while (lines.length <= row) {
      lines.push('');
    }
  };

  const writeChar = (ch) => {
    col = clampCol(col);
    let cur = lines[row] || '';
    if (col > cur.length) {
      cur += ' '.repeat(col - cur.length);
    }
    lines[row] = cur.slice(0, col) + ch + cur.slice(col + 1);
    col = clampCol(col + 1);
  };

  const eraseInLine = (mode) => {
    col = clampCol(col);
    const cur = lines[row] || '';
    if (mode === '2') {
      lines[row] = '';
      return;
    }
    if (mode === '1') {
      lines[row] = ' '.repeat(col) + cur.slice(col);
      return;
    }
    lines[row] = cur.slice(0, col);
  };

  const csiParams = (params) => {
    if (params.startsWith('?')) return null;
    return params.split(';').map((part) => {
      if (part === '') return null;
      const n = Number.parseInt(part, 10);
      return Number.isFinite(n) ? n : null;
    });
  };

  const csiParam = (values, index, fallback) => {
    if (!values || values[index] == null || values[index] === 0) return fallback;
    return values[index];
  };

  const applyCursor = (params, final) => {
    const values = csiParams(params);
    if (!values) return;
    const n = csiParam(values, 0, 1);
    if (final === 'A') {
      ensureRow(row - n);
    } else if (final === 'B') {
      ensureRow(row + n);
    } else if (final === 'C') {
      col = clampCol(col + n);
    } else if (final === 'D') {
      col = clampCol(col - n);
    } else if (final === 'E') {
      ensureRow(row + n);
      col = 0;
    } else if (final === 'F') {
      ensureRow(row - n);
      col = 0;
    } else if (final === 'G') {
      col = clampCol(n - 1);
    } else if (final === 'H' || final === 'f') {
      ensureRow(csiParam(values, 0, 1) - 1);
      col = clampCol(csiParam(values, 1, 1) - 1);
    } else if (final === 'd') {
      ensureRow(n - 1);
    } else if (final === 'a') {
      col = clampCol(col + n);
    } else if (final === 'e') {
      ensureRow(row + n);
    }
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
        } else {
          applyCursor(params, final);
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
        ensureRow(row + 1);
        lines[row] = lines[row] || '';
        col = 0;
        i += 1;
      } else {
        col = 0;
      }
      continue;
    }
    if (ch === '\n') {
      ensureRow(row + 1);
      lines[row] = lines[row] || '';
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
