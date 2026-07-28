// ─── preload（issue #268） ────────────────────────────────────────────────────
//
// BrowserWindow を nodeIntegration: false / contextIsolation: true で作るのに合わせ、
// renderer が必要とする機能だけを contextBridge で「名前を付けた API」として渡す。
//
// 狙い: 表示処理のどこか 1 箇所でエスケープ漏れが起きても、そこから任意コード実行
//       （require('child_process') など）へ到達させない。renderer には Node も
//       Electron のモジュールも一切見えない状態にし、ここに書いた関数だけを通す。
//
// sandbox は既定（false）のまま使う。
//   このファイルが fs / require.resolve を使って xterm 実体の絶対パスと xterm.css の
//   中身を解決するため。sandbox: true にすると preload から Node のモジュール解決が
//   使えなくなり、vk-terminals が npm 依存としてインストールされて依存が上位の
//   node_modules へホイストされた構成で xterm を見つけられなくなる
//   （相対パスが使えない事情は renderer/bootstrap.js のコメントを参照）。
//   preload はアプリ同梱のコードしか実行しないため、ここが Node を持つこと自体は
//   攻撃面にならない。攻撃面になるのは「renderer から Node へ触れること」であり、
//   それは contextIsolation + 下記の許可リストで塞いでいる。

const { contextBridge, ipcRenderer } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { isSafeHttpUrl } = require('./renderer/urlSafety');

// ─── チャンネル許可リスト ─────────────────────────────────────────────────────
// 任意チャンネルを呼べる汎用 invoke/send/on は公開しない。ここに載っていない
// チャンネルは preload が拒否する。main 側にハンドラを足したら、ここにも足すこと。

// renderer → main（応答あり）
const INVOKE_CHANNELS = new Set([
  'app:get-config',
  'widgets:command',
  'usage:get',
  'codex-usage:get',
  'settings:describe',
  'settings:api-server-status',
  'settings:save',
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

// ─── xterm の実体解決 ────────────────────────────────────────────────────────
// require.resolve で絶対パスを取り、file:// URL にして renderer へ渡す。
// renderer からは相対パスで辿れない（ホイスト時に 404 になる）ため、解決はここで行う。
function resolveScriptUrl(request) {
  try {
    return pathToFileURL(require.resolve(request)).href;
  } catch (e) {
    console.error(`[vk-terminals] failed to resolve ${request}`, e);
    return '';
  }
}

function readXtermCss() {
  try {
    return fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
  } catch (e) {
    // 読み込み失敗時もアプリ自体は起動させる（従来の <link> 404 と同等の状態に留める）。
    console.error('[vk-terminals] xterm.css の読み込みに失敗しました', e);
    return '';
  }
}

// エージェントルーム（issue #58）のドット絵スプライト。renderer/sprites/*.svg は
// アプリ同梱の静的ファイルだが、renderer からは fs で読めなくなるのでここで読んで渡す。
// 読めなかったものは載せない（renderer/agentRoom.js が手続き生成へフォールバックする）。
function readAgentRoomSprites() {
  const dir = path.join(__dirname, 'renderer', 'sprites');
  const sprites = {};
  let files = [];
  try {
    files = fs.readdirSync(dir);
  } catch (_e) {
    return sprites;
  }
  for (const file of files) {
    if (!file.endsWith('.svg')) continue;
    try {
      sprites[file] = fs.readFileSync(path.join(dir, file), 'utf8');
    } catch (_e) { /* 読めないものは黙って落とす */ }
  }
  return sprites;
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
    // 読み込み順は renderer/bootstrap.js が保証する（xterm → addon-fit）。
    scriptUrls: [
      resolveScriptUrl('@xterm/xterm/lib/xterm.js'),
      resolveScriptUrl('@xterm/addon-fit/lib/addon-fit.js'),
    ].filter(Boolean),
    css: readXtermCss(),
  },

  agentRoomSprites: readAgentRoomSprites(),
});
