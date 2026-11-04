'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeLiveConfig, changedLiveKeys, normalizeReflection, readSmallJson, advanceReflection } = require('../utils/configLiveReload');

test('対象キーだけの差分を取り、未指定値を既定へ戻す', () => {
  const before = normalizeLiveConfig({ confirmClose: 'always', apiHost: 'old' });
  const after = normalizeLiveConfig({ newPaneStartupDir: '/tmp', apiHost: 'new' });
  assert.deepEqual(changedLiveKeys(before, after), ['newPaneStartupDir', 'confirmClose']);
});
test('不正な対象値は起動時と同じ既定値へ寄せる', () => {
  assert.deepEqual(normalizeLiveConfig({ confirmClose: 'Always', newPaneAutoLaunchClaude: 'true', waitingExcludeCwdPatterns: [' ok ', 1, ''] }), {
    ...normalizeLiveConfig({}), waitingExcludeCwdPatterns: ['ok'],
  });
  for (const raw of [null, [], 'text']) assert.throws(() => normalizeLiveConfig(raw));
});
test('反映結果の失敗パスを検証・重複排除する', () => {
  const raw = { version: 1, eventId: null, appliedKeys: [], failedFiles: ['/tmp/a', '/tmp/a'], engine: null };
  assert.deepEqual(normalizeReflection(raw), { eventId: null, failedFiles: ['/tmp/a'] });
  assert.throws(() => normalizeReflection({ ...raw, failedFiles: ['relative'] }));
});
test('状態ファイルは通常ファイルかつサイズ上限内だけ読む', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-live-'));
  try {
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{}');
    assert.deepEqual(readSmallJson(file), {});
    assert.throws(() => readSmallJson(dir));
    fs.writeFileSync(file, ' '.repeat(65537));
    assert.throws(() => readSmallJson(file));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('初回失敗後の復旧でも全対象値の差分を反映できる', () => {
  const failed = advanceReflection({ config: null }, { config: null, failedFiles: ['/config'], eventId: null });
  const fixed = advanceReflection(failed, { config: normalizeLiveConfig({ confirmClose: 'always' }), failedFiles: [], eventId: null });
  assert.equal(fixed.config.confirmClose, 'always');
  assert.deepEqual(fixed.changedKeys, ['confirmClose']);
});
test('起動時のイベントは通知せず、新しいイベントのみ通知する', () => {
  const first = advanceReflection({}, { config: normalizeLiveConfig({}), failedFiles: [], eventId: 'a' });
  assert.equal(first.eventChanged, false);
  assert.equal(advanceReflection(first, { config: first.config, failedFiles: [], eventId: 'a' }).eventChanged, false);
  assert.equal(advanceReflection(first, { config: first.config, failedFiles: [], eventId: 'b' }).eventChanged, true);
});
test('検証失敗なら直前のメニューを保ち、失敗中のイベントは捨てて復旧時に差分を通知する', () => {
  const first = advanceReflection({}, { config: normalizeLiveConfig({ menuItems: [{ id: 'old' }] }), failedFiles: [], eventId: 'a' });
  const failed = advanceReflection(first, { config: null, failedFiles: ['/config'], eventId: 'b' });
  assert.deepEqual(failed.config.menuItems, first.config.menuItems);
  assert.equal(failed.eventChanged, false);
  const changed = advanceReflection(failed, { config: normalizeLiveConfig({ confirmClose: 'always' }), failedFiles: ['/other'], eventId: 'c' });
  const fixed = advanceReflection(changed, { config: changed.config, failedFiles: [], eventId: 'c' });
  assert.equal(fixed.eventChanged, false);
  assert.ok(fixed.changedKeys.includes('confirmClose'));
});
const { reflectionDecision } = require('../renderer/configReflectionPolicy');
test('通知抑止中でも部分反映案内を更新し、文言が変われば再通知する', () => {
  const input = { pending: true, failed: false, restartRequired: true, lastMessage: '一部の設定を反映しました', lastAt: 1000, now: 2000 };
  assert.deepEqual(reflectionDecision(input), { pending: false, partial: true, message: null });
  assert.equal(reflectionDecision({ ...input, lastMessage: '設定を反映しました' }).message, '一部の設定を反映しました');
});
test('再起動要否が未確認なら断定を保留し、再取得後に通知する', () => {
  const input = { pending: true, failed: false, restartRequired: null, now: 10000, lastAt: 0 };
  const unknown = reflectionDecision(input);
  assert.equal(unknown.message, null);
  assert.equal(unknown.pending, true);
  assert.equal(unknown.partial, null);
  assert.equal(reflectionDecision({ ...input, restartRequired: false }).message, '設定を反映しました');
});
