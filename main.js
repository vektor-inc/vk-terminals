const { app, BrowserWindow, ipcMain, screen, dialog } = require('electron');
const pty = require('node-pty');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const { stripAnsiForPattern } = require('./utils/stripAnsi');
// 宣言的ウィジェット（tasks-widget.json）契約の共有ロジック（#229 / vk-orchestrator#182）。
// タスクのドメイン語彙（遷移マトリクス・ラベル・優先度など）はこのプロセスに持たず、
// orchestrator が書き出す宣言を検証・中継するだけの汎用実装にする。
const widgetContract = require('./utils/widgetContract');
// エージェントルーム（issue #58）の agent 名・state 検証を renderer 側と共有する。
// canonicalizeState / isKnownAgent は DOM 非依存なので main プロセスから require して使える。
const { canonicalizeState, isKnownAgent } = require('./renderer/agentRoom');
// トークン使用量トラッカー（issue #69）。トランスクリプト集計＋整形はすべて usageTracker 側。
const { createUsageTracker, createTtlMemo } = require('./usageTracker');
// 公式 usage API（issue #73）。OAuth トークンは oauthUsage モジュール（main プロセス）内で
// のみ扱い、ここから先へは正規化済みの数値（%・リセット時刻・source 種別）だけを渡す。
const { createOauthUsageProvider } = require('./oauthUsage');
const { createCodexUsageProvider } = require('./codexUsage');
const { createCodexUsageTracker } = require('./codexUsageTracker');
// GUI(Electron) の GPU 起動モード。WSLg 等の Linux では Chromium の GPU 初期化が
// 失敗して起動時にエラーが多発するため、既定で GPU を無効化する。モードは
// VK_TERMINALS_GPU（環境変数）または config.json の gpu で off/default を
// 選べる（優先順位は env > config > プラットフォーム既定）。呼び出し側（VK Orchestrator
// 等）が argv で GPU スイッチを明示している場合は介入しない。詳細は utils/gpu.js を参照。
const { applyGpuMode } = require('./utils/gpu');
const { normalizeConfirmClose } = require('./utils/closeConfirm');
const { resolveInstanceId, buildHealthResponse } = require('./utils/instanceId');
const {
  describeSettingsValues,
  describeTargetPaths,
  isValidSettingsDescriptor,
  saveSettingsToTargets,
} = require('./settingsTargets');
const { buildBuiltinSettingsDescriptor } = require('./settingsSchema');
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
const pendingClosePaneCallbacks = new Map();
let nextClosePaneRequestId = 1;

// ─── Terminal state & HTTP API ───────────────────────────────────────────────
const DATA_DIR = path.join(os.homedir(), '.vk-terminals');
const STATE_FILE = path.join(DATA_DIR, 'states.json');
const LOG_PREFIX = '[vk-terminals]';
// ウィンドウタイトルバーおよびヘッダーに表示するアプリ名。既定は 'VK Terminals'。
// 呼び出し側（例: vk-orchestrator）が env VK_TERMINALS_APP_TITLE を渡すと、その名称
// （例: 'VK Orchestrator'）を表示する。renderer には app:get-config 経由で伝える。
const APP_TITLE = (() => {
  const t = process.env.VK_TERMINALS_APP_TITLE;
  return typeof t === 'string' && t.trim() ? t.trim() : 'VK Terminals';
})();
// 呼び出し側（例: vk-orchestrator）が起動時に渡した GUI インスタンス識別子。
// /api/health で同じポート上の別インスタンスとの取り違えを検出できるようにする。
// 未指定・空文字の場合は後方互換のため health レスポンスへ instanceId を含めない。
const INSTANCE_ID = resolveInstanceId(process.env);
// /api/send で「本文 + 末尾 Enter」を 1 リクエストで受け取ったとき、本文と Enter を
// 分割して送るまでの待機時間（ms）。本文と \r を 1 回の write でまとめて流すと、
// Claude Code の TUI がペースト（複数行入力）扱いして末尾 \r を入力欄の改行として
// 吸収し Enter 確定にならない（URL のような長い入力で特に再現しやすい）。
// 本文を先に流して TUI の再描画が落ち着いてから Enter を送ることで確実に確定させる。
const SEND_ENTER_SPLIT_DELAY_MS = 150;
let cachedStates = {};  // renderer から受け取った状態キャッシュ
let httpServer = null;

const MENU_ACTION_TYPES = new Set(['open-settings', 'open-url']);
const MENU_MAX_SECTIONS = 20;
const MENU_MAX_ITEMS = 50;
const MENU_MAX_CHILDREN = 20;
const MENU_MAX_TEXT = 200;
const MENU_MAX_SOURCE = 100;
const MENU_MAX_ICON = 8;
const menuSources = new Map();

// 宣言的ウィジェット（tasks-widget.json）の監視。旧 tasks-view.json とは別系統で監視し、
// dual-write 期間は新パス（widget）を優先する。
const WIDGET_POLL_INTERVAL_MS = 3000;
const WIDGET_WATCH_DEBOUNCE_MS = 150;
let widgetFilePath = '';
let widgetWatch = null;
let widgetPollTimer = null;
let widgetDebounceTimer = null;
let widgetLastRaw = Symbol('widgetLastRaw:init');
let widgetPayload = null;

function validateUrlField(raw, fieldName) {
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
}

function isSafeMenuIcon(icon) {
  if (typeof icon !== 'string') return false;
  const value = icon.trim();
  if (!value || value.length > MENU_MAX_ICON || /[<>&]/.test(value)) return false;
  return /^(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)(?:\s?(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?))?$/u.test(value);
}

