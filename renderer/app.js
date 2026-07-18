/* global require */
const { ipcRenderer, shell } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { appendAnsiForDisplay, stripAnsiForDisplay } = require('../utils/stripAnsi');
const { normalizeConfirmClose, shouldConfirmClose } = require('../utils/closeConfirm');
const { getTaskStatusActions } = require('../utils/taskStatusActions');
// エージェントルーム（issue #58）。サブエージェントの稼働状況をドット絵キャラで可視化する。
const { AGENT_ORDER, buildScene, resolveAgentStatesFromOutput } = require('./agentRoom');
const {
  isWaitingCwdExcluded,
  matchesWaiting,
  nextWaitingState,
  normalizeWaitingExcludeCwdPatterns,
} = require('./waitingState');
const { deriveStatus } = require('./statusState');
const { getPrBadgePresentation } = require('./prBadge');
const { isPatternValid } = require('./settingsValidation');
const {
  deriveSettingsTargetPathsForGroups,
  groupSettingsGroupsByTab,
  normalizeSettingsTabs,
} = require('./settingsTabs');

// ─── xterm.css の注入 ─────────────────────────────────────────────────────────
// xterm.css は index.html の相対パス <link> ではなく、Node のモジュール解決
// （require.resolve）で実体を探して <style> として注入する。
//
// なぜ必要か:
//   vk-terminals が npm 依存としてインストールされた場合（例: vk-orchestrator の
//   node_modules 内から起動）、依存パッケージは上位の node_modules へホイストされ、
//   自身の node_modules ディレクトリが存在しない。require() は上位へ遡って解決できるが、
//   <link href="../node_modules/..."> の相対パスは遡れず 404 になる。
//   xterm.css には IME 用 textarea を画面外へ逃がす必須スタイル
//   （.xterm-helper-textarea の position: absolute / opacity: 0 / left: -9999em 等）が
//   含まれており、欠落すると textarea が文書フロー上（ペイン左上）に可視状態で置かれ、
//   日本語入力の変換候補ウィンドウがペイン左上に表示される・合成中の文字列が
//   ペイン上部に見えてしまう。
(() => {
  const fs = require('fs');
  try {
    const css = fs.readFileSync(require.resolve('@xterm/xterm/css/xterm.css'), 'utf8');
    const style = document.createElement('style');
    style.textContent = css;
    // アプリ側 style.css より前に挿入し、既存の上書き関係（style.css が後勝ち）を維持する
    const appCss = document.querySelector('link[href="style.css"]');
    document.head.insertBefore(style, appCss);
  } catch (e) {
    // 読み込み失敗時もアプリ自体は起動させる（従来の <link> 404 と同等の状態に留める）
    console.error('xterm.css の読み込みに失敗しました', e);
  }
})();

// ─── State ────────────────────────────────────────────────────────────────────
let tree = null;       // Layout tree root
// ペイン D&D 中の状態（issue #40）。リサイズ用の dragState とは別変数で衝突回避。
//   - srcId: ドラッグ中のペイン id
//   - lastTargetId / lastDir: 直前フレームで描画したオーバーレイの対象と方向（再描画スキップ判定用）
let paneDragState = null;
// pane D&D 用の独自 MIME。既存のファイル D&D（パス挿入）と分岐するためのキー（issue #40）
const PANE_DRAG_MIME = 'application/x-vk-pane';
// 中央デッドゾーンの比率（issue #40）。0.2 = 中央 20% を無効ゾーンとして扱う
const PANE_DROP_DEADZONE = 0.2;
// terminals[paneId] のフィールド概要（status / runningTimer は issue #23 で追加）:
//   - waiting (bool): 内部判定用フラグ。WAITING_PATTERNS ヒットで true になり、入力まで保持。
//     states.json 後方互換のために残してある（task-queue 等の外部連携が参照している）。
//   - externalWaiting (bool): 外部権威の入力待ちフラグ。POST /api/set-status の明示 push だけで更新。
//     自動入力・リサイズ・再描画では解除せず、waiting と OR で status に合流する。
//   - status ('idle'|'running'|'waiting'): 表示用の派生値。
//     waiting または externalWaiting が true なら 'waiting' を最優先。
//     どちらも false で直近 1500ms 以内に PTY 出力があり、かつ直近 200ms 以内に入力がなければ 'running'。
//     どちらでもなければ 'idle'（DOM 側で要素ごと非表示）。
//   - runningTimer (number|null): 'running' を 1500ms 後に 'idle' へ戻すための setTimeout id。
//     recomputeStatus() / bumpRunning() が張り直し、closePane() で必ず clearTimeout する。
let terminals = {};    // paneId -> { termId, term, fitAddon, element, cwd, cwdFull, waiting, status, runningTimer, lastLines, ... }
let focusedPaneId = null;
let dragState = null;

// status 判定で使う閾値（ms）。
//   - RUNNING_IDLE_TIMEOUT_MS: 最後の PTY 出力から何 ms 経ったら idle に戻すか
//   - RUNNING_INPUT_GUARD_MS:  入力直後（タイプ中）はエコー出力で running 扱いしないためのガード時間
const RUNNING_IDLE_TIMEOUT_MS = 1500;
const RUNNING_INPUT_GUARD_MS = 200;

// ─── Agent room（issue #58） ────────────────────────────────────────────────
// config.json の `agentroom: true` のときだけ各ペイン下部にアコーディオンを表示する。
// 値は起動時に main プロセス（app:get-config）から取得する。
let agentRoomEnabled = false;
// 新規ペイン（＋ / 空グリッド「新規ペインを追加」）の既定挙動（issue #143）。
// 値は起動時に main（app:get-config）から取得する。設定反映には再起動が必要（設定パネルの note 参照）。
let newPaneStartupDir = '';
let newPaneAutoLaunchClaude = false;
// ペインを閉じる時の確認（issue #184）。'never' | 'busy' | 'always'（既定 'busy'）。
// 値は起動時に main（app:get-config）から取得する。設定反映には再起動が必要（設定パネルの note 参照）。
let confirmClosePref = 'busy';
let waitingExcludeCwdPatterns = [];
let tasksFileConfigured = false;
let commandsConfigured = false;
let lastTaskView = null;
const pendingTaskIds = new Set();
// HTTP API（POST /api/agentroom）由来のルーム状態を、この TTL を超えたら「古い」と判断して
// PTY 出力ベースのフォールバック表示に切り替える（ms）。
const AGENTROOM_API_TTL_MS = 90000;

// tasks-view.json は vk-orchestrator が数秒おきに更新する読み取り専用スナップショット。
// updatedAt がこの閾値を超えて古い場合は orchestrator 停止中として扱う。
const TASKS_ORCHESTRATOR_STALE_MS = 60000;
const TASKS_ELAPSED_TICK_MS = 30000;
const TASK_STATUS_ORDER = [
  'in-progress',
  'waiting-input',
  'ready',
  'awaiting-approval',
  'waiting-merge',
  'failed',
  'done',
];
const TASK_STATUS_LABELS = {
  'awaiting-approval': '承認待ち',
  'ready': '実行待ち',
  'in-progress': '実行中',
  'waiting-input': '入力待ち',
  'waiting-merge': 'マージ待ち',
  'done': '完了',
  'failed': '失敗',
};

// waiting 判定用 lastLines バッファの上限（issue #32 対応）。
//   - LASTLINES_MAX_LINES: 直近 N 行を保持する。
//     旧実装は 15 行だったが、Claude Code TUI はウィンドウリサイズや recap 表示で
//     プロンプト枠・「✻ Worked for ...」などの再描画行を数十行単位で吐き出すため、
//     肝心の確認待ち文（例: 「ご確認をお願いします。…」）がウィンドウから押し出されてしまい
//     検知できなくなっていた。十分大きめのウィンドウを取って取りこぼしを防ぐ。
//   - LASTLINES_MAX_CHARS: 行数だけだと「空行が大量に積まれる」状態でもメモリを食わないが、
//     1 行が極端に長い場合に備えて文字数の上限も設ける（保険）。
const LASTLINES_MAX_LINES = 80;
const LASTLINES_MAX_CHARS = 8000;

// ─── ID generation ────────────────────────────────────────────────────────────
let _idCounter = 0;
const newId = () => `pane-${++_idCounter}`;

// ─── Terminal theme ────────────────────────────────────────────────────────────
const TERM_THEME = {
  background: '#0d1117',
  foreground: '#e6edf3',
  cursor: '#e6edf3',
  cursorAccent: '#0d1117',
  selectionBackground: '#3d444d',
  black: '#0d1117', brightBlack: '#6e7681',
  red: '#ff7b72', brightRed: '#ffa198',
  green: '#3fb950', brightGreen: '#56d364',
  yellow: '#d29922', brightYellow: '#e3b341',
  blue: '#58a6ff', brightBlue: '#79c0ff',
  magenta: '#bc8cff', brightMagenta: '#d2a8ff',
  cyan: '#39c5cf', brightCyan: '#56d4dd',
  white: '#b1bac4', brightWhite: '#f0f6fc',
};

function checkWaiting(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  const matches = matchesWaiting(stripAnsiForDisplay(t.lastLines));
  const excluded = isWaitingCwdExcluded(t.cwdFull, waitingExcludeCwdPatterns);
  const waiting = nextWaitingState({ prev: t.waiting, matches, excluded });
  if (waiting !== t.waiting) {
    t.waiting = waiting;
    // waiting フラグが変わったら status も再計算する
    recomputeStatus(paneId);
    // 待機状態になったときに通知音を鳴らす
    if (waiting) shell.beep();
  }
}

// 入力（ユーザー入力・ドロップ送信・API 送信）があったペインのローカル入力待ち状態を解除する。
// スティッキー化した waiting の唯一の解除経路。externalWaiting は外部の明示 false push だけで解除する。
function markPaneInput(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  t.lastInputTime = Date.now();
  if (t.waiting) {
    t.waiting = false;
    t.lastLines = '';
  }
  recomputeStatus(paneId);
}

function clearRunningIdleTimer(t) {
  if (!t?.runningTimer) return;
  clearTimeout(t.runningTimer);
  t.runningTimer = null;
}

// running 表示の自動 idle 復帰タイマーを張り直す。
function armRunningIdleTimer(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  clearRunningIdleTimer(t);
  t.runningTimer = setTimeout(() => {
    const cur = terminals[paneId];
    if (!cur) return;
    cur.runningTimer = null;
    // タイマー満了時に waiting に変わっていたらそのまま、そうでなければ idle に戻す。
    if (!cur.waiting && !cur.externalWaiting && cur.status === 'running') {
      cur.status = 'idle';
      updatePaneStatus(paneId);
    }
  }, RUNNING_IDLE_TIMEOUT_MS);
}

// status を waiting フラグ・外部権威フラグ・最終出力時刻・最終入力時刻から再計算してセットする。
// 派生フィールドのため、ここ以外から t.status を直接書き換えないこと。
function recomputeStatus(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  const next = deriveStatus({
    localWaiting: t.waiting,
    externalWaiting: t.externalWaiting,
    now: Date.now(),
    lastOutputTime: t.lastOutputTime,
    lastInputTime: t.lastInputTime,
    runningIdleTimeoutMs: RUNNING_IDLE_TIMEOUT_MS,
    runningInputGuardMs: RUNNING_INPUT_GUARD_MS,
  });
  if (next === 'running') {
    armRunningIdleTimer(paneId);
  } else {
    clearRunningIdleTimer(t);
  }
  if (next !== t.status) {
    t.status = next;
    updatePaneStatus(paneId);
  }
}

// PTY 出力があったときに呼ぶ。waiting でなく、入力直後でなければ 'running' に切り替え、
// 1500ms 後に idle へ戻すタイマーを張る。既存タイマーがあれば張り直す（polling 不要）。
function bumpRunning(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  // waiting は最優先のため running に上書きしない
  if (t.waiting || t.externalWaiting) return;
  // タイマーは出力ごとに張り直す
  clearRunningIdleTimer(t);
  const now = Date.now();
  const recentInput = now - (t.lastInputTime || 0) <= RUNNING_INPUT_GUARD_MS;
  // 入力直後（タイプ中のエコー）は running と見なさない。idle のまま据え置く。
  if (recentInput) return;
  if (t.status !== 'running') {
    t.status = 'running';
    updatePaneStatus(paneId);
  }
  armRunningIdleTimer(paneId);
}

// ─── Create terminal ──────────────────────────────────────────────────────────
// options.noClaude が true の場合、main 側で claude の自動起動をスキップする。
// 未指定の場合は main 側のグローバル設定（CLI フラグ）にフォールバックする。
async function createTerminal(paneId, cwd, options = {}) {
  const result = await ipcRenderer.invoke('terminal:create', cwd || null, options);
  const { id: termId, cwd: initialCwd } = result;

  const term = new Terminal({
    fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 1.2,
    theme: TERM_THEME,
    cursorBlink: true,
    scrollback: 10000,
    allowTransparency: false,
    macOptionIsMeta: true,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);

  // OSC 0 / OSC 2 のタイトル変更を購読してペイン上部のタスクタイトル行に反映する。
  // 例: `printf '\033]0;ビルド中\007'` をシェルで実行すると "ビルド中" がここに表示される。
  // ここで書き込むのは OSC 由来の taskTitle のみ。API（POST /api/set-title）由来の
  // apiTitle が設定されている間はそちらが優先表示される（updatePaneTitle 参照）。
  term.onTitleChange((title) => {
    const t = terminals[paneId];
    if (!t) return;
    t.taskTitle = title || '';
    updatePaneTitle(paneId);
  });

  // 共通の入力送信ヘルパー（waiting バッジのクリアを含む）
  function sendTerminalInput(data) {
    ipcRenderer.send('terminal:input', termId, data);
    markPaneInput(paneId);
  }

  // Shift+Enter を改行として送信（Claude Code の keybindings.json 対応）
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.key === 'Enter' && ev.shiftKey && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      if (ev.type === 'keydown') {
        // CSI u エンコーディングで Shift+Enter を送信
        sendTerminalInput('\x1b[13;2u');
      }
      return false; // keydown / keypress 両方でデフォルト処理を抑止
    }
    return true;
  });

  const element = document.createElement('div');
  element.className = 'term-viewport';
  // NOTE: term.open(element) is called later, after element is attached to DOM

  // IME 合成開始時にビューポートを最下部（入力行）へスクロールし、カーソルを可視領域に入れる。
  // xterm の updateCompositionElements() は isCursorInViewport（ybase+y-ydisp が可視範囲内）が
  // 真のときだけ .xterm-helper-textarea をカーソル位置へ動かすため、通常バッファのシェルで
  // スクロールアップしたまま日本語入力を始めると textarea が画面外の既定位置に残り、変換候補
  // ウィンドウが入力行から離れた場所に出てしまう。これを防ぐ防御的措置（claude 等の代替バッファ
  // アプリでは ydisp=0 で常に可視のため no-op）。祖先要素の capture フェーズで拾うことで xterm
  // 自身の textarea ハンドラより先にスクロールを確定させる。
  // ※「変換候補がペイン左上に出る」不具合の本因は xterm.css の読み込み失敗（ファイル冒頭の
  //   「xterm.css の注入」コメント参照）であり、このリスナはその修正ではない。
  element.addEventListener('compositionstart', () => {
    try { term.scrollToBottom(); } catch (_e) {}
  }, true);

  // Input: terminal -> pty
  term.onData((data) => {
    sendTerminalInput(data);
  });

  const shortCwd = formatCwd(initialCwd);

  terminals[paneId] = {
    termId,
    term,
    fitAddon,
    element,
    opened: false,
    cwd: shortCwd,
    cwdFull: initialCwd,
    waiting: false,
    // externalWaiting: オーケストレーター等が POST /api/set-status で明示 push する外部権威の入力待ちフラグ。
    // ローカル PTY 検知(waiting)と OR で status に合流する。markPaneInput / リサイズ / 再描画 /
    // 自動入力では解除されず、明示的な false push でのみ解除される。
    externalWaiting: false,
    // status: 表示用ステータス。issue #23 で追加。
    // 初期値 'idle' は何も表示しない（.pane-status[data-status="idle"] は display:none）。
    status: 'idle',
    // runningTimer: 'running' を 1500ms 後に 'idle' に戻すタイマー id。
    // recomputeStatus() / bumpRunning() が張り直す。closePane() で必ず clearTimeout する。
    runningTimer: null,
    lastLines: '',
    lastOutputTime: Date.now(),
    lastInputTime: 0,
    // taskTitle: xterm の OSC 0/2 由来のタイトル（claude TUI 等が継続的に発行する）
    // apiTitle:  HTTP API（POST /api/set-title）で明示的にセットされたタイトル
    // apiUrl:    HTTP API（POST /api/set-title）で渡された URL（issue #29）。
    //            apiTitle が表示されているときのみ、タイトル全体をリンク化する。
    //            taskTitle（OSC 由来）の表示時は URL を一切表示しない。
    // apiPrUrl:  HTTP API（POST /api/set-title）で渡された PR URL（issue #44）。
    //            タスクタイトル行の右側に独立した [ PR ↗ ] ボタンとして表示する。
    //            apiTitle / taskTitle のいずれが表示中でも常時表示する（採用: 案A）。
    // 表示時は apiTitle を優先し、空のときに taskTitle へフォールバックする。
    // これにより task-queue 等が指定した issue タイトルが OSC 由来の文字列で
    // 上書きされなくなる（issue #22）。
    taskTitle: '',
    apiTitle: '',
    apiUrl: '',
    apiPrUrl: '',
    // apiPrMerged: HTTP API（POST /api/set-title）で渡された PR のマージ済み状態。
    apiPrMerged: false,
    // agentRoom（issue #58）: POST /api/agentroom で受け取ったルーム状態 { name: state }。
    //   null のままなら API 未通知。API が古い（AGENTROOM_API_TTL_MS 超過）場合は
    //   resolveRoomAgents() が PTY 出力ベースのフォールバック表示に切り替える。
    // agentRoomUpdatedAt: 最後に API でルーム状態を受け取った時刻（鮮度判定用）。
    // agentRoomOpen: アコーディオンの開閉状態（再 render をまたいで保持）。
    agentRoom: null,
    agentRoomUpdatedAt: 0,
    agentRoomOpen: false,
    lock: null,
  };

  return paneId;
}

function formatCwd(fullPath) {
  if (!fullPath) return '~';
  const home = fullPath.match(/^(\/Users\/[^/]+)/)?.[1] || '';
  const relative = home ? fullPath.replace(home, '~') : fullPath;
  const parts = relative.split('/').filter(Boolean);
  if (parts.length <= 3) return relative || '/';
  return '~/' + parts.slice(-2).join('/');
}

