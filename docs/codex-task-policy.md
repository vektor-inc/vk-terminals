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

1. VK Terminals が preset ごとの固定内容の専用 `CODEX_HOME`（`~/.vk-terminals/codex-task-policy/<preset>/`）を生成する（実装: `utils/codexTaskPolicy.js`）。
2. その Codex の起動だけ、`CODEX_HOME='<専用フォルダ>' codex --no-daemon …` のように環境変数を前置する。ペインのシェルへ書き込む文字列は、固定の実行ファイル名と検証済みの許可値だけで組み立てる。
3. 専用フォルダの中身は次の 3 つだけ。
   - `config.toml`: `sandbox_mode = "workspace-write"`、`network_access = false`、`web_search = "disabled"`、追加の書き込み先は会話整理の引き継ぎ先 `~/.claude/handoff` のみ
   - `rules/vk-terminals-task.rules`: 承認なしで実行してよい固定の Git / GitHub 入口（下記）
   - `auth.json`: 個人の `auth.json` へのシンボリックリンク（ログイン状態を引き継ぐためだけ。個人の設定ファイルは共有しない）
4. `--ask-for-approval` と `--sandbox` は従来どおりコマンドライン引数で渡す。`sandboxMode` を省略してもポリシー付きなら `workspace-write` を明示する。

### 判断: `-c`（設定上書き）や `-p`（プロファイル）を使わない理由

- `-c` は指定したキーしか上書きできない。個人設定にある `writable_roots`・`network_access`・`profile`・`default_permissions` などを 1 つずつ打ち消す必要があり、Codex の更新で設定キーが増えると抜けが出る。
- `-p` は「個人設定の上に重ねる」仕組みで、個人設定を無効にできない。
- 固定の許可コマンド（rules）は `CODEX_HOME/rules/` からしか読み込めず、`-c` では渡せない。専用 `CODEX_HOME` なら設定・rules・hooks・`AGENTS.md`・信頼済みプロジェクトの記録がすべて固定内容になる。

### 承認なしで実行できる固定の入口

`ORCHESTRATED_TASK_ALLOWED_COMMANDS`（`utils/codexTaskPolicy.js`）で、argv の先頭一致で判定される。

- `git status` / `git diff` / `git log` / `git show` / `git add` / `git commit`
- `gh issue view` / `gh issue comment` / `gh pr view` / `gh pr create` / `gh pr comment` / `gh pr checks`

含めないもの: `git push`、`git reset`、`gh api`、`gh pr merge`、任意のシェル。`git -c … commit` のように先頭がずれる呼び出しも一致しない。
一致したコマンドは Codex の sandbox の外で承認なしに動く。そのため `git commit` が起動するリポジトリのフック（pre-commit など）も sandbox の外で動く点を許容している。信頼できないリポジトリでは使わないこと。

## 固定できないときは止める

次のいずれかなら `503 {"error":"codex task policy unavailable: <理由>"}` を返し、Codex を起動しない（承認方針だけを `never` にした起動にもしない）。

- 専用フォルダを作れない・書き込めない
- 専用フォルダがシンボリックリンクなど通常のフォルダではない
- 書き込み後に読み戻した内容が固定内容と一致しない
- ディレクトリのパスに制御文字・シングルクォートが含まれる、または絶対パスでない

起動コマンドの組み立て（`renderer/claudeModel.js` の `buildCodexLaunchCommand`）にも最終防衛線があり、ポリシー指定があるのに専用フォルダが無い・不正な場合は例外で止める。

## 新規作成と再起動で同じ実効ポリシーにする

新規ペイン作成（`terminal:create`）と再起動（`restart-agent`）は、どちらも `resolveCodexTaskPolicyLaunchOptions` を通して「検証 → 専用フォルダの用意 → 起動オプションへの変換」を行う。生成物は毎回固定内容へ戻す（改ざん・余計な rules は削除）ので、再起動を繰り返しても権限は広がらず、失われもしない。
再起動のリクエストに `codexPolicy` を付けなかった場合は、前回のポリシーを引き継がず、ポリシー無しの Codex として起動する。ポリシーを維持したい呼び出し側は、再起動のたびに同じ `codexPolicy` を送ること。

## 利用者個人の設定との関係

- 個人の `config.toml` は読まず、変更もしない（テストで内容のハッシュ不変を確認）。
- 専用 `CODEX_HOME` を使うため、個人設定の `model` なども効かない。モデルは `model` で指定する。
- 会話の履歴は専用フォルダ側に保存されるため、個人の `codex resume` 一覧には出ない。

## 既知の制約

- 管理者配布の設定（managed config / requirements）は Codex 自体が最優先で適用する。VK Terminals からは無効化できない（制限を強める方向にしか働かない）。
- VK Terminals と vk-orchestrator が別マシンでも、専用フォルダは「実際に Codex を起動する側」の VK Terminals が生成するため、同じポリシーが適用される。
- rules の `allow` が sandbox の外で動く挙動は Codex の仕様に依存する。この環境（Codex 0.162.1）で `codex execpolicy check` により、許可コマンドだけが `allow` になり `git push` / `gh api` は一致しないことを確認した。実際の GUI での標準工程の通しの確認は vk-orchestrator#592 の手順で行う。
