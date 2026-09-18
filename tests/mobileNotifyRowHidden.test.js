'use strict';
// 通知カードの「許可済み・登録済み」状態（issue #396）で、hidden 属性をセットしても
// 表示が消えない不具合（麗美の UI テスト指摘・R-1）の回帰テスト。
//
// renderer/mobile.js はモジュールではない（トップレベルで document.getElementById を
// 呼び、末尾で poll() を即時実行する）DOM 依存のプレーンスクリプトで、このリポジトリに
// jsdom は無い。同種の DOM 依存レンダラコードは tests/csp.test.js・
// tests/mobileNotifyError.test.js と同様、静的ファイルをテキストとして読み込み、
// 正規表現・文字列一致で検証する（DOM を実際には動かさない）。
//
// 原因: .notify-row は display: flex を持つが、ブラウザ既定の
// `[hidden] { display: none }` を上書きする指定が無いと、JS 側が hidden = true を
// セットしても .notify-row の display: flex が優先されて常に表示され続ける。
// #usage-card .u-line[hidden]・.task-list[hidden] など既存の前例（同ファイル内に11
// 箇所）と同じ形で、非 none の display を持つセレクタには必ず [hidden] の上書きが
// 対になっていることを固定する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const CSS_PATH = path.join(__dirname, '..', 'renderer', 'mobile.css');
const css = fs.readFileSync(CSS_PATH, 'utf8');

test('R-1: .notify-row に display: flex があるなら [hidden] の上書きも必ずある', () => {
  const ruleMatch = css.match(/\.notify-row\s*\{([^}]*)\}/);
  assert.ok(ruleMatch, '.notify-row のルールが見つからない');
  assert.match(ruleMatch[1], /display:\s*flex;?/, '.notify-row が display: flex を持っていない（前提が崩れている）');

  assert.match(
    css,
    /\.notify-row\[hidden\]\s*\{\s*display:\s*none;\s*\}/,
    '.notify-row[hidden] { display: none; } が無い（R-1 の差し戻し違反）'
  );
});
