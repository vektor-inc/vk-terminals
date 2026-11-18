'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readOrchestratorOwners, resolveInternalBrowserHomeUrl } = require('../utils/internalBrowserHome');
const { coerceFieldValue } = require('../settingsTargets');

test('専用 URL は保存時と遷移時に同じ形式に正規化し、空欄と不正値を区別する', () => {
  const field = { key: 'internalBrowserHomeUrl', type: 'http-url' };
  const noFallback = () => assert.fail('専用 URL 指定時には代替設定を読まない');
  for (const [input, url] of [
    ['  HTTPS://Example.com:443/path?q=1#top  ', 'https://example.com/path?q=1#top'],
    ['http://localhost:8080', 'http://localhost:8080/'],
    ['https://例え.jp/日本語', 'https://xn--r8jz45g.jp/%E6%97%A5%E6%9C%AC%E8%AA%9E'],
  ]) {
    assert.deepEqual(coerceFieldValue(field, input), { ok: true, value: url });
    assert.equal(resolveInternalBrowserHomeUrl(input, noFallback), url);
  }
  assert.deepEqual(coerceFieldValue(field, '  '), { ok: true, value: '' });

  // 検索語、別スキーム、認証情報、曖昧な表記、長すぎる URL を保存・遷移させない。
  for (const input of [
    1, ['https://example.com'], 'example.com', 'file:///tmp/example', 'javascript:alert(1)',
    'https://', 'https:///example.com', 'https://user:pass@example.com', 'https://example.com/a b',
    'https://example.com/' + 'x'.repeat(2048), 'https://example.com/' + 'あ'.repeat(250),
  ]) {
    assert.equal(coerceFieldValue(field, input).ok, false, String(input).slice(0, 50));
    assert.equal(resolveInternalBrowserHomeUrl(input, noFallback), '');
  }
});

test('専用 URL が空のときだけ先頭オーナーの GitHub ページを開く', () => {
  assert.equal(resolveInternalBrowserHomeUrl(undefined, () => ['', ' First-Org ', 'second']), 'https://github.com/First-Org');
  assert.equal(resolveInternalBrowserHomeUrl('  ', () => 'Legacy-Owner'), 'https://github.com/Legacy-Owner');
  for (const owners of [undefined, '', [], [' '], ['../other', 'valid-owner'], [1, 'valid-owner'], ['one/two'], ['other@example.com']]) {
    assert.equal(resolveInternalBrowserHomeUrl('', () => owners), '');
  }
});

test('GitHub オーナーは設定パネルの保存先を優先し、指定が無ければホームの設定から読む', t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-browser-home-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  assert.equal(readOrchestratorOwners(null, homeDir), undefined);
  const defaultPath = path.join(homeDir, '.vk-orchestrator', 'config.json');
  fs.mkdirSync(path.dirname(defaultPath));
  fs.writeFileSync(defaultPath, JSON.stringify({ github: { owner: ['default-owner'] } }));
  const ownerPath = path.join(homeDir, 'custom.json');
  fs.writeFileSync(ownerPath, JSON.stringify({ github: { owner: ['custom-owner'] } }));
  const descriptor = { groups: [{ targetPath: ownerPath, fields: [{ key: 'github.owner', type: 'lines' }] }] };
  assert.deepEqual(readOrchestratorOwners(null, homeDir), ['default-owner']);
  assert.deepEqual(readOrchestratorOwners(descriptor, homeDir), ['custom-owner']);
  fs.writeFileSync(ownerPath, '{');
  assert.equal(readOrchestratorOwners(descriptor, homeDir), undefined);
});
