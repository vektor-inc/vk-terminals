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
3. 専用フォルダの中身は次の 10 個だけ（`codex` が見つかった場合。見つからなければ末尾の `member` / `member-runs` を除く 8 つ）。作った直後に一覧を検証し、これ以外があれば Codex を起動しない。
   - `config.toml`: `sandbox_mode = "workspace-write"`、`network_access = false`、`web_search = "disabled"`、追加の書き込み先は会話整理の引き継ぎ先 `~/.claude/handoff` と、メンバー起動の入出力フォルダ（下記「メンバー起動」。`codex` が見つかった場合だけ）。拘束するリポジトリと作業フォルダ（実パス）は `[projects."<パス>"] trust_level = "untrusted"` で記録する（下記「リポジトリ側の `.codex` で広げられない」）。Codex が起動するコマンドへ `LD_*`・`DYLD_*`・`NODE_*`・`BASH_ENV`・`ENV`・`GIT_*`・`GH_*`・`GITHUB_*` の環境変数を渡さない設定（`shell_environment_policy.exclude`）も入る
   - `rules/vk-terminals-task.rules`: 承認なしで実行してよいもの。信頼済みランチャー 1 つ（`<専用フォルダ>/vk-task-ops`）の実行だけ
   - `vk-task-ops`: 信頼済みランチャー（0500 の `sh` スクリプト）。下記
   - `vk-task-ops.js`: 承認なしの Git / GitHub 操作の入口（`utils/codexTaskOps.js` の複製。0400）
   - `gitconfig`: Git の global 設定の代わりに使う、author 情報（`user.name` / `user.email`）だけの設定。利用者の global 設定から読み取った値のみで、外部コマンドを起動する設定は持たない
   - `gh/`: gh 専用の設定フォルダ（0700）。固定内容の `config.yml`（通信設定・ブラウザ・エディタ・alias を持たない）と、個人の `hosts.yml` から github.com のユーザー名とトークンだけを再生成した `hosts.yml`（0600。個人側に無い・読み取れる認証項目が無ければ作らない）だけが入る。個人の `~/.config/gh` は読み込まず、通信設定や他のホストは引き継がない
   - `AGENTS.md`: 入口の使い方の案内（Codex がこの入口を知るための固定文）
   - `auth.json`: 個人の `auth.json`（最終的な実体）へのシンボリックリンク（ログイン状態を引き継ぐためだけ。個人の設定ファイルは共有しない）。個人側に無ければ作らない
   - `member/`: メンバー起動の子の Codex 用の `CODEX_HOME`（0700）。親と同じ作り方で、上の 8 つ（`member/` 自身を除く）が入る。親との違いは「`member` 操作を持たない」「承認を求めない（`approval_policy = "never"`）」の 2 点だけ。下記「メンバー起動」
   - `member-runs/`: メンバー起動の実行の記録（終了コード・ログ）の置き場（0700。作った時点では空）。子の書き込み範囲に入れない
4. `--ask-for-approval` と `--sandbox` は従来どおりコマンドライン引数で渡す。`sandboxMode` を省略してもポリシー付きなら `workspace-write` を明示する。

### 判断: `-c`（設定上書き）や `-p`（プロファイル）を使わない理由

- `-c` は指定したキーしか上書きできない。個人設定にある `writable_roots`・`network_access`・`profile`・`default_permissions` などを 1 つずつ打ち消す必要があり、Codex の更新で設定キーが増えると抜けが出る。
- `-p` は「個人設定の上に重ねる」仕組みで、個人設定を無効にできない。
- 固定の許可コマンド（rules）は `CODEX_HOME/rules/` からしか読み込めず、`-c` では渡せない。起動ごとに新規の専用 `CODEX_HOME` なら設定・rules・hooks・`AGENTS.md`・信頼済みプロジェクトの記録がすべて固定内容になる。

### リポジトリ側の `.codex` で広げられない

専用 `CODEX_HOME` を使っても、作業フォルダのリポジトリに `.codex/config.toml`（や `rules`・`hooks`）が置かれていると、Codex は**信頼済みのプロジェクトに限り**これを実効設定へ重ねる（`network_access = true` や `writable_roots`、`sandbox_mode` を広げられる）。この環境（Codex 0.162.1）で次を確認した。

- 信頼の記録が無いプロジェクトは、起動時に「Trust this folder?」（選択肢は「Trust and continue」と「Quit」）が出る。Enter 1 回で「信頼済み」が `config.toml` に保存され、プロジェクト側の設定が効く。
- `trust_level = "untrusted"` を記録したプロジェクトは、プロジェクト側の config・hooks・execpolicies が無効のまま。画面は「Open restricted」（既定）で、Enter を押しても信頼の記録は変わらない。
- 「信頼しない」の記録は Git ルートに置けばサブフォルダ・worktree にも効く。作業フォルダ自体も記録している。

そのため `config.toml` には、拘束するリポジトリの Git ルートと作業フォルダ（どちらも実パス。同じなら 1 件）を `untrusted` で必ず書く。新規作成と再起動は同じ関数を通るので、どちらも同じ記録になる。「Open restricted」の画面は信頼を与えないため、自動 Enter（`utils/trustPromptGate.js`）の対象にしている。「Trust and continue」の画面は従来どおり対象外。安全に記録できない（パスが不正など）ときは Codex を起動しない。プロジェクト側の `AGENTS.md` や skills は読まれるが、権限（sandbox・承認・rules）は広がらない。

