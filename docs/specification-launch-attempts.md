# Codex の起動試行（attemptId）を記録・照会する API（issue #657）

承認後はこの仕様書を正とする。承認された仕様案は次の issue コメント（5 点の判断はすべて推奨案で確定）。

- https://github.com/vektor-inc/vk-terminals/issues/657#issuecomment-7121033414
- https://github.com/vektor-inc/vk-terminals/issues/657#issuecomment-7121062935

## 登場するものとつながり方

- VK Orchestrator（司令塔）が、HTTP の API で VK Terminals（ペインと Codex プロセスを実際に起動するアプリ）へ「この起動試行（`attemptId`）で、この初期指示を持った Codex を 1 つ起動して」と依頼する。
- VK Terminals は試行ごとの記録（帳簿）を持ち、同じ `attemptId` が何度届いても Codex は 1 つしか起動しない。
- VK Orchestrator は応答を受け取れなかったときも、`attemptId` で状態を照会してから次の行動を決める。

## 今の仕組みで足りなかったところ

- 新規ペイン API（`POST /api/new-pane`）は、知らない項目を黙って無視して `{ ok: true }` を返す。未対応の版へ `attemptId` を送ると、成功したように見える。
- 同じ API は、15 秒でペインの報告が来なければ時間切れ（504）を返すが、その後で画面側が遅れてペインを作るのは止めていない。「結果不明」はこの経路で起きる。
- VK Orchestrator は、ペインを起動してから指示本文と Enter を端末入力（`/api/send`）として別々に送っていた。

## 1. API の形

### 対応機能の確認

既存の `GET /api/codex-task-capabilities` の `capabilities` に `launchAttempts` を足す。

```json
{
  "available": true,
  "contractVersion": 1,
  "agents": ["codex"],
  "maxPromptBytes": 65536,
  "receiptMethods": ["codex-rollout-v1"],
  "ledgerId": "<UUID>"
}
```

- `ledgerId` は帳簿の識別子。帳簿（`~/.vk-terminals/launch-attempts/`）が作り直されると変わる。
- 帳簿を用意できないときは `{ "available": false, "reason": "..." }`。

### 起動要求: `POST /api/launch-attempts`

受け付ける項目は次だけ。知らない項目は `400 UNKNOWN_FIELD` で拒否する。新しい入口なので、旧版は 404 を返す。この 2 つにより、照会を飛ばしても「未対応の版へ送って成功扱い」は起きない。

- `attemptId`（必須）: 1 回の起動試行を一意に表す UUID v4（小文字）
- `agent`（必須）: 当面は `"codex"` だけ
- `cwd`（必須）: 作業フォルダ。実在するフォルダの絶対パス
- `prompt`（必須）: 初期指示。上限は UTF-8 で 64KiB
- `codexPolicy`（必須）: 自動タスク用の権限制限（`docs/codex-task-policy.md`）
- 既存の新規ペイン API と同じ起動オプションのうち Codex で意味のあるもの: `approvalPolicy`・`sandboxMode`・`model`・`stashed`

本文は、改行を LF にそろえ、前後の空白を除いてから扱う（実装時の決定。シェルのコマンド置換は末尾の改行を落とすため、Codex に渡る本文と要約値の対象をここで一致させる）。`promptDigest` はこの正規化後の本文の値。

応答は、「起動コマンドを書き込んだ」か「失敗が確定した」ところまで最大 10 秒待つ。

- 書き込んだ・最終状態: `200`、本文は状態照会と同じ形
- 時間切れ: `202`（受け付け済み・処理中）、本文は状態照会と同じ形
- 処理前の拒否: `4xx` / `5xx`、本文は `{ "attemptId"?, "ledgerId"?, "phase": "rejected", "error": { code, retry, message } }`

同じ `attemptId` の送り直し:

- 本文と起動オプションが同じ: ペインを作らず、今の状態を返す
- 違う: `409 ATTEMPT_CONFLICT`
- 保持期間を過ぎて要約値だけが残っている: `409 ATTEMPT_EXPIRED`

### 状態照会: `GET /api/launch-attempts/<attemptId>`

