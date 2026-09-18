'use strict';
// 通知カード内の失敗文言表示（issue #396 植草の UX レビュー・U-3・U-4、安藤の検出力
// 指摘・A-6）の回帰テスト。
//
// renderer/mobile.js はモジュールではない（トップレベルで document.getElementById を
// 呼び、末尾で poll() を即時実行する）DOM 依存のプレーンスクリプトで、このリポジトリに
// jsdom は無い。同種の DOM 依存レンダラコードは tests/csp.test.js・
// tests/pushErrorMessages.test.js と同様、静的ファイルをテキストとして読み込み、
// 正規表現・文字列一致・関数ソースの抽出で検証する（DOM を実際には動かさない）。
// 安藤が9通りの突然変異を当てて検出力を実測した結果、テキスト代入を HTML 差し込みに
// 変える変異は検出できており、この方式自体は妥当と評価されている。
//
// 確認する不変条件:
//   1. #notify-error が #notify-card 内にあり、最初から role="alert" を持つ
//      （aria-live="assertive" が暗黙で付く）。#notify-live（視覚的に隠す読み上げ用）は
//      aria-live="polite" のまま変更しない。
//   2. U-4: #notify-error は hidden 属性を持たない（常にアクセシビリティツリーに
//      存在する。表示・非表示の切り替えを hidden に任せない）。
//   3. U-4: 空文字のときは .notify-error:empty で余白を0にして視覚的にだけ畳む
//      （display:none・visibility:hidden はどちらもツリーから外すため使わない）。
//   4. .notify-error の配色は #err と同じ値を再利用する（独自の色を持ち込まない）。
//   5. showErr() / #err のスタイル定義は一切変更しない（文字列完全一致で固定）。
//   6. setNotifyError() は textContent の代入 1 回だけで、hidden への参照を持たない
//      （表示切り替えと本文代入という2つの別々の書き換えを行わない）。
//   7. poll() の関数本体は setNotifyError を呼ばない（状態取得に連動させない）。
//   8. handleNotifyRequestClick / handleNotifyStopClick は処理の先頭
//      （コメントを除いた最初の実行文）で setNotifyError("") を呼び、押せない状態に
//      する前に消している。setNotifyError(""); の出現は先頭と成功時の2か所だけで、
//      2つ目は「押せない状態にした後・成功時の表示更新より前」にある
//      （安藤の指摘・A-6: コメント読み飛ばし漏れ／先頭呼び出しの誤検出を締め直す）。
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
// このファイルの対象関数の中身には文字列・オブジェクトリテラルの { } が balance
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

// `//` 行コメント（前後の空白のみを伴う行全体）を取り除き、空行も畳む。
// A-6（安藤）: コメント行を残したまま呼び出しだけを消す変異を見逃さないため、
// 「最初の実行文」はコメントを除いた上で判定する。
function stripLineComments(source) {
  return source.replace(/^\s*\/\/.*$/gm, '').replace(/^\s*[\r\n]/gm, '');
}

// ── 1. #notify-error の HTML 属性 ──────────────────────────────────────────

test('#notify-error は #notify-card 内にあり role="alert" を最初から持つ', () => {
  const cardMatch = html.match(/<div id="notify-card"[^>]*>([\s\S]*?)\n<\/div>\n<div id="usage-card"/);
  assert.ok(cardMatch, '#notify-card のブロックが見つからない');
  const cardHtml = cardMatch[1];
  const errMatch = cardHtml.match(/<div[^>]*\bid="notify-error"[^>]*>/);
  assert.ok(errMatch, '#notify-card 内に #notify-error が見つからない');
  assert.match(errMatch[0], /role="alert"/, '#notify-error に role="alert" が付いていない');
});

test('U-4: #notify-error は hidden 属性を持たない（常にアクセシビリティツリーに存在する）', () => {
  const errMatch = html.match(/<div[^>]*\bid="notify-error"[^>]*>/);
  assert.ok(errMatch, '#notify-error が見つからない');
  assert.doesNotMatch(errMatch[0], /\bhidden\b/, '#notify-error に hidden 属性が残っている（U-4 の差し戻し違反）');
});

test('#notify-live は視覚表示に転用されず aria-live="polite" のまま', () => {
  const liveMatch = html.match(/<div[^>]*\bid="notify-live"[^>]*>/);
  assert.ok(liveMatch, '#notify-live が見つからない');
  assert.match(liveMatch[0], /aria-live="polite"/);
  // #notify-error とは別要素であること（id が重複していない）。
  assert.notEqual(liveMatch[0], html.match(/<div[^>]*\bid="notify-error"[^>]*>/)[0]);
});

// ── 2. 配色・畳み方は #err の値を再利用し、独自の色・display:none 等を持ち込まない ──

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
  assert.doesNotMatch(rule, /display:\s*none/, '.notify-error 本体に display:none を使っている');
  assert.doesNotMatch(rule, /visibility:\s*hidden/, '.notify-error 本体に visibility:hidden を使っている');
});