### 承認なしで実行できる固定の入口

rules の `prefix_rule` は先頭の単語列しか指定できず、後ろに続く引数や実行時の環境を制限できない。`git diff` を許可すると `--output=<任意のファイル>` で任意の場所へ書き込め、`gh pr create` を許可すると暗黙の push が起きる。`node` を許可すると `NODE_OPTIONS` などの環境変数で検証の前に別のコードを実行できる。そのため `git` / `gh` / `node` 自体は rules で許可せず、**信頼済みランチャー 1 つだけ**を許可する。

- 呼び方: `'<専用フォルダ>/vk-task-ops' <git|gh|prepare|member> <操作> …`（AGENTS.md に書いてある）
- ランチャーは Node を起動する前に `env -i` で環境を空にし、起動時に確定した値（拘束するリポジトリ・git / gh / Node の絶対パス・固定した HOME）だけを渡して、絶対パスの Node で入口を実行する。ランチャーは起動ごとに専用フォルダへ書かれ、Codex からは書き換えられない（0500・所有者のみ）
- 許可する操作: `git status` / `git diff` / `git log` / `git show` / `git add` / `git commit` / `git push <ブランチ名>`、`prepare worktree <base> <issue番号> <ブランチ> <worktree名>`、`member start …` / `member status <実行ID>`、`gh issue view` / `gh issue comment` / `gh pr view` / `gh pr create` / `gh pr comment` / `gh pr checks`
- 引数の検証（`utils/codexTaskOps.js` の `parseTaskCommand`）:
  - オプションは操作ごとの許可リストだけ。未知のオプション（`--output`・`--ext-diff`・`--body-file`・`--repo`・`--web`・`--amend` など）は拒否
  - パスはリポジトリ内の相対パスだけ（絶対パス・`..`・`.git`・pathspec の特殊記法は拒否）。リビジョンは英数字と `._/@^~{}-` のみ
  - `gh pr create` は `--head <ブランチ名>`・`--title`・`--body` が必須（`--head` を省くと gh が現在のブランチを push するため）。`owner:branch` 形式は拒否。`gh pr view` / `gh pr checks` は PR 番号が必須（`--repo` を付けるため現在のブランチから PR を推測できない）
- 実行ファイルと環境の固定:
  - `node` / `git` / `gh` は PATH を使わず、起動時に固定の探索先（`/opt/homebrew/bin`・`/usr/local/bin`・`/usr/bin`・`/bin`・`~/.volta/bin`、およびアプリ自身の `PATH` にある絶対パス）から、所有者（自分か root）・他人が書き込めない権限・祖先フォルダの安全性を検証した絶対パスだけを選ぶ。見つからなければ起動しない。入口も実行のたびに git / gh を再検証する
  - git / gh の子プロセスの環境変数は許可リストで一から組み立てる（`PATH`・`HOME`・`XDG_CONFIG_HOME`・`GH_CONFIG_DIR`（いずれも専用の `gh/` を指す）と、Git の設定隔離・非対話の指定のみ）。親の `NODE_OPTIONS`・`LD_PRELOAD`・`GIT_*`・`GH_*` などは引き継がない
  - Git の system / global 設定は使わない。global 設定の代わりに、ランチャーが生成した author 情報だけの設定ファイルを指す。リポジトリ内の設定に外部コマンドを起動しうる項目（clean/smudge/process filter・`diff.external`・textconv・`merge.*.driver`・`gpg.*.program`・`core.sshCommand`・`core.askPass`・`core.editor`・`core.pager`・`credential.*.helper`・`include`・`includeIf` など）があるリポジトリでは、閲覧系も `git add` / `git commit` も実行を拒否する
  - git には `core.fsmonitor=false`・`core.hooksPath=/dev/null`・`maintenance.auto=false`・`gc.auto=0`・`commit.gpgsign=false`・`tag.gpgsign=false` をコマンドラインで指定する。`maintenance.auto` と `gc.auto` は、commit の後に走る自動保守（`maintenance run --auto` → `gc --auto`）が `gc.recentObjectsHook` で外部コマンドを起動する経路を止めるもの（どちらか片方でも止まるが、経路が別なので両方指定する）。`gc.recentObjectsHook`・`core.alternateRefsCommand`・`uploadpack.packObjectsHook` がリポジトリの設定にあれば、入口は実行を拒否する。**リポジトリのフック（pre-commit など）は入口経由の commit では実行されない**。diff / show / log は `--no-ext-diff --no-textconv` も付ける
