'use strict';
// 初回の自動オープン（issue #456）: このパソコンで初めて未完了と判定されたときの 1 回だけ。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AUTO_OPEN_RECORD_FILE,
  hasAutoOpenRecord,
  writeAutoOpenRecord,
  isSetupIncomplete,
  shouldAutoOpenSetupPane,
} = require('../utils/setupAutoOpen');

function result(allRequiredOk) {
  return { ok: true, status: { requirements: [], summary: { allRequiredOk } } };
}

test('shouldAutoOpenSetupPane: 未完了で記録が無いときだけ true', () => {
  assert.equal(shouldAutoOpenSetupPane({ result: result(false), recorded: false }), true);
});

test('shouldAutoOpenSetupPane: 2 回目以降（記録あり）は開かない', () => {
  assert.equal(shouldAutoOpenSetupPane({ result: result(false), recorded: true }), false);
});

test('shouldAutoOpenSetupPane: セットアップ済み・確認できなかった・結果なしは開かない', () => {
  assert.equal(shouldAutoOpenSetupPane({ result: result(true), recorded: false }), false);
  assert.equal(shouldAutoOpenSetupPane({ result: { ok: false, reason: 'timeout' }, recorded: false }), false);
  assert.equal(shouldAutoOpenSetupPane({ result: null, recorded: false }), false);
});

test('isSetupIncomplete: allRequiredOk が false と言い切れるときだけ true', () => {
  assert.equal(isSetupIncomplete(result(false)), true);
  assert.equal(isSetupIncomplete(result(true)), false);
  assert.equal(isSetupIncomplete({ ok: false }), false);
});

test('記録: 書く前は無く、書くと有り、2 回目の書き込みは失敗する（wx）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vktm-setup-auto-'));
  try {
    assert.equal(hasAutoOpenRecord(dir), false);
    assert.equal(writeAutoOpenRecord(dir, () => Date.UTC(2026, 9, 21)), true);
    assert.equal(hasAutoOpenRecord(dir), true);
    const written = JSON.parse(fs.readFileSync(path.join(dir, AUTO_OPEN_RECORD_FILE), 'utf8'));
    assert.equal(written.openedAt, '2026-10-21T00:00:00.000Z');
    assert.equal(writeAutoOpenRecord(dir), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('記録: データフォルダがまだ無くても作って書ける', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vktm-setup-auto-'));
  try {
    const dir = path.join(root, 'nested', '.vk-terminals');
    assert.equal(writeAutoOpenRecord(dir), true);
    assert.equal(hasAutoOpenRecord(dir), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('記録: 存在確認が ENOENT 以外で失敗したときは「記録あり」扱い（自動で開く側へ倒さない）', () => {
  const fsImpl = { accessSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
  assert.equal(hasAutoOpenRecord('/nowhere', fsImpl), true);
});

test('記録: 書き込みに失敗したら false（呼び出し側は自動で開かない）', () => {
  const fsImpl = { mkdirSync: () => {}, writeFileSync: () => { throw new Error('read-only'); } };
  assert.equal(writeAutoOpenRecord('/nowhere', Date.now, fsImpl), false);
});

// ─── 起動時の初回ペイン判断（記録があるときは確認を待たない）──────────────────────
const { decideSetupInitialPane } = require('../utils/setupAutoOpen');

test('decideSetupInitialPane: 記録があれば、判定が遅くても待たずに返し、確認の結果も待たない', async () => {
  let asked = false;
  const never = () => { asked = true; return new Promise(() => {}); };
  const started = Date.now();
  const out = await decideSetupInitialPane({
    recorded: true, getResult: never, waitMs: 5000, writeRecord: () => true,
  });
  assert.ok(Date.now() - started < 500, '待たされている');
  assert.equal(asked, false);
  assert.deepEqual(out, { autoOpen: false, claudeOk: false, result: null });
});

test('decideSetupInitialPane: 記録が無く判定が間に合わなければ、待ち時間だけ待って通常ペイン', async () => {
  const out = await decideSetupInitialPane({
    recorded: false, getResult: () => new Promise(() => {}), waitMs: 30, writeRecord: () => true,
  });
  assert.deepEqual(out, { autoOpen: false, claudeOk: false, result: null });
});

test('decideSetupInitialPane: 記録が無く未完了なら記録を書いて自動で開く。claudeOk は id が claude の行で決まる', async () => {
  const withClaude = { ok: true, status: { requirements: [{ id: 'claude', ok: true }], summary: { allRequiredOk: false } } };
  let wrote = 0;
  const out = await decideSetupInitialPane({
    recorded: false, getResult: async () => withClaude, waitMs: 1000, writeRecord: () => { wrote += 1; return true; },
  });
  assert.deepEqual(out, { autoOpen: true, claudeOk: true, result: withClaude });
  assert.equal(wrote, 1);

  // claude の行が無いときは Claude 無しとして扱う（command not found を見せない側へ倒す）。
  const noRow = { ok: true, status: { requirements: [{ id: 'git', ok: true }], summary: { allRequiredOk: false } } };
  const out2 = await decideSetupInitialPane({
    recorded: false, getResult: async () => noRow, waitMs: 1000, writeRecord: () => true,
  });
  assert.equal(out2.claudeOk, false);
});

test('decideSetupInitialPane: 記録を書けなければ自動で開かない', async () => {
  const r = { ok: true, status: { requirements: [], summary: { allRequiredOk: false } } };
  const out = await decideSetupInitialPane({
    recorded: false, getResult: async () => r, waitMs: 1000, writeRecord: () => false,
  });
  assert.equal(out.autoOpen, false);
});
