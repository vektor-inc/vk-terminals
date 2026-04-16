const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

let win;
const ptys = new Map();
let nextId = 1;
let firstTerminalCreated = false;

// ─── Terminal state & HTTP API ───────────────────────────────────────────────
const API_PORT = 13847;
const DATA_DIR = path.join(os.homedir(), '.vk-terminals');
const STATE_FILE = path.join(DATA_DIR, 'states.json');
const LOG_PREFIX = '[vk-terminals]';
let cachedStates = {};  // renderer から受け取った状態キャッシュ
let httpServer = null;

/**
 * ユーザー設定を読み込む。
 * 読み込み順:
 *   1. ~/.vk-terminals/config.json（ユーザー固有設定）
 *   2. {appDir}/config.json（リポジトリローカル設定）
 *   3. ~/.claude/terminals-config.json（後方互換）
 * どちらも存在しない場合は空オブジェクトを返す。
 *
 * @returns {{ initialCommand?: string }} 設定オブジェクト
 */
function loadUserConfig() {
  const candidates = [
    path.join(DATA_DIR, 'config.json'),
    path.join(__dirname, 'config.json'),
    path.join(os.homedir(), '.claude', 'terminals-config.json'), // 後方互換
  ];

  for (const configPath of candidates) {
    if (fs.existsSync(configPath)) {
      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        return JSON.parse(raw);
      } catch (e) {
        console.error(`${LOG_PREFIX} Failed to parse config: ${configPath}`, e);
      }
    }
  }

  return {};
}

/**
 * semver文字列を比較する（v接頭辞あり/なし両対応）
 * @param {string} a
 * @param {string} b
 * @returns {number} a > b なら正、a < b なら負、同じなら0
 */
function compareSemver(a, b) {
  const normalize = (v) => v.replace(/^v/, '').split('.').map(Number);
  const [aMajor, aMinor, aPatch] = normalize(a);
  const [bMajor, bMinor, bPatch] = normalize(b);
  return (aMajor - bMajor) || (aMinor - bMinor) || (aPatch - bPatch);
}

/** すべての PTY プロセスを終了する */
function cleanupPtys() {
  for (const [, p] of ptys) {
    try { p.kill(); } catch (e) {}
  }
}

/**
 * 起動時に新バージョンがあるか確認し、あれば git pull して再起動を促す
 */
async function checkAndUpdate() {
  const appDir = __dirname;
  const opts = { cwd: appDir };
  try {
    await execFileAsync('git', ['fetch', '--tags'], { ...opts, timeout: 10000 });

    // リモートタグのみを取得して最新バージョンを確認する（ローカル専用タグを除外）
    const { stdout: lsRemoteOut } = await execFileAsync(
      'git', ['ls-remote', '--tags', 'origin'], { ...opts, timeout: 10000 }
    );
    const latestTag = lsRemoteOut
      .split('\n')
      .map((l) => l.match(/refs\/tags\/(v\d+\.\d+\.\d+)$/)?.[1])
      .filter(Boolean)
      .sort((a, b) => compareSemver(b, a))[0];

    if (!latestTag) return;

    // package.json の version をバージョンの正とする
    const pkg = require('./package.json');
    const currentTag = `v${pkg.version}`;

    if (compareSemver(latestTag, currentTag) <= 0) return;

    // 作業ツリーが汚れていれば pull をスキップ
    const { stdout: statusOut } = await execFileAsync(
      'git', ['status', '--porcelain'], opts
    );
    if (statusOut.trim().length > 0) {
      console.warn(`${LOG_PREFIX} Working tree is dirty, skipping pull.`);
      return;
    }

    // fast-forward のみで git pull（マージコミットを防ぐ）
    await execFileAsync('git', ['pull', '--ff-only'], { ...opts, timeout: 30000 });

    const { response } = await dialog.showMessageBox({
      type: 'info',
      title: 'アップデート完了',
      message: `VK Terminals を ${currentTag} → ${latestTag} に更新しました。`,
      detail: '変更を反映するにはアプリを再起動してください。',
      buttons: ['今すぐ再起動', 'あとで'],
      defaultId: 0,
    });

    if (response === 0) {
      // app.exit(0) は通常の終了フックを通らないため、PTY を明示的にクリーンアップする
      cleanupPtys();
      app.relaunch();
      app.exit(0);
    }
  } catch (e) {
    // ネットワーク不通などは無視
    console.error(`${LOG_PREFIX} Update check failed:`, e.message);
  }
}