- リポジトリへの拘束:
  - 起動時に、`cwd` から Git の実ルートと `origin` の GitHub の `owner/repo` を確定し、ランチャーに固定する（実行中は変更できない）。確定できないとき（Git 管理下でない・ホームや `/` そのもの・外部コマンドを起動しうる設定がある）は起動を拒否する。`origin` が github.com でない場合は owner/repo を固定せず、gh 系の操作だけを拒否する（git の操作は使える）
  - 実行のたびに、作業フォルダの Git ルートが固定したルートと一致することを確認する。一致しない場合でも、作業フォルダの Git 管理領域（`git rev-parse --git-common-dir`。全 worktree が共有する）の実パスが、固定したルートの Git 管理領域の実パスと同じなら、拘束先の worktree（`git worktree add` で作った作業フォルダ。拘束先の内側でも外側でもよい）として受け入れる。受け入れには、さらに次の両方を求める。(1) 作業フォルダの実 gitdir（`git rev-parse --git-dir`）が、固定したルートの Git 管理領域の `worktrees/` の直下にある（`.git` ファイルが任意の場所を指す偽装を除く）。(2) その gitdir の `gitdir` ファイル（逆参照）が、検査対象のルートの `.git` ファイルを指す（登録済み worktree の `.git` ファイルを別フォルダへ複製した場合、`.git` がリンクの場合を除く）。逆参照ファイルは、通常ファイル・リンクでない・自分か root の所有のときだけ読み、読めなければ拒否する。別のリポジトリ・入れ子のリポジトリ・同じ `origin` を持つだけの別クローンは Git 管理領域が異なるため拒否する。固定したルート側の Git 管理領域は起動時に固定せず、実行のたびに固定したルートから求め直す（ランチャーに渡す値を増やさない）。外部コマンドを起動しうる設定などの検査は、worktree 側の作業フォルダで従来どおり行う
  - gh を使う操作では `origin` が固定した `owner/repo` と一致することを確認する（worktree でも同じ）
  - `git commit` は、実行前に現在のブランチを調べ、`main` / `master`、およびリモートの既定ブランチ（`refs/remotes/origin/HEAD` が指す先。無ければ判定に使わない。同名のタグがあっても取り違えないよう、`refs/heads/main` のような完全名で比較する）、ブランチに属さない状態（detached HEAD）では拒否する。拘束先・worktree のどちらにも適用する。作業ブランチを作ってから commit する。`git push` の判定は下記
  - 会話整理後の再起動でも拘束は起動時の `cwd`（通常のクローン）から決まるため、worktree で始めた作業は再起動後も同じ worktree で続けられる
  - gh には検証済みの `--repo <owner/repo>` を必ず付ける。利用者・Codex が `--repo` を指定する経路は無い
  - 新規作成と再起動のどちらも、同じ関数で拘束する
- 含めないもの: 強制上書きを伴う push、ブランチ削除、タグの送信、`git reset`、`gh api`、`gh pr merge`、任意のシェル、メンバー（子の AI）の起動（別 PR。vektor-inc/vk-terminals#438）。
- `git push <ブランチ名>`（issue #440。仕様の決定は vektor-inc/vk-terminals#438 の方式 A）:
  - 受け付ける形はブランチ名 1 つだけ。リモート名・オプション（`--force` / `--force-with-lease` / `--delete` / `--mirror` / `--tags` / `--all` / `--prune` / `-u` など）・複数指定・`+` や `:` を含む指定（任意の refspec）・`refs/` で始まる指定・`main` / `master` / `HEAD` は、パースの段階で拒否する
  - 送り先は origin の設定値を使わない。入口が、拘束した owner/repo から `https://github.com/<owner>/<repo>.git` を組み立てて渡し、送る内容も `refs/heads/<b>:refs/heads/<b>` に固定する。`+` の無い refspec なので、新規作成と早送りだけが通り、履歴を書き換えた push はリモートが拒否する（強制はしない）。`--no-verify --no-follow-tags --no-recurse-submodules --no-signed` も付ける。フックは `core.hooksPath=/dev/null` で止まるので pre-push は動かない
  - 実行時の拒否: 存在しないローカルブランチ、detached HEAD、`main` / `master`・`refs/remotes/origin/HEAD` が指す先に加えて、リモートの既定ブランチ（push の前に `git ls-remote --symref <固定 URL> HEAD` で確定する。通信に失敗した・symref が取れなかった・ブランチを指していないときは `remote default branch could not be verified` で拒否し、push は実行しない。確定できたときだけ比較して push する）。拘束先・worktree の判定と origin の照合は、他の gh 系の操作と同じ 2 段階の判定に乗る（別のリポジトリ・同じ origin を持つ別クローン・入れ子のリポジトリは拒否）
  - 通信の前に、接続先や経路を書き換えうる設定（`url.<base>.insteadOf` / `pushInsteadOf`、`http.*`（プロキシ・`extraHeader`・`sslVerify` など）、`remote.<name>.proxy` / `pushurl` / `receivepack` / `uploadpack`、`push.gpgSign` / `push.recurseSubmodules`）がリポジトリにあれば拒否する（資格情報の送り先をすり替えられないようにするため。閲覧系・add・commit には影響しない）
  - 資格情報: `-c credential.helper=` と `-c credential.https://github.com.helper=` で既存の指定を空にしたうえで、`-c credential.https://github.com.helper=!'<検証済みの gh>' auth git-credential` だけを指定する。gh は専用の `gh/hosts.yml` の認証だけを使う（`GH_CONFIG_DIR` を固定）。リポジトリ内の credential helper の設定は、そもそも設定の検査で拒否する。SSH の remote は使えず、HTTPS に固定する。gh が使えないとき（`gh` が見つからない）は拒否する
  - 通信する git だけ、環境変数 `GIT_ALLOW_PROTOCOL` を `https` に限る（通信しない操作は従来どおり空 = 全プロトコル不許可）
