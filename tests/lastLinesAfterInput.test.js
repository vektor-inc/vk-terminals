'use strict';

// issue #623: 入力待ちのペインに入力が入ったあと、アプリが画面を描き直さなくても、
// /api/states の lastLines が画面に残っている確認画面を返すことを確かめる。
// renderer/app.js の terminal:data ハンドラ・checkWaiting・markPaneInput・/api/states の
// lastLines の式を取り出して vm で動かし、実際の配線どおりに流す。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const waitingState = require('../renderer/waitingState');
const { shouldBeepForPaneWaiting } = require('../renderer/statusState');
const { createDisplayScreen, stripAnsiForDisplay } = require('../utils/stripAnsi');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

// app.js から start で始まり end の直前までのソースを切り出す。
function sliceSource(start, end) {
  const from = appSource.indexOf(start);
  const to = appSource.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `${start} が app.js に見つからない`);
  return appSource.slice(from, to);
}

// /api/states が返す lastLines の式を、状態を組み立てる箇所から取り出す。
function reportedLastLinesExpression() {
  const builder = sliceSource('states[paneId] = {', 'backgroundAgents: readBackgroundAgents(t)');
  const m = builder.match(/^\s+lastLines: (.+),$/m);
  assert.ok(m, '/api/states の lastLines が見つからない');
  return m[1];
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

// app.js の関数を vm 上で動かすための環境を作る。
function createHarness() {
  let now = 100000;
  let dataHandler = null;
  const beeps = [];
  const pane = {
    termId: 't1',
    term: { write: () => {} },
    cwdFull: '/tmp/work',
    apiUrl: '',
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
    decodeURIComponent,
    LASTLINES_MAX_LINES: 80,
    LASTLINES_MAX_CHARS: 8000,
    stripAnsiForDisplay,
    shouldBeepForPaneWaiting,
    waitingExcludeCwdPatterns: [],
    VKShell: { beep: () => beeps.push(now) },
    VKIpc: { on: (name, fn) => { if (name === 'terminal:data') dataHandler = fn; } },
    isPaneDisplayWaiting: (t) => t.waiting === true,
    recomputeStatus: () => {},
    scheduleWaitingCheck: () => {},
    clearWaitingCheckTimer: (t) => { t.waitingCheckTimer = null; },
    formatCwd: (p) => p,
    updatePaneCwd: () => {},
    bumpRunning: () => {},
  };
  vm.createContext(context);
  vm.runInContext([
    sliceSource('function checkWaiting(paneId)', 'function scheduleWaitingCheck(paneId)'),
    sliceSource('function appendWaitingBuffer(screen, data)', '// バックグラウンドサブエージェント数（issue #340）を'),
    sliceSource('function markPaneInput(paneId)', 'function clearRunningIdleTimer(t)'),
    sliceSource("VKIpc.on('terminal:data',", "VKIpc.on('terminal:exit',"),
    `function reportedLastLines(t) { return ${reportedLastLinesExpression()}; }`,
  ].join('\n'), context);

  return {
    pane,
    beeps,
    // PTY 出力が届いた（terminal:data）。
    output(data) { now += 10; dataHandler('t1', data, null); },
    // 出力が止まってから入力待ちの判定を走らせる。
    settle() { now += waitingState.WAITING_QUIESCENCE_MS + 100; context.checkWaiting('p1'); },
    // 入力（API 送信の Enter など）が入った。
    input() { now += 10; context.markPaneInput('p1'); },
    reported() { return context.reportedLastLines(pane); },
  };
}

test('入力待ちに入力が入り、アプリが画面を描き直さなくても API の lastLines は確認画面を返す', () => {
  const h = createHarness();
  h.output(FOLDER_ACCESS);
  h.settle();
  assert.equal(h.pane.waiting, true, '前提: Folder access 画面で入力待ちになる');

  h.input();
  assert.equal(h.pane.waiting, false, '入力で入力待ちは解除される');
  assert.match(h.reported(), /1\. Open restricted/);
  assert.match(h.reported(), /2\. Back to Agent Command Center/);
});

test('入力直後に判定が走っても、保持した確認画面で入力待ちが再点灯せずビープも鳴らない', () => {
  const h = createHarness();
  h.output(FOLDER_ACCESS);
  h.settle();
  assert.equal(h.beeps.length, 1, '前提: 最初の点灯でビープが 1 回鳴る');

  h.input();
  h.settle();
  h.settle();
  assert.equal(h.pane.waiting, false);
  assert.equal(h.pane.structuralWaiting, false);
  assert.equal(h.pane.lastLines, '', '判定用の lastLines は入力時に空にしたまま');
  assert.equal(h.beeps.length, 1);
  assert.match(h.reported(), /1\. Open restricted/, 'API には確認画面を返し続ける');
});

test('文字を含まない出力では切り替えず、アプリが描き直した時点で新しい画面を返す', () => {
  const h = createHarness();
  h.output(FOLDER_ACCESS);
  h.settle();
  h.input();

  // カーソルの表示切り替えだけの出力では、画面の文字は変わらない。
  h.output('\x1b[?25l\x1b[?25h');
  assert.match(h.reported(), /1\. Open restricted/);

  // アプリが次の画面を描いたら、入力前の確認画面は返さない。
  h.output('• Working (0s • esc to interrupt)');
  assert.equal(h.reported(), '• Working (0s • esc to interrupt)');
  assert.equal(h.pane.linesBeforeInput, '');

  // その後の入力（入力待ちではないとき）でも、古い確認画面を持ち出さない。
  h.input();
  assert.equal(h.reported(), '• Working (0s • esc to interrupt)');
});

test('selectReportedLastLines は lastLines に文字があればそれを、空白だけなら入力前の内容を返す', () => {
  const { selectReportedLastLines } = waitingState;
  assert.equal(selectReportedLastLines({ lastLines: 'next', linesBeforeInput: 'before' }), 'next');
  assert.equal(selectReportedLastLines({ lastLines: '\n  \n', linesBeforeInput: 'before' }), 'before');
  assert.equal(selectReportedLastLines({ lastLines: '', linesBeforeInput: '' }), '');
  assert.equal(selectReportedLastLines({ lastLines: undefined, linesBeforeInput: undefined }), '');
});
