/* global require */
const { ipcRenderer, shell } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { stripAnsiForDisplay } = require('../utils/stripAnsi');
// エージェントルーム（issue #58）。サブエージェントの稼働状況をドット絵キャラで可視化する。
const { AGENT_ORDER, buildScene, resolveAgentStatesFromOutput } = require('./agentRoom');

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
//   - waiting (bool): 内部判定用フラグ。WAITING_PATTERNS ヒットで true。
//     states.json 後方互換のために残してある（task-queue 等の外部連携が参照している）。
//   - status ('idle'|'running'|'waiting'): 表示用の派生値。
//     waiting が true なら 'waiting' を最優先。
//     waiting でなく直近 1500ms 以内に PTY 出力があり、かつ直近 200ms 以内に入力がなければ 'running'。
//     どちらでもなければ 'idle'（DOM 側で要素ごと非表示）。
//   - runningTimer (number|null): 'running' を 1500ms 後に 'idle' へ戻すための setTimeout id。
//     bumpRunning() が出力イベントごとに張り直し、closePane() で必ず clearTimeout する。
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
// HTTP API（POST /api/agentroom）由来のルーム状態を、この TTL を超えたら「古い」と判断して
// PTY 出力ベースのフォールバック表示に切り替える（ms）。
const AGENTROOM_API_TTL_MS = 90000;

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

// ─── Waiting detection ────────────────────────────────────────────────────────
const WAITING_PATTERNS = [
  /\[y\/N\]/i, /\[Y\/n\]/i, /\(y\/n\)/i,
  /Press Enter/i,
  /Continue\?/i,
  /Do you want to/i,
  /Would you like/i,
  /Proceed\?/i,
  /\? .{1,60}[›>❯]\s*$/m,  // inquirer / Claude Code prompts
  // Claude Code 承認待ちパターン
  /Yes,?\s+allow/i,
  /No,?\s+don['']t allow/i,
  /Allow\s+(once|always|this)/i,
  /\bAllow\b.{0,40}\?/i,
  /Deny\b/i,
  /Yes\s*\/\s*No/i,
  /❯\s*(Yes|No|Allow|Deny)/,
  /›\s*(Yes|No|Allow|Deny)/,
  /\[\s*A\s*\]llow/i,
  /\[\s*D\s*\]eny/i,
  /approve.*\(y\/n\)/i,
  // NOTE: /permission/i は削除 — Claude Code の UI フッター "bypass permissions on" に誤反応するため
  // 日本語の確認待ちパターン（vk-kore など、Claude が確認を求めて中断する場面で出る文言）
  /ご確認(?:を|ください|お願い)/,
  /続行しますか/,
  /進めて(?:よろしい|よい)/,
  /(?:よろしい|いかが)(?:でしょうか|ですか)[。？?]?\s*$/m,
  // マージ待ちパターン（vk-kore の PR 作成後・マージ判断委譲のタイミング）
  /マージ(?:判断|してください|してもよろしい)/,
  /マージ.{0,30}(?:ご判断|お願い|よろしい|お任せ)/,
  // recap / 追加の確認待ち文言（issue #32）。
  // Claude Code が "※ recap: …承認待ちです。…(disable recaps in /config)" のような
  // 振り返りメッセージを最後に挟むケースで、本文末尾が "承認待ち" や "委任します"
  // のような形になる。これらの「次アクションをユーザーに委ねている」言い回しを拾う。
  /(?:承認|回答|ご判断|ご返答|お返事|ご指示|ご連絡)(?:を)?(?:お)?待ち/,
  /(?:いただけ|いただい)たら.{0,30}(?:委任|お願い|進め|実装)/,
  /(?:お任せ|ご判断)(?:します|ください|いただけ)/,
  /(?:お待ち|待って)(?:しています|います|ます)/,
  // AskUserQuestion / 数字選択肢の UI 検知（issue #46）。
  // Claude Code の AskUserQuestion は「❯ 1. … / 2. …」の選択肢と
  // 「Enter to select / ↑/↓ to navigate / Esc to cancel」のフッターが固定で出る。
  // 既存パターンは ASCII `?` と `❯ Yes|No|Allow|Deny` しか拾えず取りこぼしていた。
  /Enter\s+to\s+select/i,
  /[↑↓]\/[↑↓]\s+to\s+navigate/,
  /Esc\s+to\s+cancel/i,
  /❯\s*\d+\.\s/,  // `❯ 1. ラベル` 形式（任意ラベルの数字選択肢）
  // 全角「？」で終わる質問文。AskUserQuestion 以外の TUI / 日本語プロンプト
  // でも全角？で末尾するケースを拾うための補助パターン。
  // Claude Code の AskUserQuestion 自体は上の `Enter to select` フッターで
  // 確定検知できるため、ここは網羅性ではなく **誤検知抑制** を優先して
  // `m` フラグ無しでバッファ全体の末尾にのみアンカーする。
  // `m` を付けると `lastLines` バッファ（最大 80 行）に残る過去の質問行に
  // 反応して running 中も waiting に張り付くため、その挙動を避ける。
  /[？]\s*$/,
];

