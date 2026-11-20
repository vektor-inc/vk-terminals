// ターミナル出力の表示用制御コード処理を、Electron renderer とモバイルページで共有する。
//
// Node（require）とブラウザ（mobile.html の <script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKTerminalDisplay = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // CR は TUI の全行書き換え型の再描画として扱う。
  // 裸の `\r` は行頭復帰として扱い、後続文字で現在行を列単位に上書きする。
  // `\r\n` は改行 1 個にする。
  // erase-in-line CSI と基本的なカーソル移動 CSI は表示位置へ反映する。
  //
  // createDisplayScreen は同じ処理を「状態を持つ」形にしたもの。画面の行・カーソル位置・
  // チャンク境界で途切れた未完のエスケープ列を write() 呼び出しをまたいで保持し、
  // 新しく届いたチャンクだけを適用する（issue #413）。
  function createDisplayScreen() {
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

    // 持ち越すエスケープ列の上限。終端が来ないまま膨らみ続けるのを防ぐ。
    const MAX_PENDING = 4096;
    let pending = '';
    // 持ち越しが上限を超えたあと、終端が来るまで中身を読み捨てている制御列の種類
    // （'csi' または 'str' = OSC/DCS 等の文字列型）。null なら通常処理。
    let discardMode = null;
    // 'str' の読み捨て中に、直前のチャンク末尾が ESC だったか（ESC と `\` の分割対策）。
    let discardEsc = false;

    // 読み捨て中のデータから終端までを取り除き、終端より後ろを返す。終端が無ければ null。
    const skipDiscarded = (str) => {
      if (discardMode === 'csi') {
        for (let k = 0; k < str.length; k += 1) {
          if (/[\x40-\x7e]/.test(str[k])) {
            discardMode = null;
            return str.slice(k + 1);
          }
        }
        return null;
      }
      let prevEsc = discardEsc;
      for (let k = 0; k < str.length; k += 1) {
        if (str[k] === '\x07' || (prevEsc && str[k] === '\\')) {
          discardMode = null;
          discardEsc = false;
          return str.slice(k + 1);
        }
        prevEsc = str[k] === '\x1b';
      }
      discardEsc = prevEsc;
      return null;
    };

    // str を適用する。末尾で途切れた ESC 列があれば、その開始位置を返す（無ければ -1）。
    const apply = (str) => {
    let incomplete = -1;
    for (let i = 0; i < str.length; i += 1) {
      const ch = str[i];
      if (ch === '\x1b') {
        const next = str[i + 1];
        if (next === undefined) {
          incomplete = i;
          break;
        }
        if (next === '[') {
          let j = i + 2;
          while (j < str.length && !/[\x40-\x7e]/.test(str[j])) {
            j += 1;
          }
          if (j >= str.length) {
            incomplete = i;
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
            incomplete = i;
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
            incomplete = i;
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
    return incomplete;
    };

    const text = () => lines.join('\n');

    return {
      // チャンクを適用する。前回の未完の列があれば先頭に連結して読み直す。
      write(data) {
        let input = data || '';
        if (discardMode) {
          input = skipDiscarded(input);
          if (input === null) return;
        }
        const str = pending + input;
        const incomplete = apply(str);
        pending = incomplete >= 0 ? str.slice(incomplete) : '';
        if (pending.length > MAX_PENDING) {
          // 中身は捨てるが制御列の種類は覚え、終端まで読み捨てる（続きが文字として混ざらないように）。
          discardMode = pending[1] === '[' ? 'csi' : 'str';
          discardEsc = discardMode === 'str' && pending.endsWith('\x1b');
          pending = '';
        }
      },
      text,
      // 先頭側を maxLines 行・maxChars 文字に切り詰める。カーソル行も同じだけずらす。
      trim(maxLines, maxChars) {
        let drop = Math.max(0, lines.length - maxLines);
        if (drop > 0) {
          lines.splice(0, drop);
          row = Math.max(0, row - drop);
        }
        let over = text().length - maxChars;
        // 削る量が先頭行の全体（行の長さ + 改行）に満たないときは行を消さず、下で先頭だけ削る。
        while (over > 0 && lines.length > 1 && over >= lines[0].length + 1) {
          over -= lines[0].length + 1;
          lines.shift();
          row = Math.max(0, row - 1);
        }
        if (over > 0) {
          lines[0] = lines[0].slice(over);
          if (row === 0) col = Math.max(0, col - over);
        }
      },
      reset() {
        lines.length = 0;
        lines.push('');
        row = 0;
        col = 0;
        pending = '';
        discardMode = null;
        discardEsc = false;
      },
    };
  }

  // 1 回きりの変換。途中で終わっている ESC 列は捨てる。
  function applyDisplayControls(str) {
    const screen = createDisplayScreen();
    screen.write(str);
    return screen.text();
  }

  // シェルの作業フォルダの通知（OSC 7: ESC ] 7 ; file://ホスト/パス BEL または ESC \）を読む（issue #649）。
  // 1 回の出力に複数の通知があれば最後のものを現在の作業フォルダとする。ウィンドウを作り直したときは
  // 覚えておいた出力をまとめて 1 回で流すため、最初の通知を採ると古いフォルダに戻ってしまう。
  // チャンクの境界で途切れた通知は、次の出力と合わせて読む。
  function createCwdReportReader() {
    const START = '\x1b]7;';
    const MAX_PENDING = 4096;
    const REPORT = /\x1b\]7;file:\/\/[^/\x07\x1b]*([^\x07\x1b]*)[\x07\x1b]/g;
    let pending = '';
    return {
      feed(data) {
        if (typeof data !== 'string' || !data) return null;
        const text = pending + data;
        pending = '';
        let latest = null;
        for (const match of text.matchAll(REPORT)) {
          if (!match[1]) continue;
          try { latest = decodeURIComponent(match[1]); } catch (_) { /* 壊れた通知は使わない */ }
        }
        // 終端の無い通知の始まり（または始まりの途中）が末尾にあれば、次の出力まで持ち越す。
        const start = text.lastIndexOf(START);
        if (start >= 0 && !/[\x07\x1b]/.test(text.slice(start + START.length))) {
          if (text.length - start <= MAX_PENDING) pending = text.slice(start);
        } else {
          for (let length = START.length - 1; length > 0; length -= 1) {
            if (text.endsWith(START.slice(0, length))) { pending = START.slice(0, length); break; }
          }
        }
        return latest;
      },
    };
  }

  return {
    applyDisplayControls,
    createCwdReportReader,
    createDisplayScreen,
  };
});
