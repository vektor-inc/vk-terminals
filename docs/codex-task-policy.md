# 自動処理用 Codex のタスク用ポリシー（issue #428）

`POST /api/new-pane` と `POST /api/restart-agent` の `codexPolicy` について、仕様と安全性の判断を残す。
API の書き方は [README.md](../README.md) の各 API の節を参照する。

## 目的

vk-orchestrator などが自動処理用の Codex を起動するとき、次の 2 つを両立する。

- 利用者個人の Codex 設定（`~/.codex/config.toml` など）を意図せず継承しない
- 標準工程（作業フォルダ内の編集・ローカルコミット・許可された GitHub 更新・会話整理の引き継ぎ）を承認待ちなしで完了できる

## 受け付ける指定

```json
{ "engine": "codex", "approvalPolicy": "never", "codexPolicy": { "preset": "orchestrated-task" }, "cwd": "/path/to/repo" }
```

- `cwd`（作業フォルダ）は必須。承認なしの Git / GitHub 操作を拘束するリポジトリを、ここから決める（新規作成・再起動の両方）。省略すると `400 {"error":"codexPolicy requires cwd"}`。

- 設定キーは `preset` の 1 つだけ。値は固定の名前（現在は `orchestrated-task` のみ）。
- 未知のキー、未知の preset、オブジェクト以外（文字列・配列・`null`）は `400`。ペインは作成されず、再起動では実行中の AI も止めない。
- `engine` が `codex` 以外のときは `400`（`Codex options require engine "codex"`）。Claude Code と、利用者が手動で開く通常の Codex には適用されない。
- 任意のコマンドライン引数・追加フォルダ・ネットワーク許可を渡す口は作らない。API の入力値は、preset 名を選ぶ以外に、生成するファイルにも起動コマンドにも入らない。

## 仕組み

方式は「個人設定を上書きする」ではなく「個人設定を読ませない」にした。

1. VK Terminals が起動のたびに、固定内容の専用 `CODEX_HOME`（`~/.vk-terminals/codex-task-policy/<preset>/<ランダム名>/`）を**新規に**作る（実装: `utils/codexTaskPolicy.js`）。前回の専用フォルダは使い回さない。
2. その Codex の起動だけ、`CODEX_HOME='<専用フォルダ>' codex --no-daemon …` のように環境変数を前置する。ペインのシェルへ書き込む文字列は、固定の実行ファイル名と検証済みの許可値だけで組み立てる。
3. 専用フォルダの中身は次の 7 つだけ。作った直後に一覧を検証し、これ以外があれば Codex を起動しない。
   - `config.toml`: `sandbox_mode = "workspace-write"`、`network_access = false`、`web_search = "disabled"`、追加の書き込み先は会話整理の引き継ぎ先 `~/.claude/handoff` のみ。Codex が起動するコマンドへ `LD_*`・`DYLD_*`・`NODE_*`・`BASH_ENV`・`ENV`・`GIT_*`・`GH_*`・`GITHUB_*` の環境変数を渡さない設定（`shell_environment_policy.exclude`）も入る
   - `rules/vk-terminals-task.rules`: 承認なしで実行してよいもの。信頼済みランチャー 1 つ（`<専用フォルダ>/vk-task-ops`）の実行だけ
   - `vk-task-ops`: 信頼済みランチャー（0500 の `sh` スクリプト）。下記
   - `vk-task-ops.js`: 承認なしの Git / GitHub 操作の入口（`utils/codexTaskOps.js` の複製。0400）
   - `gitconfig`: Git の global 設定の代わりに使う、author 情報（`user.name` / `user.email`）だけの設定。利用者の global 設定から読み取った値のみで、外部コマンドを起動する設定は持たない
   - `AGENTS.md`: 入口の使い方の案内（Codex がこの入口を知るための固定文）
   - `auth.json`: 個人の `auth.json`（最終的な実体）へのシンボリックリンク（ログイン状態を引き継ぐためだけ。個人の設定ファイルは共有しない）。個人側に無ければ作らない
4. `--ask-for-approval` と `--sandbox` は従来どおりコマンドライン引数で渡す。`sandboxMode` を省略してもポリシー付きなら `workspace-write` を明示する。

### 判断: `-c`（設定上書き）や `-p`（プロファイル）を使わない理由