- 本文・ファイルパス・会話の中身は返さない。
- 照会のたびに受領の記録を 1 回だけ確認し、状態を進める。待ち合わせ（繰り返しの照会）は VK Orchestrator 側で行う。
- 帳簿に無い `attemptId` は `200` で `{ "phase": "unknown", "reason": "attempt-not-found", "error": { "code": "ATTEMPT_NOT_FOUND", "retry": "forbidden" } }`。404 は「未対応の旧版」の意味に使うため、記録なしには使わない。記録なしで `ledgerId` が送信前に見た値と同じなら、要求は受け付けられていないので、同じ `attemptId` で送り直してよい。
- 保持期間を過ぎた `attemptId` は `200` で `phase: unknown`、`reason: attempt-expired`、`error.retry: forbidden`（照会では unknown なので forbidden。送り直しの `409 ATTEMPT_EXPIRED` は処理前の拒否なので not-useful）。

応答の形:

```json
{
  "attemptId": "<UUID>",
  "agent": "codex",
  "ledgerId": "<UUID>",
  "contractVersion": 1,
  "phase": "awaiting-receipt",
  "milestones": { "requestAccepted": "<ISO 8601>", "launchWritten": "<ISO 8601 | null>", "receiptConfirmed": "<ISO 8601 | null>" },
  "binding": { "termId": "<ペイン番号 | null>", "paneGeneration": 1, "sessionId": "<Codex のセッション ID | null>", "promptDigest": "sha256:<16進64桁>" },
  "receipt": { "method": "codex-rollout-v1" },
  "error": { "code": "...", "retry": "...", "message": "..." }
}
```

`error` は失敗したときだけ返す。

## 2. 状態とエラーの持ち方

`phase` は大分類で、VK Orchestrator はこの値で次の行動を決める。値は 4 つで、エージェントの種類に関係なく共通。

- `rejected`: 処理前に拒否した（最終状態）
- `awaiting-receipt`: 受け付けたが、受領をまだ確認できていない
- `received`: 対象の Codex セッションが指示を受領した（最終状態）
- `unknown`: 結果を確定できない（最終状態。自動で再試行してはいけない）

- `milestones`: 各段階を通過した時刻。`requestAccepted`（API 要求を受け付けた）、`launchWritten`（端末へ起動コマンドを書き込んだ）、`receiptConfirmed`（Codex の受領を確認した）
- `binding`: 結び付け先。ペイン（`termId` とペインの世代）、Codex セッションの ID（`sessionId`）、指示本文の要約値（`promptDigest`、SHA-256）
- `receipt.method`: 受領を確かめた方法（`codex-rollout-v1`）。将来 Claude Code を載せるときは、この値と `agent` を足すだけで済み、`phase` と再試行の判定は変えない
- `error`: `code`（機械向けの固定文字列）、`retry`、`message`

`retry` は 3 値。

- `allowed`: 処理前の一時的な拒否で、同じ `attemptId` で送り直してよい
- `not-useful`: 送り直しても通らない（要求を直す必要がある）
- `forbidden`: 起動した可能性があるので、自動で送り直してはいけない

決まり事:

- `allowed` と `not-useful` は `phase` が `rejected` のときだけ出る。
- 帳簿に記録を残すのは受け付けた試行だけ。HTTP エラー（4xx / 5xx）で拒否した後に同じ `attemptId` で送り直すのは常に安全。受け付けた後の失敗は HTTP エラーにせず、`phase` で返す。
- 受け付けた後、Codex を起動する前に止まったもの（下表の「記録済みの rejected」）は帳簿に残るため、同じ `attemptId` では結果が変わらない。Codex は起動していないので、新しい `attemptId` で依頼し直してよい（実装時の決定。`retry` は `not-useful`）。

VK Orchestrator 側への約束:

- 知らない `phase` は `unknown` として扱う
- 知らない `retry` は `forbidden` として扱う

### エラーコードの一覧

処理前の拒否（HTTP エラー。帳簿に残らない）:

