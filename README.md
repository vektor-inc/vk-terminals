# vk-terminals

複数のターミナルを並べて表示できる Electron 製デスクトップアプリです。
起動すると自動的に `claude` コマンドが実行されます。

## スクリーンショット

ペインを自動折返しグリッドに並べて複数の Claude セッションを同時に操作できます。

## 必要環境

- Node.js 18 以上
- macOS（`node-pty` のビルドが必要）

## セットアップ

```bash
npm install
```

## 起動

```bash
npm start
```

### 素のターミナルモード（claude を自動起動しない）

通常起動では各ペインで自動的に `claude` が実行されますが、`--no-claude`（または `--plain`）フラグを付けると claude を起動せず、素のシェルとしてペインを開きます。`initialCommand` の送信もスキップされます。

```bash
npm start -- --no-claude
# または
electron . --no-claude
```

設定ファイルの `additionalPanes` 各エントリに `noClaude: true` を指定すると、そのペインだけ素のシェルとして開けます（CLI フラグ未指定時の挙動）。

HTTP API（`POST /api/new-pane`）でも `noClaude: true` を指定可能です（後述）。

## 使い方

### ペインの追加・並べ替え

ペインはすべて最上位（VK Terminals 直下）に並ぶ自動折返しグリッドで配置されます。ペインが他ペインの内側に入れ子になることはなく、数が増えると自動的に行へ折り返します。各ペインのヘッダーにあるボタンで操作できます。

| ボタン | 操作 |
|---|---|
| `＋` | ペインを追加（グリッド末尾に追加） |
| `◀` `▶` `▲` `▼` | ペインをグリッド上で隣と入れ替え |
| `✕` | ペインを閉じる |

ペインのタスクタイトル行をドラッグして他ペインの左/上（前）・右/下（後）にドロップすると、並び順を入れ替えられます。

### ペインのリサイズ

列間（縦線）・行間（横線）の境界をドラッグすると、その列・行のトラック幅／高さを手動で調整できます。ペインを増減するとグリッド寸法が変わるため、トラックのサイズは均等にリセットされます。

### 待機検出

ターミナルが入力待ち状態（`y/n` 確認・Claude Code の権限承認など）になると：

- ペインのヘッダーが強調表示される
- `⚠ 待機中` バッジが表示される
- 通知音が鳴る

## 起動時の初期コマンド設定

アプリ起動後、最初のターミナルで claude が起動した直後に自動実行するコマンドを設定できます。

設定ファイルを以下のいずれかのパスに配置してください（上が優先）：

1. `~/.vk-terminals/config.json` — ユーザー固有設定（推奨）
2. `config.json`（リポジトリ直下）— ローカル設定（`.gitignore` 対象）

`config.example.json` をコピーして編集してください：

```bash
cp config.example.json config.json
# または
mkdir -p ~/.vk-terminals
cp config.example.json ~/.vk-terminals/config.json
```

設定例：

```json
{
  "initialCommand": "スキルでタスク管理を呼び出して",
  "additionalPanes": [
    { "cwd": "/Users/you/Documents/git/your-project" },
    { "cwd": "/Users/you/Documents/git/other-project", "noClaude": true }
  ]
}
```

- `initialCommand`：1 ペイン目で claude が起動した直後に自動実行されるコマンド。省略または空にすると自動実行は行われません。`--no-claude` 起動時は送信されません。
- `additionalPanes`：起動時に追加で開くペインのリスト。各要素の `cwd`（絶対パス）でペインが分割作成され、その作業ディレクトリで claude が立ち上がります。複数指定可。省略または空配列の場合は 1 ペインのみで起動します。
  - `noClaude: true` を指定すると、そのペインのみ claude を自動起動せず素のシェルとして開きます（省略時は CLI フラグの設定に従う）。
