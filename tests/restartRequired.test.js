'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeRestartRequired, readRestartRequired } = require('../utils/restartRequired');

const tabs = ['general', 'mobile'];
test('再起動状態は既知のタブだけを重複なしで受け取る', () => {
  assert.deepEqual(normalizeRestartRequired({ restartRequired: true, tabs: ['unknown', 'mobile', 'mobile', 'general'] }, tabs), { restartRequired: true, tabs: ['mobile', 'general'] });
  assert.deepEqual(normalizeRestartRequired({ restartRequired: true, tabs: ['unknown'] }, tabs), { restartRequired: false, tabs: [] });
  assert.deepEqual(normalizeRestartRequired({ restartRequired: false, tabs: ['general'] }, tabs), { restartRequired: false, tabs: [] });
});

test('再起動不要なら tabs の有無や型を問わず、必要なら配列を必須にする', () => {
  for (const raw of [{ restartRequired: false }, ...[null, 'general', {}, [1]].map((value) => ({ restartRequired: false, tabs: value }))]) {
    assert.deepEqual(normalizeRestartRequired(raw, tabs), { restartRequired: false, tabs: [] });
  }
  assert.deepEqual(normalizeRestartRequired({ restartRequired: true }, tabs), { unknown: true });
});

test('状態ファイルが無ければ不要、破損時は未確認とする', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-restart-test-'));
  try {
    const file = path.join(dir, 'status.json');
    assert.deepEqual(readRestartRequired(file, tabs), { restartRequired: false, tabs: [] });
    fs.writeFileSync(file, '{');
    assert.deepEqual(readRestartRequired(file, tabs), { unknown: true });
    fs.writeFileSync(file, JSON.stringify({ restartRequired: true, tabs: ['general'] }));
    assert.deepEqual(readRestartRequired(file, tabs), { restartRequired: true, tabs: ['general'] });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('型が不正な状態・配列要素を安全に除外する', () => {
  for (const raw of [{ restartRequired: 'true', tabs }, { restartRequired: true, tabs: 'general' }]) {
    assert.deepEqual(normalizeRestartRequired(raw, tabs), { unknown: true });
  }
  assert.deepEqual(normalizeRestartRequired({ restartRequired: true, tabs: [null, 1, {}, 'general'] }, tabs), { unknown: true });
});

test('大きすぎるファイルと通常ファイル以外は読まない', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-restart-limit-'));
  try {
    const file = path.join(dir, 'large.json');
    fs.writeFileSync(file, JSON.stringify({ restartRequired: true, tabs: ['general'] }) + ' '.repeat(65536));
    for (const target of [file, dir]) assert.deepEqual(readRestartRequired(target, tabs), { unknown: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const { createRestartApplication } = require('../utils/restartApplication');
for (const state of ['idle', 'pending', 'done']) {
  test(`再起動ゲート ${state} の分岐と終了順序`, async () => {
    const calls = [];
    const restart = createRestartApplication({
      gate: { state, markShuttingDown: () => calls.push('gate') },
      cleanupPtys: async () => { calls.push('cleanup'); },
      app: { relaunch: () => calls.push('relaunch'), exit: (code) => calls.push(`exit:${code}`) },
      log: { error() {} },
    });
    assert.equal(await restart(), state === 'idle');
    assert.deepEqual(calls, state === 'idle' ? ['gate', 'cleanup', 'relaunch', 'exit:0'] : []);
  });
}

test('cleanup と relaunch の例外でも exit に到達する', async () => {
  for (const failCleanup of [false, true]) {
    const calls = [];
    const restart = createRestartApplication({
      gate: { state: 'idle', markShuttingDown() {} },
      cleanupPtys: async () => { if (failCleanup) throw new Error('cleanup'); },
      app: { relaunch: () => { throw new Error('relaunch'); }, exit: (code) => calls.push(code) },
      log: { error: () => calls.push('logged') },
    });
    if (failCleanup) await assert.rejects(restart(), /cleanup/);
    else assert.equal(await restart(), true);
    assert.deepEqual(calls, ['logged', 0]);
  }
});