function createWindow() {
  const { workAreaSize } = screen.getPrimaryDisplay();
  const winW = Math.min(1400, workAreaSize.width);
  const winH = Math.min(900, workAreaSize.height);
  const x = Math.round((workAreaSize.width - winW) / 2);
  const y = Math.round((workAreaSize.height - winH) / 2);

  win = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    minWidth: 600,
    minHeight: 400,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 12 },
    backgroundColor: '#0d1117',
    title: 'VK Terminals',
  });

  win.loadFile('renderer/index.html');
  // win.webContents.openDevTools(); // uncomment to debug
}

app.whenReady().then(async () => {
  createWindow();
  await checkAndUpdate();
  startHttpApi();
});

app.on('window-all-closed', () => {
  cleanupPtys();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  cleanupPtys();
  try { fs.unlinkSync(STATE_FILE); } catch (e) {}
  if (httpServer) httpServer.close();
});

ipcMain.handle('terminal:create', (event, cwd) => {
  const id = String(nextId++);
  const shell = process.env.SHELL || '/bin/zsh';
  const resolvedCwd = cwd || process.env.HOME || '/tmp';

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: { ...process.env, TERM_PROGRAM: 'VKTerminals' },
  });

  // initialCommand 送信用のプロンプト検知フック（最初の 1 ターミナルのみ）
  const shouldWatchForPrompt = !firstTerminalCreated;
  let promptWatcher = null;
  if (shouldWatchForPrompt) {
    firstTerminalCreated = true;
    const config = loadUserConfig();
    if (config.initialCommand) {
      let sent = false;
      let trustHandled = false;
      let buffer = '';
      // Claude Code が入力受付状態になったことを検知するパターン
      // バージョンにより文言が揺れるため複数表現に対応
      const READY_PATTERN = /\?\s*for\s*shortcuts|\?\s*to\s*show\s*shortcuts|for\s*shortcuts|Welcome to Claude|Try\s*["']?\/help|Bypass(ing)?\s*Permissions|accept edits|cwd:/i;
      // 新規ディレクトリで起動した際の信頼確認プロンプト（デフォルトで Yes が選択されているので Enter で承認）
      // Claude Code のバージョンによって文言が揺れるため、複数表現に対応
      // 例: "Do you trust the files in this folder?" / "Do you trust this folder?" / 選択肢の "Yes, I trust this folder"
      const TRUST_PATTERN = /Do you trust.{0,40}folder|Yes,\s*I\s*trust\s*(the\s*files\s*in\s*)?this\s*folder/i;
      // Claude の起動には通常 2〜4 秒程度。READY_PATTERN が検知できなくてもフォールバック送信する
      const WATCH_TIMEOUT_MS = 10000;

      const sendInitialCommand = (reason) => {
        if (sent) return;
        sent = true;
        if (ptys.has(id)) {
          ptyProcess.write(config.initialCommand + '\r');
          console.log(`${LOG_PREFIX} initialCommand sent (${reason})`);
        }
      };

      let timeoutId = setTimeout(() => {
        if (!sent) {
          console.warn(`${LOG_PREFIX} Claude ready prompt not detected within ${WATCH_TIMEOUT_MS}ms, sending initialCommand as fallback`);
          sendInitialCommand('timeout fallback');
        }
      }, WATCH_TIMEOUT_MS);

      promptWatcher = (data) => {
        if (sent) return;
        // ANSI エスケープ（CSI / OSC）を除去してから末尾 4KB だけ保持
        const stripped = data
          .replace(/\x1b\[[\d;?]*[a-zA-Z]/g, '')
          .replace(/\x1b\]\d+;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
        buffer = (buffer + stripped).slice(-4096);

        // 信頼確認プロンプトが出ていたら Enter を送って承認（1回だけ）
        if (!trustHandled && TRUST_PATTERN.test(buffer)) {
          trustHandled = true;
          buffer = '';
          if (ptys.has(id)) {
            ptyProcess.write('\r');
          }
          // 信頼承認後は Claude の起動に時間がかかるため、タイムアウトをリセット
          clearTimeout(timeoutId);
          timeoutId = setTimeout(() => {
            if (!sent) {
              console.warn(`${LOG_PREFIX} Claude ready prompt not detected after trust confirmation, sending initialCommand as fallback`);
              sendInitialCommand('timeout fallback after trust');
            }
          }, WATCH_TIMEOUT_MS);
          return;
        }

        if (READY_PATTERN.test(buffer)) {
          clearTimeout(timeoutId);
          sendInitialCommand('ready detected');
        }
      };
    }
  }

  ptyProcess.onData((data) => {
    if (promptWatcher) promptWatcher(data);
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:data', id, data);
    }
  });

  ptyProcess.onExit(() => {
    ptys.delete(id);
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:exit', id);
    }
  });

  ptys.set(id, ptyProcess);

  // 起動後に自動でclaudeを実行
  setTimeout(() => {
    if (ptys.has(id)) {
      ptyProcess.write('claude\r');
    }
  }, 200);

  return { id, cwd: resolvedCwd };
});