function checkWaiting(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  const clean = stripAnsiForDisplay(t.lastLines);
  const waiting = WAITING_PATTERNS.some(p => p.test(clean));
  if (waiting !== t.waiting) {
    t.waiting = waiting;
    // waiting フラグが変わったら status も再計算（waiting 復帰時は running/idle に戻すため）
    recomputeStatus(paneId);
    // 待機状態になったときに通知音を鳴らす
    if (waiting) shell.beep();
  }
}

// status を waiting フラグ・最終出力時刻・最終入力時刻から再計算してセットする。
// 派生フィールドのため、ここ以外から t.status を直接書き換えないこと。
function recomputeStatus(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  let next;
  if (t.waiting) {
    next = 'waiting';
  } else {
    const now = Date.now();
    const recentOutput = now - (t.lastOutputTime || 0) <= RUNNING_IDLE_TIMEOUT_MS;
    const recentInput = now - (t.lastInputTime || 0) <= RUNNING_INPUT_GUARD_MS;
    next = (recentOutput && !recentInput) ? 'running' : 'idle';
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
  if (t.waiting) return;
  // タイマーは出力ごとに張り直す
  if (t.runningTimer) {
    clearTimeout(t.runningTimer);
    t.runningTimer = null;
  }
  const now = Date.now();
  const recentInput = now - (t.lastInputTime || 0) <= RUNNING_INPUT_GUARD_MS;
  // 入力直後（タイプ中のエコー）は running と見なさない。idle のまま据え置く。
  if (recentInput) return;
  if (t.status !== 'running') {
    t.status = 'running';
    updatePaneStatus(paneId);
  }
  t.runningTimer = setTimeout(() => {
    const cur = terminals[paneId];
    if (!cur) return;
    cur.runningTimer = null;
    // タイマー満了時に waiting に変わっていたらそのまま、そうでなければ idle に戻す
    if (!cur.waiting && cur.status === 'running') {
      cur.status = 'idle';
      updatePaneStatus(paneId);
    }
  }, RUNNING_IDLE_TIMEOUT_MS);
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
    if (terminals[paneId]) {
      terminals[paneId].lastInputTime = Date.now();
    }
    if (terminals[paneId]?.waiting) {
      terminals[paneId].waiting = false;
      terminals[paneId].lastLines = '';
    }
    // waiting がクリアされていなくても、入力タイミングを反映した status を再計算する
    if (terminals[paneId]) recomputeStatus(paneId);
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
    // status: 表示用ステータス。issue #23 で追加。
    // 初期値 'idle' は何も表示しない（.pane-status[data-status="idle"] は display:none）。
    status: 'idle',
    // runningTimer: 'running' を 1500ms 後に 'idle' に戻すタイマー id。
    // 出力イベントごとに bumpRunning() が張り直す。closePane() で必ず clearTimeout する。
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
    // agentRoom（issue #58）: POST /api/agentroom で受け取ったルーム状態 { name: state }。
    //   null のままなら API 未通知。API が古い（AGENTROOM_API_TTL_MS 超過）場合は
    //   resolveRoomAgents() が PTY 出力ベースのフォールバック表示に切り替える。
    // agentRoomUpdatedAt: 最後に API でルーム状態を受け取った時刻（鮮度判定用）。
    // agentRoomOpen: アコーディオンの開閉状態（再 render をまたいで保持）。
    agentRoom: null,
    agentRoomUpdatedAt: 0,
    agentRoomOpen: false,
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
  const stripped = stripAnsiForDisplay(data);
  let merged = (t.lastLines + stripped).split('\n').slice(-LASTLINES_MAX_LINES).join('\n');
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
  if (paneId) closePane(paneId);
});

