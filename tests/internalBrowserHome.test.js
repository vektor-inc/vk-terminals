'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { INTERNAL_BROWSER_HOME_KEY, readOrchestratorOwners, resolveInternalBrowserHomeUrl } = require('../utils/internalBrowserHome');
const { coerceFieldValue, saveSettingsToTargets } = require('../settingsTargets');

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

test('改行区切りの旧形式では先頭の空でない行を使う', () => {
  assert.equal(resolveInternalBrowserHomeUrl('', () => '\r\n  \r\n  Legacy-Org \r\nother'), 'https://github.com/Legacy-Org');
  assert.equal(resolveInternalBrowserHomeUrl('', () => '\n  \ninvalid/org\nvalid-org'), '');
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

test('保存 IPC とホーム操作は部分成功後も同じ保存済み移動先を使う', t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-browser-home-save-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const ownPath = path.join(homeDir, 'terminals.json');
  const ownerPath = path.join(homeDir, 'orchestrator.json');
  fs.writeFileSync(ownPath, '{}');
  fs.writeFileSync(ownerPath, '{');
  const ownerGroup = { targetPath: ownerPath, fields: [{ key: 'github.owner', type: 'lines' }] };
  const homeGroup = { targetPath: ownPath, fields: [{ key: INTERNAL_BROWSER_HOME_KEY, type: 'http-url' }] };

  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const getHome = source.match(/function getSavedInternalBrowserHomeUrl\(\) \{[\s\S]*?\n\}/)[0];
  const handlers = new Map();
  let reloads = 0;
  vm.runInNewContext(getHome + '\n' + ['settings:save', 'internal-browser:action'].map(channel =>
    source.slice(source.indexOf(`ipcMain.handle('${channel}'`)).split('\n});', 1)[0] + '\n});'
  ).join('\n'), {
    INTERNAL_BROWSER_HOME_KEY, readOrchestratorOwners, resolveInternalBrowserHomeUrl, saveSettingsToTargets,
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler) },
    isInternalBrowserSender: event => event.trusted === true,
    internalBrowser: { navigate: url => url },
    os: { homedir: () => homeDir },
    loadUserConfig: () => JSON.parse(fs.readFileSync(ownPath, 'utf8')),
    loadSettingsDescriptor: ({ includeBrowserHome = true } = {}) => ({
      groups: includeBrowserHome ? [ownerGroup, homeGroup] : [ownerGroup],
    }),
    reloadConfigReflection() { reloads++; },
  });
  const sender = { trusted: true };
  const save = values => handlers.get('settings:save')(sender, values);
  const navigateHome = () => handlers.get('internal-browser:action')(sender, 'home');

  // 部分成功でホームだけ反映され、空欄へ戻せば移動先もなくなる。
  const url = 'https://example.com/';
  const partial = save({ [INTERNAL_BROWSER_HOME_KEY]: url, 'github.owner': 'first-owner' });
  assert.equal(partial.ok, false);
  assert.deepEqual(partial.writtenKeys, [INTERNAL_BROWSER_HOME_KEY]);
  assert.equal(partial.hasInternalBrowserHome, true);
  assert.equal(navigateHome(), url);
  assert.equal(reloads, 1);
  assert.equal(save({ [INTERNAL_BROWSER_HOME_KEY]: '' }).hasInternalBrowserHome, false);
  assert.equal(navigateHome(), 'home-unset');

  // owner だけを保存しても移動でき、差分のない再保存では再読込も発生しない。
  fs.writeFileSync(ownerPath, '{}');
  assert.equal(save({ 'github.owner': 'first-owner\nsecond-owner' }).hasInternalBrowserHome, true);
  assert.equal(navigateHome(), 'https://github.com/first-owner');
  assert.equal(save({}).hasInternalBrowserHome, true);
  assert.equal(reloads, 3);
  assert.equal(handlers.get('settings:save')({}, {}).hasInternalBrowserHome, undefined);
});