// ─── HTML escape helpers ──────────────────────────────────────────────────────
// renderLeaf() などで innerHTML テンプレートリテラルに外部由来の文字列を挿入する際の
// XSS 対策ヘルパー（issue #39）。
//
// なぜ必要か:
//   - cwd は OS ファイルシステム由来（通常は安全だがディレクトリ名に `"` や `<` を含めることは技術的に可能）
//   - statusAriaLabel は現状内部状態のみだが、将来 API 連携等で外部入力と統合される可能性があるため
//     防御的にエスケープしておく
//
// 設計方針:
//   - escText: テキストコンテンツ用（`<`, `>`, `&` をエスケープ）
//   - escAttr: 属性値用（`<`, `>`, `&`, `"`, `'` をエスケープ。属性は常にダブルクォートで囲む前提）
//   - 入力が文字列でない場合は空文字を返す（null/undefined の安全側フォールバック）
//   - 既知の安全な静的リテラル（ボタンの title 属性など）には適用しない（差分最小化）
function escText(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escAttr(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── IPC: data from pty ───────────────────────────────────────────────────────
ipcRenderer.on('terminal:data', (event, id, data) => {
  const paneId = Object.keys(terminals).find(k => terminals[k]?.termId === id);
  if (!paneId || !terminals[paneId]) return;

  const t = terminals[paneId];
  t.term.write(data);

  // Parse OSC 7 (shell cwd report: \e]7;file://host/path\a)
  const osc7 = data.match(/\x1b\]7;file:\/\/[^/]*([^\x07\x1b]+)[\x07\x1b]/);
  if (osc7) {
    const fullPath = decodeURIComponent(osc7[1]);
    t.cwdFull = fullPath;
    t.cwd = formatCwd(fullPath);
    updatePaneCwd(paneId, t.cwd);
  }

  // Accumulate last lines for waiting detection
  // issue #32: 直近 N 行のウィンドウが小さすぎると、Claude Code TUI のプロンプト枠や
  // recap メッセージの再描画で本来の確認文が押し出されて検知できなくなる。
  // 行数とトータル文字数の両方で上限を設けてメモリ膨張も防ぎつつ十分なウィンドウを確保する。
  let merged = appendAnsiForDisplay(t.lastLines, data).split('\n').slice(-LASTLINES_MAX_LINES).join('\n');
  if (merged.length > LASTLINES_MAX_CHARS) {
    // 行を跨いだ単純な末尾切り出し（マルチバイトでも安全）。
    merged = merged.slice(-LASTLINES_MAX_CHARS);
  }
  t.lastLines = merged;
  t.lastOutputTime = Date.now();
  checkWaiting(paneId);
  // 出力があったので running を bump（waiting / 入力直後はスキップされる）
  bumpRunning(paneId);
});

ipcRenderer.on('terminal:exit', (event, id) => {
  const paneId = Object.keys(terminals).find(k => terminals[k]?.termId === id);
  if (paneId) closePane(paneId, { force: true });
});

// ─── DOM updates (without full re-render) ────────────────────────────────────
function updatePaneCwd(paneId, cwd) {
  const el = document.querySelector(`.pane[data-id="${paneId}"] .pane-cwd`);
  if (el) el.textContent = cwd;
  // 格納中のコンパクト表示の cwd も同期する（issue #89）。
  const stashCwd = document.querySelector(`.stash-item[data-id="${paneId}"] .stash-item-cwd`);
  if (stashCwd) {
    stashCwd.textContent = cwd;
    stashCwd.title = cwd;
  }
}

// API（POST /api/set-title）由来のタイトルを最優先で表示し、未設定なら OSC 0/2 由来の
// taskTitle にフォールバックする。空文字を API に送れば apiTitle がクリアされ、OSC
// タイトルがそのまま見えるようになる（後方互換）。
function getDisplayTitle(t) {
  if (!t) return '';
  return t.apiTitle || t.taskTitle || '';
}

// 表示中のタイトルにリンクを付けるべきか判定する。
//   - apiTitle が選ばれている（apiTitle が非空）かつ
//   - apiUrl が設定されている（http(s) スキームは main 側で検証済み）
// 時のみ true。OSC 由来の taskTitle 表示時はリンク化しない。
function getDisplayUrl(t) {
  if (!t) return '';
  if (!t.apiTitle) return '';
  return t.apiUrl || '';
}

// http(s): スキームのチェック（renderer 側の二段構えバリデーション）。
// main 側で検証済みでも shell.openExternal 直前に念のため再チェックする。
function isSafeExternalUrl(url) {
  if (typeof url !== 'string' || !url) return false;
  if (url.length > 2048) return false;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch (_e) {
    return false;
  }
}

// shell.openExternal を共通化したヘルパー。
// http(s) 二段チェック → shell.openExternal を呼ぶ。失敗時は何もしない。
// click ハンドラ用に preventDefault / stopPropagation 済みである前提。
function openExternalUrlSafe(url) {
  if (!isSafeExternalUrl(url)) return;
  try {
    // Electron の shell.openExternal は Promise を返すが、reject 時にハンドラがないと
    // unhandled rejection になるため明示的にハンドリングする。同期 throw もありうるので
    // 念のため try/catch でラップしておく。
    const p = shell.openExternal(url);
    if (p && typeof p.catch === 'function') {
      p.catch(() => { /* 失敗時は何もしない */ });
    }
  } catch (_e) {
    /* 同期エラー時も無視 */
  }
}

// ─── Sidebar menu ────────────────────────────────────────────────────────────
let sidebarMenuSections = [];
// 新規起動時はサイドバーを開いた状態にする（issue #169）。
let sidebarOpen = true;
let sidebarTransitionCleanup = null;
// サイドバー幅リサイズ（issue #89）。ドラッグ中の一時状態。
let sidebarResizeState = null;
// サイドバー幅の既定値・下限（px）。上限はウィンドウ幅比で動的に決める（sidebarMaxWidth）。
// 従来の 252px から約 1.3 倍に拡張した既定幅。永続化はしない（再起動で既定に戻る）。
const DEFAULT_SIDEBAR_WIDTH = 330;
const SIDEBAR_MIN_WIDTH = 200;

function isReducedMotion() {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

function isSafeMenuIcon(icon) {
  if (typeof icon !== 'string') return false;
  const value = icon.trim();
  if (!value || value.length > 8 || /[<>&]/.test(value)) return false;
  return /^(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?)(?:\s?(?:\p{Extended_Pictographic}(?:\uFE0F|\uFE0E)?))?$/u.test(value);
}

function createMenuIcon(icon) {
  const el = document.createElement('span');
  el.className = 'sidebar-menu-icon';
  el.setAttribute('aria-hidden', 'true');
  el.textContent = isSafeMenuIcon(icon) ? icon.trim() : '';
  return el;
}

function createMenuLabel(label) {
  const el = document.createElement('span');
  el.className = 'sidebar-menu-label';
  const text = typeof label === 'string' ? label : '';
  el.textContent = text;
  if (text) el.title = text;
  return el;
}

function runMenuAction(action) {
  if (!action || typeof action !== 'object') return;
  if (action.type === 'open-settings') {
    openSettingsModal();
    return;
  }
  if (action.type === 'open-url') {
    openExternalUrlSafe(action.url);
  }
}

function createMenuActionElement(item) {
  const action = item && typeof item.action === 'object' ? item.action : null;
  let el;
  if (action?.type === 'open-url' && isSafeExternalUrl(action.url)) {
    el = document.createElement('a');
    el.className = 'sidebar-menu-link';
    el.href = '#';
    el.addEventListener('click', (event) => {
      event.preventDefault();
      runMenuAction(action);
    });
  } else if (action?.type === 'open-settings') {
    el = document.createElement('button');
    el.className = 'sidebar-menu-button';
    el.type = 'button';
    el.dataset.menuAction = action.type;
    el.addEventListener('click', () => runMenuAction(action));
  } else {
    el = document.createElement('span');
    el.className = 'sidebar-menu-text';
  }
  el.appendChild(createMenuIcon(item.icon));
  el.appendChild(createMenuLabel(item.label));
  return el;
}

function createMenuItem(item) {
  const li = document.createElement('li');
  li.className = 'sidebar-menu-item';
  const children = Array.isArray(item?.children) ? item.children : [];
  if (children.length) {
    const details = document.createElement('details');
    details.className = 'sidebar-submenu';
    const summary = document.createElement('summary');
    summary.className = 'sidebar-menu-summary';
    summary.appendChild(createMenuIcon(item.icon));
    summary.appendChild(createMenuLabel(item.label));
    details.appendChild(summary);

    const childList = document.createElement('ul');
    childList.className = 'sidebar-submenu-list';
    for (const child of children) {
      childList.appendChild(createMenuItem(child));
    }
    details.appendChild(childList);
    li.appendChild(details);
    return li;
  }

  li.appendChild(createMenuActionElement(item || {}));
  return li;
}

function renderSidebarMenu() {
  const nav = document.getElementById('sidebar-menu');
  if (!nav) return;
  // メニューは専用の内側コンテナ（.sidebar-menu-inner）だけを作り直す。
  // 格納ペイン（#pane-stash）は nav の別の子として同居させ、ここでは touch しない。
  // これにより格納ペインの xterm 要素がメニュー再描画のたびに detach されるのを防ぐ（issue #89）。
  let inner = nav.querySelector('.sidebar-menu-inner');
  if (!inner) {
    inner = document.createElement('div');
    inner.className = 'sidebar-menu-inner';
    nav.insertBefore(inner, nav.firstChild);
  }
  inner.replaceChildren();

  for (let sectionIndex = 0; sectionIndex < sidebarMenuSections.length; sectionIndex++) {
    const section = sidebarMenuSections[sectionIndex];
    const list = document.createElement('ul');
    list.className = 'sidebar-menu-list';
    const items = Array.isArray(section?.items) ? section.items : [];

    if (section?.title) {
      const sectionEl = document.createElement('div');
      sectionEl.className = 'sidebar-section';
      const title = document.createElement('div');
      const titleId = `sidebar-section-title-${sectionIndex}`;
      title.className = 'sidebar-section-title';
      title.id = titleId;
      title.textContent = section.title;
      list.setAttribute('aria-labelledby', titleId);
      sectionEl.appendChild(title);
      for (const item of items) {
        list.appendChild(createMenuItem(item));
      }
      sectionEl.appendChild(list);
      inner.appendChild(sectionEl);
    } else {
      for (const item of items) {
        list.appendChild(createMenuItem(item));
      }
      inner.appendChild(list);
    }
  }

  applyUsageBadge();
}

// サイドバーのラッパー（.sidebar）を組み立てる（issue #89）。
// 中身は「固定ヘッダーの使用量カード」「スクロールする nav（メニュー内側 + 格納ペイン
// セクション）」と「幅リサイズハンドル」。開閉トランジション・可変幅の基準はこのラッパー側に持たせる。
function createSidebar() {
  const aside = document.createElement('aside');
  aside.id = 'sidebar';
  aside.className = 'sidebar';

  aside.appendChild(createSidebarUsageCard());

  const nav = document.createElement('nav');
  nav.id = 'sidebar-menu';
  nav.className = 'sidebar-menu';
  nav.setAttribute('aria-label', 'メインメニュー');

  // メニュー内側（renderSidebarMenu が作り直す対象）
  const inner = document.createElement('div');
  inner.className = 'sidebar-menu-inner';
  nav.appendChild(inner);

  // タスクセクション / 格納ペインセクション（renderSidebarMenu の再構築対象外・別管理）
  nav.appendChild(createTaskListContainer());
  nav.appendChild(createPaneStashContainer());

  aside.appendChild(nav);
  aside.appendChild(createSidebarResizer());
  return aside;
}

function createSidebarUsageCard() {
  const section = document.createElement('section');
  section.id = 'sidebar-usage';
  section.className = 'sidebar-usage';
  section.hidden = true;
  section.setAttribute('aria-label', 'Claude使用量');

  const title = document.createElement('div');
  title.className = 'sidebar-usage-title';
  title.textContent = 'Claude使用量';

  const body = document.createElement('div');
  body.className = 'sidebar-usage-body';
  body.setAttribute('aria-live', 'polite');

  section.appendChild(title);
  section.appendChild(body);
  return section;
}

// vk-orchestrator の tasks-view.json を読み取り専用で表示するセクション。
function createTaskListContainer() {
  const section = document.createElement('section');
  section.id = 'task-list';
  section.className = 'task-list';
  section.hidden = true;
  section.setAttribute('aria-label', 'タスク');

  const title = document.createElement('div');
  title.className = 'task-list-title';
  title.textContent = 'タスク';

  const notice = document.createElement('div');
  notice.className = 'task-list-stale';
  notice.setAttribute('role', 'status');
  notice.textContent = 'orchestrator 停止中';
  notice.hidden = true;

  const list = document.createElement('div');
  list.className = 'task-list-groups';

  section.appendChild(title);
  section.appendChild(notice);
  section.appendChild(list);
  return section;
}

// 格納ペインを収めるセクション（見出し＋リスト）。中身は renderPaneStash が更新する。
function createPaneStashContainer() {
  const section = document.createElement('section');
  section.id = 'pane-stash';
  section.className = 'pane-stash';
  section.hidden = true;
  section.setAttribute('aria-label', '格納したペイン');

  const title = document.createElement('div');
  title.className = 'pane-stash-title';
  title.textContent = '格納したペイン';

  const list = document.createElement('ul');
  list.className = 'pane-stash-list';

  section.appendChild(title);
  section.appendChild(list);
  return section;
}

// サイドバー右端の幅リサイズハンドル（グリッドの .grid-handle 相当のアクセシブル版）。
function createSidebarResizer() {
  const h = document.createElement('div');
  h.className = 'sidebar-resizer';
  h.setAttribute('role', 'separator');
  h.setAttribute('aria-orientation', 'vertical');
  h.setAttribute('aria-label', 'サイドバーの幅を変更');
  h.setAttribute('tabindex', '0');
  h.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
  h.setAttribute('aria-valuemax', String(sidebarMaxWidth()));
  h.setAttribute('aria-valuenow', String(getSidebarWidth()));
  h.addEventListener('mousedown', startSidebarResize);
  h.addEventListener('keydown', onSidebarResizerKey);
  return h;
}

function ensureSidebar(root) {
  let el = root.querySelector('#sidebar');
  if (!el) {
    el = createSidebar();
    renderSidebarMenu();
    renderSidebarUsage(lastUsageSnapshot);
    renderTaskList(lastTaskView);
    renderPaneStash();
  }
  return el;
}

// ─── Sidebar width（issue #89）────────────────────────────────────────────────
// 上限はウィンドウ幅の約 45%（40〜50% の範囲）。狭いウィンドウでもグリッドを潰さない。
function sidebarMaxWidth() {
  return Math.max(SIDEBAR_MIN_WIDTH, Math.round(window.innerWidth * 0.45));
}

function clampSidebarWidth(w) {
  // 数値化できない値（NaN / undefined / 文字列など）は既定幅にフォールバックする。
  const n = Number(w);
  if (!Number.isFinite(n)) return DEFAULT_SIDEBAR_WIDTH;
  return Math.max(SIDEBAR_MIN_WIDTH, Math.min(sidebarMaxWidth(), Math.round(n)));
}

// 現在のサイドバー幅（セッション内保持値、無ければ既定）をクランプして返す。
function getSidebarWidth() {
  const w = tree && typeof tree.sidebarWidth === 'number' ? tree.sidebarWidth : DEFAULT_SIDEBAR_WIDTH;
  return clampSidebarWidth(w);
}

// 幅を確定し、CSS カスタムプロパティ・aria 値・セッション保持値を更新する。
function setSidebarWidth(w) {
  const width = clampSidebarWidth(w);
  if (tree) tree.sidebarWidth = width;
  const aside = document.getElementById('sidebar');
  if (aside) aside.style.setProperty('--vktm-sidebar-width', `${width}px`);
  const handle = document.querySelector('.sidebar-resizer');
  if (handle) {
    handle.setAttribute('aria-valuemin', String(SIDEBAR_MIN_WIDTH));
    handle.setAttribute('aria-valuemax', String(sidebarMaxWidth()));
    handle.setAttribute('aria-valuenow', String(width));
  }
}

function startSidebarResize(e) {
  e.preventDefault();
  e.stopPropagation();
  sidebarResizeState = { startX: e.clientX, startWidth: getSidebarWidth() };
  document.body.classList.add('resizing-sidebar');
}

// 左右矢印キーで幅を増減する（Shift で大きめステップ）。
function onSidebarResizerKey(e) {
  const step = e.shiftKey ? 40 : 16;
  let w = getSidebarWidth();
  if (e.key === 'ArrowLeft') w -= step;
  else if (e.key === 'ArrowRight') w += step;
  else return;
  e.preventDefault();
  setSidebarWidth(w);
  debouncedFitAll();
  requestAnimationFrame(fitAll);
}

// ─── Pane stash rendering（issue #89）─────────────────────────────────────────
// 格納ペインのコンパクト表示を stashOrder に従って組み立てる。
// xterm 要素の再取り付けは render() の共通ループが担う（ここでは器だけ作る）。
function renderPaneStash() {
  const section = document.getElementById('pane-stash');
  if (!section) return;
  const stash = (tree && Array.isArray(tree.stashOrder)) ? tree.stashOrder : [];
  // 0 件のときはセクションごと隠す。
  section.hidden = stash.length === 0;
  const list = section.querySelector('.pane-stash-list');
  if (!list) return;
  list.replaceChildren();
  stash.forEach((id, idx) => {
    list.appendChild(renderStashItem(id, idx, stash.length));
  });
}

// xterm 表示トグル（― ボタン）のグリフ / ラベルを開閉状態から返す。
// aria-expanded に加えて視覚グリフも切り替える（表示中=下向き▾ / 非表示=右向き▸）。
// 並べ替えの ↑↓ とは向き（縦↔横起点）で区別する。
function stashToggleGlyph(open) { return open ? '▾' : '▸'; }
function stashToggleLabel(open) { return open ? 'ターミナルを隠す' : 'ターミナルを表示'; }
function isCloseLocked(t) { return t?.lock?.close === false; }
function closeButtonLabel(locked) { return locked ? 'このペインは保護されています（閉じられません）' : '閉じる'; }

function applyCloseButtonLock(button, locked) {
  if (!button) return;
  const label = closeButtonLabel(locked);
  button.classList.toggle('is-locked', locked);
  button.setAttribute('title', label);
  button.setAttribute('aria-label', label);
  if (locked) {
    button.setAttribute('aria-disabled', 'true');
  } else {
    button.removeAttribute('aria-disabled');
  }
}

function updatePaneCloseLock(paneId) {
  const locked = isCloseLocked(terminals[paneId]);
  applyCloseButtonLock(document.querySelector(`.pane[data-id="${paneId}"] .btn-close`), locked);
  applyCloseButtonLock(document.querySelector(`.stash-item[data-id="${paneId}"] .btn-close`), locked);
}

// ─── Task list rendering（issue #197）─────────────────────────────────────────
function parseTaskTime(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function normalizeTaskStatus(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'unknown';
}

function getTaskStatusLabel(status) {
  return TASK_STATUS_LABELS[status] || status;
}

function getTaskGroupTitle(status) {
  return getTaskStatusLabel(status);
}

function normalizeTaskList(view) {
  const tasks = Array.isArray(view?.tasks) ? view.tasks : [];
  return tasks
    .filter((task) => task && typeof task.title === 'string' && task.title.trim())
    .map((task, index) => ({
      id: task.id,
      title: task.title.trim(),
      status: normalizeTaskStatus(task.status),
      assignee: typeof task.assignee === 'string' && task.assignee.trim() ? task.assignee.trim() : '',
      startedAtMs: parseTaskTime(task.startedAt) ?? parseTaskTime(task.updatedAt) ?? parseTaskTime(task.createdAt),
      index,
    }));
}

function isTaskViewStale(view) {
  if (!view || view.unavailable === true) return true;
  const updatedAtMs = parseTaskTime(view.updatedAt);
  if (!updatedAtMs) return true;
  return Date.now() - updatedAtMs > TASKS_ORCHESTRATOR_STALE_MS;
}

function formatTaskElapsed(startedAtMs) {
  if (!startedAtMs) return '';
  const diffMs = Math.max(0, Date.now() - startedAtMs);
  const totalMinutes = Math.floor(diffMs / 60000);
  if (totalMinutes < 1) return '1分未満';
  if (totalMinutes < 60) return `${totalMinutes}分`;
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours < 24) return minutes ? `${hours}時間${minutes}分` : `${hours}時間`;
  const days = Math.floor(hours / 24);
  const restHours = hours % 24;
  return restHours ? `${days}日${restHours}時間` : `${days}日`;
}

function groupTasksByStatus(tasks) {
  const groups = new Map();
  for (const task of tasks) {
    if (!groups.has(task.status)) groups.set(task.status, []);
    groups.get(task.status).push(task);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => {
    const ai = TASK_STATUS_ORDER.indexOf(a);
    const bi = TASK_STATUS_ORDER.indexOf(b);
    if (ai !== -1 && bi !== -1) return ai - bi;
    if (ai !== -1) return -1;
    if (bi !== -1) return 1;
    return 0;
  });
}

function renderTaskItem(task) {
  const li = document.createElement('li');
  li.className = 'task-item';
  if (task.id !== undefined && task.id !== null) li.dataset.id = String(task.id);
  const taskKey = String(task.id);
  const status = task.status;

  const title = document.createElement('div');
  title.className = 'task-item-title';
  title.textContent = task.title;
  title.title = task.title;

  const head = document.createElement('div');
  head.className = 'task-item-head';

  const badge = document.createElement('span');
  badge.className = 'pane-badge pane-status task-status';
  badge.dataset.status = status;
  badge.textContent = getTaskStatusLabel(status);
  head.appendChild(badge);

  const meta = document.createElement('div');
  meta.className = 'task-item-meta';
  if (task.assignee) {
    const assignee = document.createElement('span');
    assignee.className = 'task-item-assignee';
    assignee.textContent = `担当: ${task.assignee}`;
    meta.appendChild(assignee);
  }
  const elapsedText = formatTaskElapsed(task.startedAtMs);
  if (elapsedText) {
    const elapsed = document.createElement('span');
    elapsed.className = 'task-item-elapsed';
    elapsed.textContent = elapsedText;
    elapsed.dataset.startedAt = String(task.startedAtMs);
    elapsed.title = new Date(task.startedAtMs).toLocaleString();
    meta.appendChild(elapsed);
  }
  head.appendChild(meta);

  li.appendChild(title);
  li.appendChild(head);

  const actions = getTaskStatusActions(status);
  const canSendCommand = commandsConfigured && actions.length > 0 && Number.isInteger(Number(task.id)) && Number(task.id) > 0;
  if (canSendCommand) {
    const actionRow = document.createElement('div');
    actionRow.className = 'task-item-actions';
    if (pendingTaskIds.has(taskKey)) {
      const pending = document.createElement('span');
      pending.className = 'task-item-pending';
      pending.setAttribute('role', 'status');
      pending.textContent = '反映待ち';
      actionRow.appendChild(pending);
    } else {
      actions.forEach((action) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'task-item-action';
        button.dataset.to = action.to;
        button.dataset.expected = status;
        button.textContent = action.label;
        button.addEventListener('click', async () => {
          if (pendingTaskIds.has(taskKey)) return;
          const buttons = actionRow.querySelectorAll('.task-item-action');
          buttons.forEach((el) => { el.disabled = true; });
          actionRow.querySelector('.task-item-action-error')?.remove();
          try {
            const res = await ipcRenderer.invoke('tasks:set-status', {
              taskId: task.id,
              expected: status,
              to: action.to,
            });
            if (res && res.ok) {
              pendingTaskIds.add(taskKey);
              renderTaskList(lastTaskView);
              return;
            }
            console.warn('タスクステータス変更依頼に失敗しました', res && res.error);
            buttons.forEach((el) => { el.disabled = false; });
            const error = document.createElement('span');
            error.className = 'task-item-action-error';
            error.setAttribute('role', 'status');
            error.textContent = '送信失敗';
            actionRow.appendChild(error);
          } catch (e) {
            console.warn('タスクステータス変更依頼に失敗しました', e);
            buttons.forEach((el) => { el.disabled = false; });
            const error = document.createElement('span');
            error.className = 'task-item-action-error';
            error.setAttribute('role', 'status');
            error.textContent = '送信失敗';
            actionRow.appendChild(error);
          }
        });
        actionRow.appendChild(button);
      });
    }
    li.appendChild(actionRow);
  }
  return li;
}

function renderTaskGroup(status, tasks) {
  const group = document.createElement('section');
  group.className = 'task-list-group';
  group.dataset.status = status;

  const title = document.createElement('div');
  title.className = 'task-list-group-title';
  title.textContent = getTaskGroupTitle(status);

  const list = document.createElement('ul');
  list.className = 'task-list-items';
  tasks.forEach((task) => list.appendChild(renderTaskItem(task)));

  group.appendChild(title);
  group.appendChild(list);
  return group;
}

function renderTaskList(view = lastTaskView) {
  lastTaskView = view || null;
  const section = document.getElementById('task-list');
  if (!section) return;
  const staleNotice = section.querySelector('.task-list-stale');
  const container = section.querySelector('.task-list-groups');
  if (!container) return;

  const tasks = normalizeTaskList(view);
  const stale = isTaskViewStale(view);
  const shouldShow = tasksFileConfigured || tasks.length > 0 || (!!view && stale);
  section.hidden = !shouldShow;
  section.classList.toggle('is-stale', stale);
  if (staleNotice) staleNotice.hidden = !stale;
  container.replaceChildren();
  if (!shouldShow) return;

  const groups = groupTasksByStatus(tasks);
  if (groups.length === 0) {
    if (stale) return;
    const empty = document.createElement('div');
    empty.className = 'task-list-empty';
    empty.textContent = 'タスクはありません';
    container.appendChild(empty);
    return;
  }

  groups.forEach(([status, groupTasks]) => {
    container.appendChild(renderTaskGroup(status, groupTasks));
  });
}

function tickTaskElapsed() {
  const section = document.getElementById('task-list');
  if (!section || section.hidden) return;
  section.querySelectorAll('.task-item-elapsed[data-started-at]').forEach((el) => {
    const ms = Number(el.dataset.startedAt);
    if (Number.isFinite(ms)) el.textContent = formatTaskElapsed(ms);
  });
  const stale = isTaskViewStale(lastTaskView);
  section.classList.toggle('is-stale', stale);
  const staleNotice = section.querySelector('.task-list-stale');
  if (staleNotice) staleNotice.hidden = !stale;
}

window.renderTaskList = renderTaskList;

// 格納ペイン 1 件分（コンパクトカード）を生成する。
//   - タイトル行: タスク名 / タイトルリンク / PR リンク
//   - 操作行: 状態バッジ + アクション（↑ ↓ 表示トグル(▸/▾) →(復帰) ✕）
//   - cwd 行
//   - term-container（xterm。既定は非表示、― で開閉）
function renderStashItem(id, idx, count) {
  const t = terminals[id];
  const waiting = !!(t && (t.waiting || t.externalWaiting));
  const li = document.createElement('li');
  li.className = 'stash-item'
    + (id === focusedPaneId ? ' focused' : '')
    + (waiting ? ' waiting' : '');
  li.dataset.id = id;
  const xtermOpen = !!(t && t.stashXtermOpen);
  if (xtermOpen) li.classList.add('stash-xterm-open');

  const status = t?.status || 'idle';
  const { label: statusLabel, ariaLabel: statusAriaLabel } = getStatusPresentation(status);
  const title = getDisplayTitle(t);
  const taskUrl = getDisplayUrl(t);
  const taskPrUrl = isSafeExternalUrl(t?.apiPrUrl) ? t.apiPrUrl : '';
  const cwd = t?.cwd || '~';
  const closeLocked = isCloseLocked(t);
  const closeLabel = closeButtonLabel(closeLocked);

  const titleEl = document.createElement('div');
  titleEl.className = 'pane-task-title stash-item-title-row'
    + (!title && !taskPrUrl ? ' empty' : '')
    + (taskUrl ? ' has-link' : '')
    + (taskPrUrl ? ' has-pr' : '');
  renderTaskTitleContent(titleEl, title, taskUrl, taskPrUrl, !!t?.apiPrMerged);
  if (taskUrl) {
    titleEl.removeAttribute('title');
  } else {
    titleEl.title = title;
  }

  const head = document.createElement('div');
  head.className = 'stash-item-head';
  // セキュリティ: cwd（OS 由来）・status 等は escAttr / escText でエスケープする（renderLeaf と同流儀）。
  head.innerHTML = `
    <span class="pane-badge pane-status" data-status="${escAttr(status)}" role="status" aria-live="polite"${statusAriaLabel ? ` aria-label="${escAttr(statusAriaLabel)}"` : ''}>${escText(statusLabel)}</span>
    <div class="stash-item-actions">
      <button class="btn btn-stash-up" title="上へ移動" aria-label="上へ移動">↑</button>
      <button class="btn btn-stash-down" title="下へ移動" aria-label="下へ移動">↓</button>
      <button class="btn btn-stash-toggle" title="${escAttr(stashToggleLabel(xtermOpen))}" aria-label="${escAttr(stashToggleLabel(xtermOpen))}" aria-expanded="${xtermOpen ? 'true' : 'false'}">${escText(stashToggleGlyph(xtermOpen))}</button>
      <span class="stash-actions-sep" aria-hidden="true"></span>
      <button class="btn btn-stash-restore" title="グリッドへ戻す" aria-label="グリッドへ戻す">→</button>
      <button class="btn btn-close${closeLocked ? ' is-locked' : ''}" title="${escAttr(closeLabel)}" aria-label="${escAttr(closeLabel)}"${closeLocked ? ' aria-disabled="true"' : ''}>✕</button>
    </div>
  `;

  const cwdEl = document.createElement('div');
  cwdEl.className = 'stash-item-cwd';
  cwdEl.title = cwd;
  cwdEl.textContent = cwd;

  const termContainer = document.createElement('div');
  termContainer.className = 'term-container';

  li.appendChild(titleEl);
  li.appendChild(head);
  li.appendChild(cwdEl);
  li.appendChild(termContainer);

  const upBtn = head.querySelector('.btn-stash-up');
  const downBtn = head.querySelector('.btn-stash-down');
  if (idx === 0) upBtn.disabled = true;
  if (idx === count - 1) downBtn.disabled = true;
  upBtn.addEventListener('click', e => { e.stopPropagation(); moveStashPane(id, 'up'); });
  downBtn.addEventListener('click', e => { e.stopPropagation(); moveStashPane(id, 'down'); });
  head.querySelector('.btn-stash-toggle').addEventListener('click', e => { e.stopPropagation(); toggleStashXterm(id); });
  head.querySelector('.btn-stash-restore').addEventListener('click', e => { e.stopPropagation(); unstashPane(id); });
  head.querySelector('.btn-close').addEventListener('click', e => {
    e.stopPropagation();
    if (terminals[id]?.lock?.close === false) return;
    closePane(id);
  });
  li.addEventListener('mousedown', () => focusPane(id));

  return li;
}

// 格納ペイン（サイドバー内）のコンパクト表示を最新状態へ更新する。
// グリッド用の update* 関数は .pane[data-id] しか見ないため、格納中はこちらで反映する。
function updateStashItem(paneId) {
  const li = document.querySelector(`.stash-item[data-id="${paneId}"]`);
  if (!li) return;
  const t = terminals[paneId];
  if (!t) return;
  li.classList.toggle('waiting', !!(t.waiting || t.externalWaiting));
  const badge = li.querySelector('.pane-status');
  if (badge) {
    const status = t.status || 'idle';
    badge.dataset.status = status;
    const { label, ariaLabel } = getStatusPresentation(status);
    badge.textContent = label;
    if (ariaLabel) badge.setAttribute('aria-label', ariaLabel);
    else badge.removeAttribute('aria-label');
  }
  const titleEl = li.querySelector('.stash-item-title-row');
  if (titleEl) {
    const title = getDisplayTitle(t);
    const url = getDisplayUrl(t);
    const prUrl = isSafeExternalUrl(t.apiPrUrl) ? t.apiPrUrl : '';
    renderTaskTitleContent(titleEl, title, url, prUrl, !!t.apiPrMerged);
    if (url) {
      titleEl.removeAttribute('title');
    } else {
      titleEl.title = title;
    }
    titleEl.classList.toggle('empty', title.length === 0 && !prUrl);
    titleEl.classList.toggle('has-link', !!url);
    titleEl.classList.toggle('has-pr', !!prUrl);
  }
  updatePaneCloseLock(paneId);
}

function focusFirstSidebarItem() {
  const nav = document.getElementById('sidebar-menu');
  const first = nav?.querySelector('a, button, summary');
  if (first && typeof first.focus === 'function') first.focus();
}

function setSidebarOpen(open, options = {}) {
  const root = document.getElementById('root');
  const btn = document.getElementById('menu-btn');
  // 開閉トランジション（transform）はラッパー .sidebar 側に付いている（issue #89）。
  const aside = root ? ensureSidebar(root) : null;
  if (sidebarTransitionCleanup) {
    sidebarTransitionCleanup();
    sidebarTransitionCleanup = null;
  }
  sidebarOpen = !!open;
  root?.classList.toggle('sidebar-open', sidebarOpen);
  btn?.setAttribute('aria-expanded', sidebarOpen ? 'true' : 'false');

  const afterLayout = () => {
    fitAll();
    if (sidebarOpen && options.focusFirst !== false) {
      focusFirstSidebarItem();
    } else if (!sidebarOpen && options.focusToggle) {
      btn?.focus();
    }
  };

  if (!aside || isReducedMotion()) {
    requestAnimationFrame(afterLayout);
    return;
  }

  let done = false;
  let timeoutId = null;
  const cleanup = () => {
    done = true;
    aside.removeEventListener('transitionend', onEnd);
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (sidebarTransitionCleanup === cleanup) sidebarTransitionCleanup = null;
  };
  const finish = () => {
    if (done) return;
    cleanup();
    afterLayout();
  };
  const onEnd = (event) => {
    if (event.target !== aside || event.propertyName !== 'transform') return;
    finish();
  };
  sidebarTransitionCleanup = cleanup;
  aside.addEventListener('transitionend', onEnd);
  timeoutId = setTimeout(finish, 220);
}

function setupSidebarMenu() {
  const root = document.getElementById('root');
  if (root) ensureSidebar(root);
  const btn = document.getElementById('menu-btn');
  if (btn) {
    btn.addEventListener('click', () => setSidebarOpen(!sidebarOpen, { focusFirst: true }));
  }
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !sidebarOpen) return;
    event.preventDefault();
    setSidebarOpen(false, { focusToggle: true });
  });
  ipcRenderer.on('menu:update', (_event, sections) => {
    sidebarMenuSections = Array.isArray(sections) ? sections : [];
    renderSidebarMenu();
  });
  ipcRenderer.on('tasks:update', (_event, view) => {
    pendingTaskIds.clear();
    renderTaskList(view);
  });
}

