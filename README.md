# vk-terminals

複数のターミナルを並べて表示できる Electron 製デスクトップアプリです。
起動すると自動的に `claude` コマンドが実行されます。

## スクリーンショット

ペインを自動折返しグリッドに並べて複数の Claude セッションを同時に操作できます。

## 必要環境

- Node.js 20 以上
- macOS / Windows（`node-pty` のネイティブビルドが必要。Windows でのセットアップは[後述](#windows-での起動)）

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

### GPU 起動モード（`VK_TERMINALS_GPU`）

VK Terminals は Electron アプリのため、macOS 以外（WSLg などの Linux）では Chromium の GPU 初期化が失敗し、起動時に `Exiting GPU process` / `kTransientFailure` などのエラーログが大量に出ます（利用可能な Vulkan ICD がソフトウェア実装のみで SwiftShader へフォールバックするため）。環境変数 `VK_TERMINALS_GPU` で挙動を選べます。

| 値 | 挙動 |
|---|---|
| 未設定（自動） | macOS は通常起動、それ以外は `off` 相当 |
| `off` | GPU を無効化してエラーログを抑制（描画はソフトウェア。ターミナル用途で実害なし） |
| `default` | フラグを足さず Chromium 任せ（元の挙動。macOS 以外では GPU 初期化エラーが出る場合あり） |

> WSLg での HW アクセラ（HW OpenGL / Vulkan）は対応しません。Vulkan は HW ICD（dzn 等）が WSLg に無く、OpenGL も体感差が無いうえ Mesa/Dawn 由来の警告が出るためです。

#### WSLg で出る `vkCreateInstance` / `libEGL.so` 警告について（無害）

`off` で起動しても、claude 起動後（起動から数分後のこともある）に次のような警告が stderr に出ることがあります。

```
Warning: loader_get_json: Failed to open JSON file lvp_icd.json
（他の *_icd.json も同様）
Warning: vkCreateInstance: Found no drivers!
Warning: vkCreateInstance failed with VK_ERROR_INCOMPATIBLE_DRIVER
    at ... third_party/dawn/src/dawn/native/vulkan/BackendVk.cpp ...
Warning: Failed to load libEGL.so
    at DiscoverPhysicalDevices (../../third_party/dawn/src/dawn/native/opengl/BackendGL.cpp:74)
```

これは Chromium がバックグラウンドで行う GPU 情報収集で、**WebGPU 実装の Dawn が Vulkan / OpenGL アダプタを探索**した際のログです。WSLg では次の理由で探索に失敗しますが、**いずれも完全に無害**で、描画はソフトウェアにフォールバックしてアプリは正常動作します（`--disable-gpu` とは別経路のため `off` でも出ます）。

- **Vulkan**: ICD マニフェスト（`/usr/share/vulkan/icd.d/*.json`）や実ドライバ（例: lavapipe の `libvulkan_lvp.so`）自体は存在するが、サンドボックス化された GPU プロセスからは読めず「ドライバ無し」となる。
- **OpenGL**: Dawn が `libEGL.so`（バージョン無し）を `dlopen` するが、WSLg には `libEGL.so.1` しか無く symlink が無いため失敗する。

このアプリは WebGPU を使わないため実害はありません。`VK_TERMINALS_GPU`・`config.json`・設定パネルのどのモードでも、また `--disable-features=Vulkan,WebGPU` 等の Chromium フラグでもこのバックグラウンド探索は止められない（この Electron/Chromium バージョンの挙動）ため、**この警告は無視して問題ありません**。

```bash
VK_TERMINALS_GPU=off npm start
```

`config.json` の `gpu` キーでも同じ値を指定できます（永続設定向け）。

```json
{ "gpu": "off" }
```

設定パネル（歯車 → 「設定」タブ → 「GPU 起動モード」）からも選択できます（保存後の再起動で反映）。

モードの優先順位は **環境変数 `VK_TERMINALS_GPU` > `config.json` の `gpu`（＝設定パネル） > プラットフォーム既定** です（環境変数がその場の上書きとして config を上回ります）。

> `electron . --disable-gpu` のように GPU 関連スイッチを直接指定して起動した場合は、そちらを尊重して `VK_TERMINALS_GPU` / `config.json` の自動適用は行いません（呼び出し側の指定を優先。VK Orchestrator 経由の起動もこの経路）。

## WSLg での起動

Windows 上の WSL2（WSLg）でも動作します。GUI が Windows 側にそのまま表示されます。

### 1. 前提パッケージ

WSL 側（Ubuntu 等）に以下が必要です。

```bash
sudo apt update
sudo apt install -y build-essential python3
```

`node-pty` はネイティブモジュールのため、`npm install` 時に自動でビルドされます（上記ビルドツールが前提）。

### 2. `claude` コマンドの用意

WSL 側のシェルに `claude`（Claude Code CLI）をインストールしてください。Windows 側にインストールしたものは共有されません。

```bash
npm install -g @anthropic-ai/claude-code
```

### 3. 起動

```bash
npm start
```

既定（`VK_TERMINALS_GPU` 未設定）では GPU を無効化して起動するため、`Exiting GPU process` / `kTransientFailure` / `VK_ERROR_INCOMPATIBLE_DRIVER` などのエラーログは出ません（詳細は[GPU 起動モード](#gpu-起動モードvk_terminals_gpu)を参照）。

起動後、ログに `[vk-terminals] API server listening on http://127.0.0.1:13847` が出ていれば正常です。以下で疎通確認できます。

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:13847/
# => 200
```

## Windows での起動

macOS 前提の部分があるため、まっさらな Windows 環境でセットアップする場合は以下を確認してください。

### 1. 前提ツール

- Node.js 20 以上（[Volta](https://volta.sh/) や [nvm-windows](https://github.com/coreybutler/nvm-windows) 経由でも可）
- `node-pty` のネイティブビルドに必要な C++ ビルドツール
  - [Visual Studio Build Tools](https://visualstudio.microsoft.com/ja/downloads/)（「C++ によるデスクトップ開発」ワークロード）
  - もしくは `npm install -g windows-build-tools`（環境によっては非推奨）
- `npm install` 時に `node-pty` のビルド（`electron-rebuild`）が postinstall で自動実行されます。失敗した場合は `npx electron-rebuild -f -w node-pty` を手動で実行してください
  - 環境変数 `NoDefaultCurrentDirectoryInExePath` が設定されていると、`node-pty` 同梱の winpty のビルドが `'GetCommitHash.bat' ... 認識されていません` で失敗します（winpty の `winpty.gyp` がバッチをファイル名だけで呼び出すため、カレントディレクトリ検索が無効化されていると解決できないのが原因）。この変数を（後述の 5. のセキュリティ目的で）有効化している場合は、ビルド中だけ一時的に無効化してください。例: PowerShell で `$env:NoDefaultCurrentDirectoryInExePath=$null; npm install`

### 2. `claude` コマンドの用意

起動時に各ペインで自動実行される `claude` コマンド（Claude Code CLI）が必要です。**ネイティブインストーラ（推奨）**が最も簡単で、npm / Volta のシムを介さない単体 `claude.exe` を導入します。

```powershell
irm https://claude.ai/install.ps1 | iex
```

- インストール先は `%USERPROFILE%\.local\bin\claude.exe`。インストーラの案内どおり、このディレクトリを**ユーザー PATH に追加**してください（未追加の場合は警告が出ます）。追加後は**ターミナル / VSCode を再起動**して反映させます。
- アップデートは `claude update` で完結します。
- npm や Volta のシムを使わないため、**ユーザー名にスペースを含む環境（例: `C:\Users\First Last\...`）でも問題なく動作**します（vk-terminals が各ペインで実行する裸の `claude` コマンドがそのまま解決されます）。

代替として npm グローバルインストールも利用できます。

```powershell
npm install -g @anthropic-ai/claude-code
```

こちらを使う場合、`claude` が見つからない・起動しないときは以下を確認してください。

- **PowerShell / コマンドプロンプトを開き直しても `claude` が見つからない場合**：VSCode などのエディタ内蔵ターミナルから `npm install -g` した場合、そのプロセスツリーは起動時点の古い PATH を引き継いだままのことがあります。**VSCode やターミナルアプリ自体を再起動**すると解消します。
- **Volta 環境でユーザー名にスペースが含まれる場合**、Volta が生成する `.cmd` シムがパスをスペースで分断し `'C:\Users\First' は認識されていません` のように失敗することがあります。この場合は上記のネイティブインストーラへの切り替えを推奨します（`volta uninstall @anthropic-ai/claude-code` で Volta 版を外してから導入してください）。

### 3. VSCode 統合ターミナルから `npm start` する場合の注意

VSCode 自体が Electron 製アプリであるため、その内蔵ターミナルには `ELECTRON_RUN_AS_NODE=1` が環境変数として設定されています。この変数を継承したまま `npm start`（内部的に `electron .`）を実行すると、Electron がプレーンな Node.js として起動してしまい `TypeError: Cannot read properties of undefined (reading 'whenReady')` で失敗します。

回避策：

```powershell
Remove-Item Env:\ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npm start
```

もしくは VSCode ではなく通常の PowerShell / コマンドプロンプトから起動してください。

### 4. デフォルトシェル・作業ディレクトリ

Windows では各ペインのデフォルトシェルとして `%COMSPEC%`（通常 `cmd.exe`）または `powershell.exe` が、デフォルト作業ディレクトリとして `%USERPROFILE%` が使われます（`SHELL` / `HOME` 環境変数が設定されていればそちらを優先）。

### 5. パス指定の注意点

- `config.json` の `additionalPanes[].cwd` に Windows パスを書く場合、JSON 文字列内の `\` はエスケープが必要です（例: `"C:\\Users\\you\\project"`）。エスケープ不要な `/` 区切り（例: `"C:/Users/you/project"`）でも Node.js 上では問題なく解決されます。
- ユーザー名やインストール先にスペースを含むパス（例: `C:\Users\First Last\...`）は、コマンドラインから直接実行するツールやシムスクリプトで引用符の扱いが原因で正しく解決されないことがあります（実例: Volta の `.cmd` シムがスペース入りパスで壊れるケース）。PATH に追加するディレクトリや実行ファイルのパスにスペースが含まれる場合は注意してください。
- ユーザー設定ファイルの探索先 `~/.vk-terminals/config.json` は、Windows では `os.homedir()`（`%USERPROFILE%`）配下、つまり `%USERPROFILE%\.vk-terminals\config.json` に読み替えられます。
- `cwd`（`additionalPanes[].cwd` や HTTP API `/api/new-pane` の `cwd`）は必ず **Windows ネイティブ形式**（`C:\Users\you\project` または `C:/Users/you/project`）で指定してください。`node-pty` 内部で Node.js の `path.resolve()` を通すため、Git Bash / WSL 由来の POSIX 形式パス（`/c/Users/you/project` など）を渡すとドライブレターが正しく解決されず、意図しないディレクトリが開かれます。
- リポジトリ自体は `C:\` 以外のドライブ（例: `D:\dev\vk-terminals`）に置いても問題なく動作します。ただし `C:\Program Files\...` のような管理者権限が必要なディレクトリや、OneDrive 同期対象フォルダ（既定の `ドキュメント` / `デスクトップ` が同期対象になっている場合あり）に置くと、`npm install` 時のネイティブビルド（`node-pty`）が権限エラーやファイルロックで失敗することがあります。`C:\dev\...` のような同期対象外の短いパスを推奨します。
- リポジトリを配置するディレクトリ自体にスペースが含まれる場合（例: `C:\Users\Taro Yamada\Documents\vk-terminals`）、`node-pty` の `node-gyp` 経由のネイティブビルドがパス中のスペースが原因で失敗することがあります（`npm install` / `electron-rebuild` がビルドツールへの引数展開でパスを分割してしまうケース）。ビルドエラーが出た場合は、まずスペースを含まないパス（例: `C:\dev\vk-terminals`）に配置し直して切り分けてください。
- （セキュリティ向け補足）Windows は既定で、実行ファイル名の解決時に **カレントディレクトリを PATH より先に検索**します。vk-terminals の各ペインは `cwd` を作業ディレクトリとしてシェルを起動するため、信頼できないリポジトリ（`cwd` に指定したフォルダ）に `claude.exe` など正規コマンドと同名の実行ファイルが紛れ込んでいると、そちらが誤って実行される恐れがあります。気になる場合は環境変数 `NoDefaultCurrentDirectoryInExePath=1` を設定すると、カレントディレクトリ検索を無効化し PATH のみから解決されるようになります（`setx NoDefaultCurrentDirectoryInExePath 1` 等）。`setx` はユーザー環境変数としてレジストリに恒久保存されますが、**反映されるのは次回以降に開くコマンドウィンドウのみで、実行した現在のセッションには反映されません**（現在のセッションだけで即座に有効化したい場合は `$env:NoDefaultCurrentDirectoryInExePath=1` を使います）。なお、この変数を有効化すると `node-pty`（winpty）のネイティブビルドが失敗するため、`npm install` の際は一時的に無効化する必要があります（詳細は「1. 前提ツール」を参照）。セキュリティ目的で恒久的に有効化するのではなく一時的な検証として設定しただけの場合は、`reg delete "HKCU\Environment" /F /V NoDefaultCurrentDirectoryInExePath` で削除して元に戻せます（削除も同様に次回以降のウィンドウから反映されます）。

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

### サイドバーへのペイン格納

グリッド上のペインは、サイドバーに「格納」して表示エリアを空けられます（issue #89）。格納中もターミナルは稼働を継続し、必要になったらグリッドへ戻せます。サイドバーの幅はドラッグで変更できます。HTTP API `POST /api/new-pane` に `stashed: true` を指定すると、最初から格納＋折りたたみ状態でペインを開けます。

格納したペインのヘッダーも、メインエリアと同様にタイトル行＋操作アイコン行の2段表示で、`PR ↗` リンクやタイトルリンクが表示されます（issue #112）。

## サイドバーメニュー

Claude Desktop 風のサイドバーに、外部リンクや設定モーダル起動などの項目を追加表示できます（issue #80）。項目は次の 2 系統から供給できます。

- `config.json` の `menuItems`（永続設定）
- HTTP API `POST /api/menu`（外部から動的に登録・置換。前述の[`POST /api/menu`](#post-apimenu)を参照）

各項目は `id` / `label` / `icon`（任意）/ `action` を持ち、`action.type` は `open-url`（URL を OS の既定ブラウザで開く）または `open-settings`（設定モーダルを開く）に対応します。`config.json` の記述例は [`config.example.json`](config.example.json) を参照してください。

## Claude 使用量表示

Claude の利用状況（セッション使用率 / 週間制限の使用率とリセット時刻）を、サイドバー最上部の「Claude使用量」として常時表示します（issue #69 / #73 / #109）。

- 表示は opt-out 方式で既定 ON です。`config.json` の `showUsage: false`（または設定パネルの「トークン使用量を表示」をオフ）で無効化できます。
- 値は公式 usage API（`source: 'oauth'`）を主とし、取得できない場合はローカルのトランスクリプト集計（`source: 'transcript'`）にフォールバックします。
- 同じ使用量スナップショットは `GET /api/states` レスポンスのトップレベル `usage` にも含まれ、モバイルページ（後述）でも表示されます。

## モバイルページ

vk-terminals を起動している間は、パソコン（vk-terminals を動かしているマシン）の中で小さな Web サーバー（ページの配信係）も一緒に動いています。スマートフォンのブラウザでその Web サーバーのアドレスを開くと、全ターミナルの状況をまとめて見られる専用ページが表示され、応答などの簡単な操作もできます。スマートフォン側にアプリをインストールする必要はなく、普段使っているブラウザだけで使えます。ただし初期設定では vk-terminals を動かしているマシン自身からしか見えないため、スマートフォンから見るには後述の設定が必要です。

HTTP API サーバーのルート（`GET http://<apiHost>:13847/`）は、スマートフォン等のブラウザから全ペインの状態確認と簡易操作ができるモバイル向け Web ページを返します。ページは `GET /api/states` を約 2 秒ごとにポーリングして、タスクタイトル・稼働ステータス・直近の出力プレビュー・Claude 使用量を更新します。

### スマートフォンから開く手順

既定では HTTP API サーバーは `127.0.0.1:13847` で待ち受けるため、同じパソコン上からしか見えません。スマートフォンなど LAN 内の別端末から開く場合は、パソコンの LAN IP アドレスを `apiHost` に設定します。

`apiHost` を LAN IP にすると、同一ネットワーク上の全端末から**無認証で**ターミナルを閲覧・操作できるようになります。必ず信頼できるネットワークでのみ設定してください（詳細は後述の[セキュリティ上の注意](#セキュリティ上の注意)を参照）。

1. パソコンとスマートフォンを同じ信頼できるネットワークに接続します。
2. パソコンの IP アドレスを確認します。macOS の Wi-Fi ではターミナルで `ipconfig getifaddr en0` を実行するか、「システム設定」→「Wi-Fi」→接続中ネットワークの詳細から確認します。Windows ではコマンドプロンプトで `ipconfig` を実行し、接続中のアダプターの「IPv4 アドレス」を確認します。
3. タイトルバー右端の ⚙ →「設定」タブで「API ホスト」にパソコンの IP アドレス（例: `192.168.1.23`）を入力して保存します。`config.json` を直接編集する場合は、`"apiHost": "192.168.1.23"` のように指定します。設定ファイルの場所や優先順位は[起動時の初期コマンド設定](#起動時の初期コマンド設定)、設定パネルの挙動は[設定パネル](#設定パネル)を参照してください。
4. vk-terminals を再起動します。`apiHost` は起動時に読み込まれるため、保存後の再起動が必要です。
5. スマートフォンのブラウザで `http://<パソコンのIP>:13847/`（例: `http://192.168.1.23:13847/`）を開きます。

WSL2 上で vk-terminals を動かしている場合は、Windows との間に仮想ネットワークを挟むため、LAN 内の他端末からアクセスするには Windows 側でのポート転送（`netsh interface portproxy` など）の追加設定が必要です（関連: [WSLg での起動](#wslg-での起動)）。

ポートは通常 `13847` です。テストや並列起動では環境変数 `VK_TERMINALS_API_PORT` で上書きできますが、通常利用では変更不要です。

`GET /api/health` は疎通確認用に `{ "ok": true }` を返します。起動時に環境変数 `VK_TERMINALS_INSTANCE_ID` を指定すると、レスポンスに `instanceId` も含めます（未指定または空文字の場合は従来どおり含めません）。`instanceId` は無認証の API ポートに到達できる利用者なら誰でも読めるため、`VK_TERMINALS_INSTANCE_ID` には認証情報などの機密値ではなく、取り違え検出用の非機密の識別子を指定してください。

### 外出先からのアクセス

外出先から使う場合は、Tailscale などの信頼できるプライベートネットワーク経由で公開してください。実装上は、`tailscale serve` などで vk-terminals を動かしているマシンの `127.0.0.1:13847` を tailnet に公開して使う想定です。

`apiHost` に Tailscale IP（`100.x.x.x`）を指定して tailnet 内から `http://<Tailscale IP>:13847/` を開く構成も使えます。Tailscale 未接続などで指定した `apiHost` が割り当てられていない場合、API サーバーは `127.0.0.1` にフォールバックして起動します。

### モバイルページでできること

- 全ペインのタスクタイトル・作業ディレクトリ・`idle` / `running` / `waiting` ステータス・直近出力プレビューを確認できます。`waiting` は点滅表示されます。
- Claude 使用量表示が有効な場合は、サイドバーと同じ使用量スナップショットをページ上部に表示します。設定は[Claude 使用量表示](#claude-使用量表示)を参照してください。
- 各ペインのヘッダーをタップして、出力プレビューと操作ボタンを折りたためます。折りたたみ状態は端末の localStorage に保存されます。
- PR URL が設定されている場合は、ヘッダーの `PR ↗` またはタイトルをタップして別タブで開けます（issue #103）。
- クイックボタンから `1` / `2` / `3` / `↵ Enter` / `Yes (y↵)` / `No (n↵)` / `Esc` / `Ctrl-C` を送信できます。
- 自由入力欄から任意のテキストを送信できます。「末尾に改行(↵)を付ける」をオンにすると Enter 付きで送信します。
- ▲▼ ボタンでペインの並び順を手動変更できます。順序は端末の localStorage に保存されます（issue #106）。
- 「ターミナルを終了」ボタンで対象ペインを終了できます。実行中のプロセスも停止し、元に戻せません（issue #100）。

モバイルページ内には新規ペイン作成ボタンはありません。外部からペインを作成する場合は HTTP API の [`POST /api/new-pane`](#post-apinew-pane) を使用してください。

### セキュリティ上の注意

モバイルページと HTTP API には認証がありません。`POST /api/send` などの更新系エンドポイントには Host ヘッダと Origin ヘッダを突き合わせる CSRF 対策がありますが、到達できる端末からはターミナル操作が可能です。

- 自宅 LAN や tailnet など、信頼できるネットワーク以外には公開しないでください。
- `0.0.0.0` を `apiHost` に指定すると全インターフェースで待ち受けます。公開ネットワークや不特定多数が接続できる LAN では非推奨です。
- 指定した `apiHost` が使えない場合は `127.0.0.1` にフォールバックするため、スマートフォンから見えないときは起動ログの `API server listening on ...` を確認してください。

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
- `showUsage`：Claude の使用量表示（サイドバー最上部の「Claude使用量」・モバイルページ）の ON/OFF。opt-out 方式で、省略時は ON。明示的に `false` にしたときだけ無効化されます（後述の[Claude 使用量表示](#claude-使用量表示)を参照）。
- `menuItems`：サイドバーに表示する追加メニュー項目（外部リンク・設定モーダル起動）のリスト。省略時は表示なし（後述の[サイドバーメニュー](#サイドバーメニュー)を参照）。
- `apiHost`：HTTP API サーバーの待受ホスト。省略時は `127.0.0.1`。LAN やモバイル端末からアクセスさせたい場合に自ホストの IP などを指定します。
- `gpu`：GPU 起動モード（`off` / `default` / 未設定）。詳細は[GPU 起動モード](#gpu-起動モードvk_terminals_gpu)を参照。
- `agentroom`：`true` にすると、各ペイン下部に開閉式の「エージェントルーム」を表示します（後述の[エージェントルーム](#エージェントルームissue-58)を参照）。省略時は `false`（非表示）。**現在は β 扱いで一旦無効化されており、設定パネルからは編集できません**（#70）。利用する場合は config.json に直接 `agentroom: true` を記述してください。

> **移行メモ**: 旧パス `~/.claude/terminals-config.json` も後方互換として読み込まれます。

## 設定パネル

タイトルバー右端の ⚙ ボタンから、設定を GUI 上で編集・保存できます。単体起動でも常に表示されます。

- **単体起動時**（`VK_TERMINALS_SETTINGS` 未指定）：vk-terminals 自身の `config.json`（`apiHost` / `initialCommand` / `showUsage` / `gpu` / `menuItems` / `additionalPanes`）を編集します。編集対象は `loadUserConfig()` と同じ探索順で、既存の `config.json` があればそれ、無ければリポジトリ直下 `config.json` を作成します。
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
- `type`：`text` / `password` / `number` / `boolean` / `select` / `json` のいずれか。`json` は配列・オブジェクトを textarea で編集します。`select` は許可された値のみ選べるピッカーで、`options`（`{ value, label }` の配列）を併記します。
- `default`（任意）：値が未設定のときの既定値。`boolean` で `default: true`（opt-out 項目）を指定すると、未設定のチェックボックスが誤ってオフ保存される問題を避けられます。
- `emptyToNull`（任意）：`text` / `password` / `select` で空欄を `null` として書き出します。
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
      "externalWaiting": false,
      "status": "idle",
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
| `externalWaiting` | `POST /api/set-status` で設定された外部権威の入力待ち状態 |
| `status` | 表示用ステータス（`idle` / `running` / `waiting`） |
| `lastOutputTime` | 最後に出力があった時刻（Unix ms） |
| `lastInputTime` | 最後にユーザーが入力した時刻（Unix ms） |
| `lastLines` | 最近の出力テキスト（ANSI除去済み、最大15行） |

各ペインには上記に加え、`POST /api/set-title` 由来の `apiTitle` / `apiUrl` / `apiPrUrl` / `apiPrMerged`、`agentroom: true` のときは `agentRoom` も含まれます（各エンドポイントの節を参照）。

また、レスポンスのトップレベルには `updatedAt` / `terminals` に加えて `usage`（Claude の使用量スナップショット）が含まれます。使用量表示が opt-out（`showUsage: false`）または取得失敗のときは `usage: null` です（後方互換）。モバイルページはこの `usage` を利用します（後述の[Claude 使用量表示](#claude-使用量表示)を参照）。

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

# PR ボタンをマージ済み表示（紫）にする
curl -s -X POST http://127.0.0.1:13847/api/set-title \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "title": "issue #44", "prUrl": "https://github.com/vektor-inc/vk-terminals/pull/99", "prMerged": true}'

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
- `prMerged`（任意・issue #113）: `PR ↗` ボタンをマージ済み表示（紫背景 + 非色アイコン）にする真偽値。**厳密な `true` のときだけ**マージ済み表示になり、それ以外の値（省略・`false`・文字列など）は通常表示（未マージ）になります。`prUrl` と組み合わせて使います。

| 挙動 |
|---|
| `title` / `url` / `prUrl` はペアで都度送る**置換セマンティクス**です（patch 形式ではありません）。一部だけ更新したい場合でも、必要な値はその都度すべて一緒に送る必要があります（送らないフィールドは「なし」扱いになります）。 |
| `url` が設定されている間のみ、ペインのタイトル文字列全体が `<a>` として描画され、末尾に外部リンクマーク `↗` が付きます。クリックすると `shell.openExternal()` で OS の既定ブラウザを開きます。 |
| OSC 0 / OSC 2 由来のタイトル（`taskTitle`）が表示されている間は `url` のリンク化は無効になります。API 由来のタイトル（`apiTitle`）が選択されているときだけリンク化されます。 |
| `prUrl` で表示される `PR ↗` ボタンは `apiTitle` / `taskTitle` のどちらが表示されている間でも常時表示されます（issue リンクが消える場面でも PR ボタンは独立に出続けます）。 |
| `prMerged: true` を送ると `PR ↗` ボタンがマージ済み表示（紫背景）に変わります。`prMerged` も他フィールド同様に置換セマンティクスで、送らなければ未マージ表示に戻ります。 |

レスポンス例:

```json
{ "ok": true, "termId": "1", "title": "issue #44", "url": "https://github.com/vektor-inc/vk-terminals/issues/44", "prUrl": "https://github.com/vektor-inc/vk-terminals/pull/99", "prMerged": true }
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

設定された値は `GET /api/states` のレスポンス（および `~/.vk-terminals/states.json`）の各ペインオブジェクトに `apiTitle` / `apiUrl` / `apiPrUrl` / `apiPrMerged` フィールドとして含まれます。

#### `POST /api/set-status`

指定ペインの入力待ち状態を外部権威として設定します。オーケストレーター等が GitHub status などの外部状態をもとに、ローカル PTY のパターン検知とは別レイヤーで `waiting` 表示を制御するための API です。

```bash
# 外部権威の入力待ちフラグを立てる
curl -s -X POST http://127.0.0.1:13847/api/set-status \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "waiting": true}'

# 外部権威の入力待ちフラグを解除する
curl -s -X POST http://127.0.0.1:13847/api/set-status \
  -H 'Content-Type: application/json' \
  -d '{"termId": "1", "waiting": false}'
```

リクエストボディ:

- `termId`: 対象のターミナル ID（必須）
- `waiting`: 外部権威の入力待ち状態（真偽値必須）。文字列 `"true"` / `"false"` は受け付けません。

挙動:

- `waiting: true` を送ると、ローカル PTY 検知の `waiting` が false でも表示用 `status` は `waiting` になります。
- `waiting: false` を送ると、外部権威フラグだけを解除します。ローカル PTY 検知の `waiting` が true の場合、表示用 `status` は引き続き `waiting` です。
- 外部権威フラグは自動入力（`POST /api/send`）・リサイズ・再描画では解除されず、`POST /api/set-status` で `waiting: false` が明示 push されたときだけ解除されます。

レスポンス例:

```json
{ "ok": true, "termId": "1", "waiting": true }
```

エラー例:

- `400 {"error": "termId required"}` — `termId` 未指定
- `400 {"error": "waiting must be a boolean"}` — `waiting` が真偽値以外
- `404 {"error": "terminal <id> not found"}` — 指定 `termId` のペインが存在しない

設定された値は `GET /api/states` のレスポンス（および `~/.vk-terminals/states.json`）の各ペインオブジェクトに `externalWaiting` フィールドとして含まれます。表示用 `status` はローカル `waiting` と `externalWaiting` の OR で `waiting` になります。

#### `POST /api/new-pane`

新規ペインを作成し、作成されたターミナルの `termId` を返します。ペインは通常グリッドの末尾に追加され、全体は自動折返しグリッドで再配置されます。`stashed: true` を指定した場合はサイドバー格納＋折りたたみ状態で作成されます。

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

# サイドバーに格納して折りたたみ状態で開く
curl -s -X POST http://127.0.0.1:13847/api/new-pane \
  -H 'Content-Type: application/json' \
  -d '{"stashed": true}'
```

リクエストボディ（任意）:

- `cwd`：新規ペインのカレントディレクトリ（絶対パス）。未指定ならホームディレクトリ。
- `noClaude`：`true` の場合、新規ペインで claude を自動起動せず素のシェルとして開く。未指定なら起動時の `--no-claude` フラグの値に従う。
- `stashed`：`true` の場合、新規ペインをサイドバー格納＋折りたたみ状態で開く。未指定または `false` ならグリッドに追加。

レスポンス:

- 成功時: `200 {"ok": true, "termId": "<新規ターミナルID>"}`
- ウィンドウが利用できない: `503 {"error": "window not available"}`
- タイムアウト（15秒）: `504 {"error": "timeout waiting for new pane"}`
- renderer 側でペイン作成に失敗（既存ペインなし／分割失敗など）: `500 {"error": "<renderer からのエラーメッセージ>"}`

#### `POST /api/close-pane`

指定した `termId` のペインを閉じます（`✕` ボタンと同じ操作を外部から実行します）。

```bash
curl -s -X POST http://127.0.0.1:13847/api/close-pane \
  -H 'Content-Type: application/json' \
  -d '{"termId": "3"}'
# => {"ok":true,"termId":"3"}
```

リクエストボディ:

- `termId`：閉じる対象のターミナル ID（必須）。

レスポンス:

- 成功時: `200 {"ok": true, "termId": "<閉じたターミナルID>"}`
- `termId` 未指定: `400 {"error": "termId required"}`
- 不正な JSON: `400 {"error": "invalid JSON"}`
- 指定 `termId` のペインが存在しない: `404 {"error": "terminal <id> not found"}`
- ウィンドウが利用できない: `503 {"error": "window not available"}`
- タイムアウト（15秒）: `504 {"error": "timeout waiting for close pane"}`

#### `POST /api/menu`

サイドバーに表示する追加メニュー項目を `source` 単位で登録・置換します（`config.json` の `menuItems` と同じ内容を外部から動的に反映させる用途）。同じ `source` を再送すると置換、`items: []` を送るとその `source` の項目をクリアします。

```bash
# source ごとにメニュー項目を登録・置換
curl -s -X POST http://127.0.0.1:13847/api/menu \
  -H 'Content-Type: application/json' \
  -d '{
        "source": "vk-orchestrator",
        "title": "VK Orchestrator",
        "items": [
          { "id": "task-queue", "label": "task-queue", "icon": "📋",
            "action": { "type": "open-url", "url": "https://github.com/vektor-inc/task-queue/issues" } }
        ]
      }'

# 指定 source の項目をクリア
curl -s -X POST http://127.0.0.1:13847/api/menu \
  -H 'Content-Type: application/json' \
  -d '{"source": "vk-orchestrator", "items": []}'
```

リクエストボディ:

- `source`：メニューのグループ識別子（必須）。同じ `source` の再送で置換されます。
- `title`（任意）：サイドバーに表示するグループ見出し。
- `items`：メニュー項目の配列。各項目は `id` / `label` / `icon`（任意）/ `action` を持ちます。`action.type` は `open-url`（`url` を OS の既定ブラウザで開く）または `open-settings`（設定モーダルを開く）のみ対応。`items: []` で該当 `source` をクリアします。

レスポンス:

- 成功時: `200 {"ok": true, "source": "<source>"}`
- バリデーション違反 / 不正な JSON: `400 {"error": "<内容>"}`
- 登録済み source 数の上限超過: `400 {"error": "too many menu sources (max <N>)"}`

> サイドバーメニューの詳細は後述の[サイドバーメニュー](#サイドバーメニュー)を参照してください。

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

> **現状（β・一旦無効化）**: エージェントルームは β 機能として、issue #70 で設定パネルからの項目とデフォルト表示を無効化しています。設定パネルからは切り替えられません。以下の内容は `config.json` に直接 `agentroom: true` を記述して有効化した場合の挙動です。

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
