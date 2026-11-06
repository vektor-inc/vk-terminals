'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  createConditionalTerminalInputGuard,
  mergeConditionalScreenIdentifiers,
  validateConditionalEnterRequest,
  createSilentWriteRefresher,
  SILENT_WRITE_QUIET_MS,
} = require('../utils/conditionalTerminalInput');

function setup() {
  const writes = [];
  const generations = new Map([['1', 4]]);
  const ptys = new Map([['1', { write: (value) => writes.push(value) }]]);
  const guard = createConditionalTerminalInputGuard({ secret: 'test-secret' });
  guard.initialize('1');
  return {
    guard,
    writes,
    generations,
    ptys,
    dependencies: {
      getPty: (id) => ptys.get(id),
      getGeneration: (id) => generations.get(id),
    },
  };
}

function request(snapshot) {
  return {
    termId: '1',
    expectedGeneration: snapshot.agentGeneration,
    expectedScreenIdentifier: snapshot.screenIdentifier,
  };
}

test('画面識別値と起動世代が一致する場合だけ Enter を1回送る', () => {
  const context = setup();
  const snapshot = context.guard.capture('1', 4);

  assert.deepEqual(context.guard.writeEnter(request(snapshot), context.dependencies), { ok: true, termId: '1' });
  assert.deepEqual(context.writes, ['\r']);
});

test('画面出力が取得後に変化した場合は Enter を送らない', () => {
  const context = setup();
  const snapshot = context.guard.capture('1', 4);

  context.guard.markChanged('1');

  assert.deepEqual(context.guard.writeEnter(request(snapshot), context.dependencies), {
    ok: false,
    reason: 'screen-changed',
    currentGeneration: 4,
  });
  assert.deepEqual(context.writes, []);
});

test('同じペインで Codex の起動世代が変化した場合は Enter を送らない', () => {
  const context = setup();
  const snapshot = context.guard.capture('1', 4);

  context.generations.set('1', 5);

  assert.deepEqual(context.guard.writeEnter(request(snapshot), context.dependencies), {
    ok: false,
    reason: 'generation-changed',
    currentGeneration: 5,
  });
  assert.deepEqual(context.writes, []);
});

test('選択肢移動、ペイン消失、重複依頼では想定外の Enter を送らない', () => {
  const moved = setup();
  const beforeMove = moved.guard.capture('1', 4);
  moved.guard.markChanged('1');
  assert.equal(moved.guard.writeEnter(request(beforeMove), moved.dependencies).reason, 'screen-changed');
  assert.deepEqual(moved.writes, []);

  const disappeared = setup();
  const beforeClose = disappeared.guard.capture('1', 4);
  disappeared.ptys.delete('1');
  disappeared.guard.delete('1');
  assert.deepEqual(disappeared.guard.writeEnter(request(beforeClose), disappeared.dependencies), {
    ok: false,
    reason: 'pane-not-found',
  });
  assert.deepEqual(disappeared.writes, []);

  const duplicate = setup();
  const sameRequest = request(duplicate.guard.capture('1', 4));
  assert.equal(duplicate.guard.writeEnter(sameRequest, duplicate.dependencies).ok, true);
  assert.equal(duplicate.guard.writeEnter(sameRequest, duplicate.dependencies).reason, 'screen-changed');
  assert.deepEqual(duplicate.writes, ['\r']);
});

test('画面識別値は改ざんすると一致せず、報告後に世代が変わると states へ再利用しない', () => {
  const context = setup();
  const snapshot = context.guard.capture('1', 4);
  const tampered = `${snapshot.screenIdentifier.slice(0, -1)}${snapshot.screenIdentifier.endsWith('A') ? 'B' : 'A'}`;
  assert.equal(context.guard.writeEnter({ ...request(snapshot), expectedScreenIdentifier: tampered }, context.dependencies).reason, 'screen-changed');

  const states = {
    pane1: {
      termId: '1',
      agentGeneration: 5,
      lastLines: 'new screen',
      screenIdentifier: snapshot.screenIdentifier,
      screenIdentifierGeneration: 4,
    },
  };
  assert.deepEqual(mergeConditionalScreenIdentifiers(states, new Map([['1', snapshot]])), {
    pane1: { termId: '1', agentGeneration: 5, lastLines: 'new screen', screenIdentifier: null },
  });
});

