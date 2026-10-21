'use strict';

// 組み込み用の入口。VK Orchestrator のように VK Terminals を部品として .app に含めるアプリが、
//   require('<vk-terminals>/embedded').start({ appTitle: 'VK Orchestrator', resourceRoot, ... })
// と呼んで起動する。electron . で起動するときは従来どおり main.js が入口になる。
//
// options:
//   appTitle               ウィンドウタイトル・ヘッダーの表示名（ドックの表示名は呼び出し側のアプリの Info.plist で決まる）
//   resourceRoot           renderer / preload.js / settings-schema.json / アイコン等の置き場所（絶対パス）
//   selfUpdate             git による自己更新をするか（既定 false。app.isPackaged のときは true でも行わない）
//   settingsDescriptorPath 追加の設定画面ディスクリプタのパス（絶対パス）
//   singleInstance         二重起動を検知して知らせるか（既定 true）
//
// main.js は require した時点で起動処理を登録する作りのため、オプションを先に保存してから require する。
const { setEmbeddedOptions } = require('./utils/runtimeOptions');

let started = false;

function start(options) {
  if (started) throw new Error('VK Terminals is already started');
  setEmbeddedOptions(options);
  started = true;
  require('./main');
}

module.exports = { start };