- `prepare worktree <base> <issue番号> <ブランチ> <worktree名>`（issue #440）:
  - vk-agents の `repo-prepare.sh issue-worktree` は呼ばない。対象が vk-agents 自身のとき、サンドボックス内の Codex がスクリプトを書き換えてから囲いの外で実行できてしまうため、同等の処理を `utils/codexTaskOps.js` の中に作り直した。owner/repo は引数に取らない（拘束済み）
  - パースの段階の拒否: 引数が 4 つでない、`base` / ブランチが `isSafeBranchName` を満たさない（`..`・`:`・`+`・先頭 `-`・`refs/` など）、issue 番号が数字 1〜9 桁でない（0 も不可）、ブランチ名が `<種類>/<issue番号>-...`（`/<issue番号>-` を含む）でない、ブランチが base と同じ・`main` / `master` / `HEAD`、worktree 名が英数字とハイフン（先頭は英数字、100 文字まで）でない（`/`・`..`・絶対パスは不可）
  - 実行時の拒否: 拘束先のリポジトリのルートそのもので実行していない（worktree の中・サブフォルダは不可。別のリポジトリ・同じ origin を持つ別クローンも不可）、origin が拘束した owner/repo と違う、接続先を書き換えうる設定がある、`.claude` / `.claude/worktrees` がリンクまたはフォルダでない、同名のパスがある、同名のローカルブランチがある、base を取得できない
  - 処理: 固定 URL からの `git fetch --no-tags --no-recurse-submodules --refmap= <固定 URL> +refs/heads/<base>:refs/remotes/origin/<base>`（資格情報の指定は push と同じ）→ `info/exclude` へ `/.claude/worktrees/<名前>/` を 1 行追加（共有の `.gitignore` は変えない。`info/exclude` はリポジトリの Git 管理領域の中であること・リンクでないことを確認する）→ `git branch --no-track <ブランチ> refs/remotes/origin/<base>`（作業ブランチの作成。別プロセス）→ `git worktree add --quiet --no-checkout <拘束ルート>/.claude/worktrees/<名前> <ブランチ>`（`-b` は使わず、作成済みのブランチを指定する）。通常のクローンのブランチ切り替えと、未コミット変更への操作は行わない
  - 書き込み先の制限: 書き込みを伴う処理は、Node 自身のファイル書き込みを含めてすべて、OS のファイルシステム制限（macOS の `/usr/bin/sandbox-exec`）の中の子プロセスで行う。制限は書き込みの時点でリンクを解決した後の実パスに対して判定されるため、事前の検査（拒否理由を分かりやすくするためのもの）と実行の間にパスが差し替えられても、許可した場所の外には書けない。段階ごとに書ける場所を必要最小限に分ける（Git 管理領域全体は許さない）。(1) Git 管理領域の置き場所の作成: ref・ログ・worktree 管理情報の親フォルダのうち、まだ存在しないものだけ（既存のフォルダの中身には書き込みを許さない）。(2) fetch: 取得したオブジェクト、取得先の 1 本の追跡 ref・ログとそれぞれのロックファイル（`refs/remotes` などの階層全体は許さない）、gh の専用設定フォルダ。gh の設定フォルダへ書く必要があるかは実機で未確認のため、念のため許可している。(3) 除外設定の追記: `info/exclude` ファイル 1 つだけ（`info` フォルダが無い場合の作成は、(1) と同じく存在しないフォルダだけ）。(4) 作成先の親フォルダの作成: `.claude` と `.claude/worktrees` のうち、まだ存在しないものだけ（既存のフォルダには書き込みを許さず、全部存在すれば実行しない）。(5) 作業ブランチの作成（`git branch`）: そのブランチの ref・ログとそれぞれのロックファイルの 4 ファイルだけ。(6) worktree の管理情報の作成（`worktree add --no-checkout`）: この worktree 自身の管理情報と、作成先の事前に計算した実パスだけ。ref・ログの階層（`refs/heads` など）には一切書けないので、この段階の失敗時の後片付けで既存ブランチの記録を消すことはできない。(7) index の作成（`read-tree --reset HEAD`。管理領域と作業フォルダは引数で明示し、作業ファイルには触れない）: この worktree 自身の管理情報だけ。(8) 作業ファイルの展開（`checkout-index --all --force`。別プロセス）: 作成先の実パスだけで、展開プロセスには管理領域を一切許可しない。ブランチの作成と worktree の追加を別プロセスに分けているため、worktree の追加は ref・ログの階層に書き込めず、その段階の失敗時の後片付けで既存ブランチの記録を消すことはできない。ブランチの作成のあとに worktree の追加が失敗した場合は、作業ブランチが残り、同じ引数の再実行は「working branch already exists」で拒否される（自動削除は現状していない）。どの段階でも、Git の制御ファイル（`hooks` / `config` / `config.worktree` / `info/attributes` / `objects/info` 配下など）には書けない。`sandbox-exec` が無い・信頼検証を通らない環境（現状は macOS 以外）では、prepare は `write-restricted execution is not available` で拒否する（無効化はせず、拒否のまま）
  - 標準出力に `TARGET_REPO=<worktree の絶対パス>` / `WORK_BRANCH=<ブランチ>` / `BASE_SHA=<取得した base の SHA>` を返す。作った worktree は拘束先の worktree として受け入れ判定を通り、そのまま add・commit・push できる
