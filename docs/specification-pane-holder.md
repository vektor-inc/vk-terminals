# tmux ペイン保持役（issue #585）

## 起動

`--pane-holder=tmux` または `embedded.start({ paneHolder: 'tmux' })` で有効になる。未指定・不正な CLI 値は node-pty を使う。組み込みオプションの不正値は例外にする。設定画面の項目には加えない。tmux が PATH に無い場合は警告して node-pty に戻す。

## 構成

アプリごとに tmux 制御モードのクライアントを 1 本持つ。`%output` の 8 進エスケープをバイト列へ戻し、既存の `onData` 処理へ渡す。入力は `send-keys -H`、サイズ変更は `resize-pane`。各ペインの `#{pane_pid}` をシェル PID として使う。画面の端末問い合わせへの応答は tmux に重複送信しない。Claude Code / Codex の起動コマンドからだけ `TMUX` と `TMUX_PANE` を外す。

制御モードの初期セッションには保持役用の `sleep` ペインを置く。終了時は各ペインを止め、検査済み専用ソケットの `kill-server` で保持役を止める。アプリ終了後のペイン保持と再接続は次の段階で扱う。

## 環境とソケット

tmux サーバーの環境には、値のある `HOME`, `USER`, `LOGNAME`, `SHELL`, `PATH`, `TMPDIR`, `LANG`, `LC_ALL`, `LC_CTYPE`, `LC_MESSAGES`, `TERMINFO`, `TERMINFO_DIRS` だけを渡す。同梱の `tmux-holder.conf` を `-f` で指定し、利用者の設定は読まない。

ペインは `env -i` の複数引数でシェルを起動する。変数一覧は `buildPtyEnv(process.env)` が作る全変数と `TERM=xterm-256color`。値はシェルのコマンド文字列へ埋め込まず、引数として渡す。シェルには追加引数を付けない。

専用ソケットは既定で `~/.vk-terminals/run/tmux.sock`。テスト時は `VK_TERMINALS_HOLDER_RUN_DIR` で親フォルダを変更できる。親フォルダは本人所有の 0700、ソケットは本人所有の実ソケットで 0600 または tmux が接続中に設定する 0700 とする。シンボリックリンクを拒否する。ソケットパスが 104 バイトを超える場合、起動前に失敗する。既存ソケットがある場合も別アプリのサーバーを巻き込まないため起動しない。すべての tmux 呼び出しに `-S` を付ける。
