/* global require */
const { ipcRenderer, shell } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const { stripAnsiForDisplay } = require('../utils/stripAnsi');

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
    // 表示時は apiTitle を優先し、空のときに taskTitle へフォールバックする。
    // これにより task-queue 等が指定した issue タイトルが OSC 由来の文字列で
    // 上書きされなくなる（issue #22）。
    taskTitle: '',
    apiTitle: '',
    apiUrl: '',
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

// .pane-task-title 要素の中身を、URL の有無に応じて
// プレーンテキスト or <a>（外部リンクマーク付き）で再構築する。
//   - URL 無し: テキストノードのみ（従来通り、見た目は完全互換）
//   - URL 有り: <a role="link" href="#"> + <span>title</span> + <span aria-hidden>↗</span>
// href には URL を直接入れない（Electron の <a target="_blank"> が新 BrowserWindow を
// 開く危険挙動を回避するため）。クリック時は preventDefault → shell.openExternal で
// OS の既定ブラウザを開く。
function renderTaskTitleContent(el, title, url) {
  // 既存の子要素を全消去（innerHTML は使わずに DOM API で組み立てる）
  while (el.firstChild) el.removeChild(el.firstChild);

  if (!url) {
    el.textContent = title;
    return;
  }

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
    // main 側で検証済みでも二段構えで再チェック（http(s): 以外は無視）
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
  });
  // mousedown は止めない（ペインのフォーカス移譲は通常通り）
  // ただしリンク自体のテキスト選択は意図しないドラッグを起こしやすいので、
  // ユーザビリティのため pointer 系イベントの伝搬は維持しつつ、別操作とは衝突しない。

  el.appendChild(link);
}

function updatePaneTitle(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  const el = document.querySelector(`.pane[data-id="${paneId}"] .pane-task-title`);
  if (!el) return;
  const title = getDisplayTitle(t);
  const url = getDisplayUrl(t);
  renderTaskTitleContent(el, title, url);
  // ホバー時のツールチップは has-link 時は子 <a> 側に集約して親子競合を避ける。
  //   - URL 無し: 親 .pane-task-title に title 属性をセット（従来挙動）
  //   - URL 有り: 親 title 属性を削除し、<a> 側の title（タイトル + URL）のみに任せる
  if (url) {
    el.removeAttribute('title');
  } else {
    el.title = title;
  }
  el.classList.toggle('empty', title.length === 0);
  el.classList.toggle('has-link', !!url);
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
}

// ─── Tree operations ──────────────────────────────────────────────────────────
function findNode(node, id) {
  if (node.type === 'leaf') return node.id === id ? node : null;
  return findNode(node.first, id) || findNode(node.second, id);
}

function replaceNode(node, id, replacement) {
  if (node.type === 'leaf') return node.id === id ? replacement : node;
  return {
    ...node,
    first: replaceNode(node.first, id, replacement),
    second: replaceNode(node.second, id, replacement),
  };
}

function removeNode(node, id) {
  if (node.type === 'leaf') return node.id === id ? null : node;
  const newFirst = removeNode(node.first, id);
  const newSecond = removeNode(node.second, id);
  if (newFirst === null) return newSecond;
  if (newSecond === null) return newFirst;
  return { ...node, first: newFirst, second: newSecond };
}

// tree 内の leaf 2つの「位置」を入れ替える。
// leaf オブジェクト一式（id + collapsed 等の付随フィールド）を入れ替えるため、
// 折り畳み状態などの leaf 固有フィールドはペインと一緒に移動する。
// terminals マップは paneId キーのまま不変なので、HTTP API / states.json の termId 紐付けには影響しない。
function swapLeavesInTree(node, idA, idB) {
  const leafA = findNode(node, idA);
  const leafB = findNode(node, idB);
  if (!leafA || !leafB) return node;
  function walk(n) {
    if (n.type === 'leaf') {
      // idA の位置に leafB 一式を、idB の位置に leafA 一式を置く
      if (n.id === idA) return { ...leafB };
      if (n.id === idB) return { ...leafA };
      return n;
    }
    return { ...n, first: walk(n.first), second: walk(n.second) };
  }
  return walk(node);
}