- `member start --engine codex --prompt <名前> --schema <名前> --out <名前> [--model <名前>] [--readonly]` / `member status <実行ID>`（メンバー起動。issue #441。仕様の決定は vektor-inc/vk-terminals#438 の「メンバー起動」。今回は Codex だけに対応し、Claude Code は別対応）:
  - 目的: 自動処理の作業ペインの Codex（親）が、レビュアーなどのメンバーを子の Codex として起動する。vk-agents の `run-member-agent.sh` はそのまま通さない。`--dangerously-bypass-approvals-and-sandbox` で囲いを外して起動でき、`--repo` で別リポジトリも指定できるため、通すと「任意の指示を囲いの外で別リポジトリにも実行できる」経路になる。囲いの中の親が `codex exec` を入れ子で起動すると `Operation not permitted` になる（推測。未検証）ため、入口経由で囲いの外から起動する
  - 安全の条件は「子の囲いが親の範囲を超えない」こと。親も任意の指示で動く AI なので、子が同じ制限の中で動く限り、できることは増えない
  - 子の起動引数（`buildMemberCodexArgs`）: `codex -a never exec -C <親の起動 cwd（VK_TASK_PARENT_CWD の実パス）> -s workspace-write --color never --output-schema <実行の記録フォルダ内の写し> -o <実行の記録フォルダ内の結果ファイル> [--model <名前>] -`（プロンプトは標準入力から渡す）。**子の sandbox は親の実効 sandbox を超えない**: 親の起動引数 `--sandbox` の値（省略時は `workspace-write`）をランチャーの固定値 `VK_TASK_PARENT_SANDBOX` に持ち、親が `read-only` なら、`--readonly` を省略しても常に `-s read-only` にする。`--readonly` が指定されたときも `-s read-only` にする。read-only の子には `--ignore-rules` も付けて入口の許可ルールを読み込ませない（読み取り専用のメンバーが、ランチャー経由の push などの書き込みを使えないようにする）。`--dangerously-bypass-approvals-and-sandbox`・`--full-auto`・`-s` / `-a` / `-c` / `-C` / `--add-dir` / `--profile` などの囲い・作業フォルダに関わる指定は、許可リストに無いので `member start` の引数としては受け付けない。`--engine` は `codex` だけ
  - 作業フォルダ: **子の `-C` と監督プロセスの cwd は、常に親の起動 cwd（ランチャーが実パスで固定した `VK_TASK_PARENT_CWD`）そのもの**にする。入口を呼んだ場所は検査にだけ使い、起動には使わない。入口の拘束（拘束先のリポジトリか検証済み worktree であること）を通ったうえで、呼び出し位置（実パス）が親の起動 cwd の配下（または同じ場所）のときだけ起動し、配下の worktree・サブフォルダから呼んだ場合は**親の起動 cwd に読み替えて**起動する。配下でなければ `member start must run inside the parent working directory` で拒否する（親をサブフォルダで起動したときにルートから呼ぶ場合、親の範囲の外に登録された worktree から呼ぶ場合、親が worktree のときにルートから呼ぶ場合）。`--repo` や作業フォルダを指定する引数は無い。読み替えを選んだ理由: 拒否にすると worktree で作業する親が、毎回その worktree へ `cd` してから呼ぶ必要があり使いにくい。一方、呼び出し位置を `-C` に使うと、検査のあとにその配下のフォルダが範囲外へのリンクに置き換えられたとき（親は配下の worktree を変更できる）、子の範囲が親の範囲を超える。検査と使用のあいだに競合が生じない固定値を使えば、どちらも満たせる。**どの worktree で作業させるかは、prompt で子へ伝える**（子の書き込み範囲は親の起動 cwd の配下全体なので、worktree のパスを指定すれば、そこで作業できる）。`parentCwd` が実パスでなければ拒否する
  - **メンバー起動を有効にする条件（親の起動準備で判定）**: 親の起動 cwd（実パス）の祖先（cwd 自身を含む）が、親の実効的な書き込み先のどれかの配下か同一のときは、`member` を有効にしない。親が cwd を移動して範囲外へのリンクに置き換えられるため（例: `~/.claude/handoff/repo` を起動 cwd にした場合）、入口が実パスを検査したあとに、子の `-C` と監督プロセスの cwd が置き換え先を解決し直せてしまう。無効にした場合は、子用 `CODEX_HOME`・実行の記録フォルダ・入出力フォルダを作らず、ランチャーの member 設定を空にし、案内にも書かないので、入口の `member` 操作は `member is not available from this launcher` で拒否される（他の操作は使える）。起動の直前に検査し直す方式は採らない。親の実効的な書き込み先は、`config.toml` の `writable_roots` 全部（会話整理の引き継ぎ先・この起動の入出力フォルダ）と、Codex の `workspace-write` が標準で許す一時フォルダ（`/tmp` と `$TMPDIR`）。`/tmp`（macOS では `/private/tmp` へのリンク）などは実パスで比べる。`config.toml` は一時フォルダの除外（`exclude_slash_tmp` / `exclude_tmpdir_env_var`）を設定しておらず、既定で許可されたままなので、判定に含める（設定は追加しない。追加すると親の挙動が変わるため）。判定に使う一時フォルダは `/tmp` と、VK Terminals 自身の `$TMPDIR`（絶対パスで安全な文字だけのときはその実パス、そうでなければ `/tmp` の実パス）で、親 Codex の起動コマンドには、この判定に使った実パスを `TMPDIR='<実パス>'` として `CODEX_HOME` と一緒に固定して渡す（判定に使う値と親へ渡す値は同じ1つの値から作る）。そのため、PTY のシェルの設定で別の `TMPDIR` を受け取って判定をすり抜けることはない（新規作成・再起動の両方。`orchestrated-task` の Codex だけで、ほかの起動は変えない）。配下判定は `..repo` のように `..` で始まる普通のフォルダ名も配下として扱い、親（`..`）だけを範囲外とする。テストでは、一時フォルダ配下に作業フォルダを置くため `tmpRoots` で差し替える。ルートの cwd に固定する値 `VK_TASK_PARENT_CWD` の判定は、上記「作業フォルダ」のとおり変わらない
  - 子の書き込み範囲は親と同じか、それより狭い: 子の書き込み範囲は「子の作業フォルダ（`-C`）+ `config.toml` の `writable_roots`（会話整理の引き継ぎ先と入出力フォルダ）」で、`writable_roots` は親と同一（子用 `CODEX_HOME`（`member/`）の `config.toml` は、親と同じ内容から `approval_policy` だけを `"never"` にしたもの。実機の Codex で、実効設定が親と同じ sandbox・ネットワーク・書き込み先になることをテストで確認する）。作業フォルダは上記のとおり親の起動 cwd そのものなので、子の範囲は親の範囲と一致する（超えない）。親をルートで起動していれば、後から `prepare worktree` で作る worktree（拘束ルート配下の `.claude/worktrees/<名前>`）は親の作業フォルダの配下なので、子の書き込み範囲に入っており、prompt でその worktree を指定すれば子はそこで作業できる（Codex の `workspace-write` は起動した作業フォルダの配下全体に書ける。テスト: `tests/codexTaskOps.test.js` の「親の書き込み範囲を超えない」）。親を worktree で起動した場合は、その worktree だけが範囲になる
  - 子用ランチャー（`member/vk-task-ops`）は `VK_TASK_CODEX` / `VK_TASK_MEMBER_HOME` / `VK_TASK_MEMBER_IO` / `VK_TASK_MEMBER_RUNS` / `VK_TASK_PARENT_CWD` / `VK_TASK_PARENT_SANDBOX` を空にして書かれるため、`member` 操作は `member is not available from this launcher` で拒否される（入れ子の起動を防ぐ）。子の rules は子用ランチャーの実行だけを許可する。他の操作（`git` / `gh` / `prepare`）は親と同じ拘束先で使える。親のランチャーでは、この 6 つが一部だけ設定されている・値が不正（絶対パスでない、sandbox が `read-only` / `workspace-write` 以外）な束縛は、全体を不正として拒否する
  - `codex` の実行ファイルも、`git` / `gh` と同じ所有者・権限の検証（`resolveTrustedExecutableDetailed`）で選び、起動前に入口が再検証する。見つからなければ、メンバー起動だけを持たない（`member` / `member-runs` / 入出力フォルダを作らず、案内にも書かない）
  - 入出力ファイル: 起動ごとの専用フォルダ `~/.vk-terminals/codex-task-io/<ランダム名>/`（0700。親の専用 `CODEX_HOME` と同じランダム名）の直下の名前だけを受ける。`--prompt` / `--schema` は親が作った既存のファイル、`--out` は存在しない名前で、3 つとも別の名前。名前は英数字で始まり、英数字・`.`・`_`・`-` だけ・100 文字まで（絶対パス・`/`・`..`・先頭 `.`・サブフォルダは不可）。入口は、入力をリンクをたどらずに開き、通常ファイル・自分の所有・他に実体の参照が無い（nlink = 1）・サイズ上限内（プロンプト 1 MiB、スキーマ 256 KiB・JSON として読める）を確かめ、**内容を実行の記録フォルダへ写し取って**そこから子に渡す（検証後に、子から書き換えられる場所を開き直さない）。**出力は、入口が先に排他的作成（`O_EXCL | O_NOFOLLOW`）で開いた記述子を、監督プロセスが保持して書く**: 子の Codex の `-o` は入出力フォルダではなく、子から書き換えられない実行の記録フォルダ内の結果ファイルを指し、子の終了後に監督プロセスが結果を（リンクをたどらずに開いて）保持した記述子へコピーする。入出力フォルダ内の名前は作成後に一度も開き直さないので、子がその名前をリンクに差し替えても、外部のファイルや他の実行の終了記録は書き換わらない（差し替えた場合、親が見る名前の先は空のまま・または差し替えた先になる。それは親の側の問題で、他の領域には及ばない）。`member status` と終了処理が開くのは実行の記録フォルダ内のファイルだけで、入出力フォルダ側のパスは開かない（`OUT` は記録した文字列を表示するだけ）。入出力フォルダは親と子の書き込み範囲に足す。専用フォルダの実パスは、実行のたびに「リンクでない・自分の所有・他人の書き込み不可」を確認する
  - 実行は `start` / `status` に分ける: メンバーの実行は数十分かかることがあり、Codex のツール呼び出しは長い間ひとつのコマンドを待たせ続けることを前提にしていない（根拠は下記「メンバー実行を start / status に分けた根拠」）。`member start` は、入口自身（`process.execPath` で `vk-task-ops.js`）を新しいセッション（`detached`）の**監督プロセス**として起動して、すぐに `MEMBER_ID` / `OUT` / `LOG` を返す。設定（子の起動引数・環境・実行の記録フォルダ）は環境変数 `VK_TASK_MEMBER_SUPERVISE` で渡す（ランチャーは環境を空にして入口を起動するため、親の Codex からこの変数は渡せない。形が不正な設定では何もせず終了する）。監督プロセスは、子の標準入力を写し取ったプロンプトに、標準出力・標準エラーを `member-runs/<実行ID>/log.txt` につないで子を起動し、終了後に結果を公開し、その成否と理由を `member-runs/<実行ID>/result-state` へ書いてから、終了コードを `member-runs/<実行ID>/exit` へ書く（どちらも `.tmp` を作って置き換える。`exit` がある = 公開の成否の記録も終わっている）。結果ファイルが無い・通常ファイルでない・上限（16 MiB）超過・書き込み失敗のいずれでも、成功にはしない。子の終了コードはそのまま残す。`member status <実行ID>` は `STATE=running|exited|lost`・`EXIT_CODE`（終了後）・`RESULT_STATE=published|failed`（終了後。`failed` のときは `RESULT_FAILURE=<理由>`: `result-missing` / `result-not-a-regular-file` / `result-too-large` / `result-write-failed` / `result-state-unrecorded` / `result-state-invalid`。`EXIT_CODE=0` でも `RESULT_STATE=failed` なら結果は使えない）・`OUT`・`LOG` とログの末尾（4 KiB）を返す。`lost` は、終了コードのファイルが無く、記録した pid（監督プロセス）も見つからない場合（異常終了や再起動）。実行の記録フォルダ（`member-runs/`）は子の書き込み範囲に入れないので、子が終了コード・結果・ログを書き換えられない（入出力フォルダとは別の場所）
  - 子の環境変数は一から組み立てる: `PATH`（codex・git・gh のあるフォルダと `/opt/homebrew/bin`・`/usr/local/bin`・`/usr/bin`・`/bin`）・`HOME`（固定した HOME）・`CODEX_HOME`（子用の専用フォルダ）・`NO_COLOR` だけ。親の環境は引き継がない
  - 既知の制約: 同時に起動できる子の数に上限は設けていない（親の Codex も、許可された入口を何度でも呼べるのと同じ）。`member start` で作った実行の記録・入出力フォルダは、親の専用フォルダ・入出力フォルダとともに自動では消さない（「専用フォルダの回収と削除」と同じ理由）。親が worktree を `prepare worktree` で作ったあとに、子へその worktree で作業させる場合、Codex のプロジェクト信頼の記録（`trust_level = "untrusted"`）は親の起動時に確定した拘束ルートと作業フォルダにしか無い。worktree は Git の共通のリポジトリに属するので、Codex は拘束ルートの記録を引くはずだが、実機の長時間実行では未確認