// .pane-task-title 要素の中身を、URL の有無に応じて
// プレーンテキスト or <a>（外部リンクマーク付き）で再構築する。
//   - URL 無し: テキストノードのみ（従来通り、見た目は完全互換）
//   - URL 有り: <a role="link" href="#"> + <span>title</span> + <span aria-hidden>↗</span>
// href には URL を直接入れない（Electron の <a target="_blank"> が新 BrowserWindow を
// 開く危険挙動を回避するため）。クリック時は preventDefault → shell.openExternal で
// OS の既定ブラウザを開く。
// 第4引数 prUrl（issue #44）: 非空のとき、タイトル右側に独立した PR ボタン（<a class="pane-task-title-pr">）を追加する。
//   apiTitle / taskTitle のいずれが表示中でも、prUrl があれば常時表示する（採用: 案A）。
// 第5引数 prMerged: true のとき、PR ボタンをマージ済み表示（紫 + 非色アイコン）にする。
function renderTaskTitleContent(el, title, url, prUrl, prMerged = false) {
  // 既存の子要素を全消去（innerHTML は使わずに DOM API で組み立てる）
  while (el.firstChild) el.removeChild(el.firstChild);

  // ── タイトル本文（リンク化される場合と平文の場合） ────────────────────
  if (!url) {
    // 平文のタイトルでも、prUrl がある場合は PR ボタンを右寄せできるよう
    // タイトル部分を span にラップする（flex の margin-left: auto を効かせるため）。
    if (prUrl) {
      const titleSpan = document.createElement('span');
      titleSpan.className = 'pane-task-title-text';
      titleSpan.textContent = title;
      el.appendChild(titleSpan);
    } else {
      el.textContent = title;
    }
  } else {
    const link = document.createElement('a');
    link.className = 'pane-task-title-link';
    link.href = '#'; // 実 URL は入れない（Electron の target="_blank" 経由の新 BrowserWindow 防止）
    link.setAttribute('role', 'link');
    link.setAttribute('aria-label', `${title}（外部ブラウザで開く）`);
    // ペイン D&D 起点は親 .pane-task-title 側。リンクの URL drag（href のドラッグ）が割り込まないよう抑止（issue #40）。
    link.draggable = false;
    // ホバー時のツールチップにはタイトル本文と URL の両方を改行区切りで含める。
    // 親要素 .pane-task-title の title 属性は has-link 時に外して競合を避ける
    // （ブラウザ実装により親子 title の優先順位が不定なため。updatePaneTitle / renderLeaf 側で制御）。
    link.title = title ? `${title}\n${url}` : url;

    const labelSpan = document.createElement('span');
    labelSpan.className = 'pane-task-title-text';
    labelSpan.textContent = title;
    link.appendChild(labelSpan);

    const iconSpan = document.createElement('span');
    iconSpan.className = 'pane-task-title-icon';
    iconSpan.setAttribute('aria-hidden', 'true');
    iconSpan.textContent = '↗';
    link.appendChild(iconSpan);

    // クリック: ペインのアクティブ化（mousedown 経路）は止めない。click のみ抑止し
    // shell.openExternal でブラウザを開く。
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openExternalUrlSafe(url);
    });
    // mousedown は止めない（ペインのフォーカス移譲は通常通り）
    // ただしリンク自体のテキスト選択は意図しないドラッグを起こしやすいので、
    // ユーザビリティのため pointer 系イベントの伝搬は維持しつつ、別操作とは衝突しない。

    el.appendChild(link);
  }

  // ── PR ボタン（issue #44） ──────────────────────────────────────────────
  // タイトル文字列の有無・apiTitle/taskTitle の選択状態に関わらず、prUrl があれば常時表示。
  // .pane-badge（issue #27 で導入した共通バッジ basis）に乗せて見た目を統一する。
  if (prUrl) {
    const prPresentation = getPrBadgePresentation(prMerged === true);
    const prLink = document.createElement('a');
    prLink.className = prPresentation.className;
    prLink.href = '#'; // 実 URL は入れない（タイトルリンクと同じ理由）
    prLink.setAttribute('role', 'link');
    prLink.setAttribute('aria-label', prPresentation.ariaLabel);
    prLink.title = prUrl;
    prLink.draggable = false;

    const prLabel = document.createElement('span');
    prLabel.className = 'pane-task-title-pr-label';
    prLabel.textContent = 'PR';
    prLink.appendChild(prLabel);

    const prIcon = document.createElement('span');
    prIcon.className = 'pane-task-title-pr-icon';
    prIcon.setAttribute('aria-hidden', 'true');
    prIcon.textContent = prPresentation.icon;
    prLink.appendChild(prIcon);

    prLink.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openExternalUrlSafe(prUrl);
    });

    el.appendChild(prLink);
  }
}