| code | HTTP | retry | 意味 |
|---|---|---|---|
| `INVALID_JSON` | 400 | not-useful | 本文が JSON のオブジェクトでない |
| `UNKNOWN_FIELD` | 400 | not-useful | 知らない項目がある |
| `INVALID_ATTEMPT_ID` | 400 | not-useful | `attemptId` が小文字の UUID v4 でない |
| `UNSUPPORTED_AGENT` | 400 | not-useful | `agent` が `codex` でない |
| `INVALID_CWD` | 400 | not-useful | `cwd` が実在するフォルダの絶対パスでない |
| `INVALID_PROMPT` | 400 | not-useful | 本文が空・文字列でない・NUL を含む |
| `PROMPT_TOO_LARGE` | 400 | not-useful | 本文が UTF-8 で 64KiB を超える |
| `CODEX_POLICY_REQUIRED` | 400 | not-useful | `codexPolicy` が無い |
| `INVALID_LAUNCH_OPTIONS` | 400 | not-useful | 起動オプションが不正 |
| `UNSUPPORTED_SHELL` | 400 | not-useful | ペインのシェルが sh / bash / zsh でない（Windows を含む） |
| `ATTEMPT_CONFLICT` | 409 | not-useful | 同じ `attemptId` で本文または起動オプションが違う |
| `ATTEMPT_EXPIRED` | 409 | not-useful | 保持期間を過ぎた `attemptId` |
| `FORBIDDEN_ORIGIN` | 403 | not-useful | 許可されない Origin |
| `PAYLOAD_TOO_LARGE` | 413 | not-useful | 要求の本文が 1MiB を超える |
| `APP_SHUTTING_DOWN` | 503 | allowed | アプリの終了中 |
| `WINDOW_UNAVAILABLE` | 503 | allowed | ウィンドウが無い |
| `CODEX_POLICY_UNAVAILABLE` | 503 | allowed | 自動タスク用ポリシーを用意できない |
| `GITHUB_UNREACHABLE` | 503 | allowed | GitHub へ到達できない（`githubReachability` を添える） |
| `LEDGER_UNAVAILABLE` | 503 | allowed | 帳簿を作れない・保存できない |
| `LEDGER_FULL` | 503 | allowed | 帳簿の件数が上限 |

記録済みの rejected（`phase: rejected`。Codex は起動していない）:

| code | 意味 |
|---|---|
| `PANE_CREATION_FAILED` | ペインを作れなかった |
| `PANE_CREATION_TIMEOUT` | 受け付けから 30 秒以内にペインが作られなかった（遅れて届いた作成は弾く） |
| `LAUNCH_CANCELLED` | 起動コマンドを書く前にペインが閉じた・入れ替わった |
| `LEDGER_WRITE_FAILED` | 起動コマンドを書く意図を保存できなかった（書かずに止めた） |
| `APP_RESTARTED_BEFORE_LAUNCH` | 起動コマンドを書く前にアプリが止まった |

unknown（`phase: unknown`、`retry: forbidden`）:

| code | 意味 |
|---|---|
| `RECEIPT_TIMEOUT` | 起動コマンドを書いてから 180 秒以内に受領を確認できなかった |
| `PANE_CLOSED` | 受領の前にペインが閉じられた |
| `PANE_REPLACED` | 受領の前にペインの AI が再起動された（世代が変わった） |
| `APP_RESTARTED` | 起動中にアプリが再起動し、ペインが残っていない |
| `AGENT_EXITED_EARLY` | 起動直後に Codex が終了し、受領の記録が無い |
| `LAUNCH_WRITE_FAILED` | 起動コマンドの書き込みが例外になった |
| `ROLLOUT_UNREADABLE` | 受領の記録を読めない |
| `ROLLOUT_UNRECOGNIZED` | 受領の記録の形式を判別できない |
| `RECORD_UNREADABLE` | 帳簿の記録を読めない、または必須項目・型・状態どうしの整合を満たさない（例: `launchWritten` があるのに `launchIntentAt` が無い） |
| `ATTEMPT_NOT_FOUND` | 帳簿に無い（照会のみ。`reason: attempt-not-found`） |
| `ATTEMPT_EXPIRED` | 保持期間を過ぎた（照会のみ。`reason: attempt-expired`。POST の 409 とは retry が違う） |

## 3. 初期指示を起動時に一体で渡す方法