// ─── DOM updates (without full re-render) ────────────────────────────────────
function updatePaneCwd(paneId, cwd) {
  const el = document.querySelector(`.pane[data-id="${paneId}"] .pane-cwd`);
  if (el) el.textContent = cwd;
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
let sidebarOpen = false;
let sidebarTransitionCleanup = null;

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
  nav.replaceChildren();
  const inner = document.createElement('div');
  inner.className = 'sidebar-menu-inner';

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

  nav.appendChild(inner);
}

function createSidebarMenu() {
  const nav = document.createElement('nav');
  nav.id = 'sidebar-menu';
  nav.className = 'sidebar-menu';
  nav.setAttribute('aria-label', 'メインメニュー');
  return nav;
}

function ensureSidebarMenu(root) {
  const existing = root.querySelector('#sidebar-menu');
  const nav = existing || createSidebarMenu();
  if (!existing) renderSidebarMenu();
  return nav;
}

function focusFirstSidebarItem() {
  const nav = document.getElementById('sidebar-menu');
  const first = nav?.querySelector('a, button, summary');
  if (first && typeof first.focus === 'function') first.focus();
}

function setSidebarOpen(open, options = {}) {
  const root = document.getElementById('root');
  const btn = document.getElementById('menu-btn');
  const nav = root ? ensureSidebarMenu(root) : null;
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

  if (!nav || isReducedMotion()) {
    requestAnimationFrame(afterLayout);
    return;
  }

  let done = false;
  let timeoutId = null;
  const cleanup = () => {
    done = true;
    nav.removeEventListener('transitionend', onEnd);
    if (timeoutId !== null) clearTimeout(timeoutId);
    if (sidebarTransitionCleanup === cleanup) sidebarTransitionCleanup = null;
  };
  const finish = () => {
    if (done) return;
    cleanup();
    afterLayout();
  };
  const onEnd = (event) => {
    if (event.target !== nav || event.propertyName !== 'transform') return;
    finish();
  };
  sidebarTransitionCleanup = cleanup;
  nav.addEventListener('transitionend', onEnd);
  timeoutId = setTimeout(finish, 220);
}

