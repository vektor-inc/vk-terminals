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

function resolveTerminalDisplay() {
  if (typeof require === 'function') {
    try { return require('./terminalDisplay'); } catch (_e) { /* fallthrough */ }
  }
  if (typeof self !== 'undefined' && self.VKTerminalDisplay) return self.VKTerminalDisplay;
  throw new Error('VKTerminalDisplay not available');
}

function resolveUrlSafety() {
  if (typeof require === 'function') {
    try { return require('./urlSafety'); } catch (_e) { /* fallthrough */ }
  }
  if (typeof self !== 'undefined' && self.VKUrlSafety) return self.VKUrlSafety;
  throw new Error('VKUrlSafety not available');
}

var terminalDisplay = resolveTerminalDisplay();
var urlSafety = resolveUrlSafety();

// ANSI エスケープ / 一部制御文字を除去（表示用）
function applyCarriageReturns(s) {
  return terminalDisplay.applyDisplayControls(s);
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

function isSafeHttpUrl(u) {
  return urlSafety.isSafeHttpUrl(u);
}

  return {
    applyCarriageReturns: applyCarriageReturns,
    stripAnsi: stripAnsi,
    sanitizeMobilePreviewText: sanitizeMobilePreviewText,
    tail: tail,
    isSafeHttpUrl: isSafeHttpUrl
  };
});