function updatePaneTitle(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  // 格納中ならコンパクト表示のタスク名を更新する（.pane が無いため下の処理は素通りする）。
  updateStashItem(paneId);
  const el = document.querySelector(`.pane[data-id="${paneId}"] .pane-task-title`);
  if (!el) return;
  const title = getDisplayTitle(t);
  const url = getDisplayUrl(t);
  // ペイン D&D 起点としての可用性（issue #40）。複数 leaf がある時のみドラッグ可。
  // renderLeaf() 側の `canDragPane` 判定と同一の式に合わせる。
  // ここで考慮しないと、タイトル / PR をクリアした後に `.pane-task-title` が
  // empty 扱いで消え、ドラッグ起点を失う（CodeRabbit PR #45 指摘）。
  const canDragPane = canDragGridPane();
  // PR ボタンは apiPrUrl があれば常時表示（採用: 案A）。
  // renderer 側でも http(s) 二段チェックを通してから採用する。
  const prUrl = isSafeExternalUrl(t.apiPrUrl) ? t.apiPrUrl : '';
  const prMerged = !!t.apiPrMerged;
  renderTaskTitleContent(el, title, url, prUrl, prMerged);
  // ホバー時のツールチップは has-link 時は子 <a> 側に集約して親子競合を避ける。
  //   - URL 無し: 親 .pane-task-title に title 属性をセット（従来挙動）
  //   - URL 有り: 親 title 属性を削除し、<a> 側の title（タイトル + URL）のみに任せる
  if (url) {
    el.removeAttribute('title');
  } else {
    el.title = title;
  }
  // タイトル本文・PR ボタン・ドラッグ可のいずれもない場合だけ "empty" 扱い。
  // PR ボタンだけのとき / 複数ペインのドラッグハンドルとして掴みたいときは
  // 高さを保つために empty クラスを付けない（renderLeaf() の初期描画と整合）。
  el.classList.toggle('empty', title.length === 0 && !prUrl && !canDragPane);
  el.classList.toggle('has-link', !!url);
  el.classList.toggle('has-pr', !!prUrl);
}

// .pane-status バッジ（ヘッダ最左）と .pane.waiting 枠点滅の両方を更新する。
// status は派生フィールドのため、waiting 系フラグ / t.status は呼び出し側で先にセット済みである前提。
function updatePaneStatus(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  // 格納中ならコンパクト表示の状態バッジを更新する（.pane が無いため下の処理は素通りする）。
  updateStashItem(paneId);
  const paneEl = document.querySelector(`.pane[data-id="${paneId}"]`);
  if (!paneEl) return;
  // 枠の点滅アニメ（周辺視野での気付き用、issue #23 でも残置）は派生 waiting 準拠
  paneEl.classList.toggle('waiting', !!(t.waiting || t.externalWaiting));

  const badge = paneEl.querySelector('.pane-status');
  if (!badge) return;
  const status = t.status || 'idle';
  badge.dataset.status = status;
  // 視覚: ラベルテキスト（ドットは CSS の ::before で描画）。
  // a11y: aria-label でステータスを明示し、aria-live="polite" により変化のみ読み上げ。
  //       idle は visibility:hidden により読み上げ対象外（aria-live 非発火）。
  // ラベル / aria-label のマッピングは getStatusPresentation に集約（renderLeaf と共用）。
  const { label, ariaLabel } = getStatusPresentation(status);
  badge.textContent = label;
  if (ariaLabel) {
    badge.setAttribute('aria-label', ariaLabel);
  } else {
    badge.removeAttribute('aria-label');
  }

  // フォールバック表示（司＝ペイン status 写像）は status に追従するため、ここで更新する。
  updateAgentRoom(paneId);
}

// ─── Grid layout operations ──────────────────────────────────────────────────
// レイアウトはフラットなグリッド（tree.type === 'grid'）で管理する。
//   tree = { type:'grid', order:[paneId,...], colFr:null|number[], rowFr:null|number[] }
// 全ペインは grid 直下の兄弟であり、ペインがペインの中に入れ子になることはない。
// colFr / rowFr は手動リサイズ時のトラック比率（null = 均等）。ペイン増減時は null にリセットする。

// グリッドの列数（自動）。ほぼ正方形になるよう ceil(sqrt(n)) を採用し、行方向に折り返す。
function gridColCount(n) {
  if (n <= 1) return 1;
  return Math.ceil(Math.sqrt(n));
}

// 現在のグリッド寸法 { cols, rows } を返す。
function gridDims(t = tree) {
  const n = (t && Array.isArray(t.order)) ? t.order.length : 0;
  const cols = gridColCount(n);
  const rows = Math.max(1, Math.ceil(n / cols));
  return { cols, rows };
}

// 手動リサイズ比率をクリア（ペイン増減で寸法が変わったとき均等に戻す）。
function resetGridSizing() {
  if (tree) { tree.colFr = null; tree.rowFr = null; }
}

// 全ペイン ID を返す（グリッド order ＋ サイドバー格納 stashOrder の和集合）。
// fitAll・状態レポート・closePane の残ペイン算出などが依存するため、
// グリッドと格納の両方を必ず走査対象に含める（issue #89）。
function getAllLeafIds(t = tree) {
  if (!t) return [];
  const grid = Array.isArray(t.order) ? t.order : [];
  const stash = Array.isArray(t.stashOrder) ? t.stashOrder : [];
  return grid.concat(stash);
}

// グリッド上でペイン D&D の起点になれるか（issue #40）。
// D&D はグリッド内限定のため、格納分を含まないグリッドの order 件数で判定する（issue #89）。
// グリッドに 2 枚以上あるときのみドラッグ可（1 枚だと移動先が無い）。
function canDragGridPane() {
  return !!(tree && Array.isArray(tree.order) && tree.order.length > 1);
}

// ペインがグリッド・格納のいずれかに存在するか（issue #89 で格納分も含める）。
function paneExists(id) {
  if (!tree) return false;
  const inGrid = Array.isArray(tree.order) && tree.order.includes(id);
  const inStash = Array.isArray(tree.stashOrder) && tree.stashOrder.includes(id);
  return inGrid || inStash;
}

function getPaneRect(paneId) {
  const paneEl = document.querySelector(`.pane[data-id="${paneId}"]`);
  const rect = paneEl?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

function findLargestVisiblePaneId() {
  if (!tree) return null;

  let bestPaneId = null;
  let bestArea = -1;
  for (const paneId of getAllLeafIds(tree)) {
    const rect = getPaneRect(paneId);
    if (!rect) continue;
    const area = rect.width * rect.height;
    if (area > bestArea) {
      bestPaneId = paneId;
      bestArea = area;
    }
  }
  return bestPaneId;
}

// ─── Collapse / expand ────────────────────────────────────────────────────────
// （グリッドレイアウト化により折り畳み機能は撤去。行の高さは同一行の全ペインで共有されるため、
//   単一ペインだけを縦に畳む操作がグリッドでは成立しないため。）

// ─── Pane actions ─────────────────────────────────────────────────────────────
// グリッド化により「分割」は入れ子を作らず、新ペインをグリッド末尾に追加する操作になった。
// direction は後方互換のため引数として残すが、配置には影響しない（自動折返しグリッド）。
// 新規ペインをグリッド末尾に追加する（基準ペイン不要）。
// splitPane（＋ボタン）と空グリッドのプレースホルダ「新規ペインを追加」で共有する生成経路（issue #89）。
//   - overrideCwd が指定されていればそれを使い、未指定ならホームディレクトリ（main 側でフォールバック）で開く。
//   - options.noClaude が指定されていればそのまま main に渡す。未指定なら main 側のグローバル設定に従う。
async function addPane(overrideCwd = null, options = {}) {
  const newPaneId = newId();
  await createTerminal(newPaneId, overrideCwd || null, options);

  if (!Array.isArray(tree.order)) tree.order = [];
  tree.order.push(newPaneId);
  // ペイン数が変わりグリッド寸法が変化するため、手動リサイズ比率は均等にリセットする。
  resetGridSizing();

  render();
  requestAnimationFrame(() => {
    fitAll();
    focusPane(newPaneId);
  });

  // 新ペインの情報を返す（focusedPaneId の更新を待たずに確定値を返す）
  return { paneId: newPaneId, termId: terminals[newPaneId]?.termId };
}

// グリッド化により「分割」は入れ子を作らず、新ペインをグリッド末尾に追加する操作。
// 分割元ペインの cwd は継承しない（task-queue 等の特定ディレクトリにいるペインから分割しても
// 新ペインはデフォルト位置で開かせる方針）。
async function splitPane(paneId, direction, overrideCwd, options = {}) {
  if (!paneExists(paneId)) return null;
  return addPane(overrideCwd, options);
}

function closePane(paneId, { force = false, skipConfirm = false } = {}) {
  if (!paneExists(paneId)) return;
  const _t = terminals[paneId];
  if (!force && _t?.lock?.close === false) return;
  // 誤クローズ防止（issue #184）: 非 force パスでは confirmClose 設定と status に応じて
  // アプリ内確認ダイアログを挟む。force（HTTP API / PTY exit などの自動系）は従来どおり即閉じ。
  // lock.close === false のガードが確認より優先される（上の early return）。
  if (!force && !skipConfirm && shouldConfirmClose(confirmClosePref, _t?.status || 'idle')) {
    openCloseConfirmDialog(paneId);
    return;
  }

  const t = terminals[paneId];
  if (t) {
    // status の自動 idle 復帰タイマーが残っているとクロージャ経由で terminals[paneId] を
    // 参照し続けてしまうため、必ず破棄する（リーク防止）。
    clearRunningIdleTimer(t);
    // auto-input バッジの自動非表示タイマーも残っていればクリアする
    // （runningTimer と一貫させた防御的なクリーンアップ／issue #38）
    const paneEl = document.querySelector(`.pane[data-id="${paneId}"]`);
    const autoInputTimer = paneEl?.dataset.autoInputTimer;
    if (autoInputTimer) {
      clearTimeout(Number(autoInputTimer));
      delete paneEl.dataset.autoInputTimer;
    }
    t.term.dispose();
    ipcRenderer.send('terminal:kill', t.termId);
    delete terminals[paneId];
  }

  // グリッド・格納のどちらに居ても取り除く（issue #89）。
  tree.order = tree.order.filter(id => id !== paneId);
  tree.stashOrder = (Array.isArray(tree.stashOrder) ? tree.stashOrder : []).filter(id => id !== paneId);
  if (tree.order.length === 0 && tree.stashOrder.length === 0) {
    // Last pane closed → start fresh
    // 格納ペインが 1 枚でも生き残っている場合は巻き込んで作り直さない（issue #89）。
    initApp().then(() => {
      ipcRenderer.send('terminal:renderer-ready');
    });
    return;
  }
  // ペイン数が変わりグリッド寸法が変化するため、手動リサイズ比率は均等にリセットする。
  resetGridSizing();

  // Focus another pane
  // フォーカス先は可視グリッド（tree.order）の末尾を優先する。getAllLeafIds は格納分も
  // 含むため、その末尾を選ぶと非表示の格納ペインにフォーカスが移り、キー入力が見えない
  // ターミナルへ流れてしまう。可視ペインが 1 つも無い（全て格納中）ときはどこにも
  // フォーカスしない（null）（issue #89 / CodeRabbit 指摘）。
  if (!focusedPaneId || focusedPaneId === paneId) {
    const visible = Array.isArray(tree.order) ? tree.order : [];
    focusedPaneId = visible.length > 0 ? visible[visible.length - 1] : null;
  }

  render();
  requestAnimationFrame(fitAll);
}

// ─── ペインを閉じる確認ダイアログ（issue #184）───────────────────────────────
// OS ネイティブダイアログではなくアプリ内モーダルで確認する（フォーカス移動で
// ペイン状態が変わらないこと。status は PTY 出力/入力時刻の派生値なので、モーダルへの
// フォーカス移動では変化しない）。二重表示は closeConfirmOpen で防ぐ。
let closeConfirmOpen = false;

function openCloseConfirmDialog(paneId) {
  if (closeConfirmOpen) return;
  closeConfirmOpen = true;

  const t = terminals[paneId];
  const { label } = getStatusPresentation(t?.status);
  // running / waiting はその旨を明示し、それ以外（'always' 設定の idle）は汎用文にする。
  const message = label
    ? `このペインは「${label}」です。閉じるとセッションは失われます。閉じますか？`
    : 'このペインを閉じますか？';

  const overlay = document.createElement('div');
  overlay.className = 'confirm-overlay';
  const modal = document.createElement('div');
  modal.className = 'confirm-modal';
  modal.setAttribute('role', 'alertdialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'ペインを閉じる確認');

  const msgEl = document.createElement('p');
  msgEl.className = 'confirm-message';
  msgEl.textContent = message;

  const actions = document.createElement('div');
  actions.className = 'confirm-actions';
  const cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'confirm-cancel';
  cancelBtn.textContent = 'キャンセル';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'confirm-close-pane';
  closeBtn.textContent = '閉じる';
  actions.appendChild(cancelBtn);
  actions.appendChild(closeBtn);

  modal.appendChild(msgEl);
  modal.appendChild(actions);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  const cleanup = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    closeConfirmOpen = false;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      cleanup();
    }
  };
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) cleanup(); });
  cancelBtn.addEventListener('click', cleanup);
  closeBtn.addEventListener('click', () => {
    cleanup();
    // ダイアログ表示中に PTY exit 等で当該ペインが消えていても、closePane 冒頭の
    // paneExists ガードで no-op になる（誤って別ペインを閉じることはない）。
    closePane(paneId, { skipConfirm: true });
  });

  // 既定フォーカスは安全側（キャンセル）。Enter 誤爆で閉じてしまわないようにする。
  cancelBtn.focus();
}

// ペインをグリッド上で左右の隣と入れ替える。端で隣が無ければ何もしない。
function movePane(paneId, dir) {
  const order = tree.order;
  const i = order.indexOf(paneId);
  if (i < 0) return;
  const { cols } = gridDims();
  let j = -1;
  if (dir === 'left'  && i % cols !== 0) j = i - 1;
  else if (dir === 'right' && i % cols !== cols - 1 && i + 1 < order.length) j = i + 1;
  if (j < 0) return;
  [order[i], order[j]] = [order[j], order[i]];
  render();
  requestAnimationFrame(() => {
    fitAll();
    focusPane(paneId);
  });
}

// ─── Pane stash: サイドバーへの格納 / 復帰（issue #89）──────────────────────────
// グリッド order とは別配列 stashOrder で管理する。xterm 要素（t.element）は破棄せず、
// render() の appendChild 付け替えで格納コンテナ／グリッドコンテナ間を移動させる。

// グリッドのペインをサイドバーへ格納する。
function stashPane(paneId) {
  if (!tree || !Array.isArray(tree.order)) return;
  const i = tree.order.indexOf(paneId);
  if (i < 0) return;
  tree.order.splice(i, 1);
  tree.stashOrder = Array.isArray(tree.stashOrder) ? tree.stashOrder : [];
  tree.stashOrder.push(paneId);
  // 格納直後は xterm を折り畳んだコンパクト表示にする。
  const t = terminals[paneId];
  if (t) t.stashXtermOpen = false;
  // グリッドの寸法が変わるため手動リサイズ比率を均等に戻す。
  resetGridSizing();
  // 格納したペインにフォーカスがあった場合はグリッドの残ペインへ移す。
  if (focusedPaneId === paneId) {
    focusedPaneId = tree.order.length > 0 ? tree.order[tree.order.length - 1] : paneId;
  }
  render();
  // 格納先を知らせるためサイドバーを開く（フォーカスはグリッドに残す）。
  setSidebarOpen(true, { focusFirst: false });
  requestAnimationFrame(() => {
    fitAll();
    if (tree.order.length > 0) focusPane(focusedPaneId);
  });
}

// 格納中のペインをグリッドへ戻す。
function unstashPane(paneId) {
  if (!tree) return;
  tree.stashOrder = Array.isArray(tree.stashOrder) ? tree.stashOrder : [];
  const i = tree.stashOrder.indexOf(paneId);
  if (i < 0) return;
  tree.stashOrder.splice(i, 1);
  if (!Array.isArray(tree.order)) tree.order = [];
  tree.order.push(paneId);
  resetGridSizing();
  render();
  requestAnimationFrame(() => {
    fitAll();
    focusPane(paneId);
  });
}

// 格納エリア内でペインを上下に入れ替える（stashOrder の index swap）。
function moveStashPane(paneId, dir) {
  const arr = tree && tree.stashOrder;
  if (!Array.isArray(arr)) return;
  const i = arr.indexOf(paneId);
  if (i < 0) return;
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  render();
  requestAnimationFrame(fitAll);
}

// 格納ペインの xterm 表示/非表示をトグルする（― ボタン）。
// 非表示（display:none）からの復帰時は 0 サイズ基準のままになるため再フィットする。
function toggleStashXterm(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  t.stashXtermOpen = !t.stashXtermOpen;
  const li = document.querySelector(`.stash-item[data-id="${paneId}"]`);
  if (li) {
    li.classList.toggle('stash-xterm-open', t.stashXtermOpen);
    const btn = li.querySelector('.btn-stash-toggle');
    if (btn) {
      btn.setAttribute('aria-expanded', t.stashXtermOpen ? 'true' : 'false');
      // 開閉状態に応じてグリフ・ラベルも切り替える（視覚状態の可視化）。
      btn.textContent = stashToggleGlyph(t.stashXtermOpen);
      btn.title = stashToggleLabel(t.stashXtermOpen);
      btn.setAttribute('aria-label', stashToggleLabel(t.stashXtermOpen));
    }
  }
  if (t.stashXtermOpen) {
    requestAnimationFrame(() => {
      fitTerminal(paneId);
      focusPane(paneId);
    });
  }
}