- 指示本文を、権限 0600 のファイルへ書く。置き場所は `~/.vk-terminals/launch-attempts/<attemptId>/prompt.txt`（フォルダは 0700）。
- 起動コマンドの末尾に `-- "$(cat '<そのパス>')"` を付け、Codex の起動引数として渡す。シェルに打ち込むのは短いパスだけ。長文・日本語・改行・引用符・`$`・バッククォート・`!`・タブは欠けず、展開もされない。シェルの履歴にも本文は残らない。`--` の後ろに置くので、"-" で始まる本文もオプションとして解釈されない（実装時の決定）。
- 採らなかった案: 本文を引用符で直接埋め込む案（上の問題がすべて残る）、標準入力で渡す案（対話画面の Codex は起動引数でしか初期指示を受けない）。
- 対応するシェルは sh / bash / zsh だけ。それ以外は処理前に拒否する（`UNSUPPORTED_SHELL`）。
- 本文の上限は UTF-8 で 64KiB。超えたら処理前に拒否する（`PROMPT_TOO_LARGE`）。
- 制約: 起動引数は、同じマシンの `ps` から見える。
- 起動直後に Codex が終了したとき同じコマンドで 1 回だけ起動し直す処理（vektor-inc/vk-terminals#621）は、起動試行では行わない（指示の二重渡しになるため）。
- 受領か最終状態になったら `prompt.txt` を消し、要約値だけを残す。

## 4. 「Codex が指示を受領した」の判定

- 自動タスク用ポリシー付きの Codex は、起動のたびに専用の CODEX_HOME を新しく作って動く（vektor-inc/vk-terminals#428）。配下の会話記録ファイル（rollout）は、その起動の Codex 1 つだけのもの。
- その `sessions` 配下の rollout に、要約値が一致する利用者の発言が現れたら `received` にし、`session_meta` の ID を `sessionId` として結び付ける。端末画面の文字列や入力欄の見た目には依存しない。
- 記録の先頭には AGENTS.md などが入るため、「最初の発言」ではなく「一致する発言があるか」で判定する。メンバー用の子 Codex の記録（専用フォルダ内の `member/`）は対象にしない。
- rollout の形式（既知の新旧両方に対応）:
  - 新しい形式: `response_item`（`role: user` の `message` の `input_text`）と、`event_msg` の `item_completed`（`item.type: UserMessage` の `content[].text`）
  - 古い形式: `event_msg` の `user_message`（`message`）
  - 先頭行が `session_meta`（`payload.id` あり）でない、途中の行が JSON でない場合は知らない形式として `unknown`（`ROLLOUT_UNRECOGNIZED`）。書きかけの最後の行は無視する。
- 採らなかった案: Codex の hooks（フックを信頼するかの扱いと、Codex の版への依存が増える）。

### 実物の Codex での確認（実装前に実施）

codex-cli 0.171.0 で、専用 CODEX_HOME（`trust_level = "untrusted"` を記録）を使い、tmux 上で `codex "$(cat '<本文ファイル>')"` として起動して確かめた。

- 信頼確認の画面（Open restricted）を通った後、初期指示は追加の入力なしで自動送信された。
- 日本語・改行・二重引用符・単引用符・`$HOME`・バッククォート・`!!`・タブ・バックスラッシュを含む本文が、rollout の `response_item`（`input_text`）と `event_msg` の `item_completed`（`UserMessage`）の両方に、SHA-256 が一致する形で残った。先頭には AGENTS.md などの別の `input_text` があった。
- `codex --no-daemon -- --version` は版の表示ではなく対話画面の起動になり、`--` の後ろが本文として扱われた。

## 5. 帳簿の保存と再起動・競合の扱い

- 保存先は `~/.vk-terminals/launch-attempts/<attemptId>/record.json`。権限（フォルダ 0700・ファイル 0600）を検証しながら、一時ファイルに書いてから置き換える（`utils/privateFile.js`）。帳簿の識別子は同じフォルダの `ledger.json`。
- 保存の順序:
  1. メモリ上の帳簿で、同じ `attemptId` が無いことを確認して登録する
  2. 受け付けの記録と本文を保存する。失敗したら登録を取り消し、`LEDGER_UNAVAILABLE`（`allowed`）で拒否する
  3. ペインを作る
  4. 「起動コマンドを書く」という意図を記録してから書き込み、書いた後に `launchWritten` を記録する
- 同じ `attemptId` が同時に届いた場合: 確認と登録の間に `await` を挟まない（Node の同期処理で途切れない）。記録フォルダの排他作成も併用する。2 本目は必ず 1 本目の記録を見て、第二のペインを作らない。ペインの作成時にも `attemptId` を照合し（`claimPane`）、時間切れの後に画面側が遅れて作ろうとした場合・同じ `attemptId` の 2 枚目を弾く。
- アプリ再起動後:
  - 起動コマンドを書く前で止まっていたもの: Codex は一度も起動していないので `rejected`（`APP_RESTARTED_BEFORE_LAUNCH`）。新しい `attemptId` でやり直してよい
  - 書いた後のもの: 受領を確認できれば `received`。ペインが生きていれば（tmux 保持の構成で同じ番号・同じ世代のペインが戻っていれば）確認を続け、それ以外は `unknown`（`APP_RESTARTED`）
