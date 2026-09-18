'use strict';
// 通知カード内の失敗文言表示（issue #396 植草の UX レビュー・U-3）の回帰テスト。
//
// renderer/mobile.js はモジュールではない（トップレベルで document.getElementById を
// 呼び、末尾で poll() を即時実行する）DOM 依存のプレーンスクリプトで、このリポジトリに
// jsdom は無い。同種の DOM 依存レンダラコードは tests/csp.test.js・
// tests/pushErrorMessages.test.js と同様、静的ファイルをテキストとして読み込み、
// 正規表現・文字列一致・関数ソースの抽出で検証する（DOM を実際には動かさない）。
//
// 確認する不変条件:
//   1. #notify-error が #notify-card 内にあり、最初から role="alert" を持つ
//      （aria-live="assertive" が暗黙で付く）。#notify-live（視覚的に隠す読み上げ用）は
//      aria-live="polite" のまま変更しない。
//   2. .notify-error の配色は #err と同じ値を再利用する（独自の色を持ち込まない）。
//   3. showErr() / #err のスタイル定義は一切変更しない（文字列完全一致で固定）。
//   4. poll() の関数本体は setNotifyError を呼ばない（状態取得に連動させない）。
//   5. handleNotifyRequestClick / handleNotifyStopClick は処理の先頭で
//      setNotifyError("") を呼び、成功時の表示更新（setNotifyLive）と同時にも消す。
//      showErr( を直接呼ばない（通知関連の失敗は setNotifyError に統一されている）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const HTML_PATH = path.join(__dirname, '..', 'renderer', 'mobile.html');
const CSS_PATH = path.join(__dirname, '..', 'renderer', 'mobile.css');
const JS_PATH = path.join(__dirname, '..', 'renderer', 'mobile.js');

const html = fs.readFileSync(HTML_PATH, 'utf8');
const css = fs.readFileSync(CSS_PATH, 'utf8');
const js = fs.readFileSync(JS_PATH, 'utf8');

