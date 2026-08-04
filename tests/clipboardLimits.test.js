'use strict';
// utils/clipboardLimits.js（clipboard 上限の唯一の定義）と、main.js（additionalArguments
// で preload へ値を渡す側）・preload.js（sandbox 制約で直接 require できず、引数名
// CLIPBOARD_MAX_LENGTH_ARG_PREFIX の文字列リテラルを複製している側）の整合を固定する
// （issue #325 / 安藤のセキュリティレビュー指摘・MEDIUM-1 / MEDIUM-2）。
//
// 経緯: additionalArguments 経由の受け渡しはフェイルセーフ（preload 側で値を
// 拾えなければ NaN になり、main 側の最終防衛線に委ねるだけ）だが、その縮退は
// 無言かつ無検知で起きる。main.js の additionalArguments 行が消える、あるいは
// preload.js 側の CLIPBOARD_MAX_LENGTH_ARG_PREFIX リテラルが utils/clipboardLimits.js
// 側とずれると、preload 側の一段目の検証が常にスルーされる状態になり、二段検証が
// 静かに一段へ落ちる。
//
// 当初は e2e（Playwright）で webContents.getLastWebPreferences().additionalArguments を
// 直接読む形の回帰テストを用意したが、安藤の再レビューで
// getLastWebPreferences() が additionalArguments を返さない（Electron 28.3.3 で実測。
// 返るのは allowRunningInsecureContent 等の固定 12 キーのみ）ことが判明し、常に赤に
// なる壊れたテストだった（司の判断で該当テストは削除）。代わりに
// tests/ipcChannelParity.test.js と同じ方式（main.js / preload.js に依存せず、
// ソーステキストとして読み、正規表現で構造ごと固定する）で、node --test だけで
// 完結する軽量な静的チェックとして検知できるようにする。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CLIPBOARD_MAX_LENGTH_ARG_PREFIX } = require('../utils/clipboardLimits');

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('main.js が additionalArguments で CLIPBOARD_MAX_LENGTH_ARG_PREFIX / MAX_CLIPBOARD_TEXT_LENGTH をテンプレートリテラルとして渡している', () => {
  assert.match(
    mainSource,
    /additionalArguments:\s*\[\s*`\$\{CLIPBOARD_MAX_LENGTH_ARG_PREFIX\}\$\{MAX_CLIPBOARD_TEXT_LENGTH\}`\s*\]/,
    'main.js の additionalArguments 行が見つからない、または CLIPBOARD_MAX_LENGTH_ARG_PREFIX / ' +
      'MAX_CLIPBOARD_TEXT_LENGTH を経由しない形に変わっている。この行が消える・定数を経由しなくなると、' +
      'preload 側は process.argv から上限値を読み取れなくなり一段目の検証が常にスルーされる ' +
      '（main 側の最終防衛線だけが残り、二段検証が静かに一段へ落ちる）。'
  );
});

test('preload.js の CLIPBOARD_MAX_LENGTH_ARG_PREFIX 代入行が utils/clipboardLimits.js の値と一致する', () => {
  // 単純な includes() だと (a) コメント中に同じ文字列があっても通ってしまう
  // （定数は変えたがコメントの旧値だけ残っている状態を見逃す）、(b) 代入先の変数名を
  // 見ていないので別の変数への代入でも通ってしまう、という 2 つの偽陰性を持つ
  // （安藤のセキュリティレビュー指摘・MEDIUM-2 強化）。ここでは
  // `const CLIPBOARD_MAX_LENGTH_ARG_PREFIX = '...';` という代入文そのものを正規表現で
  // 固定する。クォート種別（'/"/`）を変えると赤くなる点は、無言で緩まない安全側の
  // 挙動として許容する。
  const escapedValue = CLIPBOARD_MAX_LENGTH_ARG_PREFIX.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const assignmentPattern = new RegExp(
    `const CLIPBOARD_MAX_LENGTH_ARG_PREFIX = ['"\`]${escapedValue}['"\`];`
  );
  assert.match(
    preloadSource,
    assignmentPattern,
    'preload.js の `const CLIPBOARD_MAX_LENGTH_ARG_PREFIX = ...;` 代入行が ' +
      'utils/clipboardLimits.js の CLIPBOARD_MAX_LENGTH_ARG_PREFIX の値とずれている。' +
      'ずれると main.js が additionalArguments に載せた上限値を preload 側が読み取れず、' +
      'preload 側の一段目の検証が常にスルーされる（二段検証が一段に縮退する）。'
  );
});