// ─── Pane D&D helpers (issue #40) ────────────────────────────────────────────
// dragover の event 座標から、対象ペイン内のドロップ方向を算出する。
//   - 中央 PANE_DROP_DEADZONE (= 0.2) 範囲は無効（null を返す）
//   - 外周は最も端に近い辺（左/右/上/下）を選ぶ
// 引数は対象ペインの DOM 要素と dragover イベント。
function computePaneDropDir(paneEl, event) {
  const rect = paneEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  // offsetX/Y は paneEl 基準ではない場合があるので getBoundingClientRect ベースで再計算する
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const fx = x / rect.width;   // 0..1
  const fy = y / rect.height;  // 0..1
  // 中央デッドゾーン: 中心からの距離が PANE_DROP_DEADZONE/2 以内
  const dz = PANE_DROP_DEADZONE / 2;
  if (Math.abs(fx - 0.5) <= dz && Math.abs(fy - 0.5) <= dz) return null;
  // 各辺までの距離（正規化後）
  const distLeft = fx;
  const distRight = 1 - fx;
  const distTop = fy;
  const distBottom = 1 - fy;
  const min = Math.min(distLeft, distRight, distTop, distBottom);
  if (min === distLeft) return 'left';
  if (min === distRight) return 'right';
  if (min === distTop) return 'up';
  return 'down';
}

// `#pane-drop-indicator` を body 直下にグローバル 1 個だけ用意して使い回す。
// `dragover` で対象ペインの矩形 + dir からその半分を半透明アクセントカラーで塗りつぶす。
// pointer-events: none 必須（オーバーレイ自身が dragover を奪わないため）。
function getPaneDropIndicator() {
  let el = document.getElementById('pane-drop-indicator');
  if (!el) {
    el = document.createElement('div');
    el.id = 'pane-drop-indicator';
    document.body.appendChild(el);
  }
  return el;
}

function updatePaneDropIndicator(paneEl, dir) {
  const indicator = getPaneDropIndicator();
  if (!dir) {
    indicator.style.display = 'none';
    return;
  }
  const r = paneEl.getBoundingClientRect();
  let top = r.top;
  let left = r.left;
  let width = r.width;
  let height = r.height;
  // dir 方向の半分の矩形に縮める
  if (dir === 'left') {
    width = r.width / 2;
  } else if (dir === 'right') {
    left = r.left + r.width / 2;
    width = r.width / 2;
  } else if (dir === 'up') {
    height = r.height / 2;
  } else if (dir === 'down') {
    top = r.top + r.height / 2;
    height = r.height / 2;
  }
  indicator.style.display = 'block';
  indicator.style.top = `${top}px`;
  indicator.style.left = `${left}px`;
  indicator.style.width = `${width}px`;
  indicator.style.height = `${height}px`;
}

function removePaneDropIndicator() {
  const el = document.getElementById('pane-drop-indicator');
  if (el) el.style.display = 'none';
}

// drop 完了後 / dragend / キャンセル時の共通クリーンアップ。
function cleanupPaneDrag() {
  document.body.classList.remove('pane-dragging');
  document.querySelectorAll('.pane.pane-drag-source').forEach(el => {
    el.classList.remove('pane-drag-source');
  });
  removePaneDropIndicator();
  paneDragState = null;
}

// ペイン D&D による並べ替え（issue #40 → グリッド化で「並べ替え」に変更）。
// src ペインを order から抜き、target の位置へ挿入する。
//   dir が left/up  … target の直前へ
//   dir が right/down … target の直後へ
function handlePaneDrop(srcId, targetId, dir) {
  if (!tree) return;
  if (!srcId || !targetId || srcId === targetId) return;
  if (!paneExists(srcId) || !paneExists(targetId)) return;

  const order = tree.order;
  const from = order.indexOf(srcId);
  order.splice(from, 1);

  let ti = order.indexOf(targetId);
  if (dir === 'right' || dir === 'down') ti += 1;
  order.splice(ti, 0, srcId);

  // 並べ替えで各行の割り当てが変わるため、手動リサイズ比率は均等にリセットする。
  resetGridSizing();

  render();
  requestAnimationFrame(() => {
    fitAll();
    focusPane(srcId);
  });
}

function focusPane(paneId) {
  focusedPaneId = paneId;
  document.querySelectorAll('.pane').forEach(el => {
    el.classList.toggle('focused', el.dataset.id === paneId);
  });
  // 格納ペイン（サイドバー内）のフォーカスリングも同期する（issue #89）。
  document.querySelectorAll('.stash-item').forEach(el => {
    el.classList.toggle('focused', el.dataset.id === paneId);
  });
  terminals[paneId]?.term.focus();
}

function fitTerminal(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  // 非表示（格納中で xterm を折り畳み中など、祖先が display:none）のときは
  // 0 サイズでのフィット→pty への誤リサイズを避けるためスキップする（issue #89）。
  if (t.element && t.element.offsetParent === null) return;
  try {
    t.fitAddon.fit();
    ipcRenderer.send('terminal:resize', t.termId, t.term.cols, t.term.rows);
  } catch (e) {}
}

function fitAll() {
  getAllLeafIds(tree).forEach(fitTerminal);
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function render() {
  const root = document.getElementById('root');
  const sidebar = ensureSidebar(root);
  const newContent = renderGrid(tree);
  root.replaceChildren(sidebar, newContent);
  root.classList.toggle('sidebar-open', sidebarOpen);

  // 格納ペインのコンパクト表示を作り直す（nav が root に付いた後に実行する）。
  renderPaneStash();
  // 現在のサイドバー幅を CSS 変数・aria へ反映（issue #89）。
  setSidebarWidth(getSidebarWidth());

  // Reattach terminal elements (moved, not recreated)
  // グリッド側（.pane）と格納側（.stash-item）のどちらのコンテナへも付け替える。
  getAllLeafIds(tree).forEach(paneId => {
    const t = terminals[paneId];
    if (!t) return;
    const container = root.querySelector(`.pane[data-id="${paneId}"] .term-container`)
      || root.querySelector(`.stash-item[data-id="${paneId}"] .term-container`);
    if (container) {
      container.appendChild(t.element);
      // Open xterm after element is in the DOM (required for correct sizing)
      if (!t.opened) {
        t.term.open(t.element);
        t.opened = true;
      }
    }
  });

  // Observe pane resizes
  observePanes();
}

// フラットなグリッドを描画する。全ペインは .grid の直接の子として並ぶ。
//   - 列数は gridColCount(n)（自動折返し）。
//   - colFr / rowFr があれば fr トラックに反映（手動リサイズ結果）。無ければ均等。
//   - 最終行がフルでない場合、最後のペインを残りの列に広げてスキマを埋める。
//   - 列間・行間にドラッグ用リサイズハンドルをオーバーレイする。
// グリッドが空（全ペイン格納中など）のときのプレースホルダ（issue #89）。
// 空セルだけで行き止まりにならないよう、復帰導線を明示する。
//   - 「新規ペインを追加」: ＋ と同じ生成経路（addPane）で新規ペインを作る。
//   - 「サイドバーを開いて戻す」: ドロワーを開き、格納ペインを戻せるようにする。
function renderEmptyGrid() {
  const wrap = document.createElement('div');
  wrap.className = 'grid grid-empty';

  const box = document.createElement('div');
  box.className = 'grid-empty-box';

  const title = document.createElement('div');
  title.className = 'grid-empty-title';
  title.textContent = 'すべてのペインを格納中です';

  const desc = document.createElement('div');
  desc.className = 'grid-empty-desc';
  desc.textContent = 'グリッドに表示するペインがありません。新規ペインを追加するか、サイドバーから格納したペインを戻してください。';

  const actions = document.createElement('div');
  actions.className = 'grid-empty-actions';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'grid-empty-btn';
  addBtn.textContent = '新規ペインを追加';
  addBtn.setAttribute('aria-label', '新規ペインを追加');
  addBtn.addEventListener('click', () => { addPane(newPaneStartupDir || null, { noClaude: !newPaneAutoLaunchClaude }); });

  const openBtn = document.createElement('button');
  openBtn.type = 'button';
  openBtn.className = 'grid-empty-btn grid-empty-btn-secondary';
  openBtn.textContent = 'サイドバーを開いて戻す';
  openBtn.setAttribute('aria-label', 'サイドバーを開いて格納したペインを戻す');
  openBtn.addEventListener('click', () => setSidebarOpen(true, { focusFirst: true }));

  actions.appendChild(addBtn);
  actions.appendChild(openBtn);
  box.appendChild(title);
  box.appendChild(desc);
  box.appendChild(actions);
  wrap.appendChild(box);
  return wrap;
}

function renderGrid(t) {
  const order = (t && Array.isArray(t.order)) ? t.order : [];
  // グリッドが空のときは行き止まり回避のプレースホルダを返す（issue #89）。
  if (order.length === 0) return renderEmptyGrid();
  const { cols, rows } = gridDims(t);

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.style.gridTemplateColumns = (t.colFr && t.colFr.length === cols)
    ? t.colFr.map(f => `${f}fr`).join(' ')
    : `repeat(${cols}, 1fr)`;
  grid.style.gridTemplateRows = (t.rowFr && t.rowFr.length === rows)
    ? t.rowFr.map(f => `${f}fr`).join(' ')
    : `repeat(${rows}, 1fr)`;

  const lastRowCount = order.length % cols || cols;
  order.forEach((id, idx) => {
    const pane = renderLeaf({ type: 'leaf', id });
    // 最終行がフルでないとき、最後のペインを余った列ぶんだけ広げてスキマを埋める。
    if (idx === order.length - 1 && lastRowCount < cols) {
      pane.style.gridColumn = `span ${cols - lastRowCount + 1}`;
    }
    grid.appendChild(pane);
  });

  appendGridHandles(grid, t, cols, rows);
  return grid;
}

// 列間（縦線）・行間（横線）にリサイズハンドルを絶対配置で重ねる。
// 位置は fr トラックの累積比率（%）で計算する（gap ぶんの微小なズレはハンドル幅で吸収）。
function appendGridHandles(grid, t, cols, rows) {
  const colFr = (t.colFr && t.colFr.length === cols) ? t.colFr : Array(cols).fill(1);
  const rowFr = (t.rowFr && t.rowFr.length === rows) ? t.rowFr : Array(rows).fill(1);
  const colTotal = colFr.reduce((a, b) => a + b, 0);
  const rowTotal = rowFr.reduce((a, b) => a + b, 0);

  let acc = 0;
  for (let i = 0; i < cols - 1; i++) {
    acc += colFr[i];
    const h = document.createElement('div');
    h.className = 'grid-handle grid-handle-col';
    h.style.left = `${(acc / colTotal) * 100}%`;
    h.addEventListener('mousedown', e => startGridResize(e, grid, 'col', i, cols, rows));
    grid.appendChild(h);
  }
  let accR = 0;
  for (let j = 0; j < rows - 1; j++) {
    accR += rowFr[j];
    const h = document.createElement('div');
    h.className = 'grid-handle grid-handle-row';
    h.style.top = `${(accR / rowTotal) * 100}%`;
    h.addEventListener('mousedown', e => startGridResize(e, grid, 'row', j, cols, rows));
    grid.appendChild(h);
  }
}

// status → { label, ariaLabel } のマッピングを一元化する（updatePaneStatus / renderLeaf 共用）。
// 'idle' および未知の値は空文字を返し、呼び出し側で「非表示・aria-label 除去」相当の扱いになる。
function getStatusPresentation(status) {
  if (status === 'waiting') return { label: '入力待ち', ariaLabel: 'ステータス: 入力待ち' };
  if (status === 'running') return { label: '実行中',   ariaLabel: 'ステータス: 実行中' };
  return { label: '', ariaLabel: '' };
}

// ─── Agent room: 状態の解決と描画（issue #58） ───────────────────────────────
// ルームに表示する各キャラの状態 { name: state } を決める。
//   1. HTTP API（POST /api/agentroom）由来の t.agentRoom が「新鮮」ならそれを最優先で採用。
//   2. API が未通知 / 古い場合は PTY 出力ベースのフォールバック（A 方式）:
//        - 司（メイン Claude）= ペイン status を写像（running→working / waiting→consulting / idle→idle）
//        - その他のサブエージェント = 直近の出力にその名前が出ていれば作業中とみなす（ベストエフォート）
//   3. API が一部の人だけ報告している場合、未報告の人はフォールバック値で補完する。
function resolveRoomAgents(t) {
  const now = Date.now();
  const fresh = !!(t && t.agentRoom
    && t.agentRoomUpdatedAt
    && (now - t.agentRoomUpdatedAt <= AGENTROOM_API_TTL_MS)
    && Object.keys(t.agentRoom).length > 0);

  const status = (t && t.status) || 'idle';
  const directorState = status === 'waiting' ? 'consulting'
    : status === 'running' ? 'working'
    : 'idle';
  // フォールバック時のみ直近出力をスキャンする（API 新鮮時は不要）。
  // サブエージェントの稼働判定は agentRoom.js の純粋関数に委譲（英語ハンドル基準・issue #60）。
  const recent = fresh ? '' : stripAnsiForDisplay((t && t.lastLines) || '');
  const subStates = resolveAgentStatesFromOutput(recent);

  const out = {};
  for (const name of AGENT_ORDER) {
    if (name === '司') out[name] = directorState;
    else out[name] = subStates[name] || 'idle';
  }
  // API 報告分で上書き（未報告の人はフォールバック値のまま残る）。
  if (fresh) {
    for (const [name, state] of Object.entries(t.agentRoom)) {
      if (typeof state === 'string') out[name] = state;
    }
  }
  return out;
}

// 指定の .agent-room-body 要素にシーンを描画する（DOM 取得を伴わない純粋な描画）。
function renderRoomInto(bodyEl, t) {
  bodyEl.innerHTML = '';
  bodyEl.appendChild(buildScene(resolveRoomAgents(t)));
}

// ペインのエージェントルーム表示を最新状態へ更新する（DOM 探索あり）。
// status 変化（updatePaneStatus）や API 受信（terminal:agentroom）から呼ぶ。
function updateAgentRoom(paneId) {
  if (!agentRoomEnabled) return;
  const t = terminals[paneId];
  if (!t) return;
  const body = document.querySelector(`.pane[data-id="${paneId}"] .agent-room-body`);
  if (body) {
    renderRoomInto(body, t);
    t.agentRoomSig = JSON.stringify(resolveRoomAgents(t)); // 直近描画した状態を記録（差分判定用）
  }
}

// 定期再評価用（2000ms interval から呼ぶ）。
// API 失効（AGENTROOM_API_TTL_MS 超過）後、出力が止まったペインでも古い表示が残り続ける問題（issue #58）
// への対処。解決後の状態が前回描画と変わったときだけ再描画し、無駄な再描画を避ける。
function refreshAgentRoomIfChanged(paneId) {
  if (!agentRoomEnabled) return;
  const t = terminals[paneId];
  if (!t) return;
  const sig = JSON.stringify(resolveRoomAgents(t));
  if (sig === t.agentRoomSig) return; // 変化なし → 再描画しない
  updateAgentRoom(paneId);
}

function renderLeaf(node) {
  const t = terminals[node.id];
  const cwd = t?.cwd || '~';
  const waiting = !!(t && (t.waiting || t.externalWaiting));
  // 表示用ステータス（issue #23, #27）。idle 時は CSS の visibility:hidden で不可視のまま幅は保持。
  // ドットは CSS の .pane-status::before（currentColor）で描画するため、ラベルはテキストのみ。
  // ラベル / aria-label の対応は getStatusPresentation に集約（updatePaneStatus と共用）。
  const status = t?.status || 'idle';
  const { label: statusLabel, ariaLabel: statusAriaLabel } = getStatusPresentation(status);
  const focused = node.id === focusedPaneId;
  // apiTitle（API 由来）優先、無ければ taskTitle（OSC 由来）にフォールバック。
  const taskTitle = getDisplayTitle(t);
  // apiTitle 表示時かつ apiUrl があるときのみリンク化（OSC 由来時は URL を出さない）
  const taskUrl = getDisplayUrl(t);
  // PR ボタン用 URL（issue #44）。renderer 側でも http(s) 二段チェックを通す。
  const taskPrUrl = isSafeExternalUrl(t?.apiPrUrl) ? t.apiPrUrl : '';
  const taskPrMerged = !!t?.apiPrMerged;
  const closeLocked = isCloseLocked(t);
  const closeLabel = closeButtonLabel(closeLocked);

  const el = document.createElement('div');
  el.className = 'pane'
    + (focused ? ' focused' : '')
    + (waiting ? ' waiting' : '');
  el.dataset.id = node.id;

  // タスクタイトル行（OSC 0/2 または POST /api/set-title で設定された文字列を表示）。
  // 空のときは .empty クラスで非表示にし、xterm の表示領域を圧迫しない。
  // apiUrl があるときは .has-link を付与し、内部を <a> 化する（renderTaskTitleContent）。
  // ペイン D&D の可否判定（issue #40 / #89）。判定式は canDragGridPane に集約。
  // 空タイトル時も D&D 可なら .empty を付けず、ハンドルとして掴める高さを確保する。
  const canDragPane = canDragGridPane();
  const taskTitleEl = document.createElement('div');
  // empty 判定はタイトル本文・ドラッグ可・PR ボタンのいずれもないとき。
  // PR ボタンだけでも表示するためにこの条件で扱う（issue #44）。
  const isEmpty = !taskTitle && !canDragPane && !taskPrUrl;
  taskTitleEl.className = 'pane-task-title'
    + (isEmpty ? ' empty' : '')
    + (taskUrl ? ' has-link' : '')
    + (taskPrUrl ? ' has-pr' : '');
  renderTaskTitleContent(taskTitleEl, taskTitle, taskUrl, taskPrUrl, taskPrMerged);
  // URL 有りのときは子 <a> 側の title 属性に集約するため、親には付けない（親子競合回避）。
  if (taskTitle && !taskUrl) taskTitleEl.title = taskTitle;
  if (canDragPane) {
    taskTitleEl.draggable = true;
    taskTitleEl.addEventListener('dragstart', e => {
      // 独自 MIME に paneId を載せる。これにより受け側はファイル D&D と分岐できる。
      try {
        e.dataTransfer.setData(PANE_DRAG_MIME, node.id);
      } catch (_e) { /* setData が失敗しても続行 */ }
      e.dataTransfer.effectAllowed = 'move';
      paneDragState = { srcId: node.id, lastTargetId: null, lastDir: null };
      document.body.classList.add('pane-dragging');
      el.classList.add('pane-drag-source');
    });
    taskTitleEl.addEventListener('dragend', () => {
      // 念のための後始末。drop ハンドラが先に動いていればここはすべて no-op になる。
      cleanupPaneDrag();
    });
  }
  el.appendChild(taskTitleEl);

  const header = document.createElement('div');
  header.className = 'pane-header';
  // .pane-status はヘッダ最左に常時挿入し、CSS の data-status="idle" を visibility:hidden で扱う。
  // role="status" + aria-live="polite" で SR にステータス変化を通知（aria-label は動的更新）。
  // 共通バッジ basis は .pane-badge（issue #27）、固有スタイルは .pane-status / .auto-input-badge。
  // 旧 .waiting-badge は role を .pane-status に一本化したため削除済（issue #23）。
  //
  // セキュリティ: テンプレートリテラル経由で innerHTML に挿入する外部由来の文字列は
  // escAttr / escText でエスケープする（issue #39）。
  //   - status / statusAriaLabel: 内部状態だが将来の外部入力統合を想定し防御的にエスケープ
  //   - cwd: OS ファイルシステム由来。ディレクトリ名に `"` や `<` を含めることは技術的に可能
  //   - statusLabel: getStatusPresentation() からの静的文字列だが、念のためエスケープ
  header.innerHTML = `
    <span class="pane-badge pane-status" data-status="${escAttr(status)}" role="status" aria-live="polite"${statusAriaLabel ? ` aria-label="${escAttr(statusAriaLabel)}"` : ''}>${escText(statusLabel)}</span>
    <span class="pane-cwd" title="${escAttr(cwd)}">${escText(cwd)}</span>
    <div class="pane-actions">
      <span class="pane-badge auto-input-badge" hidden></span>
      <button class="btn btn-stash" title="サイドバーに格納" aria-label="サイドバーに格納">←</button>
      <span class="pane-actions-sep" aria-hidden="true"></span>
      <button class="btn btn-move btn-move-left" title="左へ移動" aria-label="左へ移動">◀</button>
      <button class="btn btn-move btn-move-right" title="右へ移動" aria-label="右へ移動">▶</button>
      <button class="btn btn-split" title="ペインを追加" aria-label="ペインを追加">＋</button>
      <button class="btn btn-close${closeLocked ? ' is-locked' : ''}" title="${escAttr(closeLabel)}" aria-label="${escAttr(closeLabel)}"${closeLocked ? ' aria-disabled="true"' : ''}>✕</button>
    </div>
  `;
  // ドラッグ中に複数ファイルのヒントを表示
  header.setAttribute('title', 'ファイルをドラッグ&ドロップでパスを入力（複数ファイル可）');

  const termContainer = document.createElement('div');
  termContainer.className = 'term-container';

  el.appendChild(header);
  el.appendChild(termContainer);

  // ─── エージェントルーム（issue #58） ───────────────────────────────────────
  // config.json の `agentroom: true` のときだけ、ペイン下部に開閉式の
  // 「エージェントルーム」を出す。開閉状態は t.agentRoomOpen で再 render をまたいで保持する。
  if (agentRoomEnabled) {
    const room = document.createElement('details');
    room.className = 'agent-room';
    if (t && t.agentRoomOpen) room.open = true;

    const summary = document.createElement('summary');
    summary.className = 'agent-room-summary';
    summary.innerHTML = '<span class="agent-room-icon" aria-hidden="true">🏠</span>'
      + '<span class="agent-room-title">エージェントルーム</span>';

    const body = document.createElement('div');
    body.className = 'agent-room-body';

    room.appendChild(summary);
    room.appendChild(body);

    room.addEventListener('toggle', () => {
      const cur = terminals[node.id];
      if (cur) cur.agentRoomOpen = room.open;
    });

    if (t) renderRoomInto(body, t);
    el.appendChild(room);
  }

  header.querySelector('.btn-stash').addEventListener('click', e => {
    e.stopPropagation();
    stashPane(node.id);
  });
  header.querySelector('.btn-move-left').addEventListener('click', e => {
    e.stopPropagation();
    movePane(node.id, 'left');
  });
  header.querySelector('.btn-move-right').addEventListener('click', e => {
    e.stopPropagation();
    movePane(node.id, 'right');
  });
  header.querySelector('.btn-split').addEventListener('click', e => {
    e.stopPropagation();
    splitPane(node.id, 'h', newPaneStartupDir || null, { noClaude: !newPaneAutoLaunchClaude });
  });
  header.querySelector('.btn-close').addEventListener('click', e => {
    e.stopPropagation();
    if (terminals[node.id]?.lock?.close === false) return;
    closePane(node.id);
  });
  el.addEventListener('mousedown', () => focusPane(node.id));

  // ─── Drag & Drop: pane reordering (issue #40 → グリッド化で並べ替えに変更) ──
  // 別ペインのタスクタイトル行をドラッグして、このペインの左/上（前）・右/下（後）に
  // ドロップすると、グリッド内の並び順を入れ替える。同一ペインへのドロップは no-op。
  // ファイル D&D（パス挿入）とは独自 MIME（PANE_DRAG_MIME）で分岐する。
  el.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    if (!paneDragState) return;
    // 同一ペインへのドロップは無効化（インジケータも出さない）
    if (paneDragState.srcId === node.id) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = 'none';
      // 同一ペイン上ではオーバーレイを消しておく
      if (paneDragState.lastTargetId !== null) {
        removePaneDropIndicator();
        paneDragState.lastTargetId = null;
        paneDragState.lastDir = null;
      }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    const dir = computePaneDropDir(el, e);
    // 中央デッドゾーン（dir=null）はカーソルを no-drop に。オーバーレイも消す。
    e.dataTransfer.dropEffect = dir ? 'move' : 'none';
    // 前フレームと同じ判定ならオーバーレイ更新スキップ（負荷低減）
    if (paneDragState.lastTargetId === node.id && paneDragState.lastDir === dir) return;
    paneDragState.lastTargetId = node.id;
    paneDragState.lastDir = dir;
    updatePaneDropIndicator(el, dir);
  });
  el.addEventListener('dragleave', e => {
    if (!paneDragState) return;
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    // ペイン要素の外（自要素内の子から親自身は relatedTarget が自要素になりうるので除外）
    if (!el.contains(e.relatedTarget)) {
      if (paneDragState.lastTargetId === node.id) {
        removePaneDropIndicator();
        paneDragState.lastTargetId = null;
        paneDragState.lastDir = null;
      }
    }
  });
  el.addEventListener('drop', e => {
    if (!e.dataTransfer.types.includes(PANE_DRAG_MIME)) return;
    if (!paneDragState) return;
    e.preventDefault();
    e.stopPropagation();
    const srcId = e.dataTransfer.getData(PANE_DRAG_MIME) || paneDragState.srcId;
    // 同一ペインは no-op
    if (!srcId || srcId === node.id) {
      cleanupPaneDrag();
      return;
    }
    const dir = computePaneDropDir(el, e);
    if (!dir) {
      // デッドゾーン（中央20%）は何もしない
      cleanupPaneDrag();
      return;
    }
    handlePaneDrop(srcId, node.id, dir);
    cleanupPaneDrag();
  });

  // ─── Drag & Drop: file path insertion ─────────────────────────────────────
  el.addEventListener('dragover', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    el.classList.add('drag-over');
  });

  el.addEventListener('dragleave', e => {
    // Only remove highlight when leaving the pane element itself
    if (!el.contains(e.relatedTarget)) {
      el.classList.remove('drag-over');
    }
  });

  el.addEventListener('drop', e => {
    if (!e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    resetFileDragState();

    const files = Array.from(e.dataTransfer.files);
    if (files.length === 0) return;

    // Always wrap in single quotes for shell safety (handles spaces, quotes, and all metacharacters)
    const paths = files
      .map(f => f.path)
      .filter(Boolean)
      .map(p => `'${p.replace(/'/g, "'\\''")}'`);

    const text = paths.join(' ');
    focusPane(node.id);
    const t = terminals[node.id];
    if (t) {
      ipcRenderer.send('terminal:input', t.termId, text);
      markPaneInput(node.id);
    }

    // ドロップ完了フラッシュフィードバック
    el.classList.add('drop-flash');
    el.addEventListener('animationend', () => el.classList.remove('drop-flash'), { once: true });
  });

  return el;
}