- `agentroom`：`true` にすると、各ペイン下部に開閉式の「エージェントルーム」を表示します（後述の[エージェントルーム](#エージェントルームissue-58)を参照）。省略時は `false`（非表示）。

> **移行メモ**: 旧パス `~/.claude/terminals-config.json` も後方互換として読み込まれます。

## 設定パネル

タイトルバー右端の ⚙ ボタンから、設定を GUI 上で編集・保存できます。単体起動でも常に表示されます。

- **単体起動時**（`VK_TERMINALS_SETTINGS` 未指定）：vk-terminals 自身の `config.json`（`apiHost` / `initialCommand` / `agentroom` / `additionalPanes`）を編集します。編集対象は `loadUserConfig()` と同じ探索順で、既存の `config.json` があればそれ、無ければリポジトリ直下 `config.json` を作成します。
- **呼び出し側から渡された場合**（`VK_TERMINALS_SETTINGS` に「設定ディスクリプタ JSON」のパスを指定）：そのディスクリプタが指す任意の config ファイルを編集します（vk-orchestrator が自身の統合 `config.json` を編集させる用途など）。vk-terminals 自身は編集対象の設定内容を知らず、ディスクリプタ（編集対象パス + 項目スキーマ）に従って読み書きするだけの汎用実装です。

いずれの場合も、保存後の反映には再起動が必要です（設定は起動時に読み込むため）。

ディスクリプタの形式:

```jsonc
{
  "title": "○○ 設定",                       // パネル上部の見出し
  "note": "保存後に再起動で反映されます",    // 任意の注意書き（省略可）
  "targetPath": "/abs/path/to/config.json",  // 読み書きする対象ファイル（絶対パス）
  "groups": [
    {
      "label": "GitHub",
      "fields": [
        { "key": "github.token", "label": "Token", "type": "password", "emptyToNull": true },
        { "key": "github.owner", "label": "Owner", "type": "text" }
      ]
    }
  ]
}
```

- `key`：ドット区切りで対象 JSON の入れ子キーを指す（例 `github.token`）。
- `type`：`text` / `password` / `number` / `boolean` / `json` のいずれか。`json` は配列・オブジェクトを textarea で編集します。
- `emptyToNull`（任意）：`text` / `password` で空欄を `null` として書き出します。
- 保存時はディスクリプタに載っているキーだけを型変換して書き戻し、**載っていない既存キーは保持**します。書き込み先は必ず `targetPath` に限定されます。

## HTTP API（外部連携用）

アプリ起動時にローカル HTTP API サーバーが `http://127.0.0.1:13847` で起動します。外部スクリプトや Claude Code の監視スキルからターミナルを操作できます。

### エンドポイント

#### `GET /api/health`

ヘルスチェック。

```bash
curl -s http://127.0.0.1:13847/api/health
# => {"ok":true}
```

#### `GET /api/states`

全ターミナルの状態を取得。

```bash
curl -s http://127.0.0.1:13847/api/states | python3 -m json.tool
```

レスポンス例:

```json
{
  "updatedAt": "2026-04-17T10:00:00.000Z",
  "terminals": {
    "pane-1": {
      "termId": "1",
      "cwd": "/Users/you/project",
      "cwdShort": "~/project",
      "waiting": false,
      "lastOutputTime": 1713340800000,
      "lastInputTime": 1713340790000,
      "lastLines": "最近の出力15行分..."
    }
  }
}
```

| フィールド | 説明 |
|---|---|
| `termId` | ターミナル ID（`/api/send` で使用） |
| `cwd` / `cwdShort` | カレントディレクトリ（フルパス / 短縮表示） |
| `waiting` | 入力待ち状態（権限確認プロンプト等）かどうか |
| `lastOutputTime` | 最後に出力があった時刻（Unix ms） |
| `lastInputTime` | 最後にユーザーが入力した時刻（Unix ms） |
| `lastLines` | 最近の出力テキスト（ANSI除去済み、最大15行） |

#### `POST /api/send`

指定ターミナルにコマンドを送信。

```bash
curl -s -X POST http://127.0.0.1:13847/api/send \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "input": "y\r"}'
```

- `termId`: 送信先のターミナル ID（`/api/states` で確認）
- `input`: 送信するテキスト。改行を送る場合は末尾に `\r` を付ける

送信成功時、対象ペインに「🤖 自動入力」バッジが3秒間表示されます。

#### `POST /api/set-title`

指定ペイン上部の「タスクタイトル行」に表示する文字列を設定します。任意で外部リンクの URL を渡すと、タイトル全体がリンク化され、クリックで OS の既定ブラウザで開きます。あわせて `prUrl` を渡すと、タイトル行の右端に独立した `PR ↗` ボタンが表示されます。

```bash
# タイトルだけ設定（リンクなし）
curl -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "title": "issue #29 対応中"}'

# タイトルとリンク URL をセットで設定
curl -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "title": "issue #29", "url": "https://github.com/vektor-inc/vk-terminals/issues/29"}'

# タイトル・issue リンク・PR ボタンをまとめて設定
curl -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "title": "issue #44", "url": "https://github.com/vektor-inc/vk-terminals/issues/44", "prUrl": "https://github.com/vektor-inc/vk-terminals/pull/99"}'

# タイトル・URL・PR ボタンをクリア（空文字で消す）
curl -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "title": "", "url": "", "prUrl": ""}'
```

リクエストボディ:

- `termId`: 対象のターミナル ID（必須）
- `title`: 表示する文字列。空文字 `""` を渡すと API 由来タイトルがクリアされ、OSC 由来タイトル（`taskTitle`）にフォールバックします。
- `url`（任意）: タイトル全体をリンク化するための URL。`http(s):` スキームのみ許可、2048 文字以内、`new URL()` で parse 可能であることが必須。違反時は `400` を返します。空文字 `""` を渡すと既存の URL がクリアされます。省略すると URL なしになります。
- `prUrl`（任意・issue #44）: タイトル行の右端に独立して表示する `PR ↗` ボタンに紐づける URL。バリデーションは `url` と完全同一（`http(s):` のみ・2048 文字以内・`new URL()` で parse 可）。空文字 `""` を渡すと PR ボタンが消えます。省略すると PR ボタンなしになります。

| 挙動 |
|---|
| `title` / `url` / `prUrl` はペアで都度送る**置換セマンティクス**です（patch 形式ではありません）。一部だけ更新したい場合でも、必要な値はその都度すべて一緒に送る必要があります（送らないフィールドは「なし」扱いになります）。 |
| `url` が設定されている間のみ、ペインのタイトル文字列全体が `<a>` として描画され、末尾に外部リンクマーク `↗` が付きます。クリックすると `shell.openExternal()` で OS の既定ブラウザを開きます。 |
| OSC 0 / OSC 2 由来のタイトル（`taskTitle`）が表示されている間は `url` のリンク化は無効になります。API 由来のタイトル（`apiTitle`）が選択されているときだけリンク化されます。 |
| `prUrl` で表示される `PR ↗` ボタンは `apiTitle` / `taskTitle` のどちらが表示されている間でも常時表示されます（issue リンクが消える場面でも PR ボタンは独立に出続けます）。 |

レスポンス例:

```json
{ "ok": true, "termId": "1", "title": "issue #44", "url": "https://github.com/vektor-inc/vk-terminals/issues/44", "prUrl": "https://github.com/vektor-inc/vk-terminals/pull/99" }
```

エラー例:

- `400 {"error": "url must be http(s)"}` — `file:` などの非 http(s) スキーム
- `400 {"error": "invalid url"}` — `new URL()` で parse 失敗
- `400 {"error": "url too long (max 2048 chars)"}` — 2048 文字超過
- `400 {"error": "prUrl must be http(s)"}` — `prUrl` フィールドのスキーム違反
- `400 {"error": "invalid prUrl"}` — `prUrl` フィールドが `new URL()` で parse 失敗
- `400 {"error": "prUrl too long (max 2048 chars)"}` — `prUrl` フィールドが 2048 文字超過
- `404 {"error": "terminal <id> not found"}` — 指定 `termId` のペインが存在しない

バリデーション動作確認用のリクエスト例（リグレッション検知用）:

```bash
# 大文字スキーム（`new URL()` がプロトコルを小文字化するため http(s) 判定で弾かれる）
curl -i -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId":"1","title":"x","url":"JAVASCRIPT:alert(1)"}'
# => 400 {"error":"url must be http(s)"}

# javascript: スキーム
curl -i -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId":"1","title":"x","url":"javascript:alert(1)"}'
# => 400 {"error":"url must be http(s)"}

# data: スキーム
curl -i -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId":"1","title":"x","url":"data:text/html,<script>alert(1)</script>"}'
# => 400 {"error":"url must be http(s)"}
```

設定された値は `GET /api/states` のレスポンス（および `~/.vk-terminals/states.json`）の各ペインオブジェクトに `apiTitle` / `apiUrl` / `apiPrUrl` フィールドとして含まれます。

#### `POST /api/new-pane`

新規ペインを作成し、作成されたターミナルの `termId` を返します。ペインはグリッドの末尾に追加され、全体は自動折返しグリッドで再配置されます。

```bash
curl -s -X POST http://127.0.0.1:13847/api/new-pane
# => {"ok":true,"termId":"3"}

# cwd を指定して開く
curl -s -X POST http://127.0.0.1:13847/api/new-pane \
  -H 'Content-Type: application/json' \
  -d '{"cwd": "/Users/you/Documents/git/your-project"}'

# claude を起動せず素のシェルとして開く
curl -s -X POST http://127.0.0.1:13847/api/new-pane \
  -H 'Content-Type: application/json' \
  -d '{"noClaude": true}'
```

リクエストボディ（任意）:

- `cwd`：新規ペインのカレントディレクトリ（絶対パス）。未指定ならホームディレクトリ。
- `noClaude`：`true` の場合、新規ペインで claude を自動起動せず素のシェルとして開く。未指定なら起動時の `--no-claude` フラグの値に従う。

レスポンス:

- 成功時: `200 {"ok": true, "termId": "<新規ターミナルID>"}`
- ウィンドウが利用できない: `503 {"error": "window not available"}`
- タイムアウト（15秒）: `504 {"error": "timeout waiting for new pane"}`
- renderer 側でペイン作成に失敗（既存ペインなし／分割失敗など）: `500 {"error": "<renderer からのエラーメッセージ>"}`

#### `POST /api/agentroom`

エージェントルーム（後述）の各キャラの稼働状況を更新します。`config.json` の `agentroom: true` のときだけ表示に反映されます。

```bash
# ルーム状態を丸ごと置換（agents オブジェクト）
curl -s -X POST http://127.0.0.1:13847/api/agentroom \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "agents": {"司": "consulting", "和田": "working", "麗美": "working"}}'

# 1 人だけ更新（agent + state のマージ）
curl -s -X POST http://127.0.0.1:13847/api/agentroom \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "agent": "麗美", "state": "idle"}'
```

リクエストボディ:

- `termId`：対象のターミナル ID（必須）。
- `agents`：`{ "<キャラ名>": "<state>" }` のオブジェクト。指定するとそのペインのルーム状態を**丸ごと置換**します。
- `agent` + `state`：1 人だけ更新（既存状態にマージ）。`agents` と `agent` のどちらかは必須。
- `state` の語彙：`consulting`（相談中）／`working`（作業中）／`idle`（待機中）／`off`（離席）。日本語（「相談」「作業」「テスト」「待機」「離席」等）や大文字でも受け付け、表示側で正規化します。
- キャラ名は `司` / `和田` / `安藤` / `麗美` / `植草`。未知の名前は無視されます。

更新は最終受信から 90 秒間「新鮮」として優先表示され、それを過ぎると PTY 出力ベースのフォールバック表示に切り替わります（[エージェントルーム](#エージェントルームissue-58)を参照）。

### 状態ファイル

`~/.vk-terminals/states.json` に2秒ごとに全ターミナルの状態が書き出されます。HTTP API と同じ内容です。アプリ終了時に自動削除されます。`agentroom: true` のときは各ペインに解決済みのルーム状態 `agentRoom`（`{ "<キャラ名>": "<state>" }`）も含まれます。

## エージェントルーム（issue #58）

`config.json` で `agentroom: true` にすると、各ペイン下部に開閉式（アコーディオン）の「エージェントルーム」が表示されます。司／和田／安藤／麗美／植草の 5 キャラを、Gather / WorkAdventure 風のチビキャラ（ドット絵）で次のように描き分けます。

| state | 表示 |
|---|---|
| `consulting`（相談中） | テーブルを囲み、吹き出しを出す |
| `working`（作業中） | デスクで PC（モニタ）に向かう |
| `idle`（待機中） | コーヒーを飲む |
| `off`（離席） | 薄く表示 |

状態は 2 系統で供給されます。

1. **HTTP API（正確）**: 上記 `POST /api/agentroom` で各キャラの状態を通知します。スキル（staff-director など）からサブエージェントの起動・終了時に ping する想定です。
2. **PTY 出力ベースのフォールバック**: API 未通知 / 古い場合、司（メイン Claude）はペインの稼働ステータス（実行中→作業中／入力待ち→相談中／それ以外→待機中）を写像し、その他のキャラは直近の出力にその名前が出ていれば作業中とみなします（ベストエフォート）。

## 技術スタック

- [Electron](https://www.electronjs.org/)
- [xterm.js](https://xtermjs.org/) (`@xterm/xterm`)
- [node-pty](https://github.com/microsoft/node-pty)
