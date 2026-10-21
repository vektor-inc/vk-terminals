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
//   getSetupStatus         セットアップ状況の一覧を出すための非同期関数。VK Orchestrator の doctor の結果
//                          { requirements, summary } を返す（引数に { signal } を渡す。20 秒で abort するので、signal を受けて処理を止めること。
//                          止まらない間は、新しい確認は始まらず時間切れとして返る）。
//                          Claude Code の有無は、requirements のうち id が 'claude' の行で判定する。
//                          その行が無いときは Claude Code が無いものとして扱う。
//                          別プロセスで動かすかは呼び出し側が決める（画面を固めないため）。
//   setupPane              セットアップ用ペインの { cwd, prompt }。cwd は実在する絶対パス、
//                          prompt は /^\/[a-z0-9-]+$/ に一致するスキル名（例 '/vk-orchestrator-setup'）。
//                          getSetupStatus と必ず対で渡す。どちらも渡さなければ一覧は出ない。
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
