# 自動処理用 Codex のタスク用ポリシー（issue #428）

`POST /api/new-pane` と `POST /api/restart-agent` の `codexPolicy` について、仕様と安全性の判断を残す。
API の書き方は [README.md](../README.md) の各 API の節を参照する。

## 目的

vk-orchestrator などが自動処理用の Codex を起動するとき、次の 2 つを両立する。

- 利用者個人の Codex 設定（`~/.codex/config.toml` など）を意図せず継承しない
- 標準工程（作業フォルダ内の編集・ローカルコミット・許可された GitHub 更新・会話整理の引き継ぎ）を承認待ちなしで完了できる

## 受け付ける指定

```json
{ "engine": "codex", "approvalPolicy": "never", "codexPolicy": { "preset": "orchestrated-task" } }
```

- 設定キーは `preset` の 1 つだけ。値は固定の名前（現在は `orchestrated-task` のみ）。
- 未知のキー、未知の preset、オブジェクト以外（文字列・配列・`null`）は `400`。ペインは作成されず、再起動では実行中の AI も止めない。
- `engine` が `codex` 以外のときは `400`（`Codex options require engine "codex"`）。Claude Code と、利用者が手動で開く通常の Codex には適用されない。
- 任意のコマンドライン引数・追加フォルダ・ネットワーク許可を渡す口は作らない。API の入力値は、preset 名を選ぶ以外に、生成するファイルにも起動コマンドにも入らない。

## 仕組み

方式は「個人設定を上書きする」ではなく「個人設定を読ませない」にした。

1. VK Terminals が起動のたびに、固定内容の専用 `CODEX_HOME`（`~/.vk-terminals/codex-task-policy/<preset>/<ランダム名>/`）を**新規に**作る（実装: `utils/codexTaskPolicy.js`）。前回の専用フォルダは使い回さない。
2. その Codex の起動だけ、`CODEX_HOME='<専用フォルダ>' codex --no-daemon …` のように環境変数を前置する。ペインのシェルへ書き込む文字列は、固定の実行ファイル名と検証済みの許可値だけで組み立てる。
3. 専用フォルダの中身は次の 5 つだけ。作った直後に一覧を検証し、これ以外があれば Codex を起動しない。
   - `config.toml`: `sandbox_mode = "workspace-write"`、`network_access = false`、`web_search = "disabled"`、追加の書き込み先は会話整理の引き継ぎ先 `~/.claude/handoff` のみ
   - `rules/vk-terminals-task.rules`: 承認なしで実行してよいもの。固定の入口 1 つ（`node <専用フォルダ>/vk-task-ops.js`）の実行だけ
   - `vk-task-ops.js`: 承認なしの Git / GitHub 操作の入口（`utils/codexTaskOps.js` の複製。下記）
   - `AGENTS.md`: 入口の使い方の案内（Codex がこの入口を知るための固定文）
   - `auth.json`: 個人の `auth.json`（最終的な実体）へのシンボリックリンク（ログイン状態を引き継ぐためだけ。個人の設定ファイルは共有しない）。個人側に無ければ作らない
4. `--ask-for-approval` と `--sandbox` は従来どおりコマンドライン引数で渡す。`sandboxMode` を省略してもポリシー付きなら `workspace-write` を明示する。

### 判断: `-c`（設定上書き）や `-p`（プロファイル）を使わない理由

- `-c` は指定したキーしか上書きできない。個人設定にある `writable_roots`・`network_access`・`profile`・`default_permissions` などを 1 つずつ打ち消す必要があり、Codex の更新で設定キーが増えると抜けが出る。
- `-p` は「個人設定の上に重ねる」仕組みで、個人設定を無効にできない。
- 固定の許可コマンド（rules）は `CODEX_HOME/rules/` からしか読み込めず、`-c` では渡せない。起動ごとに新規の専用 `CODEX_HOME` なら設定・rules・hooks・`AGENTS.md`・信頼済みプロジェクトの記録がすべて固定内容になる。

### 承認なしで実行できる固定の入口

rules の `prefix_rule` は先頭の単語列しか指定できず、後ろに続く引数を制限できない。`git diff` を許可すると `--output=<任意のファイル>` で任意の場所へ書き込め、`gh pr create` を許可すると暗黙の push が起きる。そのため `git` / `gh` 自体は rules で許可せず、**引数・パス・リポジトリを検証する入口 1 つだけ**を許可する。

- 呼び方: `node '<専用フォルダ>/vk-task-ops.js' <git|gh> <操作> …`（AGENTS.md に書いてある）
- 許可する操作: `git status` / `git diff` / `git log` / `git show` / `git add` / `git commit`、`gh issue view` / `gh issue comment` / `gh pr view` / `gh pr create` / `gh pr comment` / `gh pr checks`
- 検証（`utils/codexTaskOps.js` の `parseTaskCommand`）:
  - オプションは操作ごとの許可リストだけ。未知のオプション（`--output`・`--ext-diff`・`--body-file`・`--repo`・`--web`・`--amend` など）は拒否
  - パスはリポジトリ内の相対パスだけ（絶対パス・`..`・`.git`・pathspec の特殊記法は拒否）。リビジョンは英数字と `._/@^~{}-` のみ
  - `gh pr create` は `--head <ブランチ名>`・`--title`・`--body` が必須（`--head` を省くと gh が現在のブランチを push するため）。`owner:branch` 形式は拒否
  - gh の対象リポジトリは作業フォルダの `origin` に任せ、`--repo` は受け付けない。`origin` が github.com でなければ拒否
  - 作業フォルダが Git 管理下で、ホームや `/` そのものでなければ実行する。`GIT_*`（作者情報を除く）・`GH_REPO`・`GH_HOST`・`PAGER` などの環境変数は取り除いて実行する
  - git は `--no-pager`・`core.fsmonitor=false` を付け、diff / show / log は `--no-ext-diff --no-textconv` を付ける