- `-c` は指定したキーしか上書きできない。個人設定にある `writable_roots`・`network_access`・`profile`・`default_permissions` などを 1 つずつ打ち消す必要があり、Codex の更新で設定キーが増えると抜けが出る。
- `-p` は「個人設定の上に重ねる」仕組みで、個人設定を無効にできない。
- 固定の許可コマンド（rules）は `CODEX_HOME/rules/` からしか読み込めず、`-c` では渡せない。起動ごとに新規の専用 `CODEX_HOME` なら設定・rules・hooks・`AGENTS.md`・信頼済みプロジェクトの記録がすべて固定内容になる。

### 承認なしで実行できる固定の入口

rules の `prefix_rule` は先頭の単語列しか指定できず、後ろに続く引数や実行時の環境を制限できない。`git diff` を許可すると `--output=<任意のファイル>` で任意の場所へ書き込め、`gh pr create` を許可すると暗黙の push が起きる。`node` を許可すると `NODE_OPTIONS` などの環境変数で検証の前に別のコードを実行できる。そのため `git` / `gh` / `node` 自体は rules で許可せず、**信頼済みランチャー 1 つだけ**を許可する。

- 呼び方: `'<専用フォルダ>/vk-task-ops' <git|gh> <操作> …`（AGENTS.md に書いてある）
- ランチャーは Node を起動する前に `env -i` で環境を空にし、起動時に確定した値（拘束するリポジトリ・git / gh / Node の絶対パス・固定した HOME）だけを渡して、絶対パスの Node で入口を実行する。ランチャーは起動ごとに専用フォルダへ書かれ、Codex からは書き換えられない（0500・所有者のみ）
- 許可する操作: `git status` / `git diff` / `git log` / `git show` / `git add` / `git commit`、`gh issue view` / `gh issue comment` / `gh pr view` / `gh pr create` / `gh pr comment` / `gh pr checks`
- 引数の検証（`utils/codexTaskOps.js` の `parseTaskCommand`）:
  - オプションは操作ごとの許可リストだけ。未知のオプション（`--output`・`--ext-diff`・`--body-file`・`--repo`・`--web`・`--amend` など）は拒否
  - パスはリポジトリ内の相対パスだけ（絶対パス・`..`・`.git`・pathspec の特殊記法は拒否）。リビジョンは英数字と `._/@^~{}-` のみ
  - `gh pr create` は `--head <ブランチ名>`・`--title`・`--body` が必須（`--head` を省くと gh が現在のブランチを push するため）。`owner:branch` 形式は拒否。`gh pr view` / `gh pr checks` は PR 番号が必須（`--repo` を付けるため現在のブランチから PR を推測できない）
- 実行ファイルと環境の固定:
  - `node` / `git` / `gh` は PATH を使わず、起動時に固定の探索先（`/opt/homebrew/bin`・`/usr/local/bin`・`/usr/bin`・`/bin`・`~/.volta/bin`、およびアプリ自身の `PATH` にある絶対パス）から、所有者（自分か root）・他人が書き込めない権限・祖先フォルダの安全性を検証した絶対パスだけを選ぶ。見つからなければ起動しない。入口も実行のたびに git / gh を再検証する
  - git / gh の子プロセスの環境変数は許可リストで一から組み立てる（`PATH`・`HOME`・`XDG_CONFIG_HOME`・`GH_CONFIG_DIR` と、Git の設定隔離・非対話の指定のみ）。親の `NODE_OPTIONS`・`LD_PRELOAD`・`GIT_*`・`GH_*` などは引き継がない
  - Git の system / global 設定は使わない。global 設定の代わりに、ランチャーが生成した author 情報だけの設定ファイルを指す。リポジトリ内の設定に外部コマンドを起動しうる項目（clean/smudge/process filter・`diff.external`・textconv・`merge.*.driver`・`gpg.*.program`・`core.sshCommand`・`core.askPass`・`core.editor`・`core.pager`・`credential.*.helper`・`include`・`includeIf` など）があるリポジトリでは、閲覧系も `git add` / `git commit` も実行を拒否する
  - git には `core.fsmonitor=false`・`core.hooksPath=/dev/null`・`commit.gpgsign=false`・`tag.gpgsign=false` をコマンドラインで指定する。**リポジトリのフック（pre-commit など）は入口経由の commit では実行されない**。diff / show / log は `--no-ext-diff --no-textconv` も付ける