test('expected を省略した通常入力は互換性を保ち、明示した条件付き入力は Enter だけを許可する', () => {
  assert.deepEqual(validateConditionalEnterRequest({ termId: '1', input: 'hello\r' }), { conditional: false });
  assert.deepEqual(validateConditionalEnterRequest({ termId: '1', input: '\r', expected: null }), {
    conditional: true,
    ok: false,
    error: 'expected must be an object',
  });
  assert.equal(validateConditionalEnterRequest({
    termId: '1',
    input: 'y\r',
    expected: { agentGeneration: 4, screenIdentifier: 'A'.repeat(43) },
  }).ok, false);
  assert.deepEqual(validateConditionalEnterRequest({
    termId: '1',
    input: '\r',
    expected: { agentGeneration: 4, screenIdentifier: 'A'.repeat(43) },
  }), {
    conditional: true,
    ok: true,
    request: { termId: '1', expectedGeneration: 4, expectedScreenIdentifier: 'A'.repeat(43) },
  });
});

test('main は PTY 入出力を識別値へ反映し、条件付き Enter を専用ガードへ渡す', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  const sendRouteStart = source.indexOf("if (req.method === 'POST' && url.pathname === '/api/send')");
  const sendRouteEnd = source.indexOf("if (req.method === 'POST' && url.pathname === '/api/widgets/command')", sendRouteStart);
  const sendRoute = source.slice(sendRouteStart, sendRouteEnd);
  assert.match(source, /ptyProcess\.write = \(data\) => \{\s*conditionalTerminalInput\.markChanged\(id, !\(isTerminalQueryReplyOnly\(data\) \|\| isTerminalFocusNotificationOnly\(data\)\)\)/);
  assert.match(source, /ptyProcess\.onData\(\(data\) => \{[\s\S]*?conditionalTerminalInput\.markChanged\(id\)[\s\S]*?terminal:data/);
  assert.match(source, /validateConditionalEnterRequest\(parsed\)[\s\S]*conditionalTerminalInput\.writeEnter/);
  assert.ok(
    sendRoute.indexOf('validateConditionalEnterRequest(parsed)') < sendRoute.indexOf('const p = ptys.get(String(termId))'),
    '条件付き要求は通常入力用のペイン存在チェックより先に処理する'
  );
  assert.match(sendRoute, /result\.reason === 'pane-not-found' \? 404/);
  assert.match(source, /mergeConditionalScreenIdentifiers\([\s\S]*reportedScreenSnapshots/);
  assert.match(rendererSource, /VKIpc\.on\('terminal:data', \(id, data, screenSnapshot\)/);
  assert.match(rendererSource, /lastLines: t\.lastLines,[\s\S]*screenIdentifier: t\.screenIdentifier/);
});

test('issue #517: 画面出力の無い PTY 書き込みの後、states の識別値は「最新ではない」と分かる形で返す', () => {
  const context = setup();
  const snapshot = context.guard.capture('1', 4);
  const states = {
    pane1: { termId: '1', agentGeneration: 4, lastLines: 'screen', screenIdentifier: snapshot.screenIdentifier, screenIdentifierGeneration: 4 },
  };
  const snapshots = new Map([['1', snapshot]]);
  // 最新の間は識別値をそのまま返し、stale 印は付けない。
  assert.deepEqual(mergeConditionalScreenIdentifiers(states, snapshots, context.guard).pane1, {
    termId: '1', agentGeneration: 4, lastLines: 'screen', screenIdentifier: snapshot.screenIdentifier,
  });
  // 端末問い合わせへの自動応答など、出力を伴わない書き込みで番号だけ進む。
  context.guard.markChanged('1');
  const merged = mergeConditionalScreenIdentifiers(states, snapshots, context.guard).pane1;
  assert.equal(merged.screenIdentifier, null);
  assert.equal(merged.screenIdentifierStale, true);
  // 古い識別値での Enter は引き続き拒否される（安全側の意図は維持）。
  assert.equal(context.guard.writeEnter(request(snapshot), context.dependencies).reason, 'screen-changed');
  // 新しい出力で再採取されれば、再び識別値が返り、Enter も通る。
  const fresh = context.guard.capture('1', 4);
  const refreshed = mergeConditionalScreenIdentifiers(
    { pane1: { ...states.pane1, screenIdentifier: fresh.screenIdentifier } },
    new Map([['1', fresh]]),
    context.guard
  ).pane1;
  assert.equal(refreshed.screenIdentifier, fresh.screenIdentifier);
  assert.equal('screenIdentifierStale' in refreshed, false);
  assert.equal(context.guard.writeEnter(request(fresh), context.dependencies).ok, true);
});

test('issue #517: main は /api/states と状態ファイルの識別値をガードの現在番号で照合する', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const calls = source.match(/mergeConditionalScreenIdentifiers\([\s\S]*?reportedScreenSnapshots,\s*conditionalTerminalInput\s*\)/g) || [];
  assert.equal(calls.length, 2);
});

// ─── issue #517 差し戻し: 出力の無い書き込みの後、静止時間が過ぎたら識別値を採り直す ──────
function refresherSetup() {
  const context = setup();
  const timers = [];
  const sent = [];
  const refresher = createSilentWriteRefresher({
    guard: context.guard,
    quietMs: SILENT_WRITE_QUIET_MS,
    getGeneration: (id) => context.generations.get(id),
    send: (id, snapshot) => sent.push({ id, snapshot }),
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
    clearTimer: (t) => { t.cleared = true; },
  });
  const fire = () => timers.filter((t) => !t.cleared).forEach((t) => { t.cleared = true; t.fn(); });
  return { ...context, refresher, timers, sent, fire };
}

function terminalInputHarness() {
  const context = refresherSetup();
  const handlers = new Map();
  const writes = [];
  const startupInputs = [];
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const wrapper = source.match(/ptyProcess\.write = \(data\) => \{[\s\S]*?\n  \};/)[0];
  const handler = source.match(/ipcMain\.on\('terminal:input'[\s\S]*?\n\}\);/)[0];
  const { isTerminalQueryReplyOnly, isTerminalFocusNotificationOnly } = require('../utils/terminalUserInput');
  const ptyProcess = {};
  // 実際の全書き込みラッパーも評価し、API・自動 Enter と同じ入口を使う。
  vm.runInNewContext(wrapper, {
    ptyProcess,
    shellStartup: { onInput: (data) => {
      assert.equal(writes.at(-1), data);
      startupInputs.push(data);
    } },
    id: '1',
    conditionalTerminalInput: context.guard,
    silentWriteRefresher: context.refresher,
    isTerminalQueryReplyOnly,
    isTerminalFocusNotificationOnly,
    writeToPty: (data) => writes.push(data),
  });
  vm.runInNewContext(handler, {
    ipcMain: { on: (name, callback) => handlers.set(name, callback) },
    ptys: new Map([['1', ptyProcess]]),
    disarmTrustAutomationForUserInput: () => {},
    silentWriteRefresher: context.refresher,
    isTerminalQueryReplyOnly,
    isTerminalFocusNotificationOnly,
  });
  return { ...context, writes, startupInputs, ptyProcess, input: (data) => handlers.get('terminal:input')(null, '1', data) };
}

test('issue #540: 実際の terminal:input 経路でフォーカス通知後は静止時に採り直し、出力時は取り消す', () => {
  const quiet = terminalInputHarness();
  const before = quiet.guard.capture('1', 4);
  quiet.input('\x1b[I');
  assert.deepEqual(quiet.writes, ['\x1b[I']);
  assert.equal(mergeConditionalScreenIdentifiers({ pane1: { termId: '1', agentGeneration: 4 } }, new Map([['1', before]]), quiet.guard).pane1.screenIdentifierStale, true);
  assert.equal(quiet.timers[0].ms, SILENT_WRITE_QUIET_MS);
  assert.equal(quiet.sent.length, 0);
  quiet.fire();
  assert.equal(quiet.sent.length, 1);
  assert.equal(quiet.guard.isCurrent('1', quiet.sent[0].snapshot), true);
  assert.equal(quiet.guard.writeEnter(request(quiet.sent[0].snapshot), quiet.dependencies).ok, true);

  const output = terminalInputHarness();
  output.input('\x1b[O');
  output.guard.markChanged('1');
  output.refresher.noteOutput('1');
  output.fire();
  assert.equal(output.sent.length, 0);

  const mouse = terminalInputHarness();
  mouse.input('\x1b[<0;10;5M');
  mouse.fire();
  assert.equal(mouse.sent.length, 0);
});

for (const input of ['\r', '\x1b[A', 'a']) {
  test(`issue #540: 通常入力 ${JSON.stringify(input)} 後は通知でも採り直さず、可視出力後に再開する`, () => {
    const c = terminalInputHarness();
    const stale = c.guard.capture('1', 4);
    c.input(input);
    // フォーカス・問い合わせ応答・リサイズも、出力待ちを解除できない。
    c.input('\x1b[I');
    c.input('\x1b[O');
    c.input('\x1b[0n');
    c.refresher.noteWrite('1');
    c.fire();
    assert.equal(c.sent.length, 0);
    assert.equal(c.guard.isCurrent('1', stale), false);
    assert.equal(c.guard.writeEnter(request(stale), c.dependencies).reason, 'screen-changed');

    c.guard.markChanged('1');
    c.refresher.noteOutput('1');
    c.input('\x1b[I');
    assert.equal(c.timers.at(-1).ms, 800);
    c.fire();
    assert.equal(c.sent.length, 1);
    assert.equal(c.guard.writeEnter(request(c.sent[0].snapshot), c.dependencies).ok, true);
  });

  test(`issue #540: フォーカス通知後の通常入力 ${JSON.stringify(input)} は予約を取り消す`, () => {
    const c = terminalInputHarness();
    c.input('\x1b[O');
    c.input(input);
    assert.equal(c.timers[0].cleared, true);
    c.fire();
    assert.equal(c.sent.length, 0);
  });
}

test('issue #540: API・自動 Enter のラッパー経由入力後もフォーカス通知で採り直せない', () => {
  const c = terminalInputHarness();
  c.ptyProcess.write('\r');
  c.input('\x1b[I');
  c.fire();
  assert.equal(c.sent.length, 0);
});

test('issue #540: 抑止はペインごとに管理し、ペイン削除時に破棄する', () => {
  const c = refresherSetup();
  c.guard.initialize('2');
  c.generations.set('2', 4);
  c.refresher.noteInput('1');
  c.refresher.noteWrite('2');
  c.fire();
  assert.equal(c.sent[0].id, '2');
  c.refresher.delete('1');
  c.refresher.noteWrite('1');
  c.fire();
  assert.equal(c.sent[1].id, '1');
});

test('issue #517: 出力の無い書き込みの後、静止時間が過ぎると識別値を採り直して送り、条件付き Enter が通る', () => {
  const c = refresherSetup();
  const stale = c.guard.capture('1', 4);
  c.guard.markChanged('1');
  c.refresher.noteWrite('1');
  assert.equal(c.timers[0].ms, SILENT_WRITE_QUIET_MS);
  // 静止時間の前は何も送らない（従来どおり stale）。
  assert.equal(c.sent.length, 0);
  assert.equal(c.guard.writeEnter(request(stale), c.dependencies).reason, 'screen-changed');
  c.fire();
  assert.equal(c.sent.length, 1);
  assert.equal(c.sent[0].id, '1');
  assert.equal(c.sent[0].snapshot.agentGeneration, 4);
  assert.notEqual(c.sent[0].snapshot.screenIdentifier, stale.screenIdentifier);
  assert.equal(c.guard.isCurrent('1', c.sent[0].snapshot), true);
  assert.equal(c.guard.writeEnter(request(c.sent[0].snapshot), c.dependencies).ok, true);
});

test('issue #517: 静止時間内に出力が届いた場合は採り直さず、書き込みが続く間は期限を延ばす', () => {
  const c = refresherSetup();
  c.guard.markChanged('1');
  c.refresher.noteWrite('1');
  const first = c.timers[0];
  // 出力が届いたら取り消す（画面は onData 側の識別値で更新される）。
  c.refresher.noteOutput('1');
  assert.equal(first.cleared, true);
  c.fire();
  assert.equal(c.sent.length, 0);
  // 続けて書き込みがあれば前のタイマーを捨てて静止時間を数え直す。
  c.refresher.noteWrite('1');
  c.refresher.noteWrite('1');
  assert.equal(c.timers[1].cleared, true);
  c.fire();
  assert.equal(c.sent.length, 1);
});

test('issue #517: 採り直した後に再び書き込みや出力があれば、その識別値では Enter が通らない', () => {
  const c = refresherSetup();
  c.guard.markChanged('1');
  c.refresher.noteWrite('1');
  c.fire();
  const refreshed = c.sent[0].snapshot;
  c.guard.markChanged('1');
  assert.equal(c.guard.writeEnter(request(refreshed), c.dependencies).reason, 'screen-changed');
});

test('issue #517: ペイン削除後・世代不明のときは何も送らない', () => {
  const c = refresherSetup();
  c.refresher.noteWrite('1');
  c.refresher.delete('1');
  c.fire();
  assert.equal(c.sent.length, 0);
  c.guard.delete('1');
  c.refresher.noteWrite('1');
  c.fire();
  assert.equal(c.sent.length, 0);
});

test('issue #517: main は書き込み・リサイズで採り直しを予約し、出力で取り消し、renderer へ送る', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');
  assert.match(source, /ptyProcess\.write = \(data\) => \{\s*conditionalTerminalInput\.markChanged\(id, !\(isTerminalQueryReplyOnly\(data\) \|\| isTerminalFocusNotificationOnly\(data\)\)\);[\s\S]*?silentWriteRefresher\.noteInput\(id,[^\n]+\);\s*const result = writeToPty\(data\);\s*shellStartup\?\.onInput\(data\);\s*return result;/);
  assert.match(source, /conditionalTerminalInput\.markChanged\(id\);\s*silentWriteRefresher\.noteWrite\(id\);\s*try \{ p\.resize/);
  assert.match(source, /silentWriteRefresher\.noteOutput\(id\)/);
  assert.match(source, /'terminal:screen-refresh'/);
  assert.match(rendererSource, /VKIpc\.on\('terminal:screen-refresh'/);
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'preload.js'), 'utf8'), /'terminal:screen-refresh'/);
});

test('ラッパー経由の書き込みでは採り直しを予約せず、制御応答・フォーカス通知の terminal:input で予約し直す', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const wrapper = source.match(/ptyProcess\.write = \(data\) => \{[\s\S]*?\n  \};/)[0];
  assert.doesNotMatch(wrapper, /noteWrite/);
  const handler = source.match(/ipcMain\.on\('terminal:input'[\s\S]*?\n\}\);/)[0];
  assert.match(handler, /p\.write\(data\);[\s\S]*?if \(isTerminalQueryReplyOnly\(data\) \|\| isTerminalFocusNotificationOnly\(data\)\) silentWriteRefresher\.noteWrite\(id\);/);
});

