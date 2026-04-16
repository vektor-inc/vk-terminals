# claude-terminals

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

1. `~/.claude/terminals-config.json` — ユーザー固有設定（推奨）
2. `config.json`（リポジトリ直下）— ローカル設定（`.gitignore` 対象）

`config.example.json` をコピーして編集してください：

```bash
cp config.example.json config.json
# または
cp config.example.json ~/.claude/terminals-config.json
```

設定例（`config.json` / `~/.claude/terminals-config.json`）：

```json
{
  "initialCommand": "スキルでタスク管理を呼び出して"
}
```

`initialCommand` を省略または空にすると、自動実行は行われません。

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

### 状態ファイル

`~/.claude/terminal-states.json` に2秒ごとに全ターミナルの状態が書き出されます。HTTP API と同じ内容です。アプリ終了時に自動削除されます。

## 技術スタック

- [Electron](https://www.electronjs.org/)
- [xterm.js](https://xtermjs.org/) (`@xterm/xterm`)
- [node-pty](https://github.com/microsoft/node-pty)
