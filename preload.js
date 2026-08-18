// ─── preload（issue #268 / #323） ─────────────────────────────────────────────
//
// BrowserWindow を nodeIntegration: false / contextIsolation: true で作るのに合わせ、
// renderer が必要とする機能だけを contextBridge で「名前を付けた API」として渡す。
//
// 狙い: 表示処理のどこか 1 箇所でエスケープ漏れが起きても、そこから任意コード実行
//       （require('child_process') など）へ到達させない。renderer には Node も
//       Electron のモジュールも一切見えない状態にし、ここに書いた関数だけを通す。
//
// sandbox は既定（true）のまま使う（issue #323）。
//   sandbox: true の preload から require できるのは Electron の一部モジュール
//   （electron 自身が提供する contextBridge / ipcRenderer 等）と一部の Node 組み込み
//  （events / timers / url など）だけで、fs / path やローカルファイルの相対 require は
//   使えない。以前はここで fs / require.resolve を使って xterm 実体の絶対パスと
//   xterm.css の中身を解決していたが、その解決は main プロセス側（main.js の
//   ipcMain.handle('app:get-xterm-resources') / ('app:get-agent-room-sprites')）へ移し、
//   ここでは IPC 経由で受け取るだけにした。isSafeHttpUrl も同じ理由で
//   renderer/urlSafety.js を require せず、このファイル内に直接持たせている
//  （renderer/urlSafety.js 自体は mobile.html 側や settingsTabs.js 等が引き続き使うため残す）。
//   clipboard 書き込み上限（MAX_CLIPBOARD_TEXT_LENGTH・issue #325）も同じ制約のため
//   utils/clipboardLimits.js を require せず、BrowserWindow の
//   webPreferences.additionalArguments 経由で main.js から受け取っている
//  （詳細は下の定義箇所のコメントを参照）。

const { contextBridge, ipcRenderer } = require('electron');

// renderer/urlSafety.js の isSafeHttpUrl / MAX_SAFE_HTTP_URL_LENGTH と完全に同じ実装。
// sandbox 下の preload からはローカルファイルの require ができないため複製している
// （挙動を変えた場合は renderer/urlSafety.js 側にも反映すること）。
const MAX_SAFE_HTTP_URL_LENGTH = 2048;
function isSafeHttpUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.length > MAX_SAFE_HTTP_URL_LENGTH) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch (_e) {
    return false;
  }
}

// ─── チャンネル許可リスト ─────────────────────────────────────────────────────
// 任意チャンネルを呼べる汎用 invoke/send/on は公開しない。ここに載っていない
// チャンネルは preload が拒否する。main 側にハンドラを足したら、ここにも足すこと。

// renderer → main（応答あり）
const INVOKE_CHANNELS = new Set([
  'app:get-config',
  'app:get-xterm-resources',
  'app:get-agent-room-sprites',
  'widgets:command',
  'usage:get',
  'codex-usage:get',
  'settings:describe',
  'settings:api-server-status',
  'settings:save',
  'settings:content-table-saved-value',
  'settings:api-token-info',
  'settings:reissue-api-token',
  'terminal:create',
]);

// renderer → main（応答なし）
const SEND_CHANNELS = new Set([
  'terminal:input',
  'terminal:resize',
  'terminal:kill',
  'terminal:new-pane-created',
  'terminal:close-pane-done',
  'terminal:renderer-ready',
  'terminal:report-states',
]);

// main → renderer
const ON_CHANNELS = new Set([
  'menu:update',
  'widgets:update',
  'terminal:data',
  'terminal:exit',
  'terminal:title',
  'terminal:set-status',
  'terminal:set-lock',
  'terminal:auto-input',
  'terminal:agentroom',
  'terminal:request-new-pane',
  'terminal:request-close-pane',
]);

// clipboard へ渡してよい文字列の上限（issue #325）。定義は utils/clipboardLimits.js の
// 1 箇所のみで、ここではその値を持たない。sandbox 下の preload はローカルファイルの
// 相対 require ができず utils/clipboardLimits.js を直接 require できないため
// （理由は本ファイル冒頭コメント）、main.js が BrowserWindow 生成時に
// webPreferences.additionalArguments で渡した値を process.argv から読み取る。
//
// 引数が見つからない・数値として壊れている場合は Number.NaN のままにする。ここで
// 100000 のようなリテラルをフォールバックとして書くと定義が再び 2 箇所に増えてしまう
// ため、意図的に書かない。その代わり下の writeText() は「上限が確定できない場合は
// この層でのチェックをスキップし、main 側の最終防衛線（ipcMain.handle
// ('clipboard:write-text')）にそのまま委ねる」動きにしてある。通常起動では
// additionalArguments が必ず渡るためこの分岐には入らない。
const CLIPBOARD_MAX_LENGTH_ARG_PREFIX = '--clipboard-max-text-length=';
function readClipboardMaxLengthFromArgv() {
  const arg = process.argv.find(
    (a) => typeof a === 'string' && a.startsWith(CLIPBOARD_MAX_LENGTH_ARG_PREFIX)
  );
  // 通常起動では main.js が additionalArguments で必ず値を渡すため、ここに来るのは
  // 異常事態（main.js 側の変更漏れ等）。100000 のようなリテラルを再導入せずに済ませる
  // ため、フォールバック値ではなく警告ログだけを残す（安藤のセキュリティレビュー
  // 指摘・LOW-1）。
  if (!arg) {
    console.warn(`[vk-terminals] clipboard max length not found in argv; falling back to main-process validation only`);
    return NaN;
  }
  const value = Number(arg.slice(CLIPBOARD_MAX_LENGTH_ARG_PREFIX.length));
  if (!(Number.isInteger(value) && value > 0)) {
    console.warn(`[vk-terminals] clipboard max length in argv is malformed (${arg}); falling back to main-process validation only`);
    return NaN;
  }
  return value;
}
const MAX_CLIPBOARD_TEXT_LENGTH = readClipboardMaxLengthFromArgv();