// グリッドのトラックリサイズ開始。axis は 'col' | 'row'、index は境界のインデックス
// （index と index+1 のトラック間を動かす）。現在の fr 配列（無ければ均等）を基準に dragState を作る。
function startGridResize(e, grid, axis, index, cols, rows) {
  e.preventDefault();
  e.stopPropagation();
  const rect = grid.getBoundingClientRect();
  const size = axis === 'col' ? rect.width : rect.height;
  const cur = axis === 'col'
    ? ((tree.colFr && tree.colFr.length === cols) ? tree.colFr.slice() : Array(cols).fill(1))
    : ((tree.rowFr && tree.rowFr.length === rows) ? tree.rowFr.slice() : Array(rows).fill(1));
  dragState = {
    grid,
    axis,
    index,
    size,
    startPos: axis === 'col' ? e.clientX : e.clientY,
    fr: cur,
    total: cur.reduce((a, b) => a + b, 0),
  };
  document.body.classList.add(axis === 'col' ? 'resizing-h' : 'resizing-v');
}

// ドラッグ中に同一軸のハンドル位置（累積 %）を追従させる。
function repositionGridHandles(grid, fr, axis) {
  const total = fr.reduce((a, b) => a + b, 0);
  const sel = axis === 'col' ? '.grid-handle-col' : '.grid-handle-row';
  const handles = grid.querySelectorAll(sel);
  let acc = 0;
  handles.forEach((h, i) => {
    acc += fr[i];
    const pct = `${(acc / total) * 100}%`;
    if (axis === 'col') h.style.left = pct;
    else h.style.top = pct;
  });
}

// ─── Global file drag handler: drag-ready state for all panes ────────────────
// ファイルをドラッグ開始したとき、全ペインに drag-ready クラスを付与してドロップ可能を示す
let _fileDragCount = 0;

function resetFileDragState() {
  _fileDragCount = 0;
  document.body.classList.remove('file-dragging');
  document.querySelectorAll('.pane').forEach(el => {
    el.classList.remove('drag-ready');
    el.classList.remove('drag-over');
  });
}

document.addEventListener('dragenter', e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  _fileDragCount++;
  if (_fileDragCount === 1) {
    document.body.classList.add('file-dragging');
    document.querySelectorAll('.pane').forEach(el => el.classList.add('drag-ready'));
  }
});

document.addEventListener('dragleave', e => {
  if (!e.dataTransfer.types.includes('Files')) return;
  // relatedTarget が null のときウィンドウ外へ出た
  if (e.relatedTarget === null) {
    resetFileDragState();
  } else {
    _fileDragCount = Math.max(0, _fileDragCount - 1);
    if (_fileDragCount === 0) {
      resetFileDragState();
    }
  }
});

// ペイン外へのmiss-dropでBrowserWindowがファイルに遷移しないよう防止
document.addEventListener('dragover', e => {
  e.preventDefault();
  e.stopPropagation();
});

document.addEventListener('drop', e => {
  e.preventDefault();
  e.stopPropagation();
  resetFileDragState();
  // ペイン D&D が進行中のまま、ペイン外でドロップされた場合の保険（issue #40）。
  // ペイン側 drop ハンドラはバブリングを stopPropagation するため通常はここまで来ない。
  if (paneDragState) cleanupPaneDrag();
});

// ESC キャンセル / ウィンドウ外ドロップ / ブラウザによる中断時の保険（issue #40）。
// dragend は dragstart した element に届くが、render() で要素が差し替わるケース等を考慮して
// document レベルにも保険を仕掛けておく。
document.addEventListener('dragend', () => {
  if (paneDragState) cleanupPaneDrag();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!paneDragState) return;
  e.preventDefault();
  cleanupPaneDrag();
});

// ─── Global drag handler（グリッドのトラックリサイズ）─────────────────────────
document.addEventListener('mousemove', e => {
  if (!dragState) return;
  const { grid, axis, index, size, startPos, fr, total } = dragState;
  const currentPos = axis === 'col' ? e.clientX : e.clientY;
  const deltaFrac = ((currentPos - startPos) / size) * total;
  const pairSum = fr[index] + fr[index + 1];
  const minFr = total * 0.05;
  let a = fr[index] + deltaFrac;
  a = Math.max(minFr, Math.min(pairSum - minFr, a));
  const next = fr.slice();
  next[index] = a;
  next[index + 1] = pairSum - a;
  if (axis === 'col') {
    tree.colFr = next;
    grid.style.gridTemplateColumns = next.map(f => `${f}fr`).join(' ');
  } else {
    tree.rowFr = next;
    grid.style.gridTemplateRows = next.map(f => `${f}fr`).join(' ');
  }
  repositionGridHandles(grid, next, axis);
  debouncedFitAll();
});

document.addEventListener('mouseup', () => {
  if (!dragState) return;
  document.body.classList.remove('resizing-h', 'resizing-v');
  dragState = null;
  fitAll();
});

// ─── Global drag handler（サイドバー幅リサイズ, issue #89）─────────────────────
document.addEventListener('mousemove', e => {
  if (!sidebarResizeState) return;
  const dx = e.clientX - sidebarResizeState.startX;
  setSidebarWidth(sidebarResizeState.startWidth + dx);
  debouncedFitAll();
});

document.addEventListener('mouseup', () => {
  if (!sidebarResizeState) return;
  sidebarResizeState = null;
  document.body.classList.remove('resizing-sidebar');
  fitAll();
});

// ─── Resize observer ──────────────────────────────────────────────────────────
let _fitTimer = null;
function debouncedFitAll() {
  clearTimeout(_fitTimer);
  _fitTimer = setTimeout(fitAll, 30);
}

const resizeObserver = new ResizeObserver(debouncedFitAll);

// xterm の実際の描画領域は .term-container なので、.pane ではなく .term-container を監視する。
// .pane を監視すると、ペイン自体のサイズは変わらないのに内側の割り当てだけが変わるケース
// —— 例: エージェントルーム（<details>）の開閉で .agent-room-body が伸縮し、flex:1 の
// .term-container だけが縮む —— を拾えず、ターミナルが再フィットされない。その結果カーソル
// 行（Claude の入力欄）が可視領域外に押し出され、IME 合成中の textarea / composition-view も
// 旧サイズ基準の座標に取り残されて左上等の誤った位置に出てしまう。
// .term-container は .pane 内で flex:1 のため、ペインのリサイズでも必ず追従して変化する。
function observePanes() {
  resizeObserver.disconnect();
  document.querySelectorAll('.term-container').forEach(el => resizeObserver.observe(el));
}

window.addEventListener('resize', debouncedFitAll);
// ウィンドウ幅が縮んだときにサイドバー幅の上限（幅比）を超えないよう再クランプする（issue #89）。
window.addEventListener('resize', () => setSidebarWidth(getSidebarWidth()));

// ─── 設定パネル（汎用）────────────────────────────────────────────────────────
// main プロセス（settings:describe / settings:save）経由で、呼び出し側が env
// VK_TERMINALS_SETTINGS で指定した config ファイルをこの GUI から編集する。
// 歯車ボタンは設定モーダル（設定項目のみ）を開く。Claude の使用状況はサイドバー上部の
// 常時表示カードへ統合した。describe が使えない環境ではモーダル側で「設定項目なし」を表示する。
function setupSettingsPanel() {
  const btn = document.getElementById('settings-btn');
  if (!btn) return;
  btn.addEventListener('click', () => openSettingsModal());
}

// ─── 使用状況（issue #73）─────────────────────────────────────────────────────
// main の usage:get が返す統一構造:
//   - source: 'oauth'      … 公式 usage API。session / weekly = { percent, resetAtMs }
//   - source: 'transcript' … トランスクリプト集計（describeUsage の整形済み値）
// percent は百分率（17 = 17%）。トークン等の秘匿情報は main から一切渡らない。

const USAGE_POLL_INTERVAL_MS = 60000; // 使用量バッジ・サイドバーカード共通（main 側 60s TTL に相乗り）
const USAGE_SIDEBAR_TICK_INTERVAL_MS = 30000;
let lastUsageSnapshot = null;

// 公式% の閾値カラー（〜70% 青 / 70〜90% アンバー / 90%〜 赤）。
// フォールバックの自己ピーク比バーには適用しない（上限比ではないため）。
function usageLevelClass(percent) {
  if (!Number.isFinite(percent)) return '';
  if (percent >= 90) return 'level-crit';
  if (percent >= 70) return 'level-warn';
  return '';
}

/** 残り時間（ms）を「◯時間◯分後にリセット」形式にする。 */
function formatRemainingJa(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 'まもなくリセット';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}時間${m}分後にリセット`;
  if (m > 0) return `${m}分後にリセット`;
  return 'まもなくリセット';
}

/** リセット日時を「金 18:59 にリセット」形式（ローカル時刻）にする。 */
function formatResetDateTimeJa(ms) {
  const d = new Date(ms);
  const wd = ['日', '月', '火', '水', '木', '金', '土'][d.getDay()];
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${wd} ${hh}:${mm} にリセット`;
}

function setTextWithTitle(el, text) {
  el.textContent = text;
  el.title = text;
}

// 公式データ 1 区分（セッション / 週間）のセクションを組み立てる。
//   resetMode: 'remaining' … 「◯時間◯分後にリセット」。data-reset-at を付け、
//              サイドバーの低頻度ティッカーがポーリングを待たず再計算する。
//   resetMode: 'datetime'  … 「金 18:59 にリセット」（週間制限向け・静的表示）。
function buildOauthUsageSection(title, entry, resetMode, options = {}) {
  const sec = document.createElement('div');
  sec.className = 'usage-section';

  const head = document.createElement('div');
  head.className = 'usage-section-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'usage-section-title';
  titleEl.textContent = options.titleLabel || title;
  if (options.titleLabel && options.titleLabel !== title) {
    titleEl.title = title;
    titleEl.setAttribute('aria-label', title);
  }
  const valueEl = document.createElement('span');
  valueEl.className = 'usage-value';
  valueEl.textContent = Number.isFinite(entry.percent) ? `${Math.round(entry.percent)}% 使用済み` : '—';
  head.appendChild(titleEl);
  head.appendChild(valueEl);
  sec.appendChild(head);

  const track = document.createElement('div');
  track.className = 'usage-bar-track';
  const width = Number.isFinite(entry.percent) ? Math.min(100, Math.max(0, entry.percent)) : 0;
  // SR 向けにバーを progressbar として公開する（数値ラベル併記に加えた a11y 対応）。
  track.setAttribute('role', 'progressbar');
  track.setAttribute('aria-label', title);
  track.setAttribute('aria-valuemin', '0');
  track.setAttribute('aria-valuemax', '100');
  track.setAttribute('aria-valuenow', String(Math.round(width)));
  const fill = document.createElement('div');
  fill.className = `usage-bar-fill ${usageLevelClass(entry.percent)}`.trim();
  fill.style.width = `${width}%`;
  track.appendChild(fill);
  sec.appendChild(track);

  const reset = document.createElement('div');
  reset.className = 'usage-reset';
  if (Number.isFinite(entry.resetAtMs)) {
    if (resetMode === 'remaining') {
      reset.dataset.resetAt = String(entry.resetAtMs);
      setTextWithTitle(reset, formatRemainingJa(entry.resetAtMs - Date.now()));
    } else {
      setTextWithTitle(reset, formatResetDateTimeJa(entry.resetAtMs));
    }
  }
  sec.appendChild(reset);
  return sec;
}

