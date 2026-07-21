// モバイルプレビュー表示向けの純粋テキスト整形ヘルパー。
//
// renderer/mobile.html から分離し、Node のテストとブラウザのモバイルページで共有する。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKMobilePreview = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

// ANSI エスケープ / 一部制御文字を除去（表示用）
// CR は TUI の全行再描画向けに扱う。裸の CR は行頭復帰として扱い、後続文字で現在行を列単位に上書きする。CRLF は改行 1 個にする。
// erase-in-line CSI と基本的なカーソル移動 CSI は表示位置へ反映する。
function applyCarriageReturns(s) {
  var MAX_ROWS = 500;
  var MAX_COLS = 1000;
  var lines = [""];
  var row = 0;
  var col = 0;

  function clampRow(nextRow) {
    return Math.min(MAX_ROWS - 1, Math.max(0, nextRow));
  }

  function clampCol(nextCol) {
    return Math.min(MAX_COLS, Math.max(0, nextCol));
  }

  function ensureRow(nextRow) {
    row = clampRow(nextRow);
    while (lines.length <= row) {
      lines.push("");
    }
  }

  function writeChar(ch) {
    col = clampCol(col);
    var cur = lines[row] || "";
    if (col > cur.length) {
      cur += " ".repeat(col - cur.length);
    }
    lines[row] = cur.slice(0, col) + ch + cur.slice(col + 1);
    col = clampCol(col + 1);
  }

  function eraseInLine(mode) {
    col = clampCol(col);
    var cur = lines[row] || "";
    if (mode === "2") {
      lines[row] = "";
      return;
    }
    if (mode === "1") {
      lines[row] = " ".repeat(col) + cur.slice(col);
      return;
    }
    lines[row] = cur.slice(0, col);
  }

  function csiParams(params) {
    if (params.indexOf("?") === 0) return null;
    return params.split(";").map(function(part) {
      if (part === "") return null;
      var n = parseInt(part, 10);
      return isFinite(n) ? n : null;
    });
  }

  function csiParam(values, index, fallback) {
    if (!values || values[index] == null || values[index] === 0) return fallback;
    return values[index];
  }

  function applyCursor(params, final) {
    var values = csiParams(params);
    if (!values) return;
    var n = csiParam(values, 0, 1);
    if (final === "A") {
      ensureRow(row - n);
    } else if (final === "B") {
      ensureRow(row + n);
    } else if (final === "C") {
      col = clampCol(col + n);
    } else if (final === "D") {
      col = clampCol(col - n);
    } else if (final === "E") {
      ensureRow(row + n);
      col = 0;
    } else if (final === "F") {
      ensureRow(row - n);
      col = 0;
    } else if (final === "G") {
      col = clampCol(n - 1);
    } else if (final === "H" || final === "f") {
      ensureRow(csiParam(values, 0, 1) - 1);
      col = clampCol(csiParam(values, 1, 1) - 1);
    } else if (final === "d") {
      ensureRow(n - 1);
    } else if (final === "a") {
      col = clampCol(col + n);
    } else if (final === "e") {
      ensureRow(row + n);
    }
  }

  for (var i = 0; i < s.length; i += 1) {
    var ch = s[i];
    if (ch === "\x1b") {
      var next = s[i + 1];
      if (next === "[") {
        var j = i + 2;
        while (j < s.length && !/[\x40-\x7e]/.test(s[j])) {
          j += 1;
        }
        if (j >= s.length) {
          break;
        }
        var params = s.slice(i + 2, j);
        var final = s[j];
        if (final === "K") {
          eraseInLine(params === "" ? "0" : params);
        } else {
          applyCursor(params, final);
        }
        i = j;
        continue;
      }
      if (next === "]") {
        var oscEnd = i + 2;
        while (oscEnd < s.length) {
          if (s[oscEnd] === "\x07") {
            break;
          }
          if (s[oscEnd] === "\x1b" && s[oscEnd + 1] === "\\") {
            oscEnd += 1;
            break;
          }
          oscEnd += 1;
        }
        if (oscEnd >= s.length) {
          break;
        }
        i = oscEnd;
        continue;
      }
      if (next === "P" || next === "X" || next === "^" || next === "_") {
        var strEnd = i + 2;
        while (strEnd < s.length) {
          if (s[strEnd] === "\x07") {
            break;
          }
          if (s[strEnd] === "\x1b" && s[strEnd + 1] === "\\") {
            strEnd += 1;
            break;
          }
          strEnd += 1;
        }
        if (strEnd >= s.length) {
          break;
        }
        i = strEnd;
        continue;
      }
      if (next) {
        i += 1;
      }
      continue;
    }
    if (ch === "\r") {
      if (s[i + 1] === "\n") {
        ensureRow(row + 1);
        lines[row] = lines[row] || "";
        col = 0;
        i += 1;
      } else {
        col = 0;
      }
      continue;
    }
    if (ch === "\n") {
      ensureRow(row + 1);
      lines[row] = lines[row] || "";
      col = 0;
      continue;
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(ch)) {
      continue;
    }
    writeChar(ch);
  }

  return lines.join("\n");
}

function stripAnsi(s) {
  if (!s) return "";
  return applyCarriageReturns(s);
}

// Claude Code などの CLI スピナー / プログレス描画で残りやすい装飾グリフ。
// 入力待ち検知と共有する lastLines には影響させず、モバイルプレビュー表示だけで除去する。
var MOBILE_PREVIEW_DECORATIVE_GLYPH_RE = /[✻✽✶✷✴✳✢✥✦✧✩✪✫✬✭✮✯✰✱✲✵✸✹✺✼✾✿·]/g;
var MOBILE_PREVIEW_READABLE_LINE_RE = /[A-Za-z぀-ヿ㐀-䶿一-鿿豈-﫿가-힯０-９Ａ-Ｚａ-ｚｦ-ﾟ]/;

function sanitizeMobilePreviewText(s) {
  if (!s) return "";
  return s.split("\n").reduce(function(lines, line) {
    var cleaned = line.replace(MOBILE_PREVIEW_DECORATIVE_GLYPH_RE, "");
    if (cleaned.trim() === "") {
      if (line.trim() === "") lines.push(cleaned);
      return lines;
    }
    if (MOBILE_PREVIEW_READABLE_LINE_RE.test(cleaned)) lines.push(cleaned);
    return lines;
  }, []).join("\n");
}

function tail(s, n) { return s.length > n ? s.slice(s.length - n) : s; }

// href に入れる URL を http(s) のみに制限する防御（issue #53）。
// new URL() で parse し protocol が http:/https: のときだけ true を返す。
// javascript: / data: 等のスキーム注入を防ぐ。これを通った URL だけ href にセットする。
function isSafeHttpUrl(u) {
  if (typeof u !== "string" || !u) return false;
  if (u.length > 2048) return false;
  try {
    var parsed = new URL(u);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch (e) {
    return false;
  }
}

  return {
    applyCarriageReturns: applyCarriageReturns,
    stripAnsi: stripAnsi,
    sanitizeMobilePreviewText: sanitizeMobilePreviewText,
    tail: tail,
    isSafeHttpUrl: isSafeHttpUrl
  };
});