- リポジトリへの拘束:
  - 起動時に、`cwd` から Git の実ルートと `origin` の GitHub の `owner/repo` を確定し、ランチャーに固定する（実行中は変更できない）。確定できないとき（Git 管理下でない・ホームや `/` そのもの・外部コマンドを起動しうる設定がある）は起動を拒否する。`origin` が github.com でない場合は owner/repo を固定せず、gh 系の操作だけを拒否する（git の操作は使える）
  - 実行のたびに、作業フォルダの Git ルートが固定したルートと一致すること（別のリポジトリ・入れ子のリポジトリは拒否）、gh を使う操作では `origin` が固定した `owner/repo` と一致することを確認する
  - gh には検証済みの `--repo <owner/repo>` を必ず付ける。利用者・Codex が `--repo` を指定する経路は無い
  - 新規作成と再起動のどちらも、同じ関数で拘束する
- 含めないもの: `git push`、`git reset`、`gh api`、`gh pr merge`、任意のシェル。
- 入口を通さない `git` / `gh` は sandbox の制限内（ネットワーク無し）で動く。
- 認証: gh は固定した HOME の `~/.config/gh`（キーチェーンを含む）の認証を使う。`GH_TOKEN` などの環境変数のトークンは入口へ渡らない。
- 既知の制約: 設定の検査から実行までの間にリポジトリの設定が書き換えられる競合は、同じユーザーの別プロセスが書き換える場合に限り残る（実行のたびに検査し直すことで窓を狭めている）。Git LFS など、外部コマンドを起動する filter を使うリポジトリは、安全に固定できないため入口が拒否する。

### ファイルシステムの検証

- 信頼境界（データフォルダ・会話整理の引き継ぎ先・ホーム・個人の `auth.json`・実行ファイル）は、根から末端までの**全階層**について、シンボリックリンクでない実体・所有者が自分か root・他人が書き込めない権限（グループ書き込みは root 系の `wheel` と macOS の `admin` のみ許す。他人の書き込み可は、root 所有の sticky フォルダを祖先に持つ場合のみ許す）を検証する。途中の階層が他人の書き込み可・他人の所有・リンクなら拒否する。検証したときの識別子（dev / inode）は、専用フォルダの生成が終わった直後に再確認し、準備の途中で差し替えられていたら拒否して片付ける。
- 専用側のフォルダ（`codex-task-policy`・preset・起動ごとのフォルダ・`rules`）は、毎回「シンボリックリンクでない実体」「自分の所有」を確認し、0700 でなければ開いたフォルダ自体に対して 0700 へ直す。直せなければ拒否する。
- ファイルは排他的作成（既にあれば失敗）・リンク非追跡（`O_EXCL | O_NOFOLLOW`）で作る。権限は通常 0600、入口は 0400、ランチャーは 0500。専用フォルダは毎回新規なので、固定ファイル名の位置に事前配置されたリンクやファイルを再利用する経路が無い。一時ファイルは使わない。
- 書き込み後に、通常ファイル・所定の権限・自分の所有・リンクカウント 1・中身が期待どおり、を確認する。
- 個人の `auth.json` は、通常ファイル（リンクなら最終的な実体が通常ファイル）かつ自分の所有で、実体までの階層が上記の信頼境界を満たすときだけ共有する。無ければ共有しない（新規のフォルダなので古い `auth.json` も残らない）。ディレクトリやリンク切れ・他人が書き込めるものは拒否する。

### 専用フォルダの回収と削除

- 生成の途中で失敗したときは、その呼び出しで**自分が作った**専用フォルダ（作成時の識別子が一致する実体のフォルダ）だけを片付けてから拒否を返す。事前に置かれていたフォルダ・他の起動のフォルダには触らない。
- 専用フォルダを作ったのに Codex の起動に使わなかった場合（再起動での停止失敗・PTY の消滅・起動コマンドの書き込み失敗、新規作成での PTY 作成失敗）も、同じ条件で回収する。
- 再起動では、直列化の待機・ペインの存在確認（404）・世代確認（409）を通った後、AI を止める前に専用フォルダを作る。これらで終わるリクエストは専用フォルダを作らない。事前確認（`dryRun`）は専用フォルダを作らない。
- **起動に使った専用フォルダは自動では消さない。** 複数のアプリプロセスをまたいで「使用中でない」ことを確実に判定する方法が無く、古さ（更新時刻）だけで消すと長く動いている Codex のセッションの設定を消してしまうため。削除は利用者の責務で、Codex が動いていないときに `~/.vk-terminals/codex-task-policy/` 以下を消してよい（次の起動で作り直される）。

## 固定できないときは止める

