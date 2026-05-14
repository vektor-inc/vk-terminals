/* global require */
const { ipcRenderer, shell } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');

// ─── State ────────────────────────────────────────────────────────────────────
let tree = null;       // Layout tree root
let terminals = {};    // paneId -> { termId, term, fitAddon, element, cwd, cwdFull, waiting, lastLines }
let focusedPaneId = null;
let dragState = null;

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
];

function stripAnsi(str) {
  return str
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[^[\]]/g, '')
    .replace(/\r/g, '\n');  // \r を \n に変換して行バッファに乗せる
}

function checkWaiting(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  const clean = stripAnsi(t.lastLines);
  const waiting = WAITING_PATTERNS.some(p => p.test(clean));
  if (waiting !== t.waiting) {
    t.waiting = waiting;
    updatePaneStatus(paneId);
    // 待機状態になったときに通知音を鳴らす
    if (waiting) shell.beep();
  }
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
      updatePaneStatus(paneId);
    }
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
    lastLines: '',
    lastOutputTime: Date.now(),
    lastInputTime: 0,
    taskTitle: '',
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
  const stripped = stripAnsi(data);
  t.lastLines = (t.lastLines + stripped).split('\n').slice(-15).join('\n');
  t.lastOutputTime = Date.now();
  checkWaiting(paneId);
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

function updatePaneTitle(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  const el = document.querySelector(`.pane[data-id="${paneId}"] .pane-task-title`);
  if (!el) return;
  const title = t.taskTitle || '';
  el.textContent = title;
  el.title = title;
  el.classList.toggle('empty', title.length === 0);
}

function updatePaneStatus(paneId) {
  const t = terminals[paneId];
  if (!t) return;
  const paneEl = document.querySelector(`.pane[data-id="${paneId}"]`);
  if (!paneEl) return;
  paneEl.classList.toggle('waiting', t.waiting);
  const badge = paneEl.querySelector('.waiting-badge');
  if (badge) badge.style.display = t.waiting ? 'flex' : 'none';
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

// tree 内の leaf 2つの「位置」を入れ替える（leaf.id 文字列をスワップすることで等価に実現）。
// terminals マップは paneId キーのまま不変なので、HTTP API / states.json の termId 紐付けには影響しない。
function swapLeavesInTree(node, idA, idB) {
  if (node.type === 'leaf') {
    if (node.id === idA) return { type: 'leaf', id: idB };
    if (node.id === idB) return { type: 'leaf', id: idA };
    return node;
  }
  return {
    ...node,
    first: swapLeavesInTree(node.first, idA, idB),
    second: swapLeavesInTree(node.second, idA, idB),
  };
}

function getAllLeafIds(node) {
  if (node.type === 'leaf') return [node.id];
  return [...getAllLeafIds(node.first), ...getAllLeafIds(node.second)];
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
function toggleCollapse(paneId) {
  const leaf = findNode(tree, paneId);
  if (!leaf || leaf.type !== 'leaf') return;
  const found = findParentSplit(tree, paneId);
  if (!found || !found.parent) return; // ルート leaf は折り畳まない
  const parent = found.parent;

  const willCollapse = !leaf.collapsed;
  if (willCollapse) {
    // 現在の ratio を退避してから collapse
    parent.savedRatio = parent.ratio;
    leaf.collapsed = true;
  } else {
    // 元の ratio を復元
    leaf.collapsed = false;
    if (typeof parent.savedRatio === 'number') {
      parent.ratio = parent.savedRatio;
      delete parent.savedRatio;
    } else {
      parent.ratio = 0.5;
    }
  }

  render();
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

function renderLeaf(node, parentDirection) {
  const t = terminals[node.id];
  const cwd = t?.cwd || '~';
  const waiting = t?.waiting || false;
  const focused = node.id === focusedPaneId;
  const taskTitle = t?.taskTitle || '';
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
  const taskTitleEl = document.createElement('div');
  taskTitleEl.className = 'pane-task-title' + (taskTitle ? '' : ' empty');
  taskTitleEl.textContent = taskTitle;
  if (taskTitle) taskTitleEl.title = taskTitle;
  el.appendChild(taskTitleEl);

  const header = document.createElement('div');
  header.className = 'pane-header';
  // .btn-collapse は親 split が split-v のときだけ表示（canCollapse）。
  // chevron: 展開中は ▾（下向き = 中身が見えている）、折り畳み中は ▸（右向き = 閉じている）。
  const collapseBtnHtml = canCollapse
    ? `<button class="btn btn-collapse" title="${collapsed ? '展開する' : '折り畳む'}">${collapsed ? '▸' : '▾'}</button>`
    : '';
  header.innerHTML = `
    <span class="pane-cwd" title="${cwd}">${cwd}</span>
    <div class="pane-actions">
      <span class="auto-input-badge" style="display:none"></span>
      <span class="waiting-badge" style="display:${waiting ? 'flex' : 'none'}">⚠ 待機中</span>
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
      waiting: t.waiting,
      lastOutputTime: t.lastOutputTime,
      lastInputTime: t.lastInputTime,
      lastLines: t.lastLines,
      taskTitle: t.taskTitle || '',
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
ipcRenderer.on('terminal:title', (event, termId, title) => {
  const paneId = Object.keys(terminals).find(k => terminals[k]?.termId === termId);
  if (!paneId) return;
  terminals[paneId].taskTitle = title || '';
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
    badge.style.display = 'flex';
    paneEl.classList.add('auto-input');
    setTimeout(() => {
      const el = document.querySelector(`.pane[data-id="${paneId}"]`);
      if (!el) return;
      const b = el.querySelector('.auto-input-badge');
      if (b) b.style.display = 'none';
      el.classList.remove('auto-input');
    }, 3000);
  }
});
