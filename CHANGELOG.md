# Changelog

- [ 機能追加 ] ペイン上部のタスクタイトル行の右側に独立した [ PR ↗ ] ボタンを表示できる機能を追加。`POST /api/set-title` に `prUrl` フィールド（任意・`http(s):` のみ・2048 文字以内・`new URL()` で parse 可）を追加し、`prUrl` が設定されているときに限り、タイトル行の右端に GitHub PR グリーン系の `[ PR ↗ ]` ボタン（`.pane-badge` 共通基底 / 共通バッジ規格 h18 / font-size 10 / radius 3px / padding 0 6px）を表示する。クリックすると `shell.openExternal()` で OS の既定ブラウザを開く（renderer 側でも `http(s):` を再チェックする二段構え）。表示条件は `apiTitle` / `taskTitle` のいずれが表示中でも常時表示（OSC タイトル表示中で issue リンクが消える場面でも PR ボタンは独立に出る）。`prUrl` を省略すると PR ボタンなし、空文字 `""` で既存 `prUrl` をクリア。`prUrl` のバリデーション違反は `400` を返す（`url` と完全同一規約）。`states.json` および `GET /api/states` のレスポンスに `apiPrUrl` フィールドを追加（後方互換のため既存フィールドは維持）（[#44](https://github.com/vektor-inc/vk-terminals/issues/44)）
- [ 機能追加 ] ペインのタスクタイトル行をドラッグして他ペインの上下左右にドロップすると、その方向に再分割して挿入できる機能を追加（タスクタイトル行に `cursor: grab` / `grabbing`、ドロップ予定領域を半透明アクセントカラーで塗りつぶす視覚フィードバック、中央 20% はデッドゾーンとして無効化、ペイン1枚状態ではドラッグ不可）（[#40](https://github.com/vektor-inc/vk-terminals/issues/40)）
- [ セキュリティ修正 ] `renderer/app.js` の `renderLeaf()` で `innerHTML` テンプレートリテラル経由でペインヘッダを組み立てる際、`cwd`（OS ファイルシステム由来）や `statusAriaLabel` などの動的文字列を属性値・テキスト内容にエスケープせず挿入していたため、ディレクトリ名に `"` や `<` を含むパスでヘッダ DOM が壊れ任意の HTML が注入されうる問題を修正（属性値用 `escAttr` / テキスト用 `escText` のエスケープヘルパーを導入し、`data-status` / `aria-label` / `pane-cwd` の `title` 属性とテキストノードに適用）（[#39](https://github.com/vektor-inc/vk-terminals/issues/39)）
- [ 不具合修正 ] 自動入力バッジ（`🤖 自動入力`）の自動非表示用 `setTimeout` のタイマー ID を保持していなかったため、短時間に複数回 `terminal:auto-input` イベントが発火すると先発タイマーが残ったままになり、後発の表示が想定の 3 秒より早く消える不具合を修正（[#38](https://github.com/vektor-inc/vk-terminals/issues/38)）
- [ 仕様変更 ] ペインを角丸カード状デザインに変更（`margin: 6px` ＋ `border-radius` を `.pane` / `.term-container` に付与、body 背景を `#333` に変更）。あわせて共通利用想定の CSS カスタムプロパティ `--vktm--border-radius--md` を導入
- [ デザイン不具合修正 ] ペイン下部に body 背景が透けて白い余白が表示される不具合を修正（xterm.js が文字グリッド整数倍でしか描画できないために `.term-container` の下端に残る隙間を、`.term-container` の背景にターミナルテーマ色 `#0d1117` を当てることで隠す）
- [ 不具合修正 ] 入力待ち（🟡 入力待ち）の検知漏れを修正。Claude Code の TUI 再描画や recap メッセージ、ウィンドウリサイズ起因のプロンプト枠再描画によって、確認文（例: 「ご確認をお願いします」）が直近行バッファ（旧: 15 行）から押し出されインジケータが点灯しなくなる不具合を修正（バッファを 80 行／8000 文字に拡張）。あわせて WAITING_PATTERNS に recap で多用される確認待ち表現（「承認待ち」「ご判断ください」「お待ちしています」「いただけたら〜委任/お願い」等）を追加
- [ デザイン不具合修正 ] ペイン上部ステータスインジケータ（issue #27）について、`.pane.drag-over` の緑（#3fb950）と衝突していた running 色を同系統に統一、idle ↔ 表示の切替で発生していた cwd 位置のジッタを `visibility: hidden` + `min-width` 予約で解消、`role="status" aria-live="polite"` と `aria-label` 動的更新で SR 対応、絵文字（🟢🟡）を `::before` で描画する 6×6 の currentColor ドットに置換、`.pane-badge` 共通クラスへ `.pane-status` / `.auto-input-badge` の共通プロパティを集約、`badge-pulse` の周期を `1.5s` に揃え `.pane.waiting` 枠と位相を同期するよう修正
- [ 機能追加 ] 入力待ち判定（WAITING_PATTERNS）に日本語パターンを追加。vk-kore など Claude が確認を求めて中断するケース（「ご確認をお願いします」「続行しますか」「進めてよろしい」「〜よろしいでしょうか」）と、PR 作成後のマージ判断委譲（「マージ判断」「マージ〜ご判断/お任せ/お願い」等）で「🟡 入力待ち」インジケータが点灯するように
- [ 機能追加 ] ペイン上部のタスクタイトル行に外部リンクを指定できるように変更。`POST /api/set-title` に `url` フィールド（任意・`http(s):` のみ・2048 文字以内）を追加し、API 由来タイトル（`apiTitle`）表示時かつ `url` が設定されているときに限り、タイトル全体を `<a>` 化（末尾に外部リンクマーク `↗` を表示）。クリックすると `shell.openExternal()` で OS の既定ブラウザを開く。`url` を省略すると従来通り URL なし表示、空文字 `""` で既存 URL をクリア。`url` のバリデーション違反は `400` を返す。`states.json` および `GET /api/states` のレスポンスに `apiUrl` フィールドを追加（後方互換のため既存フィールドは維持）
- [ その他 ] `main.js` と `renderer/app.js` に重複していた `stripAnsi` を `utils/stripAnsi.js` に共通化（用途別に表示用 `stripAnsiForDisplay` とパターンマッチング用 `stripAnsiForPattern` の 2 関数をエクスポート。正規表現は両方の意図を維持したまま据え置き）
- [ 機能追加 ] ペイン上部のヘッダ左側に動作ステータスインジケータ（🟢 実行中／🟡 入力待ち）を追加。PTY 出力中は緑、入力待ち（既存の WAITING_PATTERNS ヒット時）は黄、それ以外は非表示。`states.json` および `GET /api/states` のレスポンスに `status` フィールド（`'idle' | 'running' | 'waiting'`）を追加（既存 `waiting` フィールドは後方互換のため維持）
- [ 仕様変更 ] 旧 `.waiting-badge`（⚠ 待機中）を新ステータスインジケータに統合して削除。入力待ち表示は `🟡 入力待ち` バッジに一本化（`.pane.waiting` 枠の点滅アニメーションは引き続き動作）
- [ 機能追加 ] 上下分割されたペインを折り畳めるように変更。ヘッダの ▾ ボタン（折り畳み中は ▴）で展開・折り畳みを切り替え。折り畳み中はタスクタイトル行とヘッダのみ表示し、xterm 領域を隠して兄弟ペインを広げる（PTY プロセスは生存し続けるため、出力や waiting バッジは継続）
- [ 機能追加 ] 各ペイン上部に「タスクタイトル行」を追加。OSC 0 / OSC 2 のターミナルタイトル変更（例: `printf '\033]0;ビルド中\007'`）と HTTP API（`POST /api/set-title { termId, title }`）の両方から設定可能。空のときはタイトル行を非表示にして xterm 表示領域を圧迫しない
- [ 機能追加 ] ペインヘッダに上下左右の移動ボタン（◀ ▼ ▲ ▶）を追加。クリックで該当方向にある隣接ペインと位置を入れ替え（PTY セッションは維持・termId 紐付けも変わらない）
- [ 機能追加 ] 起動時 CLI フラグ `--no-claude`（`--plain` も同義）を追加。指定すると新規ペインで claude を自動起動せず素のシェルとして開く（`initialCommand` も送信しない）。`additionalPanes` 設定で個別に `noClaude: true` も指定可能
- [ 機能追加 ] HTTP API（`POST /api/new-pane`）のリクエストボディで `noClaude: true` を指定できるように変更（指定された場合、新規ペインで claude を自動起動せず素のシェルとして開く）
- [ 機能追加 ] HTTP API（`POST /api/new-pane`）のリクエストボディで `cwd` を指定できるように変更（指定があればそのディレクトリ、未指定ならホームディレクトリで新規ペインを開く）
- [ 仕様変更 ] ペインを分割した際、分割元のカレントディレクトリを継承せず常にホームディレクトリで開くよう変更（API 経由で `cwd` が明示された場合のみその場所で開く）
- [ 仕様変更 ] HTTP API（`POST /api/new-pane`）経由で新規ペインを作成する際、フォーカス中ペインではなく表示面積が一番大きいペインを対象に分割するよう変更
- [ 機能追加 ] 設定ファイル（`config.json`）に `additionalPanes` を追加。起動時に追加で開くペインを `cwd` 指定で複数枚作成できる（各ペインは指定ディレクトリで claude が立ち上がる）
- [ 仕様変更 ] HTTP API（`POST /api/new-pane`）経由で新規ペインを作成する際、対象ペインの長辺方向に分割するよう変更（横にだけ広がらず、縦横バランスよくグリッド状に増える挙動に）
- [ 不具合修正 ] 2 つ目以降のターミナルで信頼確認プロンプトが自動承認されず待機状態のままになる不具合を修正（Claude Code の新 UI 文言 "Enter to confirm" にも対応）
- [ 不具合修正 ] Claude Code フッターの "bypass permissions on" 表示によってターミナルが入力待ち状態として誤判定される不具合を修正
- [ 機能追加 ] HTTP API に `POST /api/new-pane` エンドポイントを追加（新規ペインを作成して termId を返す）
- [ 不具合修正 ] Claude の初期化が 4 秒以内に終わらない場合に initialCommand（起動時自動実行コマンド）が無視されてしまう不具合を、Claude のプロンプト（`? for shortcuts`）検知方式に変更して修正
- [ 不具合修正 ] 新規ディレクトリで起動した際の信頼確認プロンプト（`Do you trust the files in this folder?`）で待機して initialCommand が送信されない不具合を修正（Enter を自動送信して承認）
- [ 仕様変更 ] アプリ名を claude-terminals から vk-terminals に変更
- [ 仕様変更 ] 設定・データディレクトリを `~/.vk-terminals/` に変更（旧パス `~/.claude/terminals-config.json` も後方互換で読み込み）
- [ 機能追加 ] 各ターミナルの状態を `~/.vk-terminals/states.json` に定期書き出しする機能を追加
- [ 機能追加 ] ローカル HTTP API（port 13847）を追加し、外部からターミナルの状態取得・コマンド送信が可能に

## 1.3.0

- [ 機能追加 ] ファイル・フォルダをターミナルペインにドラッグ&ドロップするとカーソル位置に絶対パスを挿入する機能を追加（複数ファイルはスペース区切り、スペースを含むパスはシングルクォートで囲む）

## 1.2.0
- [ 機能追加 ] Shift+Enter で改行を送信できる機能を追加（Claude Code の keybindings.json 対応）

## 1.1.0
- [ 機能追加 ] 起動時に新バージョン（git タグ）があるか確認し、あれば自動で `git pull` して再起動を促す機能を追加
- [ デザイン不具合修正 ] ボタンのサイズ・文字サイズ・色を調整

## 1.0.0
- [ 機能追加 ] 起動時に自動実行するコマンドをユーザー設定ファイル（`~/.vk-terminals/config.json` または `config.json`）で指定できる機能を追加
