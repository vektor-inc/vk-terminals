const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { stripAnsiForPattern } = require('./utils/stripAnsi');
// エージェントルーム（issue #58）の agent 名・state 検証を renderer 側と共有する。
// canonicalizeState / isKnownAgent は DOM 非依存なので main プロセスから require して使える。
const { canonicalizeState, isKnownAgent } = require('./renderer/agentRoom');
const execFileAsync = promisify(execFile);

let win;
const ptys = new Map();
let nextId = 1;
let firstTerminalCreated = false;

// CLI フラグ: `--no-claude`（または `--plain`）が指定された場合、
// 新規ペインで claude を自動起動せず素のシェルとして開く。
// 起動方法: `npm start -- --no-claude` または `electron . --no-claude`
const globalPlainMode = process.argv.includes('--no-claude') || process.argv.includes('--plain');

// /api/new-pane の HTTP レスポンスを待つコールバック（requestId → resolver）
// 並行リクエストでも取り違えが起きないように requestId で相関付ける
const pendingNewPaneCallbacks = new Map();
let nextNewPaneRequestId = 1;

// ─── Terminal state & HTTP API ───────────────────────────────────────────────
const API_PORT = 13847;
const DATA_DIR = path.join(os.homedir(), '.vk-terminals');
const STATE_FILE = path.join(DATA_DIR, 'states.json');
const LOG_PREFIX = '[vk-terminals]';
// /api/send で「本文 + 末尾 Enter」を 1 リクエストで受け取ったとき、本文と Enter を
// 分割して送るまでの待機時間（ms）。本文と \r を 1 回の write でまとめて流すと、
// Claude Code の TUI がペースト（複数行入力）扱いして末尾 \r を入力欄の改行として
// 吸収し Enter 確定にならない（URL のような長い入力で特に再現しやすい）。
// 本文を先に流して TUI の再描画が落ち着いてから Enter を送ることで確実に確定させる。
const SEND_ENTER_SPLIT_DELAY_MS = 150;
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
 * @returns {{ initialCommand?: string, additionalPanes?: Array<{cwd: string}> }} 設定オブジェクト
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
      // ウィンドウがオクルード（背面/最小化）状態になっても renderer のタイマーを
      // 間引かせない。スマホ等から監視している間 Mac 側ウィンドウは背面になりがちで、
      // 既定の backgroundThrottling: true だと状態レポート用 setInterval(2s) が約1分に1回まで
      // 間引かれ、cachedStates が古いまま固定 → モバイルページの同期が止まるため無効化する。
      backgroundThrottling: false,
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

// renderer がエージェントルーム（issue #58）の有効/無効を知るための設定取得。
//   config.json の `agentroom: true` のときだけ各ペイン下部にアコーディオンを表示する。
ipcMain.handle('app:get-config', () => {
  const config = loadUserConfig();
  return { agentroom: config.agentroom === true };
});

// ─── 設定パネル（汎用）────────────────────────────────────────────────────────
// 呼び出し側（例: vk-orchestrator）が環境変数 VK_TERMINALS_SETTINGS に「設定ディスク
// リプタ JSON」のパスを渡すと、renderer の設定パネルからそのディスクリプタが指す
// config ファイルを GUI 上で編集・保存できる。vk-terminals 自身は特定ツールの設定
// 内容を知らず、ディスクリプタ（項目スキーマ + targetPath）に従って読み書きするだけの
// 汎用実装にすることで、スタンドアロン利用時は影響を受けない（env 未指定なら
// settings:describe が available:false を返し、ボタンごと非表示になる）。
function settingsDescriptorPath() {
  const p = process.env.VK_TERMINALS_SETTINGS;
  return p && p.trim() ? p : null;
}