- テスト用の差し替え口: push 先・fetch 元の基点（`https://github.com`）は、ランチャーが固定する値 `VK_TASK_REMOTE_BASE` で決まる。本番のランチャーは常に `https://github.com` を書く。テストだけが `prepareCodexTaskPolicyHome` の `remoteBase` 引数（一時フォルダの絶対パス）で、bare リポジトリを remote にできる。`main.js` と API の入力（`codexPolicy`）からはこの値を渡せない（`codexPolicy` に未知のキーを入れると `400`）。入口は基点が `https://github.com` か安全な絶対パス以外なら拘束の設定を不正として拒否する
- 入口を通さない `git` / `gh` は sandbox の制限内（ネットワーク無し）で動く。
- 認証: gh は専用の `gh/hosts.yml`（個人の `hosts.yml` から引き継いだ github.com のユーザー名・トークン。キーチェーン保管のトークンはユーザー名から引ける）の認証だけを使う。`GH_TOKEN` などの環境変数のトークンは入口へ渡らない。トークンを引き継ぐ場合、専用フォルダ内にトークンの写しが残るため、専用フォルダを消すときに一緒に消える（権限は個人の `hosts.yml` と同じ 0600・所有者のみ）。入口は実行のたびに `gh/` が実体・自分の所有・他人の書き込み不可であることも確認する。
- 既知の制約: 設定の検査から実行までの間にリポジトリの設定が書き換えられる競合は、同じユーザーの別プロセスが書き換える場合に限り残る（実行のたびに検査し直すことで窓を狭めている）。Git LFS など、外部コマンドを起動する filter を使うリポジトリは、安全に固定できないため入口が拒否する。