function getAllLeafIds(node) {
  if (node.type === 'leaf') return [node.id];
  return [...getAllLeafIds(node.first), ...getAllLeafIds(node.second)];
}

// tree 内の targetId（leaf）の位置を、srcLeaf を dir 方向に挿入した split で置き換える（issue #40）。
//   dir = 'left'  : 新 split は split-h、srcLeaf が左 / target が右
//   dir = 'right' : 新 split は split-h、target が左 / srcLeaf が右
//   dir = 'up'    : 新 split は split-v、srcLeaf が上 / target が下
//   dir = 'down'  : 新 split は split-v、target が上 / srcLeaf が下
// 新規 split の ratio は 0.5 固定（ドロップ位置から動的算出は UX が裏切られやすいため）。
function insertBesideLeaf(node, targetId, srcLeaf, dir) {
  if (!srcLeaf || (dir !== 'left' && dir !== 'right' && dir !== 'up' && dir !== 'down')) {
    return node;
  }
  const direction = (dir === 'left' || dir === 'right') ? 'h' : 'v';
  const targetNode = findNode(node, targetId);
  if (!targetNode) return node;
  // src と target の順序を dir から決める
  const srcFirst = (dir === 'left' || dir === 'up');
  const newSplit = {
    type: 'split',
    direction,
    ratio: 0.5,
    first: srcFirst ? srcLeaf : targetNode,
    second: srcFirst ? targetNode : srcLeaf,
  };
  return replaceNode(node, targetId, newSplit);
}

// tree 内で指定 leaf を直接の子に持つ split ノードと、そのどちら側にいるか（'first' or 'second'）を返す。
// 親が存在しない（ルートが leaf 自身）場合は null。
function findParentSplit(node, leafId, parent = null, side = null) {
  if (node.type === 'leaf') {
    return node.id === leafId ? { parent, side } : null;
  }
  return (
    findParentSplit(node.first, leafId, node, 'first') ||
    findParentSplit(node.second, leafId, node, 'second')
  );
}

function getPaneRect(paneId) {
  const paneEl = document.querySelector(`.pane[data-id="${paneId}"]`);
  const rect = paneEl?.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;
  return rect;
}