- 含めないもの: `git push`、`git reset`、`gh api`、`gh pr merge`、任意のシェル。
- 入口を通さない `git` / `gh` は sandbox の制限内（ネットワーク無し）で動く。入口の実行は `node` が PATH にあることが前提で、無ければ入口が動かないだけで権限は広がらない。
- `git commit` が起動するリポジトリのフック（pre-commit など）は sandbox の外で動く点を許容している。信頼できないリポジトリでは使わないこと。

### ファイルシステムの検証

- 親フォルダ（データフォルダ・`codex-task-policy`・preset・起動ごとのフォルダ・`rules`）は、毎回「シンボリックリンクでない実体」「自分の所有」を確認する。専用側のフォルダは 0700 でなければ開いたフォルダ自体に対して 0700 へ直し、直せなければ拒否する。
- ファイルは排他的作成（既にあれば失敗）・リンク非追跡（`O_EXCL | O_NOFOLLOW`）・0600 で作る。専用フォルダは毎回新規なので、固定ファイル名の位置に事前配置されたリンクやファイルを再利用する経路が無い。一時ファイルは使わない。
- 書き込み後に、通常ファイル・0600・自分の所有・リンクカウント 1・中身が期待どおり、を確認する。
- 個人の `auth.json` は、通常ファイル（リンクなら最終的な実体が通常ファイル）かつ自分の所有のときだけ共有する。無ければ共有しない（新規のフォルダなので古い `auth.json` も残らない）。ディレクトリやリンク切れなら拒否する。
- 30 日より古い起動ごとの専用フォルダ（名前・種別・所有者が条件に合うものだけ）は、起動時に掃除する。

## 固定できないときは止める

次のいずれかなら `503 {"error":"codex task policy unavailable: <理由>"}` を返し、Codex を起動しない（承認方針だけを `never` にした起動にもしない）。

- 専用フォルダを作れない・書き込めない
- 親フォルダや専用フォルダがシンボリックリンクなど通常のフォルダではない、または他人の所有・権限を 0700 にできない
- 書き込み後に読み戻した内容・一覧が許可した生成物と一致しない（余計なファイルがある）
- 個人の `auth.json` が通常ファイルでない・他人の所有・リンク切れ
- ディレクトリのパスに制御文字・シングルクォートが含まれる、または絶対パスでない

起動コマンドの組み立て（`renderer/claudeModel.js` の `buildCodexLaunchCommand`）にも最終防衛線があり、ポリシー指定があるのに専用フォルダが無い・不正な場合は例外で止める。

### 事前確認と本番の食い違い

`POST /api/new-pane` は受付時に事前確認（専用フォルダを作らず、親フォルダと引き継ぎ先の検証だけ。`dryRun`）を行い、その後ペイン作成（`terminal:create`）側で専用フォルダを作る。この間に状態が変わって本番だけが失敗しうるため、`terminal:create` は **PTY を作る前に**起動オプションの解決と起動コマンドの組み立てを済ませ、失敗したら例外で返す。失敗は renderer から HTTP の `500` として呼び出し元へ伝わり、Codex が起動していないペインを成功として返さない。PTY を作る前なので、破棄すべき PTY・管理状態は残らない。

## 新規作成と再起動で同じ実効ポリシーにする

新規ペイン作成（`terminal:create`）と再起動（`restart-agent`）は、どちらも `resolveCodexTaskPolicyLaunchOptions` を通して「検証 → 専用フォルダの用意 → 起動オプションへの変換」を行う。専用フォルダは起動のたびに固定内容で新規に作るので、再起動を繰り返しても権限は広がらず、失われもしない（会話の履歴は起動ごとの専用フォルダに残り、再起動後の Codex には引き継がれない）。
再起動のリクエストに `codexPolicy` を付けなかった場合は、前回のポリシーを引き継がず、ポリシー無しの Codex として起動する。ポリシーを維持したい呼び出し側は、再起動のたびに同じ `codexPolicy` を送ること。

## 利用者個人の設定との関係

- 個人の `config.toml` は読まず、変更もしない（テストで内容のハッシュ不変を確認）。
- 専用 `CODEX_HOME` を使うため、個人設定の `model` なども効かない。モデルは `model` で指定する。
- 会話の履歴は起動ごとの専用フォルダ側に保存されるため、個人の `codex resume` 一覧には出ない。

## 既知の制約

- 管理者配布の設定（managed config / requirements）は Codex 自体が最優先で適用する。VK Terminals からは無効化できない（制限を強める方向にしか働かない）。
- VK Terminals と vk-orchestrator が別マシンでも、専用フォルダは「実際に Codex を起動する側」の VK Terminals が生成するため、同じポリシーが適用される。
- rules の `allow` が sandbox の外で動く挙動は Codex の仕様に依存する。この環境（Codex 0.162.1）で `codex execpolicy check` により、入口の実行だけが `allow` になり `git` / `gh` の直接実行は一致しないことを確認する（入口の引数の検証は `tests/codexTaskOps.test.js`）。実際の GUI での標準工程の通しの確認は vk-orchestrator#592 の手順で行う。
