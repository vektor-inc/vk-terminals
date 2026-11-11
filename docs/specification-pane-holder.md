# tmux ペイン保持役（issue #585）

## 起動

`--pane-holder=tmux` または `embedded.start({ paneHolder: 'tmux' })` で有効になる。未指定・不正な CLI 値は node-pty を使う。組み込みオプションの不正値は例外にする。設定画面の項目には加えない。tmux が使えない場合は原因とソケットのパスを警告して node-pty に戻す。

## 構成

アプリごとに tmux 制御モードのクライアントを 1 本持つ。`%output` の 8 進エスケープをバイト列へ戻し、既存の `onData` 処理へ渡す。入力は制御クライアントの標準入力へ分割した `send-keys -H`、サイズ変更は `resize-window`。各ペインの `#{pane_pid}` をシェル PID として使う。画面の端末問い合わせへの応答は tmux に重複送信しない。Claude Code / Codex の起動コマンドからだけ `TMUX` と `TMUX_PANE` を外す。

制御モードの初期セッションには保持役用の `sleep` ペインを置く。終了時は各ペインを止め、検査済み専用ソケットの `kill-server` で保持役を止める。アプリ終了後のペイン保持と再接続は次の段階で扱う。

## 環境とソケット

tmux サーバーの環境には、値のある `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TERMINFO`, `TERMINFO_DIRS` だけを渡す。同梱の `tmux-holder.conf` を `-f` で指定し、利用者の設定は読まない。

ペインは本人だけが読める 0600 の一時スクリプトに環境変数を書き、`env -i /bin/sh` で実行する。変数一覧は `buildPtyEnv(process.env)` が作る全変数と `TERM=xterm-256color`。スクリプトはシェル起動前に削除され、最後は `exec` で対象シェルに置き換わる。値はプロセス引数に載らない。シェルには追加引数を付けない。alias や関数で定義した `claude` / `codex` は、この起動経路では使われない。

専用ソケットは既定で `~/.vk-terminals/run/tmux.sock`。テスト時は `VK_TERMINALS_HOLDER_RUN_DIR` で親フォルダを変更できる。親フォルダは本人所有の 0700、ソケットは本人所有の実ソケットで 0600 または tmux が接続中に設定する 0700 とする。シンボリックリンクを拒否する。ソケットパスが 104 バイト以上なら起動前に失敗する。残ったソケットは起動時に所有者の生死とサーバー応答を確認して回収する。別アプリの生きたサーバーなら使用しない。すべての tmux 呼び出しに `-S` を付ける。手動で片付ける場合はアプリと保持役が停止したことを確認し、`~/.vk-terminals/run/tmux.sock` を削除する。