function validateMenuItem(raw, source, depth, seenIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'menu item must be an object' };
  }
  if (typeof raw.id !== 'string' || !raw.id.trim()) {
    return { ok: false, error: 'menu item id required' };
  }
  if (raw.id.length > MENU_MAX_TEXT) {
    return { ok: false, error: 'menu item id too long' };
  }
  const itemKey = `${source}:${raw.id}`;
  if (seenIds.has(itemKey)) {
    return { ok: false, error: `duplicate menu item id "${raw.id}"` };
  }
  seenIds.add(itemKey);

  if (typeof raw.label !== 'string' || !raw.label.trim()) {
    return { ok: false, error: 'menu item label required' };
  }
  if (raw.label.length > MENU_MAX_TEXT) {
    return { ok: false, error: 'menu item label too long' };
  }

  const item = {
    id: raw.id.trim(),
    label: raw.label,
  };
  if (raw.icon != null && raw.icon !== '') {
    if (!isSafeMenuIcon(raw.icon)) {
      return { ok: false, error: 'menu item icon must be emoji only' };
    }
    item.icon = raw.icon.trim();
  }

  if (raw.action != null) {
    if (!raw.action || typeof raw.action !== 'object' || Array.isArray(raw.action)) {
      return { ok: false, error: 'menu item action must be an object' };
    }
    if (!MENU_ACTION_TYPES.has(raw.action.type)) {
      return { ok: false, error: `unsupported menu action "${raw.action.type}"` };
    }
    if (raw.action.type === 'open-settings') {
      item.action = { type: 'open-settings' };
    } else if (raw.action.type === 'open-url') {
      const r = validateUrlField(raw.action.url, 'action.url');
      if (!r.ok || !r.value) {
        return { ok: false, error: r.error || 'action.url required' };
      }
      item.action = { type: 'open-url', url: r.value };
    }
  }

  if (raw.children != null) {
    if (!Array.isArray(raw.children)) {
      return { ok: false, error: 'menu item children must be an array' };
    }
    if (depth >= 1) {
      return { ok: false, error: 'menu item children depth exceeded' };
    }
    if (raw.children.length > MENU_MAX_CHILDREN) {
      return { ok: false, error: `menu item children too many (max ${MENU_MAX_CHILDREN})` };
    }
    const children = [];
    for (const child of raw.children) {
      const r = validateMenuItem(child, source, depth + 1, seenIds);
      if (!r.ok) return r;
      children.push(r.item);
    }
    item.children = children;
  }

  return { ok: true, item };
}

function validateMenuSection(raw, options = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'menu section must be an object' };
  }
  const sourceRaw = typeof raw.source === 'string' ? raw.source : options.defaultSource;
  if (typeof sourceRaw !== 'string' || !sourceRaw.trim()) {
    return { ok: false, error: 'source required' };
  }
  if (sourceRaw.length > MENU_MAX_SOURCE) {
    return { ok: false, error: `source too long (max ${MENU_MAX_SOURCE} chars)` };
  }
  if (!Array.isArray(raw.items)) {
    return { ok: false, error: 'items array required' };
  }
  if (raw.items.length > MENU_MAX_ITEMS) {
    return { ok: false, error: `items too many (max ${MENU_MAX_ITEMS})` };
  }
  const source = sourceRaw.trim();
  const section = { source, items: [] };
  if (raw.title != null) {
    if (typeof raw.title !== 'string') {
      return { ok: false, error: 'title must be a string' };
    }
    if (raw.title.length > MENU_MAX_TEXT) {
      return { ok: false, error: 'title too long' };
    }
    section.title = raw.title;
  }

  const seenIds = new Set();
  for (const item of raw.items) {
    const r = validateMenuItem(item, source, 0, seenIds);
    if (!r.ok) return r;
    section.items.push(r.item);
  }
  return { ok: true, section };
}

function getConfigMenuSections() {
  const config = loadUserConfig();
  const rawSections = Array.isArray(config.menuItems) ? config.menuItems : [];
  if (!rawSections.length) return [];
  if (rawSections.length > MENU_MAX_SECTIONS) {
    console.error(`${LOG_PREFIX} config menuItems too many (max ${MENU_MAX_SECTIONS})`);
    return [];
  }
  const sections = [];
  for (const raw of rawSections) {
    const r = validateMenuSection(raw, { defaultSource: 'config' });
    if (!r.ok) {
      console.error(`${LOG_PREFIX} invalid config menu item: ${r.error}`);
      return [];
    }
    sections.push(r.section);
  }
  return sections;
}

function builtinMenuSection() {
  return {
    source: 'builtin',
    items: [
      {
        id: 'settings',
        label: '設定',
        icon: '⚙',
        action: { type: 'open-settings' },
      },
    ],
  };
}

function mergedMenuSections() {
  return [
    ...getConfigMenuSections(),
    ...Array.from(menuSources.values()),
    builtinMenuSection(),
  ];
}

function pushMenuUpdate() {
  if (win && !win.isDestroyed()) {
    win.webContents.send('menu:update', mergedMenuSections());
  }
}

function normalizeAbsoluteConfigPath(config, keys) {
  for (const key of keys) {
    const raw = config && typeof config[key] === 'string' ? config[key].trim() : '';
    if (raw && path.isAbsolute(raw)) return raw;
  }
  return '';
}

// 新 tasks-widget.json（宣言的ウィジェット）の絶対パス。widgetFile 優先、tasksWidgetPath も受け付ける。
function normalizeTasksWidgetFile(config) {
  return normalizeAbsoluteConfigPath(config, ['widgetFile', 'tasksWidgetPath', 'tasksWidgetFile']);
}