ipcMain.on('terminal:input', (event, id, data) => {
  const p = ptys.get(id);
  if (p) p.write(data);
});

ipcMain.on('terminal:resize', (event, id, cols, rows) => {
  const p = ptys.get(id);
  if (p) {
    try { p.resize(Math.max(2, cols), Math.max(2, rows)); } catch (e) {}
  }
});

ipcMain.on('terminal:kill', (event, id) => {
  const p = ptys.get(id);
  if (p) {
    try { p.kill(); } catch (e) {}
    ptys.delete(id);
  }
});

// ─── State reporting from renderer ───────────────────────────────────────────
// データディレクトリを確保
fs.mkdirSync(DATA_DIR, { recursive: true });

ipcMain.on('terminal:report-states', (event, states) => {
  cachedStates = states;
  // 状態ファイルに書き出し（非同期、エラーは無視）
  const payload = JSON.stringify({ updatedAt: new Date().toISOString(), terminals: states }, null, 2);
  fs.writeFile(STATE_FILE, payload, 'utf8', () => {});
});

// ─── HTTP API ────────────────────────────────────────────────────────────────
function startHttpApi() {
  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`);

    // GET /api/health
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /api/states
    if (req.method === 'GET' && url.pathname === '/api/states') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ updatedAt: new Date().toISOString(), terminals: cachedStates }));
      return;
    }

    // POST /api/send  { termId: "1", input: "y" }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      const MAX_BODY = 10 * 1024; // 10KB
      let body = '';
      let aborted = false;
      req.on('data', chunk => {
        body += chunk;
        if (body.length > MAX_BODY) {
          aborted = true;
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large' }));
          req.destroy();
        }
      });
      req.on('end', () => {
        if (aborted) return;
        try {
          const { termId, input } = JSON.parse(body);
          if (!termId || typeof input !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'termId and input required' }));
            return;
          }
          const p = ptys.get(String(termId));
          if (!p) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `terminal ${termId} not found` }));
            return;
          }
          p.write(input);
          // renderer に通知（バッジ表示用）
          if (win && !win.isDestroyed()) {
            win.webContents.send('terminal:auto-input', termId);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, termId }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  httpServer.listen(API_PORT, '127.0.0.1', () => {
    console.log(`${LOG_PREFIX} API server listening on http://127.0.0.1:${API_PORT}`);
  });

  httpServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.warn(`${LOG_PREFIX} Port ${API_PORT} in use, API server disabled.`);
    } else {
      console.error(`${LOG_PREFIX} API server error:`, e);
    }
  });
}