### メンバー実行を start / status に分けた根拠

issue #441 は「Codex のツール呼び出しのタイムアウトで打ち切られるなら `member start` / `member status` に分ける」としていた。実機で数十分の長時間実行はしていないため、次の確認できた範囲の根拠で、**分ける方を選んだ**（分けておけば、打ち切られる場合も打ち切られない場合も同じ手順で動く。分けない案は、打ち切られた場合に子が途中で止まり、結果が失われる）。

- Codex CLI 0.162.1 の実行ファイルの内蔵文字列に、シェルコマンドの `timeout_ms`（コマンドごとのタイムアウトをモデルが指定する引数）と、既定の設定値 `background_terminal_max_timeout = 300000`（バックグラウンドの端末を待つ 1 回あたりの上限 = 5 分）がある。標準の `codex exec` の既定では、1 回の待ちは最長 5 分で、数十分続く子を 1 回の呼び出しで待たせ続ける前提になっていない
- `exec` ツールには `yield_time_ms` があり、指定時間を過ぎると結果を返して処理を続ける作りで、完了の確認は「あとで状態を見に行く」形になる
- 確かめていないこと: 実際に数十分かかるコマンドを入口経由で動かして打ち切られるかどうか。ここは vk-orchestrator#592 の手順での通し確認に委ねる