// 旧 tasks-view.json の絶対パス。dual-write 期間の後方互換注記（legacyNotice）判定にのみ使う。
function normalizeTasksFile(config) {
  return normalizeAbsoluteConfigPath(config, ['tasksFile', 'tasksViewPath']);
}

function normalizeCommandsFile(config) {
  return normalizeAbsoluteConfigPath(config, ['commandsPath', 'tasksCommandFile']);
}

// tasks-widget.json を読み、契約に沿ってサニタイズしたウィジェットを返す。
// ファイルが無い・JSON が壊れている・kind が契約外のときは widget: null を返す。
function readWidgetFromFile(filePath) {
  let raw = null;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (_e) {
    return { raw: null, widget: null };
  }
  try {
    const parsed = JSON.parse(raw);
    // サーバー側の検証（防御的サニタイズ）。tone/field/action/rel の allowlist・文字長上限・
    // URL の http(s) 検証・payload のプリミティブ化をここで行い、renderer へ渡す前に安全化する。
    const widget = widgetContract.sanitizeWidget(parsed);
    return { raw, widget };
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to parse tasks widget: ${filePath}`, e.message);
    return { raw, widget: null };
  }
}

// renderer / モバイルへ配る中継ペイロードを組み立てる。
// dual-write 期間: 新 widget があればそれを描画。無く旧 tasks-view.json だけがある場合は
// タスク語彙を復活させず legacyNotice のみ立てる（意味論には踏み込まない）。
function buildWidgetPayload(widget) {
  const config = loadUserConfig();
  const legacyConfigured = !!normalizeTasksFile(config);
  const legacyNotice = !widget && legacyConfigured;
  return {
    widget: widget || null,
    legacyNotice,
    commandsConfigured: !!normalizeCommandsFile(config),
  };
}

// commands.jsonl へ 1 行追記する共通機構（新 action は増やさない）。
async function appendTaskCommand(command, commandsFile = normalizeCommandsFile(loadUserConfig())) {
  if (!commandsFile) {
    return { ok: false, error: 'commands-file-not-configured' };
  }
  await fs.promises.mkdir(path.dirname(commandsFile), { recursive: true });
  await fs.promises.appendFile(commandsFile, `${JSON.stringify(command)}\n`, 'utf8');
  return { ok: true, id: command.id };
}

// 宣言のコマンド断片 { action, taskId, to, expected } を受け取り、契約 allowlist で検証してから
// 一意 id と requestedAt を付与し commands.jsonl へ追記する。ビューア（VK Terminals）が id と
// requestedAt を付与する契約なので、ここで crypto.randomUUID と ISO8601 を採番する。
async function submitWidgetCommand(fragment) {
  try {
    const commandsFile = normalizeCommandsFile(loadUserConfig());
    if (!commandsFile) {
      return { ok: false, error: 'commands-file-not-configured' };
    }
    const command = widgetContract.buildCommandLine(fragment, {
      id: crypto.randomUUID(),
      requestedAt: new Date().toISOString(),
    });
    if (!command) {
      return { ok: false, error: 'invalid-command' };
    }
    return appendTaskCommand(command, commandsFile);
  } catch (e) {
    console.error(LOG_PREFIX, e);
    return { ok: false, error: 'internal-error' };
  }
}

function widgetCommandHttpStatus(result) {
  if (!result || result.ok) return 200;
  if (result.error === 'commands-file-not-configured') return 409;
  if (result.error === 'invalid-command') return 400;
  return 500;
}

function currentWidgetPayload() {
  if (widgetPayload) return widgetPayload;
  const config = loadUserConfig();
  const filePath = normalizeTasksWidgetFile(config);
  const widget = filePath ? readWidgetFromFile(filePath).widget : null;
  widgetPayload = buildWidgetPayload(widget);
  return widgetPayload;
}

function pushWidgetUpdate() {
  if (!win || win.isDestroyed()) return;
  win.webContents.send('widgets:update', currentWidgetPayload());
}

function refreshWidgetSnapshot(forceSend = false) {
  const config = loadUserConfig();
  widgetFilePath = normalizeTasksWidgetFile(config);
  const next = widgetFilePath ? readWidgetFromFile(widgetFilePath) : { raw: null, widget: null };
  const changed = next.raw !== widgetLastRaw;
  widgetLastRaw = next.raw;
  widgetPayload = buildWidgetPayload(next.widget);
  if (changed || forceSend) pushWidgetUpdate();
}

function scheduleWidgetRefresh() {
  if (widgetDebounceTimer) clearTimeout(widgetDebounceTimer);
  widgetDebounceTimer = setTimeout(() => {
    widgetDebounceTimer = null;
    refreshWidgetSnapshot(true);
  }, WIDGET_WATCH_DEBOUNCE_MS);
}

function startWidgetWatcher() {
  widgetFilePath = normalizeTasksWidgetFile(loadUserConfig());
  refreshWidgetSnapshot(false);
  if (!widgetFilePath) return;

  try {
    const dir = path.dirname(widgetFilePath);
    const base = path.basename(widgetFilePath);
    widgetWatch = fs.watch(dir, (eventType, filename) => {
      if (!filename || String(filename) === base) scheduleWidgetRefresh();
    });
    widgetWatch.on('error', (e) => {
      console.error(`${LOG_PREFIX} widget watcher failed:`, e && e.message);
    });
  } catch (e) {
    console.error(`${LOG_PREFIX} Failed to watch widget file: ${widgetFilePath}`, e && e.message);
  }

  widgetPollTimer = setInterval(() => refreshWidgetSnapshot(false), WIDGET_POLL_INTERVAL_MS);
}

function stopWidgetWatcher() {
  if (widgetDebounceTimer) clearTimeout(widgetDebounceTimer);
  widgetDebounceTimer = null;
  if (widgetPollTimer) clearInterval(widgetPollTimer);
  widgetPollTimer = null;
  if (widgetWatch) {
    try { widgetWatch.close(); } catch (_e) {}
  }
  widgetWatch = null;
}

/**
 * ユーザー設定を読み込む。
 * 読み込み順:
 *   1. ~/.vk-terminals/config.json（ユーザー固有設定）
 *   2. {appDir}/config.json（リポジトリローカル設定）
 *   3. ~/.claude/terminals-config.json（後方互換）
 * どちらも存在しない場合は空オブジェクトを返す。
 *
 * @returns {{ initialCommand?: string, additionalPanes?: Array<{cwd: string}>, waitingExcludeCwdPatterns?: string[], tasksFile?: string }} 設定オブジェクト
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

// app が ready になる前に GPU スイッチを適用する（appendSwitch は ready 前に呼ぶ必要がある）。
// config.json の gpu も見るため loadUserConfig 定義後に実行する（env 未指定時に config を採用）。
const appliedGpuMode = applyGpuMode(app, { configMode: loadUserConfig().gpu });
if (appliedGpuMode) console.log(`${LOG_PREFIX} GPU mode: ${appliedGpuMode}`);

// テストや並列起動時は環境変数で上書きし、未指定時は config.json の port を採用する。
// loadUserConfig() は DATA_DIR を参照するため、DATA_DIR / loadUserConfig 定義後に算出する。
const API_PORT = (() => {
  const raw = Number(process.env.VK_TERMINALS_API_PORT ?? loadUserConfig().port);
  return Number.isInteger(raw) && raw >= 1 && raw <= 65535 ? raw : 13847;
})();

// ─── トークン使用量（issue #69）────────────────────────────────────────────────
// GET /api/states（モバイルページが ~2s ごとにポーリング）のホットパスで usage 判定の
// たびに loadUserConfig() の同期 I/O（readFileSync + JSON.parse）を走らせないよう、
// usage 系ヘルパー専用に config を短TTL（5s）でメモ化する（CR-1）。
//   - このメモは usage 判定（usageEnabled / usageProjectsDirs）だけが使う。settings:describe /
//     settings:save / app:get-config は従来どおり loadUserConfig() を直接呼ぶ（設定変更を即時反映
//     させるため、loadUserConfig 自体はグローバルキャッシュしない）。
//   - TTL 5s なので、設定変更後も遅くとも 5 秒で usage 表示に反映される。
const USAGE_CONFIG_TTL_MS = 5000;
const usageConfig = createTtlMemo(loadUserConfig, USAGE_CONFIG_TTL_MS);

// showUsage は opt-out（既定 ON）。config.json で明示的に false のときだけ無効化する。
// （settings descriptor 側でも default:true を持たせ、GUI の未設定→false 化を防ぐ。）
function usageEnabled() {
  return usageConfig().showUsage !== false;
}

function codexUsageEnabled() {
  return usageConfig().showCodexUsage !== false;
}

// 集計対象の Claude projects ディレクトリ。複数アカウントは config.claudeProjectsDirs で
// 複数指定できる。未指定なら usageTracker 側の既定（~/.claude/projects）を使う。
function usageProjectsDirs() {
  const raw = usageConfig().claudeProjectsDirs;
  if (Array.isArray(raw)) {
    const dirs = raw.filter((d) => typeof d === 'string' && d.trim());
    if (dirs.length) return dirs;
  }
  return null; // null → usageTracker のデフォルト
}

// トラッカーは 1 個だけ生成し、差分読み・SWR キャッシュを内包させる。
const usageTracker = createUsageTracker({
  getDirs: () => usageProjectsDirs(),
});

// 表示用に整形したスナップショットを返す。無効時・失敗時は null（アプリ本体に影響させない）。
function getUsageForDisplay() {
  try {
    if (!usageEnabled()) return null;
    return usageTracker.getDescribed();
  } catch (e) {
    console.error(`${LOG_PREFIX} usage snapshot failed:`, e && e.message);
    return null;
  }
}

// 公式 usage API のプロバイダ（issue #73）。60 秒 TTL キャッシュを内包し、renderer の
// ポーリング（設定モーダルの使用状況ビュー・歯車バッジ）やモバイルページの /api/states
// ポーリングが重なっても API / Keychain への問い合わせは 60 秒に 1 回に抑えられる。
const oauthUsage = createOauthUsageProvider();
const codexUsage = createCodexUsageProvider();
const codexUsageTracker = createCodexUsageTracker();

// 使用状況の統一構造を返す（issue #73）。
//   - 公式 usage API（source: 'oauth'、session / weekly の % とリセット時刻）を主とする。
//   - 取得不可（未ログイン・期限切れ・オフライン・Keychain 拒否・API 変更等）のときは
//     既存のトランスクリプト集計（source: 'transcript'、describeUsage の整形済み値）へ
//     フォールバックする。どちらも無ければ null。
//   - opt-out 設定 showUsage=false のときは常に null。
async function getUsageUnified() {
  if (!usageEnabled()) return null;
  try {
    const oauth = await oauthUsage.get();
    if (oauth) return oauth;
  } catch (e) {
    // oauthUsage 側で握りつぶしているため通常ここには来ないが、念のための保険。
    // トークン等の秘匿情報はエラーメッセージに含まれない設計（oauthUsage.js 参照）。
    console.error(`${LOG_PREFIX} oauth usage failed:`, e && e.message);
  }
  return getUsageForDisplay();
}

async function getCodexUsageUnified() {
  if (!codexUsageEnabled()) return null;
  let limits = null;
  try {
    limits = await codexUsage.get();
  } catch (e) {
    console.error(`${LOG_PREFIX} codex usage failed:`, e && e.message);
  }

  let tokens = null;
  try {
    tokens = codexUsageTracker.getDescribed();
  } catch (e) {
    console.error(`${LOG_PREFIX} codex token usage failed:`, e && e.message);
  }

  if (!limits && !tokens) {
    return {
      source: 'codex',
      session: null,
      weekly: null,
      tokens: null,
      fetchedAtMs: Date.now(),
      empty: true,
    };
  }
  return {
    source: 'codex',
    session: limits && limits.session ? limits.session : null,
    weekly: limits && limits.weekly ? limits.weekly : null,
    stale: limits && limits.stale === true ? true : undefined,
    fetchedAtMs: limits && Number.isFinite(limits.fetchedAtMs)
      ? limits.fetchedAtMs
      : (tokens && tokens.fetchedAtMs) || Date.now(),
    tokens,
  };
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
    // `v` プレフィックスは任意。リリースタグは v なし（例: 1.4.1）と v あり（例: v1.1.0）が
    // 混在しているため、両形式を拾う。バージョン比較は compareSemver が `v` を除去して行う。
    const latestTag = lsRemoteOut
      .split('\n')
      .map((l) => l.match(/refs\/tags\/(v?\d+\.\d+\.\d+)$/)?.[1])
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

  // e2e（Playwright）実行時はウィンドウを画面に表示しないことで、実行中に OS のフォーカスを
  // 奪って PC 操作を妨げないようにする。Playwright は CDP 経由で操作するため OS 上の表示は不要。
  // ただし描画/スクリーンショットに依存するテスト向けに VK_TERMINALS_E2E_SHOW=1 で表示に opt-out できる。
  // 通常起動（env 未設定）では従来どおり表示する。
  const showWindow = process.env.VK_TERMINALS_E2E === '1'
    ? process.env.VK_TERMINALS_E2E_SHOW === '1'
    : true;

  win = new BrowserWindow({
    width: winW,
    height: winH,
    x,
    y,
    show: showWindow,
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
    title: APP_TITLE,
  });

  win.webContents.on('did-finish-load', () => {
    pushMenuUpdate();
    pushWidgetUpdate();
  });
  win.loadFile('renderer/index.html');
  // win.webContents.openDevTools(); // uncomment to debug
}

app.whenReady().then(async () => {
  createWindow();
  startWidgetWatcher();
  await checkAndUpdate();
  startHttpApi();
  // 使用量スナップショットを起動時に温めておく（初回ポーリングで null が返るのを避ける）。
  if (usageEnabled()) usageTracker.warmup().catch(() => {});
  if (codexUsageEnabled()) Promise.all([codexUsage.get(), codexUsageTracker.warmup()]).catch(() => {});
});

app.on('window-all-closed', () => {
  cleanupPtys();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  cleanupPtys();
  stopWidgetWatcher();
  try { fs.unlinkSync(STATE_FILE); } catch (e) {}
  if (httpServer) httpServer.close();
});

// renderer がエージェントルーム（issue #58）の有効/無効を知るための設定取得。
//   本来は config.json の `agentroom: true` のときだけ各ペイン下部にアコーディオンを
//   表示するが、issue #70 でエージェントルーム（β）を一旦無効化するため、config.json の
//   値によらず agentroom は常に false を返す。復帰時は agentroom の返却値だけ
//   `config.agentroom === true` に戻せばよい。
ipcMain.handle('app:get-config', () => {
  const config = loadUserConfig();
  // waitingExcludeCwdPatterns は設定 GUI には出さず、config.json 直編集専用にする（#192）。
  // 読み込み・除外判定の機能は維持し、GUI 項目だけ settings-schema.json から削除した。
  const waitingExcludeCwdPatterns = Array.isArray(config.waitingExcludeCwdPatterns)
    ? config.waitingExcludeCwdPatterns.filter((pattern) => typeof pattern === 'string')
    : [];
  const widgetFile = normalizeTasksWidgetFile(config);
  const tasksFile = normalizeTasksFile(config);
  const commandsFile = normalizeCommandsFile(config);
  return {
    agentroom: false,
    appTitle: APP_TITLE,
    newPaneStartupDir: typeof config.newPaneStartupDir === 'string' ? config.newPaneStartupDir.trim() : '',
    newPaneAutoLaunchClaude: config.newPaneAutoLaunchClaude === true,
    // ペインを閉じる時の確認（issue #184）。不正値・未指定は既定 'busy' に正規化して渡す。
    confirmClose: normalizeConfirmClose(config.confirmClose),
    waitingExcludeCwdPatterns,
    widgetFile,
    // tasksFile（旧 tasks-view.json）は dual-write 期間の後方互換注記判定に残す。
    tasksFile,
    commandsFile,
  };
});

// 宣言的ウィジェットのコマンド中継（汎用）。renderer は宣言に載っていたコマンド断片
// { action, taskId, to, expected } をそのまま渡し、main が検証・id/requestedAt 付与・追記する。
ipcMain.handle('widgets:command', async (_event, fragment) => {
  return submitWidgetCommand(fragment);
});

// 使用状況の取得（issue #69 → #73 で公式 API 主・トランスクリプト従の統一構造に変更）。
// renderer（設定モーダルの使用状況ビュー: 表示中のみ初回即時＋60秒間隔 / 歯車の警告
// ドットバッジ: 60秒間隔）がポーリングする。main 側 60 秒 TTL キャッシュに相乗りするため
// 実際の API 問い合わせは増えない。無効時・データ無し・失敗時は null。
ipcMain.handle('usage:get', () => getUsageUnified());
ipcMain.handle('codex-usage:get', () => getCodexUsageUnified());

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

// 組み込みディスクリプタが編集する「vk-terminals 自身の config.json」のパスを解決する。
// loadUserConfig() の読み込み順に合わせ、既存の候補があればそれを、無ければ appDir 直下
// （README の `cp config.example.json config.json` の既定先）を対象にする。
function resolveOwnConfigTargetPath() {
  const candidates = [
    path.join(DATA_DIR, 'config.json'),
    path.join(__dirname, 'config.json'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return path.join(__dirname, 'config.json');
}

// env 未指定（スタンドアロン起動）時に使う組み込みディスクリプタ。静的な項目定義は
// settings-schema.json に置き、実行時に決まる targetPath だけをここで合成する。
function builtinSettingsDescriptor() {
  return buildBuiltinSettingsDescriptor({
    targetPath: resolveOwnConfigTargetPath(),
    onError: (error, schemaPath) => {
      console.error(`${LOG_PREFIX} Failed to load built-in settings schema: ${schemaPath}`, error);
    },
  });
}

// ディスクリプタを解決する。env VK_TERMINALS_SETTINGS が指す有効なディスクリプタが
// あればそれを優先し（vk-orchestrator など呼び出し側の設定を編集）、無い／不正な場合は
// 組み込みディスクリプタ（vk-terminals 自身の config.json を編集）にフォールバックする。
// これにより単体起動でも常に設定パネルを表示できる。
function loadSettingsDescriptor() {
  const p = settingsDescriptorPath();
  if (p && fs.existsSync(p)) {
    try {
      const d = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (isValidSettingsDescriptor(d)) {
        return d;
      }
      console.error(`${LOG_PREFIX} Invalid settings descriptor (unresolved targetPath/groups): ${p}`);
    } catch (e) {
      console.error(`${LOG_PREFIX} Failed to parse settings descriptor: ${p}`, e);
    }
    // env 指定が不正でも、単体編集用の組み込みディスクリプタにフォールバックする。
  }
  return builtinSettingsDescriptor();
}

// renderer 用: ディスクリプタと targetPath の現在値を返す。VK_TERMINALS_SETTINGS が
// 未設定なら available:false（renderer 側は設定ボタンを表示しない）。
ipcMain.handle('settings:describe', () => {
  const descriptor = loadSettingsDescriptor();
  if (!descriptor) return { available: false };

  const values = describeSettingsValues(descriptor, {
    onReadError: (targetPath, e) => {
      console.error(`${LOG_PREFIX} Failed to read target config: ${targetPath}`, e);
    },
  });
  const targetInfo = describeTargetPaths(descriptor);
  const groups = descriptor.groups.map((group, index) => ({
    ...group,
    targetPaths: targetInfo.groupTargets[index] || [],
  }));
  return {
    available: true,
    title: descriptor.title || '設定',
    note: descriptor.note || '',
    tabs: Array.isArray(descriptor.tabs) ? descriptor.tabs : [],
    targetPath: targetInfo.targetPath,
    groups,
    values,
    appVersion: require('./package.json').version,
    targetPaths: targetInfo.allTargets,
    hasMultipleTargets: targetInfo.hasMultipleTargets,
  };
});

// renderer からの保存。ディスクリプタに載っているキーだけを型変換して書き戻す
// （未知のキーは既存 config から保持する。書き込み先は field/group/descriptor の targetPath）。
ipcMain.handle('settings:save', (event, incoming) => {
  const descriptor = loadSettingsDescriptor();
  if (!descriptor) return { ok: false, error: '設定ディスクリプタが見つかりません' };

  return saveSettingsToTargets(descriptor, incoming);
});

ipcMain.handle('terminal:create', (event, cwd, options = {}) => {
  const id = String(nextId++);
  const shell = process.env.SHELL || (process.platform === 'win32' ? (process.env.COMSPEC || 'powershell.exe') : '/bin/zsh');
  let resolvedCwd = cwd || process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  try {
    if (!fs.existsSync(resolvedCwd) || !fs.statSync(resolvedCwd).isDirectory()) {
      resolvedCwd = process.env.HOME || process.env.USERPROFILE || os.tmpdir();
    }
  } catch (_e) {
    resolvedCwd = process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  }

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

ipcMain.on('terminal:close-pane-done', (event, payload = {}) => {
  const { requestId, ...result } = payload;
  if (!requestId) return;
  const resolve = pendingClosePaneCallbacks.get(requestId);
  if (!resolve) return;
  pendingClosePaneCallbacks.delete(requestId);
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
  pushMenuUpdate();
  pushWidgetUpdate();
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
      res.end(JSON.stringify(buildHealthResponse(INSTANCE_ID)));
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

    // GET /mobile.css — mobile.html は静的ファイルサーバーではないため、
    // CSS を外部化したファイルも明示的に配信する。
    if (req.method === 'GET' && url.pathname === '/mobile.css') {
      fs.readFile(path.join(__dirname, 'renderer', 'mobile.css'), (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'mobile css not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    // GET /widgetContract.js / /widgetView.js / 共有 UMD / /mobile.js — モバイルは静的ファイルサーバーではないため、
    // 宣言的ウィジェットの共有描画モジュール（PC 版と共通）とモバイル用 JS を明示的に配信する。
    if (req.method === 'GET' && (
      url.pathname === '/widgetContract.js'
      || url.pathname === '/widgetView.js'
      || url.pathname === '/terminalDisplay.js'
      || url.pathname === '/urlSafety.js'
      || url.pathname === '/statusPresentation.js'
      || url.pathname === '/mobilePreviewText.js'
      || url.pathname === '/mobile.js'
    )) {
      const fileMap = {
        '/widgetContract.js': path.join(__dirname, 'utils', 'widgetContract.js'),
        '/widgetView.js': path.join(__dirname, 'renderer', 'widgetView.js'),
        '/terminalDisplay.js': path.join(__dirname, 'renderer', 'terminalDisplay.js'),
        '/urlSafety.js': path.join(__dirname, 'renderer', 'urlSafety.js'),
        '/statusPresentation.js': path.join(__dirname, 'renderer', 'statusPresentation.js'),
        '/mobilePreviewText.js': path.join(__dirname, 'renderer', 'mobilePreviewText.js'),
        '/mobile.js': path.join(__dirname, 'renderer', 'mobile.js'),
      };
      fs.readFile(fileMap[url.pathname], (err, data) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'widget module not found' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(data);
      });
      return;
    }

    // GET /api/states
    if (req.method === 'GET' && url.pathname === '/api/states') {
      // usage（issue #69）はモバイルページの既存ポーリングに相乗りで additive に追加する。
      // issue #73 で公式 API（source:'oauth'）主・トランスクリプト（source:'transcript'）従の
      // 統一構造になった。oauth 取得は非同期（main 側 60s TTL キャッシュ済み）のため、
      // ここだけ Promise を待ってからレスポンスする。失敗時は usage: null（後方互換）。
      //
      // codexUsage（issue #218）も同様に additive に追加する。PC 版サイドバーと同じ
      // getCodexUsageUnified() の統一構造を返し、モバイルでも Codex 使用量カードを描画する。
      // usage と並行取得（Promise.all）し、片方が失敗しても他方に影響させない。失敗時は
      // codexUsage: null（後方互換）。showCodexUsage=false のときは main 側で null が返る。
      Promise.all([
        Promise.resolve(getUsageUnified()).catch(() => null),
        Promise.resolve(getCodexUsageUnified()).catch(() => null),
      ]).then(([usage, codexUsage]) => {
        res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          updatedAt: new Date().toISOString(),
          terminals: cachedStates,
          usage,
          codexUsage,
          version: require('./package.json').version,
          appTitle: APP_TITLE,
        }));
      });
      return;
    }

    // GET /api/widgets
    //   モバイルページ向けに宣言的ウィジェット（tasks-widget.json）の中継ペイロードを返す。
    //   ステータス遷移・ラベル・確認文言などの語彙は持たず、サニタイズ済みの宣言をそのまま返す。
    if (req.method === 'GET' && url.pathname === '/api/widgets') {
      const config = loadUserConfig();
      const filePath = normalizeTasksWidgetFile(config);
      let payload = widgetPayload;
      if (!payload || filePath !== widgetFilePath) {
        const widget = filePath ? readWidgetFromFile(filePath).widget : null;
        payload = buildWidgetPayload(widget);
      }
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(payload));
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

    // POST /api/widgets/command  { action, taskId, to, expected }
    //   宣言に載っていたコマンド断片をそのまま受け取り、契約 allowlist で検証してから
    //   id / requestedAt を付与し commands.jsonl へ追記する（サイドバー IPC widgets:command と同経路）。
    if (req.method === 'POST' && url.pathname === '/api/widgets/command') {
      if (isForbiddenOrigin(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden origin' }));
        return;
      }
      readJsonBody(req, res, 10 * 1024, async (body) => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch (_e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        const result = await submitWidgetCommand(parsed);
        res.writeHead(widgetCommandHttpStatus(result), { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result.ok ? result : { ok: false, error: result.error }));
      });
      return;
    }

    // POST /api/set-title  { termId: "1", title: "タスク名", url?: "https://...", prUrl?: "https://...", prMerged?: true }
    //   — ペイン上部のタスクタイトル行に表示する文字列を設定。
    //   空文字や null を title に指定するとタイトル行を非表示に戻す。
    //   url を指定するとタイトル全体をリンク化（クリックで OS の既定ブラウザで開く）。
    //   url を省略すると URL なし扱い、空文字 "" を渡すと既存 URL をクリアする扱い。
    //   url は http(s): スキームのみ許可・new URL() で parse 可能・2048 文字以内の制約あり。
    //   title と url はペアで都度送る置換セマンティクス（patch ではない）。
    //   prUrl（issue #44）: タイトル右側の独立した [ PR ↗ ] ボタンに紐づける URL。
    //   省略 → PR ボタンなし扱い、空文字 "" → 既存 prUrl をクリア。
    //   バリデーションは url と同一規約（http(s):・2048 文字以内・new URL() parse 可）。
    //   prMerged: PR ボタンをマージ済み表示にする真偽値。厳密な true のみ true、それ以外は false。
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
          const prMergedValue = parsed?.prMerged === true;

          if (win && !win.isDestroyed()) {
            win.webContents.send('terminal:title', termId, title, urlValue, prUrlValue, prMergedValue);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, termId, title, url: urlValue, prUrl: prUrlValue, prMerged: prMergedValue }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/set-status  { termId: "1", waiting: true }
    //   — オーケストレーター等の外部権威が、そのペインの入力待ち状態を明示設定する。
    //   waiting: true で外部権威フラグを立て、waiting: false で解除する。
    //   ローカル PTY 検知とは別レイヤーとして renderer 側で OR 合流し、自動入力・再描画では解除しない。
    //   termId は必須、waiting は真偽値のみ許可する（文字列 "true" 等は 400）。
    if (req.method === 'POST' && url.pathname === '/api/set-status') {
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
          if (typeof parsed?.waiting !== 'boolean') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'waiting must be a boolean' }));
            return;
          }
          const waiting = parsed.waiting;
          if (win && !win.isDestroyed()) {
            win.webContents.send('terminal:set-status', termId, waiting);
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, termId, waiting }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/set-lock  { termId: "1", lock: { close: false } }
    //   — オーケストレーター等の外部権威が、そのペインの操作ロック状態を明示設定する。
    //   lock.close === false のときだけ UI から閉じられない状態として扱う。
    //   lock: null または { close: true } は解除相当。将来 stash/move 等を足せる拡張形にする。
    if (req.method === 'POST' && url.pathname === '/api/set-lock') {
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
      readJsonBody(req, res, 10 * 1024, (body) => {
        try {
          const parsed = JSON.parse(body);
          const rawTermId = parsed?.termId;
          if (!rawTermId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'termId required' }));
            return;
          }
          const termId = String(rawTermId);
          if (!ptys.has(termId)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `terminal ${termId} not found` }));
            return;
          }

          const rawLock = parsed?.lock;
          let lock = null;
          if (rawLock === null) {
            lock = null;
          } else if (rawLock && typeof rawLock === 'object' && typeof rawLock.close === 'boolean') {
            lock = { close: rawLock.close };
          } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'lock must be null or an object with boolean close' }));
            return;
          }

          win.webContents.send('terminal:set-lock', termId, lock);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
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

    // POST /api/menu  { source: "vk-orchestrator", title?: "...", items: [...] }
    //   — サイドバーメニューを source 単位で置換する。items: [] は該当 source のクリア。
    if (req.method === 'POST' && url.pathname === '/api/menu') {
      if (isForbiddenOrigin(req)) {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'forbidden origin' }));
        return;
      }
      const MAX_BODY = 10 * 1024;
      readJsonBody(req, res, MAX_BODY, (body) => {
        try {
          const parsed = JSON.parse(body);
          const r = validateMenuSection(parsed);
          if (!r.ok) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: r.error }));
            return;
          }
          const { source, items } = r.section;
          if (items.length === 0) {
            menuSources.delete(source);
          } else {
            if (!menuSources.has(source) && menuSources.size >= MENU_MAX_SECTIONS) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: `too many menu sources (max ${MENU_MAX_SECTIONS})` }));
              return;
            }
            menuSources.set(source, r.section);
          }
          pushMenuUpdate();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, source }));
        } catch (e) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
        }
      });
      return;
    }

    // POST /api/new-pane  { cwd?: "/path/to/dir", noClaude?: boolean, stashed?: boolean } — 新規ペインを作成して termId を返す
    //   cwd を指定すればそのディレクトリで開く。未指定なら HOME で開く。
    //   noClaude: true を指定すると、新規ペインで claude を自動起動せず素のシェルとして開く。
    //   stashed: true を指定すると、サイドバー格納＋折りたたみ状態で開く。
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
        let requestedStashed;
        let requestedUseDefaults;
        if (body.length > 0) {
          try {
            const parsed = JSON.parse(body);
            if (typeof parsed?.cwd === 'string' && parsed.cwd.trim()) {
              requestedCwd = parsed.cwd;
            }
            if (typeof parsed?.noClaude === 'boolean') {
              requestedNoClaude = parsed.noClaude;
            }
            if (typeof parsed?.stashed === 'boolean') {
              requestedStashed = parsed.stashed;
            }
            // useDefaults: true のときだけ、cwd/noClaude 省略時に renderer 側で
            // config 既定値（newPaneStartupDir / !newPaneAutoLaunchClaude）を補う。
            // モバイルの「ペインを追加」ボタン専用のオプトイン。他の呼び出し元
            // （orchestrator 等）は従来どおり passthrough される（issue #217）。
            if (typeof parsed?.useDefaults === 'boolean') {
              requestedUseDefaults = parsed.useDefaults;
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
        if (typeof requestedStashed === 'boolean') payload.stashed = requestedStashed;
        if (requestedUseDefaults === true) payload.useDefaults = true;
        win.webContents.send('terminal:request-new-pane', payload);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/close-pane') {
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
      readJsonBody(req, res, 10 * 1024, (body) => {
        let termId;
        try {
          const parsed = JSON.parse(body);
          termId = parsed?.termId;
        } catch {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON' }));
          return;
        }
        if (!termId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'termId required' }));
          return;
        }
        if (!ptys.has(String(termId))) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'terminal ' + termId + ' not found' }));
          return;
        }
        const requestId = String(nextClosePaneRequestId++);
        const timeoutId = setTimeout(() => {
          if (pendingClosePaneCallbacks.has(requestId)) {
            pendingClosePaneCallbacks.delete(requestId);
            res.writeHead(504, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'timeout waiting for close pane' }));
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
        pendingClosePaneCallbacks.set(requestId, resolve);
        win.webContents.send('terminal:request-close-pane', { requestId, termId: String(termId) });
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