// ディスクリプタを読み込む。未指定・不正・最低限のキー（targetPath / groups）を
// 欠く場合は null を返す（呼び出し側で「機能なし」として扱う）。
function loadSettingsDescriptor() {
  const p = settingsDescriptorPath();
  if (!p || !fs.existsSync(p)) return null;
  try {
    const d = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!d || typeof d !== 'object') return null;
    if (typeof d.targetPath !== 'string' || !Array.isArray(d.groups)) return null;
    return d;
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to parse settings descriptor: ${p}`, e);
    return null;
  }
}

// ディスクリプタの全 groups からフィールド定義を平坦化して集める。
function descriptorFields(descriptor) {
  const fields = [];
  for (const g of descriptor.groups) {
    if (g && Array.isArray(g.fields)) fields.push(...g.fields);
  }
  return fields.filter(f => f && typeof f.key === 'string');
}

// "a.b.c" 形式のドットキーで入れ子オブジェクトから値を取り出す。
function deepGet(obj, dottedKey) {
  return dottedKey.split('.').reduce(
    (acc, k) => (acc == null ? undefined : acc[k]),
    obj,
  );
}

// "a.b.c" 形式のドットキーで入れ子オブジェクトに値を設定する（中間は生成）。
function deepSet(obj, dottedKey, value) {
  const keys = dottedKey.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] == null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

// renderer 用: ディスクリプタと targetPath の現在値を返す。VK_TERMINALS_SETTINGS が
// 未設定なら available:false（renderer 側は設定ボタンを表示しない）。
ipcMain.handle('settings:describe', () => {
  const descriptor = loadSettingsDescriptor();
  if (!descriptor) return { available: false };

  let current = {};
  try {
    if (fs.existsSync(descriptor.targetPath)) {
      current = JSON.parse(fs.readFileSync(descriptor.targetPath, 'utf8'));
    }
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to read target config: ${descriptor.targetPath}`, e);
  }
  if (!current || typeof current !== 'object') current = {};

  const values = {};
  for (const f of descriptorFields(descriptor)) {
    const v = deepGet(current, f.key);
    values[f.key] = v === undefined ? null : v;
  }
  return {
    available: true,
    title: descriptor.title || '設定',
    note: descriptor.note || '',
    targetPath: descriptor.targetPath,
    groups: descriptor.groups,
    values,
  };
});

// renderer からの保存。ディスクリプタに載っているキーだけを型変換して書き戻す
// （未知のキーは既存 config から保持する。書き込み先は必ず descriptor.targetPath）。
ipcMain.handle('settings:save', (event, incoming) => {
  const descriptor = loadSettingsDescriptor();
  if (!descriptor) return { ok: false, error: '設定ディスクリプタが見つかりません' };

  const fields = descriptorFields(descriptor);
  const values = incoming && typeof incoming === 'object' ? incoming : {};

  // 既存 config を読み、ディスクリプタに載っていないキーは保持したまま更新する。
  let config = {};
  try {
    if (fs.existsSync(descriptor.targetPath)) {
      config = JSON.parse(fs.readFileSync(descriptor.targetPath, 'utf8'));
    }
  } catch (e) {
    return { ok: false, error: `既存設定の読み込みに失敗: ${e.message}` };
  }
  if (!config || typeof config !== 'object') config = {};

  for (const f of fields) {
    if (!(f.key in values)) continue;
    const raw = values[f.key];
    const label = f.label || f.key;
    let coerced;
    switch (f.type) {
      case 'number': {
        if (raw === '' || raw === null || raw === undefined) { coerced = null; break; }
        const n = Number(raw);
        if (!Number.isFinite(n)) return { ok: false, error: `${label}: 数値として不正です` };
        coerced = n;
        break;
      }
      case 'boolean':
        coerced = !!raw;
        break;
      case 'json': {
        if (raw === '' || raw === null || raw === undefined) {
          coerced = f.emptyToNull ? null : [];
          break;
        }
        try {
          coerced = typeof raw === 'string' ? JSON.parse(raw) : raw;
        } catch (e) {
          return { ok: false, error: `${label}: JSON として不正です（${e.message}）` };
        }
        break;
      }
      default: { // text / password
        const s = raw == null ? '' : String(raw);
        coerced = (s === '' && f.emptyToNull) ? null : s;
      }
    }
    deepSet(config, f.key, coerced);
  }

  try {
    fs.writeFileSync(descriptor.targetPath, JSON.stringify(config, null, 2) + '\n');
  } catch (e) {
    return { ok: false, error: `保存に失敗: ${e.message}` };
  }
  return { ok: true, targetPath: descriptor.targetPath };
});

