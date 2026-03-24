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
  /permission/i,
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
async function createTerminal(paneId, cwd) {
  const result = await ipcRenderer.invoke('terminal:create', cwd || null);
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

  const element = document.createElement('div');
  element.className = 'term-viewport';
  // NOTE: term.open(element) is called later, after element is attached to DOM

  // Input: terminal -> pty
  term.onData((data) => {
    ipcRenderer.send('terminal:input', termId, data);
    // Clear waiting on any keystroke
    if (terminals[paneId]?.waiting) {
      terminals[paneId].waiting = false;
      terminals[paneId].lastLines = '';
      updatePaneStatus(paneId);
    }
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

function getAllLeafIds(node) {
  if (node.type === 'leaf') return [node.id];
  return [...getAllLeafIds(node.first), ...getAllLeafIds(node.second)];
}

// ─── Pane actions ─────────────────────────────────────────────────────────────
async function splitPane(paneId, direction) {
  const node = findNode(tree, paneId);
  if (!node) return;

  const newPaneId = newId();
  // Inherit cwd from current pane if available
  const inheritCwd = terminals[paneId]?.cwdFull || null;
  await createTerminal(newPaneId, inheritCwd);

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
    initApp();
    return;
  }
  tree = newTree;

  // Focus another pane
  const remaining = getAllLeafIds(tree);
  if (remaining.length > 0 && (!focusedPaneId || focusedPaneId === paneId)) {
    focusedPaneId = remaining[remaining.length - 1];
  }

  render();
  requestAnimationFrame(fitAll);
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

function renderNode(node) {
  return node.type === 'leaf' ? renderLeaf(node) : renderSplit(node);
}

function renderLeaf(node) {
  const t = terminals[node.id];
  const cwd = t?.cwd || '~';
  const waiting = t?.waiting || false;
  const focused = node.id === focusedPaneId;

  const el = document.createElement('div');
  el.className = 'pane' + (focused ? ' focused' : '') + (waiting ? ' waiting' : '');
  el.dataset.id = node.id;

  const header = document.createElement('div');
  header.className = 'pane-header';
  header.innerHTML = `
    <span class="pane-cwd" title="${cwd}">${cwd}</span>
    <div class="pane-actions">
      <span class="waiting-badge" style="display:${waiting ? 'flex' : 'none'}">⚠ 待機中</span>
      <button class="btn btn-split-h" title="左右に分割">⇔</button>
      <button class="btn btn-split-v" title="上下に分割">⇕</button>
      <button class="btn btn-close" title="閉じる">✕</button>
    </div>
  `;

  const termContainer = document.createElement('div');
  termContainer.className = 'term-container';

  el.appendChild(header);
  el.appendChild(termContainer);

  header.querySelector('.btn-split-h').addEventListener('click', e => {
    e.stopPropagation();
    splitPane(node.id, 'h');
  });
  header.querySelector('.btn-split-v').addEventListener('click', e => {
    e.stopPropagation();
    splitPane(node.id, 'v');
  });
  header.querySelector('.btn-close').addEventListener('click', e => {
    e.stopPropagation();
    closePane(node.id);
  });
  el.addEventListener('mousedown', () => focusPane(node.id));

  return el;
}

function renderSplit(node) {
  const el = document.createElement('div');
  el.className = `split split-${node.direction}`;

  const first = renderNode(node.first);
  const handle = document.createElement('div');
  handle.className = `resize-handle resize-handle-${node.direction}`;
  const second = renderNode(node.second);

  first.style.flex = String(node.ratio);
  second.style.flex = String(1 - node.ratio);

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

initApp();
