'use strict';

// issue #623: 入力待ちのペインに入力が入ったあと、アプリが画面を描き直さなくても、
// /api/states の lastLines が画面に残っている確認画面を返すことを確かめる。
// renderer/app.js の terminal:data・terminal:engine-changed ハンドラ・checkWaiting・markPaneInput・
// /api/states の画面の組み立て（buildReportedScreen）と、main.js の状態報告の受け取り
// （識別値の採取と再結合）を取り出して vm で動かし、実際の配線どおりに流す。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const waitingState = require('../renderer/waitingState');
const { shouldBeepForPaneWaiting } = require('../renderer/statusState');
const { createDisplayScreen, stripAnsiForDisplay } = require('../utils/stripAnsi');
const { createCwdReportReader } = require('../renderer/terminalDisplay');
const {
  createConditionalTerminalInputGuard,
  mergeConditionalScreenIdentifiers,
} = require('../utils/conditionalTerminalInput');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

// source から start で始まり end の直前までを切り出す。
function sliceSource(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} が見つからない`);
  return source.slice(from, to);
}

// /api/states の状態オブジェクトのうち、画面の文字列と識別値の 3 項目を取り出す式。
// 状態オブジェクトの範囲に限って探す（markPaneInput 等の同名の記述に当てない）。
function reportedFieldExpressions() {
  const builder = sliceSource(appSource, 'states[paneId] = {', 'backgroundAgents: readBackgroundAgents(t)');
  const pick = (name) => {
    const m = builder.match(new RegExp(`^\\s+${name}: (.+),$`, 'm'));
    assert.ok(m, `/api/states の ${name} が見つからない`);
    return m[1];
  };
  // 修正前は状態オブジェクトの直前で組を作らないため、組み立て用の行も一緒に取り出す。
  const prelude = (sliceSource(appSource, 'if (agentRoomEnabled) refreshAgentRoomIfChanged(paneId);', 'states[paneId] = {')
    .match(/^\s+const reportedScreen = .+;$/m) || [''])[0];
  return `${prelude}\nreturn { lastLines: ${pick('lastLines')}, screenIdentifier: ${pick('screenIdentifier')}, screenIdentifierGeneration: ${pick('screenIdentifierGeneration')} };`;
}

// Codex の Folder access 画面（信頼していないフォルダを開くときの確認画面）。
const FOLDER_ACCESS = [
  '  Folder access',
  '',
  '  Codex wants to work in this folder.',
  '',
  '› 1. Open restricted',
  '  2. Back to Agent Command Center',
  '',
  '  Press enter to continue',
].join('\r\n');

const TERM_ID = '7';

// app.js・main.js の処理を vm 上で動かすための環境を作る。
function createHarness() {
  let now = 100000;
  let generation = 1;
  const handlers = {};
  const beeps = [];
  const guard = createConditionalTerminalInputGuard({ secret: 'test-secret' });
  guard.initialize(TERM_ID);
  const writes = [];
  const dependencies = {
    getPty: () => ({ write: (value) => writes.push(value) }),
    getGeneration: () => generation,
  };
  const pane = {
    termId: TERM_ID,
    term: { write: () => {} },
    cwdFull: '/tmp/work',
    apiUrl: '',
    engine: 'codex',
    waiting: false,
    structuralWaiting: false,
    externalWaiting: false,
    waitingCheckTimer: null,
    waitingPendingSince: 0,
    lastWaitingBeepAt: 0,
    localWaitingOnset: null,
    waitingOnsetMatch: null,
    waitingOnsetKey: null,
    lastBeepedOnsetKey: null,
    lastLines: '',
    linesBeforeInput: '',
    linesBeforeInputGeneration: null,
    outputTailSinceInput: '',
    screenIdentifier: null,
    screenIdentifierGeneration: null,
    lastScreen: createDisplayScreen(),
    recentScreen: createDisplayScreen(),
    recentLines: '',
    lastOutputTime: now,
    lastInputTime: 0,
  };
  const context = {
    ...waitingState,
    terminals: { p1: pane },
    Date: { now: () => now },
    Object,
    Number,
    decodeURIComponent,
    LASTLINES_MAX_LINES: 80,
    LASTLINES_MAX_CHARS: 8000,
    stripAnsiForDisplay,
    shouldBeepForPaneWaiting,
    waitingExcludeCwdPatterns: [],
    VKShell: { beep: () => beeps.push(now) },
    VKIpc: { on: (name, fn) => { handlers[name] = fn; } },
    isPaneDisplayWaiting: (t) => t.waiting === true,
    recomputeStatus: () => {},
    scheduleWaitingCheck: () => {},
    clearWaitingCheckTimer: (t) => { t.waitingCheckTimer = null; },
    formatCwd: (p) => p,
    updatePaneCwd: () => {},
    createCwdReportReader,
    bumpRunning: () => {},
  };
  vm.createContext(context);
  const markPaneInputSource = sliceSource(appSource, 'function markPaneInput(paneId)', 'function clearRunningIdleTimer(t)');
  vm.runInContext([
    sliceSource(appSource, 'function checkWaiting(paneId)', 'function scheduleWaitingCheck(paneId)'),
    sliceSource(appSource, 'function appendWaitingBuffer(screen, data)', '// バックグラウンドサブエージェント数（issue #340）を'),
    markPaneInputSource,
    sliceSource(appSource, "VKIpc.on('terminal:data',", "VKIpc.on('terminal:exit',"),
    sliceSource(appSource, "VKIpc.on('terminal:engine-changed',", '// ─── Status update from main'),
    `function reportedScreenOf(t) { ${reportedFieldExpressions()} }`,
  ].join('\n'), context);

  // main.js の terminal:report-states のうち、renderer の報告から識別値を採る部分。
  const collectSnapshots = new vm.Script(
    `(() => { ${sliceSource(mainSource, 'const nextScreenSnapshots = new Map();', 'reportedScreenSnapshots = nextScreenSnapshots;')} return nextScreenSnapshots; })()`
  );

  return {
    pane,
    beeps,
    writes,
    guard,
    dependencies,
    // PTY 出力が届いた（main.js の onData と同じく、画面番号を進めて識別値を採ってから渡す）。
    output(data) {
      now += 10;
      guard.markChanged(TERM_ID);
      handlers['terminal:data'](TERM_ID, data, guard.capture(TERM_ID, generation));
    },
    // 出力が止まってから入力待ちの判定を走らせる。
    settle() { now += waitingState.WAITING_QUIESCENCE_MS + 100; context.checkWaiting('p1'); },
    // 入力（API 送信の Enter など）が入った。main 側は入力として画面番号を進める。
    input() {
      now += 10;
      guard.markChanged(TERM_ID, true);
      context.markPaneInput('p1');
    },
    // 起動し直しでエージェントの世代だけが進んだ（engine-changed はまだ届いていない）。
    bumpGeneration() { generation += 1; },
    // POST /api/restart-agent が成功した（世代を進め、engine-changed を送る）。
    restartAgent() {
      generation += 1;
      guard.markChanged(TERM_ID);
      handlers['terminal:engine-changed'](TERM_ID, 'codex');
    },
    // renderer の /api/states の値を main が受け取り、再結合して外部へ返す値。
    api() {
      const reported = context.reportedScreenOf(pane);
      const states = { p1: { termId: TERM_ID, agentGeneration: generation, ...reported } };
      const snapshots = collectSnapshots.runInNewContext({ states, Map, Number, Object, String });
      return mergeConditionalScreenIdentifiers(states, snapshots, guard).p1;
    },
    // 公開された識別値で条件付き Enter を送る。
    conditionalEnter(screenIdentifier) {
      return guard.writeEnter({ termId: TERM_ID, expectedGeneration: generation, expectedScreenIdentifier: screenIdentifier }, dependencies);
    },
  };
}

// Folder access 画面で入力待ちになり、Enter を受けたがアプリが画面を描き直さなかった状態まで進める。
function enterIgnored() {
  const h = createHarness();
  h.output(FOLDER_ACCESS);
  h.settle();
  assert.equal(h.pane.waiting, true, '前提: Folder access 画面で入力待ちになる');
  h.input();
  return h;
}

test('入力待ちに入力が入り、アプリが画面を描き直さなくても API の lastLines は確認画面を返す', () => {
  const h = enterIgnored();
  assert.equal(h.pane.waiting, false, '入力で入力待ちは解除される');
  const api = h.api();
  assert.match(api.lastLines, /1\. Open restricted/);
  assert.match(api.lastLines, /2\. Back to Agent Command Center/);
  assert.equal(api.screenIdentifier, null, '入力後に画面が変わっていない間は識別値を返さない');
});

test('入力直後に判定が走っても、保持した確認画面で入力待ちが再点灯せずビープも鳴らない', () => {
  const h = enterIgnored();
  assert.equal(h.beeps.length, 1, '前提: 最初の点灯でビープが 1 回鳴る');
  h.settle();
  h.settle();
  assert.equal(h.pane.waiting, false);
  assert.equal(h.pane.structuralWaiting, false);
  assert.equal(h.pane.lastLines, '', '判定用の lastLines は入力時に空にしたまま');
  assert.equal(h.beeps.length, 1);
  assert.match(h.api().lastLines, /1\. Open restricted/, 'API には確認画面を返し続ける');
});

test('カーソルの表示切り替えだけの出力では確認画面を返し続け、識別値は公開せず条件付き Enter も通らない', () => {
  const h = enterIgnored();
  h.output('\x1b[?25l\x1b[?25h');
  const api = h.api();
  assert.match(api.lastLines, /1\. Open restricted/);
  assert.equal(api.screenIdentifier, null);
  // renderer は新しい出力の識別値を持っているが、古い画面と組にして公開しない。
  // 公開すると照合を通ってしまう値であることも確かめる（安藤の指摘 HIGH）。
  assert.equal(typeof h.pane.screenIdentifier, 'string');
  assert.equal(h.guard.isCurrent(TERM_ID, { agentGeneration: 1, screenIdentifier: h.pane.screenIdentifier }), true);
  assert.equal(h.conditionalEnter(api.screenIdentifier).ok, false);
  assert.deepEqual(h.writes, []);
});

test('画面を消す制御列が届いたら、文字の出力が無くても入力前の画面を返さない', () => {
  const sequences = {
    '画面全体の消去': '\x1b[2J',
    'スクロールバックの消去': '\x1b[3J',
    'カーソルを左上へ移してから以降を消去': '\x1b[H\x1b[J',
    'カーソル位置以降の消去': '\x1b[0J',
    '行の消去': '\x1b[2K',
    '端末の初期化': '\x1bc',
    '代替画面への切り替え': '\x1b[?1049h',
  };
  for (const [name, seq] of Object.entries(sequences)) {
    const h = enterIgnored();
    h.output(seq);
    const api = h.api();
    assert.doesNotMatch(api.lastLines, /Open restricted/, name);
    assert.equal(h.pane.linesBeforeInput, '', name);
    // 入力前の画面を返していないので、識別値は新しい出力のものを公開する。
    assert.equal(typeof api.screenIdentifier, 'string', name);
  }
});

test('画面を消す制御列がチャンクの境界で分かれて届いても拾う', () => {
  const h = enterIgnored();
  h.output('\x1b[?25l\x1b[');
  assert.match(h.api().lastLines, /Open restricted/, '途中までの制御列ではまだ保持する');
  h.output('2J');
  assert.doesNotMatch(h.api().lastLines, /Open restricted/);
});

test('アプリが新しい画面を描いたら、入力前の確認画面ではなく新しい画面と識別値を返す', () => {
  const h = enterIgnored();
  h.output('• Working (0s • esc to interrupt)');
  const api = h.api();
  assert.equal(api.lastLines, '• Working (0s • esc to interrupt)');
  assert.equal(typeof api.screenIdentifier, 'string');
  assert.equal(h.pane.linesBeforeInput, '');

  // その後の入力（入力待ちではないとき）でも、古い確認画面を持ち出さない。
  h.input();
  assert.equal(h.api().lastLines, '• Working (0s • esc to interrupt)');
});

test('同じペインでエージェントを起動し直したら、文字の出力がまだ無くても入力前の画面を返さない', () => {
  const h = enterIgnored();
  h.restartAgent();
  assert.equal(h.pane.linesBeforeInput, '');
  assert.doesNotMatch(h.api().lastLines, /Open restricted/);
});

test('起動し直しで世代の変わった出力が届いたら、文字を含まなくても入力前の画面を返さない', () => {
  const h = enterIgnored();
  // engine-changed より先に、新しい世代の出力（文字を含まない）が届く場合。
  h.bumpGeneration();
  h.output('\x1b[?25l');
  assert.equal(h.pane.linesBeforeInput, '');
  assert.doesNotMatch(h.api().lastLines, /Open restricted/);
});
