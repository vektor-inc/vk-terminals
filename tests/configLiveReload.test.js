'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeLiveConfig, changedLiveKeys, normalizeReflection, readSmallJson, reflectionMessage } = require('../utils/configLiveReload');

test('対象キーだけの差分を取り、未指定値を既定へ戻す', () => {
  const before = normalizeLiveConfig({ confirmClose: 'always', apiHost: 'old' });
  const after = normalizeLiveConfig({ newPaneStartupDir: '/tmp', apiHost: 'new' });
  assert.deepEqual(changedLiveKeys(before, after), ['newPaneStartupDir', 'confirmClose']);
});
test('不正な型では保存全体を保留できる', () => {
  for (const raw of [{ confirmClose: 42 }, { waitingExcludeCwdPatterns: ['ok', 1] }, { menuItems: {} }, []]) {
    assert.throws(() => normalizeLiveConfig(raw));
  }
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
test('再起動要否に応じた文言', () => {
  assert.equal(reflectionMessage(false), '設定を反映しました');
  assert.equal(reflectionMessage(true), '一部の設定を反映しました');
});