test('U-4: .notify-error:empty は余白だけを0にして畳む（display:none・visibility:hidden は使わない）', () => {
  const ruleMatch = css.match(/\.notify-error:empty\s*\{([^}]*)\}/);
  assert.ok(ruleMatch, '.notify-error:empty のルールが見つからない');
  const rule = ruleMatch[1];
  assert.match(rule, /padding:\s*0;?/, ':empty で padding を0にしていない');
  assert.match(rule, /margin:\s*0;?/, ':empty で margin を0にしていない');
  assert.doesNotMatch(rule, /display:\s*none/, ':empty で display:none を使っている（アクセシビリティツリーから外れる）');
  assert.doesNotMatch(rule, /visibility:\s*hidden/, ':empty で visibility:hidden を使っている（アクセシビリティツリーから外れる）');
});

// ── 3. showErr() / #err の JS 実装は変更していない ─────────────────────────

test('showErr() の実装は変更されていない（文字列完全一致）', () => {
  const expected = 'function showErr(msg) {\n'
    + '  if (!msg) { errEl.style.display = "none"; return; }\n'
    + '  errEl.textContent = msg; errEl.style.display = "block";\n'
    + '}';
  assert.ok(js.includes(expected), 'showErr() の実装が想定と一致しない（変更されている可能性）');
});

// ── 4. setNotifyError() は hidden の切り替えを行わない（U-4） ───────────────

test('U-4: setNotifyError() は textContent の代入だけで、hidden を切り替えない', () => {
  const src = extractFunctionSource(js, 'function setNotifyError(msg) {');
  assert.doesNotMatch(src, /\.hidden\s*=/, 'setNotifyError() が hidden を切り替えている（U-4 の差し戻し違反）');
  assert.match(src, /notifyErrorEl\.textContent = msg \|\| "";/);
});

// ── 5. poll() は setNotifyError を呼ばない（状態取得に連動させない） ────────

test('poll() は setNotifyError を呼ばない（2秒周期の状態取得に連動させない）', () => {
  const pollSrc = extractFunctionSource(js, 'async function poll() {');
  assert.doesNotMatch(pollSrc, /setNotifyError/, 'poll() が setNotifyError を呼んでいる（司の差し戻し指示違反）');
  // 既存の showErr("") 呼び出し（状態取得成功時のグローバル帯クリア）はそのまま残っている。
  assert.match(pollSrc, /showErr\(""\);/);
});

// ── 6. handleNotifyRequestClick / handleNotifyStopClick の呼び出し順序（A-6締め直し） ──

function assertClearsAtStartAndSuccess(src, busyMarker, successMarker) {
  // コメントを除いた「最初の実行文」が setNotifyError("") であること
  // （コメント行を残したまま呼び出しだけ消す変異を見逃さない）。
  const bodyStart = src.indexOf('{') + 1;
  const firstStatement = stripLineComments(src.slice(bodyStart)).trimStart();
  assert.ok(firstStatement.startsWith('setNotifyError("");'), '先頭の実行文が setNotifyError("") ではない');

  // setNotifyError(""); の出現を出現位置と件数で固定する（先頭と成功時の2か所だけ）。
  const clears = [...src.matchAll(/setNotifyError\(""\);/g)].map((m) => m.index);
  assert.equal(clears.length, 2, '消しているのは先頭と成功時の2か所であること');

  const busyIdx = src.indexOf(busyMarker);
  const successIdx = src.indexOf(successMarker);
  assert.ok(busyIdx !== -1, `busyMarker が見つからない: ${busyMarker}`);
  assert.ok(successIdx !== -1, `successMarker が見つからない: ${successMarker}`);

  assert.ok(clears[0] < busyIdx, '押せない状態にするより前で消していない');
  assert.ok(clears[1] > busyIdx && clears[1] < successIdx, '成功時の表示更新と同時に消していない');

  assert.doesNotMatch(src, /\bshowErr\(/, '通知ハンドラが showErr( を直接呼んでいる');
}

test('handleNotifyRequestClick: 先頭と成功時の2か所だけで消し、順序も正しい', () => {
  const src = extractFunctionSource(js, 'async function handleNotifyRequestClick() {');
  assertClearsAtStartAndSuccess(
    src,
    'notifyRequestBtn.disabled = true',
    'setNotifyLive("通知を有効にしました")'
  );
});

test('handleNotifyStopClick: 先頭と成功時の2か所だけで消し、順序も正しい', () => {
  const src = extractFunctionSource(js, 'async function handleNotifyStopClick() {');
  assertClearsAtStartAndSuccess(
    src,
    'notifyStopBtn.disabled = true',
    'setNotifyLive("通知を停止しました")'
  );
});
