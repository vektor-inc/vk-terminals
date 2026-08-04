'use strict';

// clipboard へ書き込んでよい文字列の上限（issue #325）。
// 設定パネルのコピーボタンが渡すのは URL・コマンド 1 行なので、桁違いに余裕を
// 持たせたうえで青天井にはしない。
//
// 以前は preload.js（renderer からの検証）と main.js（clipboard 書き込み直前の
// 最終防衛線）にそれぞれ同じ値のリテラルを持っていた。二重管理を解消するため
// ここへ 1 箇所に集約し、main.js だけがこのファイルを require する。
//
// preload.js（sandbox: true。issue #323）はローカルファイルの相対 require が
// できないため、このファイルを直接 require できない（詳細は preload.js 冒頭の
// コメントを参照。renderer/urlSafety.js を preload 内に複製している前例と同じ制約）。
// そのため main.js がこの値を BrowserWindow の webPreferences.additionalArguments
// 経由で preload へ渡し、preload は process.argv からその値を読み取る
// （additionalArguments は Electron が「preload へ小さな値を渡す」用途として公式に
// 用意している仕組み。渡した文字列は renderer プロセスの process.argv 末尾に
// 追加される）。preload 側の読み取りロジックは preload.js 内に持たせている
// （CLIPBOARD_MAX_LENGTH_ARG_PREFIX という引数名の文字列自体は preload.js 側にも
// 複製が必要。ずれた場合は preload 側が上限不明と判定し、main 側の検証へ委ねる
// だけで、上限値そのものが 2 箇所に増えるわけではない）。
const MAX_CLIPBOARD_TEXT_LENGTH = 100000;

// additionalArguments に載せる際の引数名。preload.js 側のパース処理と対応させる。
const CLIPBOARD_MAX_LENGTH_ARG_PREFIX = '--clipboard-max-text-length=';

module.exports = {
  MAX_CLIPBOARD_TEXT_LENGTH,
  CLIPBOARD_MAX_LENGTH_ARG_PREFIX,
};
