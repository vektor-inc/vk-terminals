'use strict';
// utils/clipboardLimits.js（clipboard 上限の唯一の定義）と preload.js（sandbox 制約で
// 直接 require できず、引数名 CLIPBOARD_MAX_LENGTH_ARG_PREFIX の文字列リテラルを
// 複製している側）の整合を固定する（issue #325 / 安藤のセキュリティレビュー
// 指摘・MEDIUM-2）。
//
// 経緯: additionalArguments 経由の受け渡しはフェイルセーフ（preload 側で値を
// 拾えなければ NaN になり、main 側の最終防衛線に委ねるだけ）だが、その縮退は
// 無言かつ無検知で起きる。preload.js 側の CLIPBOARD_MAX_LENGTH_ARG_PREFIX
// リテラルを書き換えて（あるいは書き換え忘れて）utils/clipboardLimits.js 側と
// ずれると、preload 側の一段目の検証が常にスルーされる状態になり、二段検証が
// 静かに一段へ落ちる。
//
// tests/ipcChannelParity.test.js と同じ方式（main.js / preload.js に依存せず、
// preload.js をソーステキストとして読み、リテラルの一致を機械的に固定する）で、
// この縮退を node --test の軽量な静的チェックとして検知できるようにする。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { CLIPBOARD_MAX_LENGTH_ARG_PREFIX } = require('../utils/clipboardLimits');

const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8');

test('preload.js の引数接頭辞リテラルが utils/clipboardLimits.js の CLIPBOARD_MAX_LENGTH_ARG_PREFIX と一致する', () => {
  assert.ok(
    preloadSource.includes(`'${CLIPBOARD_MAX_LENGTH_ARG_PREFIX}'`),
    'preload.js の CLIPBOARD_MAX_LENGTH_ARG_PREFIX リテラルが utils/clipboardLimits.js の値とずれている。' +
      'ずれると main.js が additionalArguments に載せた上限値を preload 側が読み取れず、' +
      'preload 側の一段目の検証が常にスルーされる（二段検証が一段に縮退する）。'
  );
});
