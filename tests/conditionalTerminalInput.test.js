'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createConditionalTerminalInputGuard,
  mergeConditionalScreenIdentifiers,
  validateConditionalEnterRequest,
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
  assert.match(source, /ptyProcess\.write = \(data\) => \{\s*conditionalTerminalInput\.markChanged\(id\)/);
  assert.match(source, /ptyProcess\.onData\(\(data\) => \{[\s\S]*?conditionalTerminalInput\.markChanged\(id\)[\s\S]*?terminal:data/);
  assert.match(source, /validateConditionalEnterRequest\(parsed\)[\s\S]*conditionalTerminalInput\.writeEnter/);
  assert.match(source, /mergeConditionalScreenIdentifiers\([\s\S]*reportedScreenSnapshots/);
  assert.match(rendererSource, /VKIpc\.on\('terminal:data', \(id, data, screenSnapshot\)/);
  assert.match(rendererSource, /lastLines: t\.lastLines,[\s\S]*screenIdentifier: t\.screenIdentifier/);
});
