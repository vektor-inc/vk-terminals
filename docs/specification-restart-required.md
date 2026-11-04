# 設定反映のための再起動案内

## 状態の受け渡し

VK Orchestrator は `~/.vk-terminals/restart-required.json` を別名の一時ファイルに書いてから同じディレクトリ内で置き換える。形式は UTF-8 JSON:

```json
{"restartRequired": true, "tabs": ["general", "mobile"]}
```

`restartRequired` は再起動が必要なときだけ `true`。`tabs` は案内を出す設定タブ ID の配列で、サイドバーの「設定を確認」は先頭の有効タブへ移動する。組み込みディスクリプタでは `general` と `mobile`。組み込み側が別の設定ディスクリプタを渡す場合は、その `tabs[].id` に実在する値を使う。複数タブに案内を出せる。差が解消したら `restartRequired: false` を書くかファイルを削除する。

VK Terminals は 5 秒ごとにファイルを読み直し、設定パネルを開いたときにも状態を参照する。ファイルが無い、JSON が壊れている、値の型が違う、タブ ID がすべて未知の場合は表示しない。未知のタブ ID は無視する。文言は VK Terminals 側に固定し、ファイルからは受け取らない。パネルを開いたことでは状態を消さない。

`fs.watch` 単体は atomic rename で監視対象を失うため使わない。`embedded.start()` オプション経由の関数は、単体起動時に供給元がなく、後から状態を更新するにも組み込み側のプロセスに依存するため採らない。

## 再起動

設定タブの案内からのみ「アプリを再起動」を実行する。本体の `dialog.showMessageBox` で確認し、キャンセルを既定・Esc にする。確認後は更新後再起動と同じ PTY 終了待ちを使う。組み込み時の `app.relaunch()` は Electron アプリ全体の再起動であり、VK Orchestrator が起動した Electron 実行ファイルと引数に依存する。親アプリの起動経路によっては復帰先の実機確認が必要。