test('issue #517: 端末の自動応答は利用者入力ではなく、キー入力・Enter・矢印は利用者入力と判定される', () => {
  const { containsUserTerminalInput } = require('../utils/terminalUserInput');
  for (const auto of ['\x1b[?1;2c', '\x1b[0n', '\x1b[12;40R', '\x1b[I', '\x1b[O', '\x1b[?2004;2$y']) {
    assert.equal(containsUserTerminalInput(auto), false, JSON.stringify(auto));
  }
  for (const user of ['\r', 'a', '\x1b[B', '\x1b[A']) {
    assert.equal(containsUserTerminalInput(user), true, JSON.stringify(user));
  }
});

test('PowerShell の準備監視には端末応答を書き込んだ後で通知する', () => {
  const context = terminalInputHarness();
  context.input('\x1b[3;40R');
  assert.deepEqual(context.startupInputs, ['\x1b[3;40R']);
});


test('pane send: 出力の画面世代と、本文後の追加入力の世代を別々に管理する', () => {
  const guard = createConditionalTerminalInputGuard();
  guard.initialize('6');
  const before = guard.capture('6', 1);
  guard.markChanged('6');
  assert.notEqual(guard.capture('6', 1).screenIdentifier, before.screenIdentifier);
  assert.equal(guard.getWriteVersion('6'), 0);
  guard.markChanged('6', true);
  assert.equal(guard.getWriteVersion('6'), 1);
  guard.delete('6'); assert.equal(guard.getWriteVersion('6'), undefined);
});

test('pane send: 実際の PTY 書き込みラッパーは自動応答とフォーカスで入力世代を進めない', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('  const writeToPty = ptyProcess.write.bind(ptyProcess);');
  const end = source.indexOf('\n  };', start) + '\n  };'.length;
  const guard = createConditionalTerminalInputGuard(); guard.initialize('1');
  const { isTerminalQueryReplyOnly, isTerminalFocusNotificationOnly } = require('../utils/terminalUserInput');
  const ptyProcess = { write() {} };
  vm.runInNewContext(source.slice(start, end), { ptyProcess, conditionalTerminalInput: guard, id: '1',
    isTerminalQueryReplyOnly, isTerminalFocusNotificationOnly, silentWriteRefresher: { noteInput() {} }, shellStartup: null });
  for (const data of ['\x1b[1;1R', '\x1b[I', '\x1b[O']) ptyProcess.write(data);
  assert.equal(guard.getWriteVersion('1'), 0);
  ptyProcess.write('human');
  assert.equal(guard.getWriteVersion('1'), 1);
});
