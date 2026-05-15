# vk-terminals

複数のターミナルを並べて表示できる Electron 製デスクトップアプリです。
起動すると自動的に `claude` コマンドが実行されます。

## スクリーンショット

ペインを左右・上下に自由に分割して複数の Claude セッションを同時に操作できます。

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

### ペインの分割

各ペインのヘッダーにあるボタンで分割できます。

| ボタン | 操作 |
|---|---|
| `⇔` | 左右に分割 |
| `⇕` | 上下に分割 |
| `✕` | ペインを閉じる |

分割後のペインは親ペインのカレントディレクトリを引き継ぎます。

### ペインのリサイズ

ペイン間のセパレーターをドラッグしてサイズを調整できます。

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

> **移行メモ**: 旧パス `~/.claude/terminals-config.json` も後方互換として読み込まれます。

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

指定ペイン上部の「タスクタイトル行」に表示する文字列を設定します。任意で外部リンクの URL を渡すと、タイトル全体がリンク化され、クリックで OS の既定ブラウザで開きます。

```bash
# タイトルだけ設定（リンクなし）
curl -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "title": "issue #29 対応中"}'

# タイトルとリンク URL をセットで設定
curl -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "title": "issue #29", "url": "https://github.com/vektor-inc/vk-terminals/issues/29"}'

# タイトルと URL をクリア（空文字で消す）
curl -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "title": "", "url": ""}'
```

リクエストボディ:

- `termId`: 対象のターミナル ID（必須）
- `title`: 表示する文字列。空文字 `""` を渡すと API 由来タイトルがクリアされ、OSC 由来タイトル（`taskTitle`）にフォールバックします。
- `url`（任意）: タイトル全体をリンク化するための URL。`http(s):` スキームのみ許可、2048 文字以内、`new URL()` で parse 可能であることが必須。違反時は `400` を返します。空文字 `""` を渡すと既存の URL がクリアされます。省略すると URL なしになります。

| 挙動 |
|---|
| `title` と `url` はペアで都度送る**置換セマンティクス**です（patch 形式ではありません）。`title` だけ更新したい場合も、その都度 `url` を一緒に送る必要があります（送らなければ URL なし扱いになります）。 |
| `url` が設定されている間のみ、ペインのタイトル文字列全体が `<a>` として描画され、末尾に外部リンクマーク `↗` が付きます。クリックすると `shell.openExternal()` で OS の既定ブラウザを開きます。 |
| OSC 0 / OSC 2 由来のタイトル（`taskTitle`）が表示されている間は URL を表示しません。API 由来のタイトル（`apiTitle`）が選択されているときだけリンク化されます。 |

レスポンス例:

```json
{ "ok": true, "termId": "1", "title": "issue #29", "url": "https://github.com/vektor-inc/vk-terminals/issues/29" }
```

エラー例:

- `400 {"error": "url must be http(s)"}` — `file:` などの非 http(s) スキーム
- `400 {"error": "invalid url"}` — `new URL()` で parse 失敗
- `400 {"error": "url too long (max 2048 chars)"}` — 2048 文字超過
- `404 {"error": "terminal <id> not found"}` — 指定 `termId` のペインが存在しない

設定された値は `GET /api/states` のレスポンス（および `~/.vk-terminals/states.json`）の各ペインオブジェクトに `apiTitle` / `apiUrl` フィールドとして含まれます。

#### `POST /api/new-pane`

新規ペインを作成し、作成されたターミナルの `termId` を返します。表示面積が一番大きいペインを対象に、そのペインの長辺方向へ分割して新規ペインを生成します。

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

### 状態ファイル

`~/.vk-terminals/states.json` に2秒ごとに全ターミナルの状態が書き出されます。HTTP API と同じ内容です。アプリ終了時に自動削除されます。

## 技術スタック

- [Electron](https://www.electronjs.org/)
- [xterm.js](https://xtermjs.org/) (`@xterm/xterm`)
- [node-pty](https://github.com/microsoft/node-pty)
