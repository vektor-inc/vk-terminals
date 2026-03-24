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

## 技術スタック

- [Electron](https://www.electronjs.org/)
- [xterm.js](https://xtermjs.org/) (`@xterm/xterm`)
- [node-pty](https://github.com/microsoft/node-pty)
