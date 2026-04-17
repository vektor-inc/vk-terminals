# Changelog

- [ 不具合修正 ] Claude の初期化が 4 秒以内に終わらない場合に initialCommand（起動時自動実行コマンド）が無視されてしまう不具合を、Claude のプロンプト（`? for shortcuts`）検知方式に変更して修正
- [ 不具合修正 ] 新規ディレクトリで起動した際の信頼確認プロンプト（`Do you trust the files in this folder?`）で待機して initialCommand が送信されない不具合を修正（Enter を自動送信して承認）
- [ 仕様変更 ] アプリ名を claude-terminals から vk-terminals に変更
- [ 仕様変更 ] 設定・データディレクトリを `~/.vk-terminals/` に変更（旧パス `~/.claude/terminals-config.json` も後方互換で読み込み）
- [ 機能追加 ] 各ターミナルの状態を `~/.vk-terminals/states.json` に定期書き出しする機能を追加
- [ 機能追加 ] ローカル HTTP API（port 13847）を追加し、外部からターミナルの状態取得・コマンド送信が可能に

## 1.3.0

- [ 機能追加 ] ファイル・フォルダをターミナルペインにドラッグ&ドロップするとカーソル位置に絶対パスを挿入する機能を追加（複数ファイルはスペース区切り、スペースを含むパスはシングルクォートで囲む）

## 1.2.0
- [ 機能追加 ] Shift+Enter で改行を送信できる機能を追加（Claude Code の keybindings.json 対応）

## 1.1.0
- [ 機能追加 ] 起動時に新バージョン（git タグ）があるか確認し、あれば自動で `git pull` して再起動を促す機能を追加
- [ デザイン不具合修正 ] ボタンのサイズ・文字サイズ・色を調整

## 1.0.0
- [ 機能追加 ] 起動時に自動実行するコマンドをユーザー設定ファイル（`~/.vk-terminals/config.json` または `config.json`）で指定できる機能を追加