// フォールバック（source: 'transcript'）のセクション。「現在の5時間ブロック」のみ表示し、
// 週間セクションは出さない（データが無いものを 0% バーで見せない）。
// ラベルは既存の「ピーク比」語彙（peakLabel）を維持し「使用済み」とは書かない
// （上限比ではなく自己ピーク比のため）。バーは単色青・閾値カラーなし。
function buildTranscriptUsageSection(u) {
  const sec = document.createElement('div');
  sec.className = 'usage-section';

  const head = document.createElement('div');
  head.className = 'usage-section-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'usage-section-title';
  titleEl.textContent = '現在の5時間ブロック';
  const valueEl = document.createElement('span');
  valueEl.className = 'usage-value';
  valueEl.textContent = u.percentText
    ? `${u.tokensText} トークン · ${u.peakLabel || 'ピーク比'}${u.percentText}`
    : `${u.tokensText} トークン`;
  head.appendChild(titleEl);
  head.appendChild(valueEl);
  sec.appendChild(head);

  // 自己ピーク比バー（utilization が無いときはバー行ごと出さない）
  if (typeof u.utilization === 'number' && Number.isFinite(u.utilization)) {
    const width = Math.min(100, Math.max(0, u.utilization * 100));
    const track = document.createElement('div');
    track.className = 'usage-bar-track';
    // SR 向け progressbar。ラベルは「使用済み」ではなく既存の「ピーク比」語彙を使う。
    track.setAttribute('role', 'progressbar');
    track.setAttribute('aria-label', u.peakLabel || 'ピーク比');
    track.setAttribute('aria-valuemin', '0');
    track.setAttribute('aria-valuemax', '100');
    track.setAttribute('aria-valuenow', String(Math.round(width)));
    const fill = document.createElement('div');
    fill.className = 'usage-bar-fill'; // 単色青（閾値カラーなし・誤解防止）
    fill.style.width = `${width}%`;
    track.appendChild(fill);
    sec.appendChild(track);
  }

  const reset = document.createElement('div');
  reset.className = 'usage-reset';
  setTextWithTitle(reset, `リセット ${u.resetText}（残り${u.remainingText}）`);
  sec.appendChild(reset);

  if (u.peakNote) {
    const note = document.createElement('div');
    note.className = 'usage-note';
    setTextWithTitle(note, u.peakNote);
    sec.appendChild(note);
  }
  return sec;
}

// 使用状況ビュー全体を描画する（読み取り専用）。
function renderUsageView(container, usage, options = {}) {
  container.innerHTML = '';
  if (!usage) {
    const p = document.createElement('p');
    p.className = 'usage-empty';
    p.textContent = '使用状況データを取得できません。Claude Code に未ログイン・オフラインの場合や、設定「トークン使用量を表示」が無効の場合はここには何も表示されません。';
    container.appendChild(p);
    return;
  }
  if (usage.source === 'oauth') {
    // スクリーンリーダーが「直近取得値（古い可能性あり）」の前置きを数値より先に
    // 読み上げられるよう、stale 注記はブロック先頭に置く（a11y 改善）。
    if (usage.stale === true) {
      const note = document.createElement('div');
      note.className = 'usage-note';
      setTextWithTitle(note, '直近に取得した値を表示しています（最新の取得に一時的に失敗しました）');
      container.appendChild(note);
    }
    if (usage.session) {
      container.appendChild(buildOauthUsageSection('現在のセッション', usage.session, 'remaining', {
        titleLabel: options.compact ? 'セッション' : '',
      }));
    }
    if (usage.weekly) {
      container.appendChild(buildOauthUsageSection('週間制限（すべてのモデル）', usage.weekly, 'datetime', {
        titleLabel: options.compact ? '週間' : '',
      }));
    }
    return;
  }
  // フォールバック（トランスクリプト集計）
  container.appendChild(buildTranscriptUsageSection(usage));
}

function renderSidebarUsage(usage) {
  lastUsageSnapshot = usage || null;
  const section = document.getElementById('sidebar-usage');
  if (!section) return;
  const body = section.querySelector('.sidebar-usage-body');
  if (!body) return;

  if (!usage) {
    section.hidden = true;
    body.replaceChildren();
    return;
  }

  renderUsageView(body, usage, { compact: true });
  section.hidden = false;
}

function tickSidebarUsageReset() {
  const section = document.getElementById('sidebar-usage');
  if (!section || section.hidden) return;
  section.querySelectorAll('[data-reset-at]').forEach((el) => {
    const at = Number(el.dataset.resetAt);
    if (Number.isFinite(at)) setTextWithTitle(el, formatRemainingJa(at - Date.now()));
  });
}

// ☰ メニューボタンの警告ドットバッジ（issue #73）。
// 公式の使用率（セッション・週間のいずれか）が 80% を超えたときだけドットを重ねる
// （80〜90%: アンバー / 90%〜: 赤）。フォールバック（自己ピーク比）は上限比ではないため
// バッジ対象にしない。ポーリングは 60 秒間隔で main 側 60s TTL キャッシュに相乗りする。
// 色のみの表現にしないよう、警告レベルに応じて title / aria-label も切り替える（a11y）。
const USAGE_ALERT_LABELS = {
  '':     '',
  'warn': 'Claude使用量: 警告（80%超）',
  'crit': 'Claude使用量: 危険（90%超）',
};

// 直近の使用率警告レベル（'' / 'warn' / 'crit'）。
let usageAlertLevel = '';

// 使用率の警告ドットを ☰ メニューボタン（常時表示）に反映する。
// サイドバー閉時でも警告に気付けるようにし、開いているときは使用量カードのバー色で示す。
function applyUsageBadge() {
  const level = usageAlertLevel;
  const menuBtn = document.getElementById('menu-btn');
  const targets = [];
  if (menuBtn) targets.push(menuBtn);
  for (const el of targets) {
    el.classList.toggle('usage-alert-warn', level === 'warn');
    el.classList.toggle('usage-alert-crit', level === 'crit');
  }
  if (menuBtn) {
    const extra = USAGE_ALERT_LABELS[level];
    const label = extra ? `メニュー（${extra}）` : 'メニュー';
    menuBtn.title = label;
    menuBtn.setAttribute('aria-label', label);
  }
}

function setupUsageBadge() {
  const refresh = async () => {
    let level = '';
    let usage = null;
    try {
      usage = await ipcRenderer.invoke('usage:get');
      if (usage && usage.source === 'oauth') {
        const pcts = [usage.session && usage.session.percent, usage.weekly && usage.weekly.percent]
          .filter((p) => Number.isFinite(p));
        const max = pcts.length ? Math.max(...pcts) : null;
        if (max !== null && max > 80) level = max >= 90 ? 'crit' : 'warn';
      }
    } catch (_e) {
      level = ''; // 取得失敗時はバッジを消す（古い警告を残さない）
    }
    renderSidebarUsage(usage);
    usageAlertLevel = level;
    applyUsageBadge();
  };
  refresh();
  setInterval(refresh, USAGE_POLL_INTERVAL_MS);
  setInterval(tickSidebarUsageReset, USAGE_SIDEBAR_TICK_INTERVAL_MS);
}

// 1 フィールド分の入力 HTML を組み立てる。
// id は描画順で採番したユニークな値を呼び出し側から受け取る（キーから id を導出すると
// "a.b" と "a_b" のような別キーがサニタイズ後に衝突しうるため、キー由来にしない）。
function renderSettingsField(f, value, id) {
  const label = escText(f.label || f.key);
  // help には id を振り、text/number 分岐で input の aria-describedby から参照する。
  const help = f.help ? `<span class="settings-help" id="${escAttr(id + '-help')}">${escText(f.help)}</span>` : '';

  if (f.type === 'boolean') {
    return `<div class="settings-row settings-row-check">
      <label class="settings-check">
        <input type="checkbox" id="${id}" ${value ? 'checked' : ''}>
        <span class="settings-label">${label}</span>
      </label>${help}
    </div>`;
  }

  const strVal = value === null || value === undefined
    ? ''
    : (f.type === 'json'
        ? escAttr(JSON.stringify(value, null, 2))
        : escAttr(String(value)));

  if (f.type === 'json') {
    // textarea の中身は要素内容なので escText 側でよいが、値は文字列前提なので escAttr で統一。
    const body = value === null || value === undefined ? '' : escText(JSON.stringify(value, null, 2));
    return `<div class="settings-row">
      <label class="settings-label" for="${id}">${label}</label>${help}
      <textarea id="${id}" rows="4" spellcheck="false">${body}</textarea>
    </div>`;
  }

  if (f.type === 'lines') {
    const body = Array.isArray(value) ? escText(value.join('\n')) : '';
    return `<div class="settings-row">
      <label class="settings-label" for="${id}">${label}</label>${help}
      <textarea id="${id}" rows="4" spellcheck="false">${body}</textarea>
    </div>`;
  }

  if (f.type === 'password') {
    return `<div class="settings-row">
      <label class="settings-label" for="${id}">${label}</label>${help}
      <div class="settings-pwd">
        <input type="password" id="${id}" value="${strVal}" autocomplete="off" spellcheck="false">
        <button type="button" class="settings-reveal" data-target="${id}" title="表示切替">👁</button>
      </div>
    </div>`;
  }

  if (f.type === 'select') {
    // 許可された値だけを選べる制約付きピッカー。f.options は {value,label} の配列。
    const cur = value === null || value === undefined ? '' : String(value);
    const opts = (Array.isArray(f.options) ? f.options : [])
      .map((o) => {
        const ov = escAttr(String(o.value ?? ''));
        const ol = escText(String(o.label ?? o.value ?? ''));
        const sel = String(o.value ?? '') === cur ? ' selected' : '';
        return `<option value="${ov}"${sel}>${ol}</option>`;
      })
      .join('');
    return `<div class="settings-row">
      <label class="settings-label" for="${id}">${label}</label>${help}
      <select id="${id}">${opts}</select>
    </div>`;
  }

  const inputType = f.type === 'number' ? 'number' : 'text';
  const ph = f.placeholder ? ` placeholder="${escAttr(f.placeholder)}"` : '';
  // pattern 検証のエラー行と aria 関連付け。help があれば help id と error id を
  // スペース区切りで両方指す（無ければ error id のみ）。
  const errorId = escAttr(id + '-error');
  const describedBy = escAttr(f.help ? `${id}-help ${id}-error` : `${id}-error`);
  return `<div class="settings-row">
    <label class="settings-label" for="${id}">${label}</label>${help}
    <input type="${inputType}" id="${id}" value="${strVal}"${ph} spellcheck="false" aria-describedby="${describedBy}">
    <span class="settings-error" id="${errorId}" role="alert"></span>
  </div>`;
}

// 設定モーダルの二重オープンを防ぐロック。settings:describe の await 中は overlay がまだ
// DOM に無いため、.settings-overlay の有無チェックだけでは二重生成されうる。await より前に
// 同期で立てるこのフラグで「チェック〜生成」を原子的に守り、モーダルを閉じた／生成に
// 失敗した時に必ず戻す。
let modalOpen = false;