ipcMain.handle('terminal:create', (event, cwd, options = {}) => {
  const id = String(nextId++);
  const shell = process.env.SHELL || '/bin/zsh';
  const resolvedCwd = cwd || process.env.HOME || '/tmp';

  // `options.noClaude` が明示指定されていればそれを優先、未指定なら CLI フラグの値を継承。
  // `noClaude` が true の場合、claude を自動起動せず素のシェルとして開く。
  const noClaude = typeof options.noClaude === 'boolean' ? options.noClaude : globalPlainMode;

  const ptyProcess = pty.spawn(shell, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: resolvedCwd,
    env: { ...process.env, TERM_PROGRAM: 'VKTerminals' },
  });

  // initialCommand は最初の 1 ターミナルのみ送信
  const isFirstTerminal = !firstTerminalCreated;
  if (isFirstTerminal) firstTerminalCreated = true;

  let promptWatcher = null;
  let promptWatcherTimeoutId = null;

  // 信頼確認プロンプトの検知パターン（全ターミナル共通）
  // 「Enter to confirm」が出た時点でメニュー描画済みなので、そこで \r を送る
  // 旧UI: "Do you trust the files in this folder?" / "Yes, I trust this folder"
  // 新UI: "Quick safety check..." → "Enter to confirm · Esc to cancel"
  const TRUST_PATTERN = /Enter to confirm|Do you trust.{0,40}folder|Yes,\s*I\s*trust\s*(the\s*files\s*in\s*)?this\s*folder/i;

  // Claude Code が入力受付状態になったことを検知するパターン
  const READY_PATTERN = /\?\s*for\s*shortcuts|\?\s*to\s*show\s*shortcuts|for\s*shortcuts|Welcome to Claude|Try\s*["']?\/help|Bypass(ing)?\s*Permissions|accept edits/i;

  const WATCH_TIMEOUT_MS = 10000;

  // 素のターミナルモードでは claude を起動しないため、信頼確認や initialCommand の監視も不要
  if (!noClaude) {
    const config = isFirstTerminal ? loadUserConfig() : {};
    let sent = false;
    let trustHandled = false;
    let buffer = '';

    const sendInitialCommand = (reason) => {
      if (sent || !config.initialCommand) return;
      sent = true;
      if (ptys.has(id)) {
        ptyProcess.write(config.initialCommand + '\r');
        console.log(`${LOG_PREFIX} initialCommand sent (${reason})`);
      }
    };

    if (isFirstTerminal && config.initialCommand) {
      promptWatcherTimeoutId = setTimeout(() => {
        if (!sent) {
          console.warn(`${LOG_PREFIX} Claude ready prompt not detected within ${WATCH_TIMEOUT_MS}ms, sending initialCommand as fallback`);
          sendInitialCommand('timeout fallback');
        }
      }, WATCH_TIMEOUT_MS);
    }

    promptWatcher = (data) => {
      const stripped = stripAnsiForPattern(data);
      buffer = (buffer + stripped).slice(-4096);

      // 信頼確認プロンプト → Enter で承認（全ターミナル共通）
      if (!trustHandled && TRUST_PATTERN.test(buffer)) {
        trustHandled = true;
        buffer = '';
        console.log(`${LOG_PREFIX} trust prompt detected, sending Enter (terminal ${id})`);
        if (ptys.has(id)) {
          ptyProcess.write('\r');
        }
        // 信頼承認後はタイムアウトをリセット（initialCommand 待ち継続）
        if (isFirstTerminal && config.initialCommand && !sent) {
          clearTimeout(promptWatcherTimeoutId);
          promptWatcherTimeoutId = setTimeout(() => {
            if (!sent) {
              console.warn(`${LOG_PREFIX} Claude ready prompt not detected after trust confirmation, sending initialCommand as fallback`);
              sendInitialCommand('timeout fallback after trust');
            }
          }, WATCH_TIMEOUT_MS);
        }
        return;
      }

      // initialCommand 送信（最初のターミナルのみ）
      if (isFirstTerminal && !sent && READY_PATTERN.test(buffer)) {
        clearTimeout(promptWatcherTimeoutId);
        promptWatcherTimeoutId = null;
        sendInitialCommand('ready detected');
      }
    };
  }

  ptyProcess.onData((data) => {
    if (promptWatcher) promptWatcher(data);
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:data', id, data);
    }
  });

  ptyProcess.onExit(() => {
    // ターミナル終了時に未発火のタイムアウトが残らないようクリアする
    if (promptWatcherTimeoutId) {
      clearTimeout(promptWatcherTimeoutId);
      promptWatcherTimeoutId = null;
    }
    ptys.delete(id);
    if (win && !win.isDestroyed()) {
      win.webContents.send('terminal:exit', id);
    }
  });

  ptys.set(id, ptyProcess);

  // 起動後に自動でclaudeを実行（素のターミナルモード時はスキップ）
  if (!noClaude) {
    setTimeout(() => {
      if (ptys.has(id)) {
        ptyProcess.write('claude\r');
      }
    }, 200);
  }

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

// renderer が新規ペインを作成し終えたら HTTP レスポンスを返す
ipcMain.on('terminal:new-pane-created', (event, payload = {}) => {
  const { requestId, ...result } = payload;
  if (!requestId) return;
  const resolve = pendingNewPaneCallbacks.get(requestId);
  if (!resolve) return;
  pendingNewPaneCallbacks.delete(requestId);
  resolve(result);
});

/**
 * 指定された cwd で追加ペインを 1 枚作成する。
 * 内部的には renderer の splitPane を呼び出すのと同じ経路（pendingNewPaneCallbacks）を使う。
 * options.noClaude が true の場合、新ペインで claude を自動起動しない。
 */
function createAdditionalPane(cwd, options = {}) {
  return new Promise((resolve) => {
    if (!win || win.isDestroyed()) {
      resolve({ error: 'window not available' });
      return;
    }
    const requestId = String(nextNewPaneRequestId++);
    const timeoutId = setTimeout(() => {
      if (pendingNewPaneCallbacks.has(requestId)) {
        pendingNewPaneCallbacks.delete(requestId);
        resolve({ error: 'timeout waiting for new pane' });
      }
    }, 15000);
    pendingNewPaneCallbacks.set(requestId, (result) => {
      clearTimeout(timeoutId);
      resolve(result);
    });
    const payload = { requestId, cwd };
    if (typeof options.noClaude === 'boolean') payload.noClaude = options.noClaude;
    win.webContents.send('terminal:request-new-pane', payload);
  });
}

// renderer 初期化完了 → config.additionalPanes に従って追加ペインを順次作成
let additionalPanesCreated = false;
ipcMain.on('terminal:renderer-ready', async () => {
  if (additionalPanesCreated) return; // closePane で最後のペインを閉じて再 initApp された場合は再生成しない
  additionalPanesCreated = true;
  const config = loadUserConfig();
  const panes = Array.isArray(config.additionalPanes) ? config.additionalPanes : [];
  for (const pane of panes) {
    if (!pane || typeof pane.cwd !== 'string' || !pane.cwd.trim()) continue;
    // pane.noClaude が指定されていれば優先、未指定なら CLI フラグの値を使う（terminal:create 側で解決）
    const paneOptions = typeof pane.noClaude === 'boolean' ? { noClaude: pane.noClaude } : {};
    const result = await createAdditionalPane(pane.cwd, paneOptions);
    if (result && result.error) {
      console.warn(`${LOG_PREFIX} additionalPane (${pane.cwd}) failed: ${result.error}`);
    }
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
  // ブラウザ起点の cross-origin リクエストを弾く CSRF 対策。
  //   Origin ヘッダはブラウザが cross-origin の POST 等で必ず送る。同一オリジンの
  //   モバイルページや、curl 等の非ブラウザクライアント（Origin なし）は素通りさせ、
  //   悪意あるサイトから http://<apiHost>:13847/api/send への CSRF だけを拒否する。
  //   Host ヘッダ（apiHost が 127.0.0.1 でも Tailscale IP でも実際の接続先が入る）と
  //   Origin のホストを突き合わせ、不一致なら拒否。
  const isForbiddenOrigin = (req) => {
    const origin = req.headers.origin;
    if (!origin) return false; // 非ブラウザ or 同一オリジン GET 等 → 許可
    let originHost;
    try {
      originHost = new URL(origin).host;
    } catch (_e) {
      return true; // パース不能な Origin は拒否
    }
    return originHost !== req.headers.host;
  };

  // POST リクエスト body を読み取り、UTF-8 文字列にして onBody(body) を呼ぶ。
  //   - chunk は Buffer のまま貯めて最後に一度だけ decode する（日本語がチャンク境界で
  //     割れて文字化け→JSON 破損するのを防ぐ）。
  //   - サイズ制限はバイト数で判定し、超過したら 413 を返して破棄する（onBody は呼ばない）。
  const readJsonBody = (req, res, maxBytes, onBody) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', chunk => {
      if (aborted) return;
      size += chunk.length; // chunk は Buffer なので length はバイト数
      if (size > maxBytes) {
        aborted = true;
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload too large' }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (aborted) return;
      onBody(Buffer.concat(chunks).toString('utf8'));
    });
  };

  httpServer = http.createServer((req, res) => {
    const url = new URL(req.url, `http://127.0.0.1:${API_PORT}`);

    // GET /api/health
    if (req.method === 'GET' && url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // GET /  — スマホ等から状態確認・応答するモバイルページ
    //   tailscale serve 等で 127.0.0.1:13847 を tailnet に公開して使う想定。
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      fs.readFile(path.join(__dirname, 'renderer', 'mobile.html'), (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mobile page not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    // GET /api/states
    if (req.method === 'GET' && url.pathname === '/api/states') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ updatedAt: new Date().toISOString(), terminals: cachedStates }));
      return;
    }

    // POST /api/send  { termId: "1", input: "y" }
    if (req.method === 'POST' && url.pathname === '/api/send') {
      if (isForbiddenOrigin(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden origin' }));
        return;
      }
      const MAX_BODY = 10 * 1024; // 10KB
      readJsonBody(req, res, MAX_BODY, (body) => {
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
          // 「本文 + 末尾 Enter」を 1 リクエストで受け取った場合は、本文と Enter を
          // 別々の write に分割して送る（まとめて送ると Claude Code が末尾 \r を
          // ペーストの改行として吸収し Enter 確定にならないため。SEND_ENTER_SPLIT_DELAY_MS 参照）。
          const trailingNewline = input.match(/[\r\n]+$/);
          const hasBodyBeforeNewline = trailingNewline && input.length > trailingNewline[0].length;
          if (hasBodyBeforeNewline) {
            const bodyPart = input.slice(0, input.length - trailingNewline[0].length);
            p.write(bodyPart);
            setTimeout(() => {
              // 待機中にターミナルが閉じられている可能性があるので存在を再確認する
              if (ptys.get(String(termId)) === p) {
                p.write(trailingNewline[0]);
              }
            }, SEND_ENTER_SPLIT_DELAY_MS);
          } else {
            p.write(input);
          }
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

    // POST /api/set-title  { termId: "1", title: "タスク名", url?: "https://...", prUrl?: "https://..." }
    //   — ペイン上部のタスクタイトル行に表示する文字列を設定。
    //   空文字や null を title に指定するとタイトル行を非表示に戻す。
    //   url を指定するとタイトル全体をリンク化（クリックで OS の既定ブラウザで開く）。
    //   url を省略すると URL なし扱い、空文字 "" を渡すと既存 URL をクリアする扱い。
    //   url は http(s): スキームのみ許可・new URL() で parse 可能・2048 文字以内の制約あり。
    //   title と url はペアで都度送る置換セマンティクス（patch ではない）。
    //   prUrl（issue #44）: タイトル右側の独立した [ PR ↗ ] ボタンに紐づける URL。
    //   省略 → PR ボタンなし扱い、空文字 "" → 既存 prUrl をクリア。
    //   バリデーションは url と同一規約（http(s):・2048 文字以内・new URL() parse 可）。
    if (req.method === 'POST' && url.pathname === '/api/set-title') {
      if (isForbiddenOrigin(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden origin' }));
        return;
      }
      const MAX_BODY = 10 * 1024;
      readJsonBody(req, res, MAX_BODY, (body) => {
        try {
          const parsed = JSON.parse(body);
          const termId = parsed?.termId != null ? String(parsed.termId) : '';
          if (!termId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'termId required' }));
            return;
          }
          if (!ptys.has(termId)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `terminal ${termId} not found` }));
            return;
          }
          const title = typeof parsed?.title === 'string' ? parsed.title : '';

          // url / prUrl の共通バリデーション。
          //   - フィールド未指定（undefined）→ 後方互換のため URL なし扱い（空文字を送る）
          //   - 空文字 "" / null → クリア扱い（renderer 側で対応フィールドをクリア）
          //   - それ以外 → 文字列必須、長さ 2048 以内、new URL() parse 必須、http(s): のみ
          //
          // フィールド名（'url' / 'prUrl'）はエラーメッセージにも反映するため引数で受け取る。
          // 戻り値:
          //   { ok: true, value: string } バリデーション成功（value はそのままレンダラに渡す文字列）
          //   { ok: false, error: string } バリデーション失敗（error は 400 で返すエラーメッセージ）
          //   { ok: true, missing: true } フィールド未指定（このときは value を使わない）
          const validateUrlField = (raw, fieldName) => {
            if (raw === '' || raw == null) {
              return { ok: true, value: '' };
            }
            if (typeof raw !== 'string') {
              return { ok: false, error: `${fieldName} must be a string` };
            }
            if (raw.length > 2048) {
              return { ok: false, error: `${fieldName} too long (max 2048 chars)` };
            }
            let parsedUrl;
            try {
              parsedUrl = new URL(raw);
            } catch (_e) {
              return { ok: false, error: `invalid ${fieldName}` };
            }
            if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
              return { ok: false, error: `${fieldName} must be http(s)` };
            }
            return { ok: true, value: raw };
          };

          let urlValue = '';
          if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'url')) {
            const r = validateUrlField(parsed.url, 'url');
            if (!r.ok) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: r.error }));
              return;
            }
            urlValue = r.value;
          }

          // prUrl（issue #44）: 独立した PR ボタン用 URL。url と同一規約。
          let prUrlValue = '';
          if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'prUrl')) {
            const r = validateUrlField(parsed.prUrl, 'prUrl');
            if (!r.ok) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: r.error }));
              return;
            }
            prUrlValue = r.value;
          }

          if (win && !win.isDestroyed()) {
            win.webContents.send('terminal:title', termId, title, urlValue, prUrlValue);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, termId, title, url: urlValue, prUrl: prUrlValue }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/agentroom  { termId: "1", agents?: {"和田":"working", ...}, agent?: "麗美", state?: "consulting" }
    //   — エージェントルーム（issue #58）の稼働状況を更新する。config.json の `agentroom: true` 時のみ表示に反映。
    //   `agents` オブジェクトを渡すとそのペインのルーム状態を丸ごと置換する（置換セマンティクス）。
    //   `agent` + `state` を渡すと該当 1 人だけ更新する（マージセマンティクス）。
    //   state の語彙: 'consulting'（相談中）/ 'working'（作業中）/ 'idle'（待機中）/ 'off'（離席）。
    //   agent は既知（司/和田/安藤/麗美/植草）のみ受理。state は表記ゆれ（日本語・大文字等）を
    //   canonical へ正規化し、いずれにも写像できない値（誤記等）は 400 で reject する。
    //   renderer へは正規化済みの canonical state を送る。
    if (req.method === 'POST' && url.pathname === '/api/agentroom') {
      if (isForbiddenOrigin(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden origin' }));
        return;
      }
      const MAX_BODY = 10 * 1024;
      readJsonBody(req, res, MAX_BODY, (body) => {
        try {
          const parsed = JSON.parse(body);
          const termId = parsed?.termId != null ? String(parsed.termId) : '';
          if (!termId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'termId required' }));
            return;
          }
          if (!ptys.has(termId)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `terminal ${termId} not found` }));
            return;
          }

          // agent 名は既知（司/和田/安藤/麗美/植草、前後空白許容）のみ受理。
          // state は canonical（consulting/working/idle/off）へ正規化し、写像できなければ reject。
          // 正規化した値を renderer へ送ることで、未知 state が idle 扱いされて fallback を
          // 不本意に抑制する事故を防ぐ。

          // 1 人だけ更新（agent + state）。replace=false でマージ。
          if (typeof parsed?.agent === 'string') {
            if (!isKnownAgent(parsed.agent)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `unknown agent "${parsed.agent}"` }));
              return;
            }
            const state = canonicalizeState(parsed.state);
            if (!state) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'state must be one of consulting/working/idle/off' }));
              return;
            }
            const agents = { [parsed.agent.trim()]: state };
            if (win && !win.isDestroyed()) {
              win.webContents.send('terminal:agentroom', termId, agents, false);
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, termId, agents, replace: false }));
            return;
          }

          // ルーム状態を丸ごと置換（agents オブジェクト）。
          const agentsRaw = parsed?.agents;
          if (agentsRaw == null || typeof agentsRaw !== 'object' || Array.isArray(agentsRaw)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'agents object or agent+state required' }));
            return;
          }
          const agents = {};
          for (const [k, v] of Object.entries(agentsRaw)) {
            if (!isKnownAgent(k)) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `unknown agent "${k}"` }));
              return;
            }
            const state = canonicalizeState(v);
            if (!state) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `state for "${k}" must be one of consulting/working/idle/off` }));
              return;
            }
            agents[k.trim()] = state;
          }
          if (win && !win.isDestroyed()) {
            win.webContents.send('terminal:agentroom', termId, agents, true);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, termId, agents, replace: true }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/new-pane  { cwd?: "/path/to/dir", noClaude?: boolean } — 新規ペインを作成して termId を返す
    //   cwd を指定すればそのディレクトリで開く。未指定なら HOME で開く。
    //   noClaude: true を指定すると、新規ペインで claude を自動起動せず素のシェルとして開く。
    if (req.method === 'POST' && url.pathname === '/api/new-pane') {
      if (isForbiddenOrigin(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden origin' }));
        return;
      }
      if (!win || win.isDestroyed()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'window not available' }));
        return;
      }
      const MAX_BODY = 10 * 1024;
      readJsonBody(req, res, MAX_BODY, (body) => {
        let requestedCwd = null;
        let requestedNoClaude;
        if (body.length > 0) {
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed?.cwd === 'string' && parsed.cwd.trim()) {
              requestedCwd = parsed.cwd;
            }
            if (typeof parsed?.noClaude === 'boolean') {
              requestedNoClaude = parsed.noClaude;
            }
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'invalid JSON' }));
            return;
          }
        }
        const requestId = String(nextNewPaneRequestId++);
        const timeoutId = setTimeout(() => {
          if (pendingNewPaneCallbacks.has(requestId)) {
            pendingNewPaneCallbacks.delete(requestId);
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'timeout waiting for new pane' }));
          }
        }, 15000);
        const resolve = (result) => {
          clearTimeout(timeoutId);
          if (result.error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: result.error }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, termId: result.termId }));
          }
        };
        pendingNewPaneCallbacks.set(requestId, resolve);
        const payload = { requestId, cwd: requestedCwd };
        if (typeof requestedNoClaude === 'boolean') payload.noClaude = requestedNoClaude;
        win.webContents.send('terminal:request-new-pane', payload);
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });

  // バインド先ホスト。config.json の apiHost で変更可能（既定 127.0.0.1）。
  //   例: Tailscale IP（100.x.x.x）を指定すると tailnet 内からのみ到達可能になり、
  //   スマホ等から http://<apiHost>:13847/ で状態確認・応答できる（LAN/公開には出さない）。
  //   '0.0.0.0' を指定すると LAN を含む全 I/F で待ち受ける（信頼できる NW でのみ推奨）。
  const apiHostRaw = loadUserConfig().apiHost;
  const apiHost = (typeof apiHostRaw === 'string' && apiHostRaw.trim())
    ? apiHostRaw.trim()
    : '127.0.0.1';

  let triedFallback = false;
  const listen = (host) => {
    httpServer.listen(API_PORT, host, () => {
      console.log(`${LOG_PREFIX} API server listening on http://${host}:${API_PORT}`);
    });
  };

  httpServer.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.warn(`${LOG_PREFIX} Port ${API_PORT} in use, API server disabled.`);
    } else if (e.code === 'EADDRNOTAVAIL' && !triedFallback && apiHost !== '127.0.0.1') {
      // apiHost（例: Tailscale IP）が未割り当て（Tailscale 未接続など）の場合は
      // ローカルのみで起動して API を死なせない。
      triedFallback = true;
      console.warn(`${LOG_PREFIX} apiHost ${apiHost} unavailable, falling back to 127.0.0.1.`);
      listen('127.0.0.1');
    } else {
      console.error(`${LOG_PREFIX} API server error:`, e);
    }
  });

  listen(apiHost);
}