function setupSidebarMenu() {
  const root = document.getElementById('root');
  if (root) ensureSidebarMenu(root);
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
function renderTaskTitleContent(el, title, url, prUrl) {
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
    const prLink = document.createElement('a');
    prLink.className = 'pane-badge pane-task-title-pr';
    prLink.href = '#'; // 実 URL は入れない（タイトルリンクと同じ理由）
    prLink.setAttribute('role', 'link');
    prLink.setAttribute('aria-label', 'プルリクエストを開く（外部ブラウザ）');
    prLink.title = prUrl;
    prLink.draggable = false;

    const prLabel = document.createElement('span');
    prLabel.className = 'pane-task-title-pr-label';
    prLabel.textContent = 'PR';
    prLink.appendChild(prLabel);

    const prIcon = document.createElement('span');
    prIcon.className = 'pane-task-title-pr-icon';
    prIcon.setAttribute('aria-hidden', 'true');
    prIcon.textContent = '↗';
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
  const el = document.querySelector(`.pane[data-id="${paneId}"] .pane-task-title`);
  if (!el) return;
  const title = getDisplayTitle(t);
  const url = getDisplayUrl(t);
  // ペイン D&D 起点としての可用性（issue #40）。複数 leaf がある時のみドラッグ可。
  // renderLeaf() 側の `canDragPane` 判定と同一の式に合わせる。
  // ここで考慮しないと、タイトル / PR をクリアした後に `.pane-task-title` が
  // empty 扱いで消え、ドラッグ起点を失う（CodeRabbit PR #45 指摘）。
  const canDragPane = !!(tree && getAllLeafIds(tree).length > 1);
  // PR ボタンは apiPrUrl があれば常時表示（採用: 案A）。
  // renderer 側でも http(s) 二段チェックを通してから採用する。
  const prUrl = isSafeExternalUrl(t.apiPrUrl) ? t.apiPrUrl : '';
  renderTaskTitleContent(el, title, url, prUrl);
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
// status は派生フィールドのため、t.waiting / t.status は呼び出し側で先にセット済みである前提。
function updatePaneStatus(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  const paneEl = document.querySelector(`.pane[data-id="${paneId}"]`);
  if (!paneEl) return;
  // 枠の点滅アニメ（周辺視野での気付き用、issue #23 でも残置）は waiting フラグ準拠
  paneEl.classList.toggle('waiting', t.waiting);

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

// 全ペイン ID を表示順で返す（後方互換のため名前を維持）。
function getAllLeafIds(t = tree) {
  return (t && Array.isArray(t.order)) ? t.order.slice() : [];
}

function paneExists(id) {
  return !!(tree && Array.isArray(tree.order) && tree.order.includes(id));
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
async function splitPane(paneId, direction, overrideCwd, options = {}) {
  if (!paneExists(paneId)) return null;

  const newPaneId = newId();
  // overrideCwd が指定されていればそれを使い、未指定ならホームディレクトリ（main 側でフォールバック）で開く。
  // 分割元ペインの cwd は継承しない（task-queue 等の特定ディレクトリにいるペインから分割しても
  // 新ペインはデフォルト位置で開かせる方針）。
  const targetCwd = overrideCwd || null;
  // options.noClaude が指定されていればそのまま main に渡す。未指定なら main 側のグローバル設定に従う。
  await createTerminal(newPaneId, targetCwd, options);

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

function closePane(paneId) {
  if (!paneExists(paneId)) return;

  const t = terminals[paneId];
  if (t) {
    // status の自動 idle 復帰タイマーが残っているとクロージャ経由で terminals[paneId] を
    // 参照し続けてしまうため、必ず破棄する（リーク防止）。
    if (t.runningTimer) {
      clearTimeout(t.runningTimer);
      t.runningTimer = null;
    }
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

  tree.order = tree.order.filter(id => id !== paneId);
  if (tree.order.length === 0) {
    // Last pane closed → start fresh
    initApp().then(() => {
      ipcRenderer.send('terminal:renderer-ready');
    });
    return;
  }
  // ペイン数が変わりグリッド寸法が変化するため、手動リサイズ比率は均等にリセットする。
  resetGridSizing();

  // Focus another pane
  const remaining = getAllLeafIds();
  if (remaining.length > 0 && (!focusedPaneId || focusedPaneId === paneId)) {
    focusedPaneId = remaining[remaining.length - 1];
  }

  render();
  requestAnimationFrame(fitAll);
}

// ペインをグリッド上で dir 方向の隣と入れ替える。端で隣が無ければ何もしない。
//   left/right … 同一行内の隣（行をまたがない）
//   up/down    … 上下の行の同じ列
function movePane(paneId, dir) {
  const order = tree.order;
  const i = order.indexOf(paneId);
  if (i < 0) return;
  const { cols } = gridDims();
  let j = -1;
  if (dir === 'left'  && i % cols !== 0) j = i - 1;
  else if (dir === 'right' && i % cols !== cols - 1 && i + 1 < order.length) j = i + 1;
  else if (dir === 'up'    && i - cols >= 0) j = i - cols;
  else if (dir === 'down'  && i + cols < order.length) j = i + cols;
  if (j < 0) return;
  [order[i], order[j]] = [order[j], order[i]];
  render();
  requestAnimationFrame(() => {
    fitAll();
    focusPane(paneId);
  });
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
  terminals[paneId]?.term.focus();
}

function fitTerminal(paneId) {
  const t = terminals[paneId];
  if (!t) return;
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
  const sidebar = ensureSidebarMenu(root);
  const newContent = renderGrid(tree);
  root.replaceChildren(sidebar, newContent);
  root.classList.toggle('sidebar-open', sidebarOpen);

  // Reattach terminal elements (moved, not recreated)
  getAllLeafIds(tree).forEach(paneId => {
    const t = terminals[paneId];
    if (!t) return;
    const container = root.querySelector(`.pane[data-id="${paneId}"] .term-container`);
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
function renderGrid(t) {
  const order = (t && Array.isArray(t.order)) ? t.order : [];
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
  const waiting = t?.waiting || false;
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

  const el = document.createElement('div');
  el.className = 'pane'
    + (focused ? ' focused' : '')
    + (waiting ? ' waiting' : '');
  el.dataset.id = node.id;

  // タスクタイトル行（OSC 0/2 または POST /api/set-title で設定された文字列を表示）。
  // 空のときは .empty クラスで非表示にし、xterm の表示領域を圧迫しない。
  // apiUrl があるときは .has-link を付与し、内部を <a> 化する（renderTaskTitleContent）。
  // ペイン D&D の可否判定（issue #40）。leaf が 2 つ以上ある時のみ drag 起点になれる。
  // ルート leaf（ペイン 1 枚状態）は移動先が無いため drag 不可。
  // 空タイトル時も D&D 可なら .empty を付けず、ハンドルとして掴める高さを確保する。
  const canDragPane = !!(tree && getAllLeafIds().length > 1);
  const taskTitleEl = document.createElement('div');
  // empty 判定はタイトル本文・ドラッグ可・PR ボタンのいずれもないとき。
  // PR ボタンだけでも表示するためにこの条件で扱う（issue #44）。
  const isEmpty = !taskTitle && !canDragPane && !taskPrUrl;
  taskTitleEl.className = 'pane-task-title'
    + (isEmpty ? ' empty' : '')
    + (taskUrl ? ' has-link' : '')
    + (taskPrUrl ? ' has-pr' : '');
  renderTaskTitleContent(taskTitleEl, taskTitle, taskUrl, taskPrUrl);
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
      <button class="btn btn-move btn-move-left" title="左へ移動">◀</button>
      <button class="btn btn-move btn-move-down" title="下へ移動">▼</button>
      <button class="btn btn-move btn-move-up" title="上へ移動">▲</button>
      <button class="btn btn-move btn-move-right" title="右へ移動">▶</button>
      <button class="btn btn-split" title="ペインを追加">＋</button>
      <button class="btn btn-close" title="閉じる">✕</button>
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

  header.querySelector('.btn-move-left').addEventListener('click', e => {
    e.stopPropagation();
    movePane(node.id, 'left');
  });
  header.querySelector('.btn-move-right').addEventListener('click', e => {
    e.stopPropagation();
    movePane(node.id, 'right');
  });
  header.querySelector('.btn-move-up').addEventListener('click', e => {
    e.stopPropagation();
    movePane(node.id, 'up');
  });
  header.querySelector('.btn-move-down').addEventListener('click', e => {
    e.stopPropagation();
    movePane(node.id, 'down');
  });
  header.querySelector('.btn-split').addEventListener('click', e => {
    e.stopPropagation();
    splitPane(node.id, 'h');
  });
  header.querySelector('.btn-close').addEventListener('click', e => {
    e.stopPropagation();
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

// ─── 設定パネル（汎用）────────────────────────────────────────────────────────
// main プロセス（settings:describe / settings:save）経由で、呼び出し側が env
// VK_TERMINALS_SETTINGS で指定した config ファイルをこの GUI から編集する。
// issue #73 で歯車ボタンは常時表示になった。使用状況ビューは descriptor の有無に
// かかわらず開けるため、describe の結果を待たずに click を配線する（describe が
// 使えない環境ではモーダル側で設定タブを描画しない）。
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

const USAGE_POLL_INTERVAL_MS = 60000; // モーダル表示中・バッジ共通（main 側 60s TTL に相乗り）

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

// 公式データ 1 区分（セッション / 週間）のセクションを組み立てる。
//   resetMode: 'remaining' … 「◯時間◯分後にリセット」。data-reset-at を付け、
//              モーダルの毎秒ティッカーがポーリングを待たずライブ再計算する。
//   resetMode: 'datetime'  … 「金 18:59 にリセット」（週間制限向け・静的表示）。
function buildOauthUsageSection(title, entry, resetMode) {
  const sec = document.createElement('div');
  sec.className = 'usage-section';

  const head = document.createElement('div');
  head.className = 'usage-section-head';
  const titleEl = document.createElement('span');
  titleEl.className = 'usage-section-title';
  titleEl.textContent = title;
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
      reset.textContent = formatRemainingJa(entry.resetAtMs - Date.now());
    } else {
      reset.textContent = formatResetDateTimeJa(entry.resetAtMs);
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
  reset.textContent = `リセット ${u.resetText}（残り${u.remainingText}）`;
  sec.appendChild(reset);

  if (u.peakNote) {
    const note = document.createElement('div');
    note.className = 'usage-note';
    note.textContent = u.peakNote;
    sec.appendChild(note);
  }
  return sec;
}

// 使用状況ビュー全体を描画する（読み取り専用）。
function renderUsageView(container, usage) {
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
      note.textContent = '直近に取得した値を表示しています（最新の取得に一時的に失敗しました）';
      container.appendChild(note);
    }
    if (usage.session) {
      container.appendChild(buildOauthUsageSection('現在のセッション', usage.session, 'remaining'));
    }
    if (usage.weekly) {
      container.appendChild(buildOauthUsageSection('週間制限（すべてのモデル）', usage.weekly, 'datetime'));
    }
    return;
  }
  // フォールバック（トランスクリプト集計）
  container.appendChild(buildTranscriptUsageSection(usage));
}

// 歯車ボタンの警告ドットバッジ（issue #73）。
// 公式の使用率（セッション・週間のいずれか）が 80% を超えたときだけドットを重ねる
// （80〜90%: アンバー / 90%〜: 赤）。フォールバック（自己ピーク比）は上限比ではないため
// バッジ対象にしない。ポーリングは 60 秒間隔で main 側 60s TTL キャッシュに相乗りする。
// 色のみの表現にしないよう、警告レベルに応じて title / aria-label も切り替える（a11y）。
const USAGE_BADGE_LABELS = {
  '':     '設定',
  'warn': '設定（Claude使用状況: 警告）',
  'crit': '設定（Claude使用状況: 危険）',
};

function setupUsageBadge() {
  const btn = document.getElementById('settings-btn');
  if (!btn) return;
  const refresh = async () => {
    let level = '';
    try {
      const u = await ipcRenderer.invoke('usage:get');
      if (u && u.source === 'oauth') {
        const pcts = [u.session && u.session.percent, u.weekly && u.weekly.percent]
          .filter((p) => Number.isFinite(p));
        const max = pcts.length ? Math.max(...pcts) : null;
        if (max !== null && max > 80) level = max >= 90 ? 'crit' : 'warn';
      }
    } catch (_e) {
      level = ''; // 取得失敗時はバッジを消す（古い警告を残さない）
    }
    btn.classList.toggle('usage-alert-warn', level === 'warn');
    btn.classList.toggle('usage-alert-crit', level === 'crit');
    const label = USAGE_BADGE_LABELS[level] || USAGE_BADGE_LABELS[''];
    btn.title = label;
    btn.setAttribute('aria-label', label);
  };
  refresh();
  setInterval(refresh, USAGE_POLL_INTERVAL_MS);
}

// 1 フィールド分の入力 HTML を組み立てる。
// id は描画順で採番したユニークな値を呼び出し側から受け取る（キーから id を導出すると
// "a.b" と "a_b" のような別キーがサニタイズ後に衝突しうるため、キー由来にしない）。
function renderSettingsField(f, value, id) {
  const label = escText(f.label || f.key);
  const help = f.help ? `<span class="settings-help">${escText(f.help)}</span>` : '';

  if (f.type === 'boolean') {
    return `<label class="settings-row settings-row-check">
      <input type="checkbox" id="${id}" ${value ? 'checked' : ''}>
      <span class="settings-label">${label}</span>${help}
    </label>`;
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
  return `<div class="settings-row">
    <label class="settings-label" for="${id}">${label}</label>${help}
    <input type="${inputType}" id="${id}" value="${strVal}"${ph} spellcheck="false">
  </div>`;
}

// モーダルを開き、「Claude使用状況｜設定」のタブ構成で描画する（issue #73）。
//   - 既定タブは「Claude使用状況」（読み取り専用。フッターの保存/キャンセルは出さない）
//   - 「設定」タブは settings:describe が使えるときだけ描画し、従来どおり保存できる
//   - 使用状況のポーリングは「Claude使用状況タブ表示中のみ」初回即時＋60秒間隔。
//     残り時間表示（◯時間◯分後にリセット）は毎秒ライブ再計算する
async function openSettingsModal() {
  // 二重オープン防止
  if (document.querySelector('.settings-overlay')) return;

  // describe が失敗しても使用状況ビューだけのモーダルとして開く。
  let desc = null;
  try {
    desc = await ipcRenderer.invoke('settings:describe');
  } catch (_e) {
    desc = null;
  }
  const settingsAvailable = !!(desc && desc.available);

  // 描画順に採番したユニーク id と field を対応付ける（保存時もこの対応で走査する）。
  const entries = [];
  const groupsHtml = settingsAvailable ? desc.groups.map(g => {
    const rows = (g.fields || []).map(f => {
      const id = 'set-field-' + entries.length;
      entries.push({ field: f, id });
      return renderSettingsField(f, desc.values[f.key], id);
    }).join('');
    return `<fieldset class="settings-group">
      <legend>${escText(g.label || '')}</legend>${rows}</fieldset>`;
  }).join('') : '';

  const appVersion = (desc && desc.appVersion) ? desc.appVersion : '';
  const overlay = document.createElement('div');
  overlay.className = 'settings-overlay';
  overlay.innerHTML = `
    <div class="settings-modal" role="dialog" aria-modal="true">
      <div class="settings-header">
        <h2>${escText((settingsAvailable && desc.title) || 'VK Terminals')}${appVersion ? `<span class="settings-version">VK Terminals v${escText(appVersion)}</span>` : ''}</h2>
        <button class="settings-close" title="閉じる">✕</button>
      </div>
      <div class="settings-tabs" role="tablist">
        <button type="button" class="settings-tab" data-tab="usage" role="tab" aria-selected="false">Claude使用状況</button>
        ${settingsAvailable ? '<button type="button" class="settings-tab" data-tab="config" role="tab" aria-selected="false">設定</button>' : ''}
      </div>
      <div class="settings-view settings-view-usage" role="tabpanel" hidden>
        <p class="usage-empty">Claude の使用状況を取得中…</p>
      </div>
      <div class="settings-view settings-view-config" role="tabpanel" hidden>
        ${settingsAvailable && desc.note ? `<p class="settings-note">${escText(desc.note)}</p>` : ''}
        ${settingsAvailable ? `<p class="settings-target">保存先: <code>${escText(desc.targetPath || '')}</code></p>` : ''}
        <form class="settings-form" onsubmit="return false">${groupsHtml}</form>
      </div>
      <div class="settings-footer" hidden>
        <span class="settings-msg" role="status"></span>
        <button type="button" class="settings-cancel">キャンセル</button>
        <button type="button" class="settings-save">保存</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const modal = overlay.querySelector('.settings-modal');
  const msg = modal.querySelector('.settings-msg');
  const usageView = modal.querySelector('.settings-view-usage');
  const configView = modal.querySelector('.settings-view-config');
  const footer = modal.querySelector('.settings-footer');
  const tabs = Array.from(modal.querySelectorAll('.settings-tab'));

  // ── 使用状況のポーリング（Claude使用状況タブ表示中のみ）──────────────────
  let usagePollTimer = null; // 60 秒間隔の再取得（main 側 60s TTL キャッシュに相乗り）
  let usageTickTimer = null; // 「◯時間◯分後にリセット」の毎秒ライブ再計算
  const refreshUsage = async () => {
    let u = null;
    try {
      u = await ipcRenderer.invoke('usage:get');
    } catch (_e) {
      u = null;
    }
    if (!overlay.isConnected) return; // 取得中に閉じられたら何もしない
    renderUsageView(usageView, u);
  };
  const startUsagePolling = () => {
    if (usagePollTimer) return;
    refreshUsage(); // 初回即時（ポーリング待ちにしない）
    usagePollTimer = setInterval(refreshUsage, USAGE_POLL_INTERVAL_MS);
    usageTickTimer = setInterval(() => {
      usageView.querySelectorAll('[data-reset-at]').forEach((el) => {
        const at = Number(el.dataset.resetAt);
        if (Number.isFinite(at)) el.textContent = formatRemainingJa(at - Date.now());
      });
    }, 1000);
  };
  const stopUsagePolling = () => {
    if (usagePollTimer) { clearInterval(usagePollTimer); usagePollTimer = null; }
    if (usageTickTimer) { clearInterval(usageTickTimer); usageTickTimer = null; }
  };

  // ── タブ切替 ──────────────────────────────────────────────────────────────
  const selectTab = (name) => {
    tabs.forEach((t) => {
      const on = t.dataset.tab === name;
      t.classList.toggle('active', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    usageView.hidden = name !== 'usage';
    configView.hidden = name !== 'config';
    // 使用状況ビューは読み取り専用のため、保存/キャンセルのフッターごと隠す（閉じるのみ）。
    footer.hidden = name !== 'config';
    if (name === 'usage') startUsagePolling();
    else stopUsagePolling();
  };
  tabs.forEach((t) => t.addEventListener('click', () => selectTab(t.dataset.tab)));
  selectTab('usage'); // 既定タブは「Claude使用状況」

  const close = () => {
    stopUsagePolling();
    document.removeEventListener('keydown', onKey);
    overlay.remove();
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  modal.querySelector('.settings-close').addEventListener('click', close);
  modal.querySelector('.settings-cancel').addEventListener('click', close);

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

  modal.querySelector('.settings-save').addEventListener('click', async () => {
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
  } catch (_e) { /* 取得失敗時は無効のまま */ }

  // Dispose any existing terminals
  for (const [paneId, t] of Object.entries(terminals)) {
    try { t.term.dispose(); } catch (e) {}
    ipcRenderer.send('terminal:kill', t.termId);
  }
  terminals = {};
  focusedPaneId = null;

  const paneId = newId();
  tree = { type: 'grid', order: [paneId], colFr: null, rowFr: null };
  await createTerminal(paneId, null);
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

// 設定パネル（Claude使用状況｜設定モーダル）の歯車ボタンを配線する（issue #73 で常時表示）。
setupSettingsPanel();

// 歯車ボタンの使用率警告ドットバッジ（issue #73）を配線する。
setupUsageBadge();

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
      displayTitle: getDisplayTitle(t),
      // collapsed: グリッド化で折り畳み機能を撤去したため常に false（後方互換のためキーは維持）。
      collapsed: false,
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
  const { requestId, cwd, noClaude } = payload;
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
    reply({ termId: result.termId });
  } catch (e) {
    reply({ error: e?.message || 'failed to create pane' });
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
// title / url / prUrl はペアで都度送る置換セマンティクス。
ipcRenderer.on('terminal:title', (event, termId, title, url, prUrl) => {
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
  updatePaneTitle(paneId);
});

// ─── Auto-input notification from main (HTTP API経由の入力時) ─────────────────
ipcRenderer.on('terminal:auto-input', (event, termId) => {
  const paneId = Object.keys(terminals).find(k => terminals[k]?.termId === termId);
  if (!paneId) return;
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