async function openSettingsModal() {
  // 二重オープン防止（describe の await より前に立てる）
  if (modalOpen) return;
  modalOpen = true;

  // 設定ディスクリプタが無い環境でも空の設定モーダルとして開く（使用量はサイドバー上部）。
  let desc = null;
  try {
    desc = await ipcRenderer.invoke('settings:describe');
  } catch (_e) {
    desc = null;
  }
  const settingsAvailable = !!(desc && desc.available);

  // 描画順に採番したユニーク id と field を対応付ける（保存時もこの対応で走査する）。
  const entries = [];
  const settingsTabs = settingsAvailable ? normalizeSettingsTabs(desc) : [];
  const useTabbedSettings = settingsTabs.length > 0;
  const settingsSaveHintId = 'settings-save-hint';
  const renderGroupHtml = (g, options = {}) => {
    const rows = (g.fields || []).map(f => {
      const id = 'set-field-' + entries.length;
      entries.push({ field: f, id, tabIndex: options.tabIndex });
      return renderSettingsField(f, desc.values[f.key], id);
    }).join('');
    const groupTargets = Array.isArray(g.targetPaths) ? g.targetPaths : [];
    const groupTargetHtml = !useTabbedSettings && desc.hasMultipleTargets && groupTargets.length
      ? `<div class="settings-group-target">保存先: ${groupTargets.map((targetPath) => `<code>${escText(targetPath)}</code>`).join(' / ')}</div>`
      : '';
    const legendHtml = options.omitLegend ? '' : `<legend>${escText(g.label || '')}</legend>`;
    return `<fieldset class="settings-group">
      ${legendHtml}${groupTargetHtml}${rows}</fieldset>`;
  };

  const groupedTabs = useTabbedSettings ? groupSettingsGroupsByTab(desc.groups, settingsTabs) : [];
  const settingsTabsHtml = useTabbedSettings ? `<div class="settings-tabs" role="tablist" aria-label="設定カテゴリ">
    ${settingsTabs.map((tab, index) => {
      const tabId = `settings-tab-${index}`;
      const panelId = `settings-panel-${index}`;
      return `<button type="button" class="settings-tab${index === 0 ? ' is-active' : ''}" id="${escAttr(tabId)}" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" aria-controls="${escAttr(panelId)}" tabindex="${index === 0 ? '0' : '-1'}" data-tab-index="${index}">
        <span>${escText(tab.label)}</span>
        <span class="settings-tab-dirty" aria-hidden="true"></span>
      </button>`;
    }).join('')}
  </div>` : '';
  const groupsHtml = settingsAvailable
    ? (useTabbedSettings
        ? groupedTabs.map(({ groups }, tabIndex) => {
          const tabId = `settings-tab-${tabIndex}`;
          const panelId = `settings-panel-${tabIndex}`;
          const targetPaths = deriveSettingsTargetPathsForGroups(groups);
          const targetHtml = targetPaths.length
            ? `<div class="settings-group-target settings-tab-target">保存先: ${targetPaths.map((targetPath) => `<code>${escText(targetPath)}</code>`).join(' / ')}</div>`
            : '';
          const noteHtml = desc.note ? `<p class="settings-note settings-tab-note">${escText(desc.note)}</p>` : '';
          const tabGroupsHtml = groups.map((group) => renderGroupHtml(group, {
            tabIndex,
            omitLegend: groups.length === 1,
          })).join('');
          return `<section class="settings-tab-panel" id="${escAttr(panelId)}" role="tabpanel" aria-labelledby="${escAttr(tabId)}" tabindex="0"${tabIndex === 0 ? '' : ' hidden'}>
            ${targetHtml}${noteHtml}${tabGroupsHtml}
          </section>`;
        }).join('')
        : desc.groups.map(g => renderGroupHtml(g)).join(''))
    : '';

  const appVersion = (desc && desc.appVersion) ? desc.appVersion : '';
  const targetPathLabel = settingsAvailable
    ? (desc.targetPath || (Array.isArray(desc.targetPaths) ? desc.targetPaths[0] : '') || '')
    : '';
  const settingsTargetHtml = settingsAvailable
    ? (useTabbedSettings
      ? ''
      : desc.hasMultipleTargets
      ? '<p class="settings-target">保存先: 項目またはグループごとに異なります（各項目・グループの下に表示）</p>'
      : `<p class="settings-target">保存先: <code>${escText(targetPathLabel)}</code></p>`)
    : '';
  const settingsHeaderHtml = useTabbedSettings
    ? `<div class="settings-header has-tabs">
        <div class="settings-titlebar">
          <h2>${escText((settingsAvailable && desc.title) || 'VK Terminals')}${appVersion ? `<span class="settings-version">VK Terminals v${escText(appVersion)}</span>` : ''}</h2>
          <button class="settings-close" title="閉じる">✕</button>
        </div>
        ${settingsTabsHtml}
      </div>`
    : `<div class="settings-header">
        <h2>${escText((settingsAvailable && desc.title) || 'VK Terminals')}${appVersion ? `<span class="settings-version">VK Terminals v${escText(appVersion)}</span>` : ''}</h2>
        <button class="settings-close" title="閉じる">✕</button>
      </div>`;
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-modal" role="dialog" aria-modal="true">
      ${settingsHeaderHtml}
      <div class="settings-view settings-view-config" role="region">
        ${settingsAvailable && desc.note && !useTabbedSettings ? `<p class="settings-note">${escText(desc.note)}</p>` : ''}
        ${settingsTargetHtml}
        ${settingsAvailable
          ? `<form class="settings-form" onsubmit="return false">${groupsHtml}</form>`
          : '<p class="settings-empty">この環境では編集できる設定項目がありません。</p>'}
      </div>
      ${settingsAvailable ? `<div class="settings-footer${useTabbedSettings ? ' has-tabs' : ''}">
        <span class="settings-msg" role="status"></span>
        ${useTabbedSettings ? `<span class="settings-save-hint" id="${settingsSaveHintId}">すべてのタブの変更をまとめて保存</span>` : ''}
        <button type="button" class="settings-cancel">キャンセル</button>
        <button type="button" class="settings-save"${useTabbedSettings ? ` aria-describedby="${settingsSaveHintId}"` : ''}>保存</button>
      </div>` : ''}
    </div>`;
  document.body.appendChild(overlay);

  const modal = overlay.querySelector('.settings-modal');

  const close = () => {
    document.removeEventListener('keydown', onKey);
    overlay.remove();
    modalOpen = false;
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  modal.querySelector('.settings-close').addEventListener('click', close);

  // 設定項目が無い環境ではフォーム関連の配線は不要（閉じるだけ）。
  if (!settingsAvailable) return;

  const msg = modal.querySelector('.settings-msg');
  modal.querySelector('.settings-cancel').addEventListener('click', close);

  let switchToFieldTab = () => {};
  let clearDirtyTabs = () => {};
  if (useTabbedSettings) {
    const tablist = modal.querySelector('.settings-tabs');
    const tabButtons = Array.from(modal.querySelectorAll('.settings-tab'));
    const tabPanels = Array.from(modal.querySelectorAll('.settings-tab-panel'));
    const activateTab = (nextIndex, options = {}) => {
      if (nextIndex < 0 || nextIndex >= tabButtons.length) return;
      tabButtons.forEach((button, index) => {
        const active = index === nextIndex;
        button.classList.toggle('is-active', active);
        button.setAttribute('aria-selected', active ? 'true' : 'false');
        button.setAttribute('tabindex', active ? '0' : '-1');
      });
      tabPanels.forEach((panel, index) => {
        panel.hidden = index !== nextIndex;
      });
      if (options.focus) tabButtons[nextIndex].focus();
    };
    const moveTabFocus = (delta) => {
      const currentIndex = tabButtons.findIndex((button) => button.getAttribute('aria-selected') === 'true');
      const baseIndex = currentIndex >= 0 ? currentIndex : 0;
      activateTab((baseIndex + delta + tabButtons.length) % tabButtons.length, { focus: true });
    };
    tablist.addEventListener('click', (e) => {
      const button = e.target.closest('.settings-tab');
      if (!button || !tablist.contains(button)) return;
      activateTab(Number(button.dataset.tabIndex));
    });
    tablist.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        moveTabFocus(-1);
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        moveTabFocus(1);
      } else if (e.key === 'Home') {
        e.preventDefault();
        activateTab(0, { focus: true });
      } else if (e.key === 'End') {
        e.preventDefault();
        activateTab(tabButtons.length - 1, { focus: true });
      }
    });
    for (const { id, tabIndex } of entries) {
      if (!Number.isInteger(tabIndex)) continue;
      const input = modal.querySelector('#' + id);
      if (!input) continue;
      const markDirty = () => {
        const button = tabButtons[tabIndex];
        const tabLabel = settingsTabs[tabIndex] ? settingsTabs[tabIndex].label : '';
        if (!button) return;
        button.classList.add('is-dirty');
        button.setAttribute('aria-label', `${tabLabel}（未保存の変更あり）`);
      };
      input.addEventListener('input', markDirty);
      input.addEventListener('change', markDirty);
    }
    clearDirtyTabs = () => {
      tabButtons.forEach((button) => {
        button.classList.remove('is-dirty');
        button.removeAttribute('aria-label');
      });
    };
    switchToFieldTab = (fieldEl) => {
      const entry = entries.find(({ id }) => fieldEl && fieldEl.id === id);
      if (!entry || !Number.isInteger(entry.tabIndex)) return;
      activateTab(entry.tabIndex);
    };
  }

  // password の表示/非表示トグル
  modal.querySelectorAll('.settings-reveal').forEach(rev => {
    rev.addEventListener('click', () => {
      const input = modal.querySelector('#' + rev.dataset.target);
      if (!input) return;
      const show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      rev.textContent = show ? '🙈' : '👁';
    });
  });

  // ─── pattern 検証（issue #140） ──────────────────────────────────────────────
  // 検証対象は field.pattern（正規表現文字列）を持つフィールドのみ。type ではなく
  // pattern の有無で判定することで、text/number など type を問わず汎用的に扱う。
  const validatable = entries.filter(
    ({ field }) => typeof field.pattern === 'string' && field.pattern !== ''
  );

  // 1 フィールドの検証結果を DOM に反映する。valid かどうかを返す。
  // - valid: aria-invalid を外し、エラー文をクリア（赤枠も CSS 側で解除される）。
  // - invalid: aria-invalid="true" を付与し、invalidMessage（無ければ汎用文）を表示。
  //   invalidMessage は textContent で流し込むため HTML として解釈されない（XSS 安全）。
  const applyFieldValidity = (field, id) => {
    const input = modal.querySelector('#' + id);
    const errEl = modal.querySelector('#' + id + '-error');
    if (!input) return true;
    const valid = isPatternValid(field.pattern, input.value);
    if (valid) {
      input.removeAttribute('aria-invalid');
      if (errEl) errEl.textContent = '';
    } else {
      input.setAttribute('aria-invalid', 'true');
      if (errEl) errEl.textContent = field.invalidMessage || '入力形式が正しくありません';
    }
    return valid;
  };

  // エラー表示を一旦消す（保存時の再判定前リセットに使う）。
  const clearFieldValidity = (field, id) => {
    const input = modal.querySelector('#' + id);
    const errEl = modal.querySelector('#' + id + '-error');
    if (input) input.removeAttribute('aria-invalid');
    if (errEl) errEl.textContent = '';
  };

  // "優しく遅らせ、素早く許す": 打鍵中は警告せず blur で初回検証。エラーが付いた後だけ
  // input イベントで再検証し、valid になれば即解除する。
  for (const { field, id } of validatable) {
    const input = modal.querySelector('#' + id);
    if (!input) continue;
    input.addEventListener('blur', () => { applyFieldValidity(field, id); });
    input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') applyFieldValidity(field, id);
    });
  }

  modal.querySelector('.settings-save').addEventListener('click', async () => {
    // 保存前の検証ゲート: 全エラー表示を一旦クリアしてから対象を一括再判定する。
    for (const { field, id } of validatable) clearFieldValidity(field, id);
    let firstInvalid = null;
    for (const { field, id } of validatable) {
      const valid = applyFieldValidity(field, id);
      if (!valid && !firstInvalid) firstInvalid = modal.querySelector('#' + id);
    }
    // 1 つでも不一致なら settings:save を呼ばず中断し、最初の不正欄へフォーカスする。
    if (firstInvalid) {
      msg.textContent = '入力内容に問題があります';
      msg.className = 'settings-msg err';
      switchToFieldTab(firstInvalid);
      firstInvalid.focus();
      if (typeof firstInvalid.scrollIntoView === 'function') {
        firstInvalid.scrollIntoView({ block: 'nearest' });
      }
      return;
    }

    const out = {};
    for (const { field, id } of entries) {
      const input = modal.querySelector('#' + id);
      if (!input) continue;
      out[field.key] = field.type === 'boolean' ? input.checked : input.value;
    }
    msg.textContent = '保存中...';
    msg.className = 'settings-msg';
    try {
      const res = await ipcRenderer.invoke('settings:save', out);
      if (res && res.ok) {
        clearDirtyTabs();
        msg.textContent = '保存しました';
        msg.classList.add('ok');
        setTimeout(close, 800);
      } else {
        msg.textContent = 'エラー: ' + (res && res.error ? res.error : '不明なエラー');
        msg.classList.add('err');
      }
    } catch (e) {
      msg.textContent = 'エラー: ' + e.message;
      msg.classList.add('err');
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────
async function initApp() {
  // エージェントルーム（issue #58）の有効/無効を main から取得（最初の render より前に確定させる）。
  try {
    const cfg = await ipcRenderer.invoke('app:get-config');
    agentRoomEnabled = !!(cfg && cfg.agentroom);
    newPaneStartupDir = (cfg && typeof cfg.newPaneStartupDir === 'string') ? cfg.newPaneStartupDir : '';
    newPaneAutoLaunchClaude = !!(cfg && cfg.newPaneAutoLaunchClaude);
    // main 側でも正規化済みだが、取得失敗・欠落に備えてここでも既定 'busy' に落とす。
    confirmClosePref = normalizeConfirmClose(cfg && cfg.confirmClose);
    waitingExcludeCwdPatterns = normalizeWaitingExcludeCwdPatterns(cfg && cfg.waitingExcludeCwdPatterns);
    tasksFileConfigured = !!(cfg && typeof cfg.tasksFile === 'string' && cfg.tasksFile.trim());
    commandsConfigured = !!(cfg && typeof cfg.commandsFile === 'string' && cfg.commandsFile.trim());
    renderTaskList(lastTaskView);
    // ヘッダー／タブのアプリ名。呼び出し側（例: vk-orchestrator）が env で上書きすると
    // main が app:get-config で伝えてくる。未指定時は index.html の既定 'VK Terminals'。
    if (cfg && typeof cfg.appTitle === 'string' && cfg.appTitle.trim()) {
      const titleEl = document.querySelector('.app-title');
      if (titleEl) titleEl.textContent = cfg.appTitle.trim();
      document.title = cfg.appTitle.trim();
    }
  } catch (_e) { /* 取得失敗時は無効のまま */ }

  // Dispose any existing terminals
  for (const [paneId, t] of Object.entries(terminals)) {
    try { t.term.dispose(); } catch (e) {}
    ipcRenderer.send('terminal:kill', t.termId);
  }
  terminals = {};
  focusedPaneId = null;

  const paneId = newId();
  // stashOrder: サイドバー格納ペインの並び（issue #89）。sidebarWidth: セッション内の可変幅。
  tree = { type: 'grid', order: [paneId], colFr: null, rowFr: null, stashOrder: [], sidebarWidth: DEFAULT_SIDEBAR_WIDTH };
  // 起動時の初回ペインも手動の新規ペイン（＋ボタン・分割）と同じく newPaneStartupDir に従う。
  // 存在しないパスは main 側 terminal:create が HOME へフォールバックする。
  await createTerminal(paneId, newPaneStartupDir || null);
  focusedPaneId = paneId;

  render();
  requestAnimationFrame(() => {
    fitTerminal(paneId);
    terminals[paneId]?.term.focus();
  });
}

// サイドバーは root の flex 子として常駐させるため、初回 render 前に配線する。
setupSidebarMenu();

initApp().then(() => {
  // 起動完了を main プロセスに通知（main 側で additionalPanes を順次作成する）
  ipcRenderer.send('terminal:renderer-ready');
});

// 設定モーダルの歯車ボタンを配線する（設定のみ。使用量はサイドバー上部へ常時表示）。
setupSettingsPanel();

// 使用率警告ドットバッジ（☰ メニューボタン）とサイドバー使用量カードを配線する。
setupUsageBadge();
setInterval(tickTaskElapsed, TASKS_ELAPSED_TICK_MS);

// ─── State reporting to main process ─────────────────────────────────────────
setInterval(() => {
  const states = {};
  for (const [paneId, t] of Object.entries(terminals)) {
    if (!t) continue;
    // エージェントルーム（issue #58）: API 失効後の取り残しを防ぐため、ここで TTL を含めて
    // 定期再評価する（updatePaneStatus / API 受信以外の契機を補う）。変化時のみ再描画。
    if (agentRoomEnabled) refreshAgentRoomIfChanged(paneId);
    states[paneId] = {
      termId: t.termId,
      cwd: t.cwdFull || '',
      cwdShort: t.cwd || '~',
      // waiting は内部判定フラグ。後方互換のため引き続き出力（task-queue 連携などが参照）。
      waiting: t.waiting,
      // externalWaiting は POST /api/set-status 由来の外部権威フラグ。
      externalWaiting: t.externalWaiting || false,
      // status は issue #23 で追加した表示用ステータス（'idle' | 'running' | 'waiting'）。
      // 既存フィールドは破壊せず、新規追加のみ。
      status: t.status || 'idle',
      lastOutputTime: t.lastOutputTime,
      lastInputTime: t.lastInputTime,
      lastLines: t.lastLines,
      // taskTitle: OSC 0/2 由来のタイトル（後方互換のため既存キーを維持）
      // apiTitle:  POST /api/set-title 由来のタイトル（issue #22 で分離）
      // apiUrl:    POST /api/set-title 由来の URL（issue #29）。apiTitle 表示時のみリンク化される
      // apiPrUrl:  POST /api/set-title 由来の PR URL（issue #44）。タイトル右の独立ボタン用
      // displayTitle: 実際にペイン上部に表示している値（apiTitle || taskTitle）
      taskTitle: t.taskTitle || '',
      apiTitle: t.apiTitle || '',
      apiUrl: t.apiUrl || '',
      apiPrUrl: t.apiPrUrl || '',
      apiPrMerged: !!t.apiPrMerged,
      displayTitle: getDisplayTitle(t),
      // collapsed: グリッド化で折り畳み機能を撤去したため常に false（後方互換のためキーは維持）。
      collapsed: false,
      // stashed: サイドバーへ格納中かどうか（issue #89）。外部監視ツール向けの新規フィールド。
      stashed: !!(tree && Array.isArray(tree.stashOrder) && tree.stashOrder.includes(paneId)),
      // lock: HTTP API POST /api/set-lock 由来の操作ロック状態。未設定は null（全許可）。
      lock: (t.lock && typeof t.lock.close === 'boolean') ? { close: t.lock.close } : null,
      // agentRoom（issue #58）: 解決済みのルーム状態 { name: state }。
      // agentroom 有効時のみ出力（モバイルページ等の将来連携用）。
      ...(agentRoomEnabled ? { agentRoom: resolveRoomAgents(t) } : {}),
    };
  }
  ipcRenderer.send('terminal:report-states', states);
}, 2000);

// ─── Agent room update from main (HTTP API POST /api/agentroom) ──────────────
// replace=true: そのペインのルーム状態を agents で丸ごと置換。
// replace=false: agents の分だけ既存状態にマージ（1 人更新）。
// いずれも agentRoomUpdatedAt を更新して「新鮮」扱いにする。
ipcRenderer.on('terminal:agentroom', (event, termId, agents, replace) => {
  const paneId = Object.keys(terminals).find(k => terminals[k]?.termId === termId);
  if (!paneId) return;
  const t = terminals[paneId];
  if (!t || !agents || typeof agents !== 'object') return;
  if (replace) {
    t.agentRoom = { ...agents };
  } else {
    t.agentRoom = { ...(t.agentRoom || {}), ...agents };
  }
  t.agentRoomUpdatedAt = Date.now();
  updateAgentRoom(paneId);
});

// ─── New pane request from HTTP API ──────────────────────────────────────────
ipcRenderer.on('terminal:request-new-pane', async (event, payload = {}) => {
  const { requestId, cwd, noClaude, stashed } = payload;
  const reply = (result) => ipcRenderer.send('terminal:new-pane-created', { requestId, ...result });
  const targetPaneId = findLargestVisiblePaneId() || focusedPaneId || (tree ? getAllLeafIds(tree)[0] : null);
  if (!targetPaneId) {
    reply({ error: 'no pane available' });
    return;
  }
  try {
    // 表示面積が最大のペインを長辺方向に分割し、全体の空きが大きい場所へ追加する
    const rect = getPaneRect(targetPaneId);
    const direction = (rect && rect.height > rect.width) ? 'v' : 'h';
    const splitOptions = typeof noClaude === 'boolean' ? { noClaude } : {};
    const result = await splitPane(targetPaneId, direction, cwd, splitOptions);
    if (!result || !result.termId) {
      reply({ error: 'split failed or termId unavailable' });
      return;
    }
    if (stashed === true) {
      stashPane(result.paneId);
    }
    reply({ termId: result.termId });
  } catch (e) {
    reply({ error: e?.message || 'failed to create pane' });
  }
});

ipcRenderer.on('terminal:request-close-pane', (event, payload = {}) => {
  const { requestId, termId } = payload;
  const reply = (result) => ipcRenderer.send('terminal:close-pane-done', { requestId, ...result });
  // termId → paneId 逆引き（既存の terminal:title / set-status ハンドラと同じパターン）
  const paneId = Object.keys(terminals).find(k => String(terminals[k]?.termId) === String(termId));
  if (!paneId) {
    reply({ error: 'terminal not found' });
    return;
  }
  try {
    closePane(paneId, { force: true });
    reply({ ok: true, termId: termId });
  } catch (e) {
    reply({ error: e?.message || 'failed to close pane' });
  }
});

// ─── Title update from main (HTTP API POST /api/set-title) ──────────────────
// API 由来のタイトルは apiTitle に保存し、OSC 由来の taskTitle とは別フィールドで管理する。
// これにより claude TUI が継続的に発行する OSC 0/2 で API 設定タイトルが上書きされない。
// 空文字を送ると apiTitle がクリアされ、OSC 由来の taskTitle にフォールバックする。
// 第3引数 url（issue #29）: タイトル全体をリンク化するための URL。
//   - undefined → 後方互換のため URL 変更なしと解釈（ただし main 側は常に第3引数を送る）
//   - 空文字  → apiUrl をクリア
//   - 文字列 → http(s): スキームのみ（main 側で検証済み）。apiUrl にセット
// 第4引数 prUrl（issue #44）: タイトル右側の独立した [ PR ↗ ] ボタン用 URL。
//   - undefined → 後方互換のため prUrl 変更なしと解釈（ただし main 側は常に第4引数を送る）
//   - 空文字  → apiPrUrl をクリア（PR ボタン非表示）
//   - 文字列 → http(s): スキームのみ（main 側で検証済み）。apiPrUrl にセット
// 第5引数 prMerged: PR ボタンのマージ済み表示フラグ。boolean のときのみ apiPrMerged に反映する。
// title / url / prUrl / prMerged はペアで都度送る置換セマンティクス。
ipcRenderer.on('terminal:title', (event, termId, title, url, prUrl, prMerged) => {
  const paneId = Object.keys(terminals).find(k => terminals[k]?.termId === termId);
  if (!paneId) return;
  terminals[paneId].apiTitle = title || '';
  // url が string で渡ってきた場合のみ書き換える（旧来の 2 引数呼び出しとの後方互換のため）
  if (typeof url === 'string') {
    terminals[paneId].apiUrl = url;
  }
  // prUrl も同様。後方互換のため string 以外は無視する。
  if (typeof prUrl === 'string') {
    terminals[paneId].apiPrUrl = prUrl;
  }
  // prMerged も同様。後方互換のため boolean 以外は無視する。
  if (typeof prMerged === 'boolean') {
    terminals[paneId].apiPrMerged = prMerged;
  }
  updatePaneTitle(paneId);
});

// ─── Status update from main (HTTP API POST /api/set-status) ────────────────
// 外部権威の入力待ちフラグを明示的に設定する。markPaneInput / 自動入力では解除しない。
ipcRenderer.on('terminal:set-status', (event, termId, waiting) => {
  const paneId = Object.keys(terminals).find(k => terminals[k]?.termId === termId);
  if (!paneId) return;
  const t = terminals[paneId];
  if (!t) return;
  t.externalWaiting = !!waiting;
  recomputeStatus(paneId);
});

// ─── Lock update from main (HTTP API POST /api/set-lock) ────────────────────
// lock.close === false のときだけ閉じる操作を保護する。未設定/null は全許可。
ipcRenderer.on('terminal:set-lock', (event, termId, lock) => {
  const paneId = Object.keys(terminals).find(k => String(terminals[k]?.termId) === String(termId));
  if (!paneId) return;
  const t = terminals[paneId];
  if (!t) return;
  t.lock = (lock && typeof lock.close === 'boolean') ? { close: lock.close } : null;
  updatePaneCloseLock(paneId);
});

// ─── Auto-input notification from main (HTTP API経由の入力時) ─────────────────
ipcRenderer.on('terminal:auto-input', (event, termId) => {
  const paneId = Object.keys(terminals).find(k => terminals[k]?.termId === termId);
  if (!paneId) return;
  markPaneInput(paneId);
  const paneEl = document.querySelector(`.pane[data-id="${paneId}"]`);
  if (!paneEl) return;
  const badge = paneEl.querySelector('.auto-input-badge');
  if (badge) {
    badge.textContent = '🤖 自動入力';
    // インラインスタイルではなく hidden 属性でトグルし、共通バッジ basis
    // (.pane-badge の display: inline-flex) を活かす（issue #35）
    badge.hidden = false;
    paneEl.classList.add('auto-input');
    // 先発の自動非表示タイマーが残っていればクリアしてから新規予約する
    // （短時間に複数回イベントが来た際に後発のバッジが 3 秒より早く消える問題対策／issue #38）
    const existing = paneEl.dataset.autoInputTimer;
    if (existing) clearTimeout(Number(existing));
    paneEl.dataset.autoInputTimer = String(setTimeout(() => {
      const el = document.querySelector(`.pane[data-id="${paneId}"]`);
      if (!el) return;
      const b = el.querySelector('.auto-input-badge');
      if (b) b.hidden = true;
      el.classList.remove('auto-input');
      delete el.dataset.autoInputTimer;
    }, 3000));
  }
});
