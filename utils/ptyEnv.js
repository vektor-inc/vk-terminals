'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ペインのシェルへ渡す環境変数を組み立てる。
// Volta（Node のツール管理ツール）で入れた codex / claude は ~/.volta/bin に置かれる。
// Finder 等から起動した Electron は PATH が最小限で、シェルの設定ファイル（.zprofile 等）の
// 読み込み方次第では Volta の bin が PATH に載らず `command not found` になるため、
// 実在し、かつ PATH に無い場合だけ末尾へ補う。
// 先頭ではなく末尾に足すのは、ユーザーが設定ファイルで決めた優先順位を壊さないため。
//
// 引数は注入できる形にしてテスト容易性を保つ。
//   - env: 元の環境変数
//   - options.homeDir: ホームディレクトリ（既定は os.homedir()）
//   - options.dirExists: ディレクトリの実在判定（既定は fs.statSync による判定）
function buildPtyEnv(env, options = {}) {
  const homeDir = options.homeDir || os.homedir();
  const dirExists = typeof options.dirExists === 'function' ? options.dirExists : defaultDirExists;
  const result = { ...env, TERM_PROGRAM: 'VKTerminals' };

  // Windows は PATH の区切り・変数名の大文字小文字が異なるため対象外にする。
  if (process.platform === 'win32') return result;

  const voltaHome = typeof env.VOLTA_HOME === 'string' && env.VOLTA_HOME ? env.VOLTA_HOME : path.join(homeDir, '.volta');
  const voltaBin = path.join(voltaHome, 'bin');
  const currentPath = typeof env.PATH === 'string' ? env.PATH : '';
  const entries = currentPath.split(path.delimiter).filter(Boolean);

  if (!entries.includes(voltaBin) && dirExists(voltaBin)) {
    result.PATH = [...entries, voltaBin].join(path.delimiter);
  }
  return result;
}

function defaultDirExists(dirPath) {
  try {
    return fs.statSync(dirPath).isDirectory();
  } catch (_e) {
    return false;
  }
}

module.exports = { buildPtyEnv };