次のいずれかなら `503 {"error":"codex task policy unavailable: <理由>"}` を返し、Codex を起動しない（承認方針だけを `never` にした起動にもしない）。

- 専用フォルダを作れない・書き込めない
- 親フォルダや専用フォルダがシンボリックリンクなど通常のフォルダではない、または他人の所有・権限を 0700 にできない
- データフォルダ・引き継ぎ先・ホーム・認証元のいずれかの階層が、リンク・他人の所有・他人が書き込める権限である、または検証後に差し替えられた
- 書き込み後に読み戻した内容・一覧が許可した生成物と一致しない（余計なファイルがある）
- 個人の `auth.json` が通常ファイルでない・他人の所有・リンク切れ
- `node` / `git` の実行ファイルを、所有者・権限を検証したうえで固定の探索先から見つけられない
- `cwd` が無い・Git 管理下でない・ホームや `/` そのもの・リポジトリの設定に外部コマンドを起動しうる項目がある
- ディレクトリのパスに制御文字・シングルクォートが含まれる、または絶対パスでない

起動コマンドの組み立て（`renderer/claudeModel.js` の `buildCodexLaunchCommand`）にも最終防衛線があり、ポリシー指定があるのに専用フォルダが無い・不正な場合は例外で止める。

### 事前確認と本番の食い違い

`POST /api/new-pane` は受付時に事前確認（専用フォルダを作らず、親フォルダ・引き継ぎ先・実行ファイル・`cwd` のリポジトリの検証だけ。`dryRun`）を行い、その後ペイン作成（`terminal:create`）側で専用フォルダを作る。この間に状態が変わって本番だけが失敗しうるため、`terminal:create` は **PTY を作る前に**起動オプションの解決と起動コマンドの組み立てを済ませ、失敗したら例外で返す。失敗は renderer から HTTP の `500` として呼び出し元へ伝わり、Codex が起動していないペインを成功として返さない。PTY を作る前なので、破棄すべき PTY・管理状態は残らない。

## 新規作成と再起動で同じ実効ポリシーにする

新規ペイン作成（`terminal:create`）と再起動（`restart-agent`）は、どちらも `resolveCodexTaskPolicyLaunchOptions` を通して「検証 → 専用フォルダの用意 → 起動オプションへの変換」を行い、拘束するリポジトリも同じ関数で `cwd` から決める。専用フォルダは起動のたびに固定内容で新規に作るので、再起動を繰り返しても権限は広がらず、失われもしない（会話の履歴は起動ごとの専用フォルダに残り、再起動後の Codex には引き継がれない）。
再起動のリクエストに `codexPolicy` を付けなかった場合は、前回のポリシーを引き継がず、ポリシー無しの Codex として起動する。ポリシーを維持したい呼び出し側は、再起動のたびに同じ `codexPolicy` を送ること。

## 利用者個人の設定との関係

- 個人の `config.toml` は読まず、変更もしない（テストで内容のハッシュ不変を確認）。
- 専用 `CODEX_HOME` を使うため、個人設定の `model` なども効かない。モデルは `model` で指定する。
- 会話の履歴は起動ごとの専用フォルダ側に保存されるため、個人の `codex resume` 一覧には出ない。

## 既知の制約

- 管理者配布の設定（managed config / requirements）は Codex 自体が最優先で適用する。VK Terminals からは無効化できない（制限を強める方向にしか働かない）。
- VK Terminals と vk-orchestrator が別マシンでも、専用フォルダは「実際に Codex を起動する側」の VK Terminals が生成するため、同じポリシーが適用される。
- rules の `allow` が sandbox の外で動く挙動は Codex の仕様に依存する。この環境（Codex 0.162.1）で `codex execpolicy check` により、ランチャーの実行だけが `allow` になり `git` / `gh` / `node` の直接実行は一致しないことを確認する（入口の引数・拘束・環境の検証は `tests/codexTaskOps.test.js`、ランチャーを実際に起動する検証は `tests/codexTaskPolicy.test.js`）。
- Git LFS のようにリポジトリ内の設定で外部コマンドを起動する filter を使うリポジトリでは、入口を使えない（起動自体は拒否される）。
- 実行ファイルの探索先に含まれない場所（独自のインストール先）の `node` / `git` は、アプリ自身の `PATH` に絶対パスで含まれていて検証を通れば使える。通らなければ起動を拒否する。実際の GUI での標準工程の通しの確認は vk-orchestrator#592 の手順で行う。