function rejectChannel(kind, channel) {
  return new Error(`[vk-terminals] ${kind} channel not allowed: ${String(channel)}`);
}

// ─── on のリスナー管理 ────────────────────────────────────────────────────────
// コールバックへ ipcRenderer の event オブジェクトは渡さない。渡すと renderer から
// event.sender（webContents）を辿れてしまい、チャンネルを絞った意味が無くなる。
//
// 解除手段は「on() の戻り値の unsubscribe」だけにしてある。
// off(channel, listener) 形式は提供しない: contextBridge は renderer から渡された関数を
// 通すたびに新しいプロキシを作るため、on() のときの listener と off() のときの listener が
// 別オブジェクトになり、リスナーを引き当てられない（渡された関数を鍵にした解除は
// 原理的に成立しない）。戻り値のクロージャなら登録した wrapper 自身を掴んでいるので確実。
function addListener(channel, listener) {
  if (!ON_CHANNELS.has(channel)) throw rejectChannel('on', channel);
  if (typeof listener !== 'function') throw new TypeError('[vk-terminals] listener must be a function');
  const wrapper = (_event, ...args) => { listener(...args); };
  ipcRenderer.on(channel, wrapper);
  let removed = false;
  return () => {
    // 二重解除は無害に false を返す（同じ unsubscribe を cleanup から複数回呼べる）。
    if (removed) return false;
    removed = true;
    ipcRenderer.removeListener(channel, wrapper);
    // ⚠ ここは必ず true を返す。`return ipcRenderer.removeListener(...)` と短くしたくなるが、
    //   removeListener はチェーン用に ipcRenderer 自身を返すため、contextBridge がそれを
    //   プロキシ化して renderer へ渡してしまう。上のチャンネル許可リストを丸ごと迂回できる
    //   穴になる（renderer が生の ipcRenderer で任意チャンネルへ invoke / send できる）。
    return true;
  };
}

// ─── contextBridge へ公開する API ─────────────────────────────────────────────
contextBridge.exposeInMainWorld('vkBridge', {
  ipc: {
    invoke(channel, ...args) {
      if (!INVOKE_CHANNELS.has(channel)) return Promise.reject(rejectChannel('invoke', channel));
      return ipcRenderer.invoke(channel, ...args);
    },
    send(channel, ...args) {
      if (!SEND_CHANNELS.has(channel)) throw rejectChannel('send', channel);
      ipcRenderer.send(channel, ...args);
    },
    // 戻り値は unsubscribe 関数。解除はこれだけ（理由は addListener のコメント）。
    on: addListener,
  },

  shell: {
    // 外部ブラウザで開く。ここでも http(s) を確認するが、最終防衛線は main 側
    // （ipcMain.handle('shell:open-external')）の再検証。
    openExternal(url) {
      if (!isSafeHttpUrl(url)) return Promise.resolve(false);
      return ipcRenderer.invoke('shell:open-external', url);
    },
    beep() {
      ipcRenderer.send('shell:beep');
    },
  },

  clipboard: {
    // 成否を boolean で返す（main 側で書き込みが失敗したら false）。
    writeText(text) {
      if (typeof text !== 'string' || !text) return Promise.resolve(false);
      // MAX_CLIPBOARD_TEXT_LENGTH が NaN（additionalArguments 未到達など）の場合、
      // NaN との比較は常に false になるためこのチェックは自然にスキップされ、
      // main 側の最終防衛線（ipcMain.handle('clipboard:write-text')）の判定に委ねる。
      if (text.length > MAX_CLIPBOARD_TEXT_LENGTH) return Promise.resolve(false);
      return ipcRenderer.invoke('clipboard:write-text', text);
    },
  },

  xterm: {
    // xterm 本体・addon-fit の絶対パス（file:// URL）と xterm.css の中身は main プロセス
    // 側で解決する（issue #323。理由はファイル冒頭コメントを参照）。読み込み順
    //（xterm → addon-fit → xterm.css → app.js）は renderer/bootstrap.js が保証する。
    getResources() {
      return ipcRenderer.invoke('app:get-xterm-resources');
    },
  },

  agentRoomSprites: {
    // エージェントルーム（issue #58）のドット絵スプライト（renderer/sprites/*.svg の中身）。
    // renderer からは fs で読めないため main プロセス側で読み、ここでは IPC で受け取るだけ。
    get() {
      return ipcRenderer.invoke('app:get-agent-room-sprites');
    },
  },
});