- 受領の前にペインが入れ替わった・閉じられた場合は `unknown`。受領の後なら `received` のまま。判定は照会のたびに、受領の確認を先に行ってから行う。
- 保持期間:
  - 記録は最終状態になってから 7 日間残す
  - その後は `attemptId` と要約値だけを、受け付けから 30 日まで残す。期限切れの `attemptId` がまた届いたら拒否する（`ATTEMPT_EXPIRED`）
  - 期限の整理は、受け付け・送り直しの照合・状態照会のたびに、検索の前に行う（同じ `attemptId` の送り直しと照会しか来なくても期限が進む）
  - 要約値だけでない記録の件数の上限は 1000 件（`LEDGER_FULL`）。要約値だけの記録は 10000 件を超えたら古い順に消す
- 帳簿のフォルダが本人だけの 0700 でない・親フォルダを他人が書き込める・識別子を読めないときは帳簿を作らず、`LEDGER_UNAVAILABLE` で拒否する。
- `ledger.json` が無いときだけ識別子を作る。あるのに読めない・`ledgerId` が欠落・null・UUID でない場合は作り直さない（`ledgerId` が変わると、照会側が帳簿の作り直しと取り違えるため）。
- 初期化の後も、受け付けと保存（起動コマンドを書く直前の意図の記録を含む）のたびに、帳簿のフォルダが初期化時と同じ実体（dev/ino）で、本人だけの 0700 のままで、親フォルダを他人が書き込めないことを確かめる。違えば受け付けは `LEDGER_UNAVAILABLE`、起動直前なら書かずに `LEDGER_WRITE_FAILED` で止める。
- 復帰時は、通常の記録と要約値だけの記録の両方で、必須項目・型・状態どうしの整合（例: 書いた記録には書く意図とペインの結び付けがある、`rejected` は書く意図が無く retry が allowed / not-useful、`unknown` は retry が forbidden、`received` はセッション ID と受領時刻がある）を検証する。満たさない記録は「未起動」とはみなさず `unknown`（`RECORD_UNREADABLE`・`forbidden`）にし、同じ `attemptId` では第二のペインを作らない。

## 6. 変えないもの

- 既存の新規ペイン API、エージェントの再起動 API、Claude Code の受領確認 API（`/api/transcript-evidence`。vektor-inc/vk-terminals#417）、通常の手動ペイン起動の動作は変えない。
- 画面に新しく出る文言は無い。API の `message` や `code` は VK Orchestrator が読むもので、VK Terminals の画面には出ない。見え方の変化は 1 つだけで、ペイン内の Codex で指示が入力欄に残る形から、最初の発言として表示される形に変わる。

## 7. テスト

- 単体テスト（`tests/launchAttempts.test.js`）: 状態の移り変わり、送り直しと 409、同時に届いた 2 要求で作成が 1 回、保存に失敗したときの扱い、再起動からの復帰、要約値の取り方、rollout の新旧の形式と知らない形式、遅延起動（`utils/delayedLaunch.js`）に足した口
- E2E（`tests/e2e/launch-attempts.smoke.spec.js`）: 偽 Codex（`tests/e2e/helpers/fake-engine.js`）が受け取った初期指示を rollout へ書く。長文・日本語・改行・引用符・シェル記号の要約値の一致、応答前に通信を切ってからの送り直し・同時送信でペインと偽 Codex の起動が 1 回、ペインの入れ替え・閉じる、起動直後の終了、帳簿を保存できないとき・書く前に止まった記録。node-pty と tmux 保持の両方の構成で動かす
- 起動直後の終了の検知は、AI 本体の生死の追跡（`utils/agentLifecycle.js`）に頼る。負荷が高くその追跡が取得の時間切れ（750ms）で打ち切られた場合は検知できず、受領確認の時間切れ（`RECEIPT_TIMEOUT`）で `unknown` になる（どちらも `forbidden` で、自動で送り直さない点は同じ）
