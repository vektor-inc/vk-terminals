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

// clipboard へ渡してよい文字列の上限。設定パネルのコピーボタンが渡すのは
// URL・コマンド 1 行なので、桁違いに余裕を持たせたうえで青天井にはしない。
const MAX_CLIPBOARD_TEXT_LENGTH = 100000;

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