### ファイルシステムの検証

- 信頼境界（データフォルダ・会話整理の引き継ぎ先・ホーム・個人の `auth.json` と gh の `hosts.yml`・実行ファイル）は、**realpath ではなく元の絶対パス**を根から 1 階層ずつ辿って検証する。リンクは「所有者が自分か root」であることを確認して向き先を 1 段ずつ解決し、向き先の階層も同じ検証に通す（途中のリンクを置いたフォルダが他人に書ける場合は、リンクを差し替えられるので拒否する）。実行ファイルは Homebrew のようにリンクのまま使うが、node・git・gh・env の全候補で、途中の全てのリンクとフォルダを検証したパスだけを使い、実行のたびに入口が同じ検証を繰り返す。フォルダ（データ・引き継ぎ先・ホーム・`gh/`）は末端自体がリンクなら拒否する。各階層は所有者が自分か root・他人が書き込めない権限（グループ書き込みは root 系の `wheel` と macOS の `admin` のみ許す。他人の書き込み可は、root 所有の sticky フォルダを祖先に持つ場合のみ許す）を求める。リンクの連鎖は 16 段までで、循環は拒否する。無いフォルダは、検証済みの親の下に 1 段ずつ（再帰作成せず）0700 で作り、作成前に書き込める親かどうかを検証する。検証したときの識別子（dev / inode と、リンクの向き先）は、専用フォルダの生成が終わった直後に再確認し、準備の途中で差し替えられていたら拒否して片付ける。
- 専用側のフォルダ（`codex-task-policy`・preset・起動ごとのフォルダ・`rules`）は、毎回「シンボリックリンクでない実体」「自分の所有」を確認し、0700 でなければ開いたフォルダ自体に対して 0700 へ直す。直せなければ拒否する。
- ファイルは排他的作成（既にあれば失敗）・リンク非追跡（`O_EXCL | O_NOFOLLOW`）で作る。権限は通常 0600、入口は 0400、ランチャーは 0500。専用フォルダは毎回新規なので、固定ファイル名の位置に事前配置されたリンクやファイルを再利用する経路が無い。一時ファイルは使わない。
- 書き込み後に、通常ファイル・所定の権限・自分の所有・リンクカウント 1・中身が期待どおり、を確認する。
- 個人の `auth.json` は、通常ファイル（リンクなら最終的な実体が通常ファイル）かつ自分の所有で、元のパスの全階層（リンクの途中を含む）が上記の信頼境界を満たすときだけ共有する。無ければ共有しない（新規のフォルダなので古い `auth.json` も残らない）。ディレクトリやリンク切れ・他人が書き込めるものは拒否する。

### 専用フォルダの回収と削除

- 生成の途中で失敗したときは、その呼び出しで**自分が作った**専用フォルダ（作成時の識別子が一致する実体のフォルダ）だけを片付けてから拒否を返す。事前に置かれていたフォルダ・他の起動のフォルダには触らない。
- 専用フォルダを作ったのに Codex の起動に使わなかった場合（再起動での停止失敗・PTY の消滅・起動コマンドの書き込み失敗、新規作成での PTY 作成失敗）も、同じ条件で回収する。メンバー起動の入出力フォルダ（`~/.vk-terminals/codex-task-io/<ランダム名>/`）は、この専用フォルダと一緒に作ったものとして、作ったときの識別子が一致する場合に同時に回収する。
- 再起動では、直列化の待機・ペインの存在確認（404）・世代確認（409）を通った後、AI を止める前に専用フォルダを作る。これらで終わるリクエストは専用フォルダを作らない。事前確認（`dryRun`）は専用フォルダを作らない。
- **起動に使った専用フォルダは自動では消さない。** 複数のアプリプロセスをまたいで「使用中でない」ことを確実に判定する方法が無く、古さ（更新時刻）だけで消すと長く動いている Codex のセッションの設定を消してしまうため。削除は利用者の責務で、Codex が動いていないときに `~/.vk-terminals/codex-task-policy/` 以下と `~/.vk-terminals/codex-task-io/` 以下（メンバー起動の入出力フォルダ。子の出力ファイルもここに残る）を消してよい（次の起動で作り直される）。

## 固定できないときは止める

次のいずれかなら `503 {"error":"codex task policy unavailable: <理由>"}` を返し、Codex を起動しない（承認方針だけを `never` にした起動にもしない）。

- 専用フォルダを作れない・書き込めない
- 親フォルダや専用フォルダがシンボリックリンクなど通常のフォルダではない、または他人の所有・権限を 0700 にできない
- データフォルダ・引き継ぎ先・ホーム・認証元（`auth.json`・gh の `hosts.yml`）・実行ファイルのいずれかの階層（リンクの途中を含む）が、他人の所有・他人が書き込める権限・書込可能なフォルダに置かれたリンクである、末端のフォルダがリンクである、またはリンクが長すぎる・循環している、あるいは検証後に差し替えられた
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