// 開始位置から中括弧の対応を数え、関数本体（{ を含む）をソースから丸ごと切り出す。
// このファイルの対象2関数の中身には文字列・オブジェクトリテラルの { } が balance
// しているため単純な深さカウントで十分。
function extractFunctionSource(source, signature) {
  const startIdx = source.indexOf(signature);
  assert.ok(startIdx !== -1, `signature not found in source: ${signature}`);
  const braceStart = source.indexOf('{', startIdx);
  assert.ok(braceStart !== -1, `no opening brace after signature: ${signature}`);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(startIdx, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting: ${signature}`);
}

// ── 1. #notify-error の HTML 属性 ──────────────────────────────────────────

test('#notify-error は #notify-card 内にあり role="alert" を最初から持つ', () => {
  const cardMatch = html.match(/<div id="notify-card"[^>]*>([\s\S]*?)\n<\/div>\n<div id="usage-card"/);
  assert.ok(cardMatch, '#notify-card のブロックが見つからない');
  const cardHtml = cardMatch[1];
  const errMatch = cardHtml.match(/<div[^>]*\bid="notify-error"[^>]*>/);
  assert.ok(errMatch, '#notify-card 内に #notify-error が見つからない');
  assert.match(errMatch[0], /role="alert"/, '#notify-error に role="alert" が付いていない');
  // hidden 属性で初期非表示（他の notify-state-* 要素と同じ流儀）。
  assert.match(errMatch[0], /\bhidden\b/, '#notify-error は初期状態で hidden であるべき');
});

test('#notify-live は視覚表示に転用されず aria-live="polite" のまま', () => {
  const liveMatch = html.match(/<div[^>]*\bid="notify-live"[^>]*>/);
  assert.ok(liveMatch, '#notify-live が見つからない');
  assert.match(liveMatch[0], /aria-live="polite"/);
  // #notify-error とは別要素であること（id が重複していない）。
  assert.notEqual(liveMatch[0], html.match(/<div[^>]*\bid="notify-error"[^>]*>/)[0]);
});

// ── 2. 配色は #err の値を再利用（独自の色を持ち込まない） ──────────────────

test('#err のスタイル定義は変更されていない（文字列完全一致）', () => {
  assert.match(
    css,
    /#err \{ display: none; background: #4a1e1e; color: #ffb4b4; font-size: 12px; padding: 6px 12px; \}/
  );
});

test('.notify-error は #err と同じ配色（#4a1e1e 背景・#ffb4b4 文字）を再利用する', () => {
  const ruleMatch = css.match(/\.notify-error\s*\{([^}]*)\}/);
  assert.ok(ruleMatch, '.notify-error のルールが見つからない');
  const rule = ruleMatch[1];
  assert.match(rule, /background:\s*#4a1e1e;/, '#err と異なる背景色を使っている');
  assert.match(rule, /color:\s*#ffb4b4;/, '#err と異なる文字色を使っている');
  assert.doesNotMatch(rule, /!important/, 'CSS ルールに !important を使っている');
});

// ── 3. showErr() / #err の JS 実装は変更していない ─────────────────────────

test('showErr() の実装は変更されていない（文字列完全一致）', () => {
  const expected = 'function showErr(msg) {\n'
    + '  if (!msg) { errEl.style.display = "none"; return; }\n'
    + '  errEl.textContent = msg; errEl.style.display = "block";\n'
    + '}';
  assert.ok(js.includes(expected), 'showErr() の実装が想定と一致しない（変更されている可能性）');
});

// ── 4. poll() は setNotifyError を呼ばない（状態取得に連動させない） ────────

test('poll() は setNotifyError を呼ばない（2秒周期の状態取得に連動させない）', () => {
  const pollSrc = extractFunctionSource(js, 'async function poll() {');
  assert.doesNotMatch(pollSrc, /setNotifyError/, 'poll() が setNotifyError を呼んでいる（司の差し戻し指示違反）');
  // 既存の showErr("") 呼び出し（状態取得成功時のグローバル帯クリア）はそのまま残っている。
  assert.match(pollSrc, /showErr\(""\);/);
});

// ── 5. handleNotifyRequestClick / handleNotifyStopClick の呼び出し順序 ──────

test('handleNotifyRequestClick は処理の先頭で setNotifyError("") を呼び、直接 showErr( は呼ばない', () => {
  const src = extractFunctionSource(js, 'async function handleNotifyRequestClick() {');
  const bodyStart = src.indexOf('{') + 1;
  const firstStatement = src.slice(bodyStart).trimStart();
  assert.ok(
    firstStatement.startsWith('// 処理の先頭で前回の失敗文言を消す') || firstStatement.startsWith('setNotifyError("");'),
    '先頭の実行文が setNotifyError("") ではない'
  );
  assert.match(src, /setNotifyError\(""\);/);
  assert.doesNotMatch(src, /\bshowErr\(/, 'handleNotifyRequestClick が showErr( を直接呼んでいる');
  // 成功時の表示更新（setNotifyLive）の直前で setNotifyError("") を呼んでいる。
  const successIdx = src.indexOf('setNotifyLive("通知を有効にしました")');
  assert.ok(successIdx !== -1);
  const clearIdx = src.lastIndexOf('setNotifyError("");', successIdx);
  assert.ok(clearIdx !== -1 && clearIdx < successIdx, '成功時の表示更新と同時に setNotifyError("") を呼んでいない');
});

test('handleNotifyStopClick は処理の先頭で setNotifyError("") を呼び、直接 showErr( は呼ばない', () => {
  const src = extractFunctionSource(js, 'async function handleNotifyStopClick() {');
  const bodyStart = src.indexOf('{') + 1;
  const firstStatement = src.slice(bodyStart).trimStart();
  assert.ok(
    firstStatement.startsWith('// 処理の先頭で前回の失敗文言を消す') || firstStatement.startsWith('setNotifyError("");'),
    '先頭の実行文が setNotifyError("") ではない'
  );
  assert.match(src, /setNotifyError\(""\);/);
  assert.doesNotMatch(src, /\bshowErr\(/, 'handleNotifyStopClick が showErr( を直接呼んでいる');
  const successIdx = src.indexOf('setNotifyLive("通知を停止しました")');
  assert.ok(successIdx !== -1);
  const clearIdx = src.lastIndexOf('setNotifyError("");', successIdx);
  assert.ok(clearIdx !== -1 && clearIdx < successIdx, '成功時の表示更新と同時に setNotifyError("") を呼んでいない');
});

test('setNotifyError() は hidden 切り替えと textContent の両方を扱う', () => {
  const src = extractFunctionSource(js, 'function setNotifyError(msg) {');
  assert.match(src, /notifyErrorEl\.hidden = true/);
  assert.match(src, /notifyErrorEl\.hidden = false/);
  assert.match(src, /notifyErrorEl\.textContent = msg;/);
});