// フォーカスペインから方向 dir にある最も近い隣接ペインを座標ベースで探す。
// 無ければ null。dir は 'left' | 'right' | 'up' | 'down'。
function findNeighborPane(fromPaneId, dir) {
  const fromRect = getPaneRect(fromPaneId);
  if (!fromRect) return null;
  const fromCx = fromRect.left + fromRect.width / 2;
  const fromCy = fromRect.top + fromRect.height / 2;
  let best = null;
  // 主軸ギャップ（共有辺への近さ）を最優先、同値なら直交軸の中心ずれが小さい方を選ぶ
  let bestGap = Infinity;
  let bestCross = Infinity;
  for (const id of getAllLeafIds(tree)) {
    if (id === fromPaneId) continue;
    const r = getPaneRect(id);
    if (!r) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    // dir 方向の主軸ギャップ（候補の手前辺と fromRect の対辺の隙間）
    const axisGap =
      dir === 'left'  ? fromRect.left - r.right  :
      dir === 'right' ? r.left - fromRect.right  :
      dir === 'up'    ? fromRect.top - r.bottom  :
                        r.top - fromRect.bottom;
    // 候補が dir 方向側に存在しない（手前 or 重なっている）場合は除外
    if (axisGap < -1) continue;
    // 直交軸でオーバーラップしているペインのみを隣接候補とする（対角線上の非隣接ペイン除外）
    const orthOverlap =
      (dir === 'left' || dir === 'right')
        ? (r.top < fromRect.bottom && r.bottom > fromRect.top)
        : (r.left < fromRect.right && r.right > fromRect.left);
    if (!orthOverlap) continue;
    const cross = (dir === 'left' || dir === 'right')
      ? Math.abs(cy - fromCy)
      : Math.abs(cx - fromCx);
    if (axisGap < bestGap || (axisGap === bestGap && cross < bestCross)) {
      bestGap = axisGap;
      bestCross = cross;
      best = id;
    }
  }
  return best;
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
// leaf.collapsed をトグルする。collapse 時は親 split の現在 ratio を savedRatio に退避し、
// 兄弟側に flex を寄せて自身は自然高さ（pane-task-title + pane-header）に縮める。
// expand 時は savedRatio から元の比率を復元（未保存なら 0.5）。
// ※ tree のルート leaf（親 split がない）は対象外。
//
// render() を呼ばずに既存 DOM を直接書き換えるのは、`.pane.collapsed { transition: max-height ... }`
// を効かせるため。render() は innerHTML 入れ替えで要素を再生成してしまい、新しい要素が
// 最初から .collapsed 状態で生まれるため transition が走らない。
function toggleCollapse(paneId) {
  const leaf = findNode(tree, paneId);
  if (!leaf || leaf.type !== 'leaf') return;
  const found = findParentSplit(tree, paneId);
  if (!found || !found.parent) return; // ルート leaf は折り畳まない
  const parent = found.parent;

  const willCollapse = !leaf.collapsed;
  // 1) データ構造の更新
  if (willCollapse) {
    parent.savedRatio = parent.ratio;
    leaf.collapsed = true;
  } else {
    leaf.collapsed = false;
    if (typeof parent.savedRatio === 'number') {
      parent.ratio = parent.savedRatio;
      delete parent.savedRatio;
    } else {
      parent.ratio = 0.5;
    }
  }

  // 2) DOM を in-place 更新（element 同一性を保って transition を走らせる）
  const paneEl = document.querySelector(`.pane[data-id="${paneId}"]`);
  if (paneEl) {
    paneEl.classList.toggle('collapsed', willCollapse);

    // 親 .split の DOM を取得（必ず .split.split-v）。
    const splitEl = paneEl.parentElement;
    if (splitEl && splitEl.classList.contains('split')) {
      splitEl.classList.toggle('collapsed-pair', willCollapse);

      // 兄弟要素（自分以外の .pane または .split 子）を取得して flex を更新する。
      // resize-handle を挟むため previousElementSibling / nextElementSibling のうち
      // .resize-handle でない方が兄弟ノード。
      const sibling = [splitEl.firstElementChild, splitEl.lastElementChild]
        .find(el => el && el !== paneEl);
      if (willCollapse) {
        paneEl.style.flex = '0 0 auto';
        if (sibling) sibling.style.flex = '1 1 auto';
      } else {
        // 復元された ratio を data 側から読み取って按分（自分が parent.first か second かで分岐）
        const ratio = parent.ratio;
        if (found.side === 'first') {
          paneEl.style.flex = String(ratio);
          if (sibling) sibling.style.flex = String(1 - ratio);
        } else {
          paneEl.style.flex = String(1 - ratio);
          if (sibling) sibling.style.flex = String(ratio);
        }
      }
    }

    // ボタンのテキスト / aria を更新
    const btn = paneEl.querySelector('.btn-collapse');
    if (btn) {
      btn.textContent = willCollapse ? '▴' : '▾';
      btn.setAttribute('aria-expanded', String(!willCollapse));
      btn.setAttribute('aria-label', willCollapse ? 'ペインを展開' : 'ペインを折り畳む');
      btn.setAttribute('title', willCollapse ? '展開する' : '折り畳む');
    }
  }

  // 3) サイズ反映と focus
  // collapse 中は fitTerminal がスキップされる（fitTerminal 側で leaf.collapsed を見ている）。
  // expand 後は transition 完了を待ってから fit したいが、xterm は ResizeObserver でも
  // 自動 fit がかかるため、ここでは即時 fitAll() で十分（collapse 中はスキップされる）。
  requestAnimationFrame(() => {
    fitAll();
    if (!willCollapse) focusPane(paneId);
  });
}

// tree を走査し、「折り畳む意味がない位置にいる collapsed leaf」を強制展開する。
// 具体的には親 split が split-v でない leaf に collapsed=true が残っているケースを補正する。
// closePane で removeNode により leaf がルートに昇格したり、split-h の中に取り残された場合の保護。
function sanitizeCollapsedFlags(node, parentDirection = null) {
  if (node.type === 'leaf') {
    if (node.collapsed && parentDirection !== 'v') {
      node.collapsed = false;
    }
    return;
  }
  sanitizeCollapsedFlags(node.first, node.direction);
  sanitizeCollapsedFlags(node.second, node.direction);
}

// 折り畳まれていた場合に展開だけ行う（focus はしない）。focusPane / splitPane から内部利用。
function expandIfCollapsed(paneId) {
  const leaf = findNode(tree, paneId);
  if (!leaf || leaf.type !== 'leaf' || !leaf.collapsed) return false;
  const found = findParentSplit(tree, paneId);
  leaf.collapsed = false;
  if (found && found.parent) {
    const parent = found.parent;
    if (typeof parent.savedRatio === 'number') {
      parent.ratio = parent.savedRatio;
      delete parent.savedRatio;
    } else {
      parent.ratio = 0.5;
    }
  }
  return true;
}

// ─── Pane actions ─────────────────────────────────────────────────────────────
async function splitPane(paneId, direction, overrideCwd, options = {}) {
  const node = findNode(tree, paneId);
  if (!node) return null;

  // 折り畳まれているペインを分割対象にすると分割後も縮んだままで操作不能になるため、
  // 分割前に必ず展開しておく（render() は最後の render で一括反映）。
  expandIfCollapsed(paneId);

  const newPaneId = newId();
  // overrideCwd が指定されていればそれを使い、未指定ならホームディレクトリ（main 側でフォールバック）で開く。
  // 分割元ペインの cwd は継承しない（task-queue 等の特定ディレクトリにいるペインから分割しても
  // 新ペインはデフォルト位置で開かせる方針）。
  const targetCwd = overrideCwd || null;
  // options.noClaude が指定されていればそのまま main に渡す。未指定なら main 側のグローバル設定に従う。
  await createTerminal(newPaneId, targetCwd, options);

  tree = replaceNode(tree, paneId, {
    type: 'split',
    direction,
    ratio: 0.5,
    first: node,
    second: { type: 'leaf', id: newPaneId },
  });

  render();
  requestAnimationFrame(() => {
    fitTerminal(paneId);
    fitTerminal(newPaneId);
    focusPane(newPaneId);
  });

  // 新ペインの情報を返す（focusedPaneId の更新を待たずに確定値を返す）
  return { paneId: newPaneId, termId: terminals[newPaneId]?.termId };
}

function closePane(paneId) {
  if (!findNode(tree, paneId)) return;

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

  const newTree = removeNode(tree, paneId);
  if (!newTree) {
    // Last pane closed → start fresh
    initApp().then(() => {
      ipcRenderer.send('terminal:renderer-ready');
    });
    return;
  }
  tree = newTree;
  // 兄弟ペインを削除した結果、collapsed leaf がルートに昇格したり split-h の中に
  // 取り残されたりして自力では展開できなくなるケースを補正する。
  sanitizeCollapsedFlags(tree);

  // Focus another pane
  const remaining = getAllLeafIds(tree);
  if (remaining.length > 0 && (!focusedPaneId || focusedPaneId === paneId)) {
    focusedPaneId = remaining[remaining.length - 1];
  }

  render();
  requestAnimationFrame(fitAll);
}

// ペインを方向 dir の隣接ペインと入れ替える。隣が無ければ何もしない。
function movePane(paneId, dir) {
  const target = findNeighborPane(paneId, dir);
  if (!target) return;
  tree = swapLeavesInTree(tree, paneId, target);
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

// 実際のツリー再構築（issue #40）。
//   1. src / target 両方に expandIfCollapsed（畳まれたまま新 split に入って操作不能ペインになるのを防止）
//   2. removeNode(tree, srcId) でドラッグ元を抜く（親 split が単一子になるケースは removeNode 側で自動処理）
//   3. insertBesideLeaf で target の位置に srcLeaf を dir 方向で挿入
//   4. render() → requestAnimationFrame(() => { fitAll(); focusPane(srcId); })
//   5. sanitizeCollapsedFlags(tree) を必ず実行（split-h 配下に collapsed leaf が紛れ込むケースの補正）
function handlePaneDrop(srcId, targetId, dir) {
  if (!tree) return;
  if (!srcId || !targetId || srcId === targetId) return;
  const srcLeaf = findNode(tree, srcId);
  if (!srcLeaf || srcLeaf.type !== 'leaf') return;

  // 折り畳み状態のまま動かすと新 split で操作不能ペインになるため、両方とも展開しておく
  expandIfCollapsed(srcId);
  expandIfCollapsed(targetId);

  // 動かす leaf のスナップショット（collapsed 等の付随フィールドごと持ち運ぶ。
  // ただし上で expandIfCollapsed を通したので collapsed は false 化されている）
  const srcSnapshot = { ...findNode(tree, srcId) };

  // src を抜いた tree を作る
  const removed = removeNode(tree, srcId);
  if (!removed) return; // 想定外（leaf が 1 枚しかなかった等）
  // 抜いた結果 target が消えるケースは無いはずだが、念のためチェック
  if (!findNode(removed, targetId)) return;

  // target の位置に srcSnapshot を dir 方向で挿入
  const next = insertBesideLeaf(removed, targetId, srcSnapshot, dir);
  if (!next) return;
  tree = next;

  // split-h 配下に collapsed leaf が紛れ込むなどの不整合を補正
  sanitizeCollapsedFlags(tree);

  render();
  requestAnimationFrame(() => {
    fitAll();
    focusPane(srcId);
  });
}

function focusPane(paneId) {
  // 折り畳まれているペインに focus が当たっても自動展開はしない（明示操作のみで展開する方針）。
  // フォーカス枠は当てるが xterm への入力フォーカスはスキップする（ヘッダだけ見える状態のまま）。
  focusedPaneId = paneId;
  document.querySelectorAll('.pane').forEach(el => {
    el.classList.toggle('focused', el.dataset.id === paneId);
  });
  const leaf = tree ? findNode(tree, paneId) : null;
  if (leaf && leaf.collapsed) return;
  terminals[paneId]?.term.focus();
}

function fitTerminal(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  // 折り畳み中のペインは高さ 0 になっており、fitAddon.fit() が NaN を返して例外を吐くため明示的にスキップする。
  // PTY 側のサイズは展開時に再 fit されるので、ここで送らなくても問題ない。
  const leaf = tree ? findNode(tree, paneId) : null;
  if (leaf && leaf.collapsed) return;
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
  const newContent = renderNode(tree);
  root.innerHTML = '';
  root.appendChild(newContent);

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

// parentDirection: 親 split の direction ('h' | 'v') または null（ルート leaf の場合）。
// renderLeaf 側で .btn-collapse を表示するか（親が split-v のときだけ）の判定に使う。
function renderNode(node, parentDirection = null) {
  return node.type === 'leaf'
    ? renderLeaf(node, parentDirection)
    : renderSplit(node);
}

// status → { label, ariaLabel } のマッピングを一元化する（updatePaneStatus / renderLeaf 共用）。
// 'idle' および未知の値は空文字を返し、呼び出し側で「非表示・aria-label 除去」相当の扱いになる。
function getStatusPresentation(status) {
  if (status === 'waiting') return { label: '入力待ち', ariaLabel: 'ステータス: 入力待ち' };
  if (status === 'running') return { label: '実行中',   ariaLabel: 'ステータス: 実行中' };
  return { label: '', ariaLabel: '' };
}

function renderLeaf(node, parentDirection) {
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
  const collapsed = !!node.collapsed;
  // 親 split が split-v（上下分割）の場合のみ折り畳みボタンを表示する。
  // 親 split-h（横並び）の場合は折り畳むと縦のストリップになるが、今回はスコープ外。
  // ルート leaf（親 split がない）は折り畳めない（兄弟が無いため）。
  const canCollapse = parentDirection === 'v';

  const el = document.createElement('div');
  el.className = 'pane'
    + (focused ? ' focused' : '')
    + (waiting ? ' waiting' : '')
    + (collapsed ? ' collapsed' : '');
  el.dataset.id = node.id;

  // タスクタイトル行（OSC 0/2 または POST /api/set-title で設定された文字列を表示）。
  // 空のときは .empty クラスで非表示にし、xterm の表示領域を圧迫しない。
  // apiUrl があるときは .has-link を付与し、内部を <a> 化する（renderTaskTitleContent）。
  const taskTitleEl = document.createElement('div');
  taskTitleEl.className = 'pane-task-title'
    + (taskTitle ? '' : ' empty')
    + (taskUrl ? ' has-link' : '');
  renderTaskTitleContent(taskTitleEl, taskTitle, taskUrl);
  // URL 有りのときは子 <a> 側の title 属性に集約するため、親には付けない（親子競合回避）。
  if (taskTitle && !taskUrl) taskTitleEl.title = taskTitle;
  // ペイン D&D 起点（issue #40）。leaf が 2 つ以上ある時のみ draggable を付与する。
  // ルート leaf（ペイン 1 枚状態）は移動先が無いため drag 不可。
  if (tree && getAllLeafIds(tree).length > 1) {
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
  // .btn-collapse は親 split が split-v のときだけ表示（canCollapse）。
  // chevron は上下分割のメンタルモデルに合わせる:
  //   展開中（open）  : ▾（下向き = 中身が下に出ている）
  //   折り畳み中（closed）: ▴（上向き = 上に巻き上げて閉じている）
  // aria-expanded で支援技術にも開閉状態を伝える。
  const collapseBtnHtml = canCollapse
    ? `<button class="btn btn-collapse"
         aria-label="${collapsed ? 'ペインを展開' : 'ペインを折り畳む'}"
         aria-expanded="${!collapsed}"
         title="${collapsed ? '展開する' : '折り畳む'}">${collapsed ? '▴' : '▾'}</button>`
    : '';
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
      <button class="btn btn-split-h" title="左右に分割">⇔</button>
      <button class="btn btn-split-v" title="上下に分割">⇕</button>
      ${collapseBtnHtml}
      <button class="btn btn-close" title="閉じる">✕</button>
    </div>
  `;
  // ドラッグ中に複数ファイルのヒントを表示
  header.setAttribute('title', 'ファイルをドラッグ&ドロップでパスを入力（複数ファイル可）');

  const termContainer = document.createElement('div');
  termContainer.className = 'term-container';

  el.appendChild(header);
  el.appendChild(termContainer);

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
  header.querySelector('.btn-split-h').addEventListener('click', e => {
    e.stopPropagation();
    splitPane(node.id, 'h');
  });
  header.querySelector('.btn-split-v').addEventListener('click', e => {
    e.stopPropagation();
    splitPane(node.id, 'v');
  });
  if (canCollapse) {
    header.querySelector('.btn-collapse').addEventListener('click', e => {
      e.stopPropagation();
      toggleCollapse(node.id);
    });
  }
  header.querySelector('.btn-close').addEventListener('click', e => {
    e.stopPropagation();
    closePane(node.id);
  });
  el.addEventListener('mousedown', () => focusPane(node.id));

  // ─── Drag & Drop: pane insertion (issue #40) ─────────────────────────────
  // 別ペインのタスクタイトル行をドラッグして、このペインの上下左右にドロップすると
  // その方向に再分割して挿入する。同一ペインへのドロップは no-op。
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
    e.dataTransfer.dropEffect = 'move';
    const dir = computePaneDropDir(el, e);
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

function renderSplit(node) {
  // 直下の子が collapsed leaf かどうかを判定（split-v のときのみ意味を持つ）。
  // split-h 側では .btn-collapse を出さない仕様のため、collapsed leaf は通常発生しない。
  const firstCollapsed = node.first.type === 'leaf' && node.first.collapsed;
  const secondCollapsed = node.second.type === 'leaf' && node.second.collapsed;
  const hasCollapsedChild = firstCollapsed || secondCollapsed;

  const el = document.createElement('div');
  el.className = `split split-${node.direction}`
    + (hasCollapsedChild ? ' collapsed-pair' : '');

  // 子に親 split の direction を渡して、leaf 側で .btn-collapse の表示可否を判定できるようにする
  const first = renderNode(node.first, node.direction);
  const handle = document.createElement('div');
  handle.className = `resize-handle resize-handle-${node.direction}`;
  const second = renderNode(node.second, node.direction);

  // 片側が collapsed の場合は flex を固定し、もう片方に空きを吸収させる。
  // どちらも展開中なら通常通り ratio で按分する。
  if (firstCollapsed && !secondCollapsed) {
    first.style.flex = '0 0 auto';
    second.style.flex = '1 1 auto';
  } else if (secondCollapsed && !firstCollapsed) {
    first.style.flex = '1 1 auto';
    second.style.flex = '0 0 auto';
  } else {
    first.style.flex = String(node.ratio);
    second.style.flex = String(1 - node.ratio);
  }

  el.appendChild(first);
  el.appendChild(handle);
  el.appendChild(second);

  handle.addEventListener('mousedown', e => {
    // 片側 collapsed の split では handle 操作を無効化する。
    // CSS では cursor: not-allowed で「無効」状態を視覚表現するため、pointer-events は外して
    // mousedown 側で早期 return する方式に統一。
    if (hasCollapsedChild) return;
    e.preventDefault();
    e.stopPropagation();
    const rect1 = first.getBoundingClientRect();
    const rect2 = second.getBoundingClientRect();
    const totalSize = node.direction === 'h'
      ? rect1.width + rect2.width
      : rect1.height + rect2.height;

    dragState = {
      node,
      startPos: node.direction === 'h' ? e.clientX : e.clientY,
      startRatio: node.ratio,
      totalSize,
      firstEl: first,
      secondEl: second,
    };
    document.body.classList.add(node.direction === 'h' ? 'resizing-h' : 'resizing-v');
  });

  return el;
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

// ─── Global drag handler ──────────────────────────────────────────────────────
document.addEventListener('mousemove', e => {
  if (!dragState) return;
  const { node, startPos, startRatio, totalSize, firstEl, secondEl } = dragState;
  const currentPos = node.direction === 'h' ? e.clientX : e.clientY;
  const delta = currentPos - startPos;
  const newRatio = Math.max(0.05, Math.min(0.95, startRatio + delta / totalSize));
  node.ratio = newRatio;
  firstEl.style.flex = String(newRatio);
  secondEl.style.flex = String(1 - newRatio);
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

function observePanes() {
  resizeObserver.disconnect();
  document.querySelectorAll('.pane').forEach(el => resizeObserver.observe(el));
}

window.addEventListener('resize', debouncedFitAll);

// ─── Init ─────────────────────────────────────────────────────────────────────
async function initApp() {
  // Dispose any existing terminals
  for (const [paneId, t] of Object.entries(terminals)) {
    try { t.term.dispose(); } catch (e) {}
    ipcRenderer.send('terminal:kill', t.termId);
  }
  terminals = {};
  focusedPaneId = null;

  const paneId = newId();
  tree = { type: 'leaf', id: paneId };
  await createTerminal(paneId, null);
  focusedPaneId = paneId;

  render();
  requestAnimationFrame(() => {
    fitTerminal(paneId);
    terminals[paneId]?.term.focus();
  });
}

initApp().then(() => {
  // 起動完了を main プロセスに通知（main 側で additionalPanes を順次作成する）
  ipcRenderer.send('terminal:renderer-ready');
});

// ─── State reporting to main process ─────────────────────────────────────────
setInterval(() => {
  const states = {};
  for (const [paneId, t] of Object.entries(terminals)) {
    if (!t) continue;
    // 折り畳み状態は tree 側に持っているので、レポート時に leaf を引いて取り出す
    const leaf = tree ? findNode(tree, paneId) : null;
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
      // displayTitle: 実際にペイン上部に表示している値（apiTitle || taskTitle）
      taskTitle: t.taskTitle || '',
      apiTitle: t.apiTitle || '',
      apiUrl: t.apiUrl || '',
      displayTitle: getDisplayTitle(t),
      collapsed: !!(leaf && leaf.collapsed),
    };
  }
  ipcRenderer.send('terminal:report-states', states);
}, 2000);

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
// title と url はペアで都度送る置換セマンティクス。
ipcRenderer.on('terminal:title', (event, termId, title, url) => {
  const paneId = Object.keys(terminals).find(k => terminals[k]?.termId === termId);
  if (!paneId) return;
  terminals[paneId].apiTitle = title || '';
  // url が string で渡ってきた場合のみ書き換える（旧来の 2 引数呼び出しとの後方互換のため）
  if (typeof url === 'string') {
    terminals[paneId].apiUrl = url;
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
