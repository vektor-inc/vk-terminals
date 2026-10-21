'use strict';
// 組み込み用の入口（issue #455）のテスト。
// - オプションの検証・正規化
// - 表示名・資源の置き場所・更新方針・二重起動検知の解決
// - 書き込む設定ファイルを読み取り専用の置き場所へ向けないこと
// - 二重起動の検知（ポート使用中）と案内文
// - main.js が資源を __dirname 直参照せず、更新・二重起動の判定を通っていること

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

const {
  normalizeEmbeddedOptions,
  setEmbeddedOptions,
  getEmbeddedOptions,
  resetEmbeddedOptions,
  resolveAppTitle,
  resolveResourceRoot,
  isBundledRun,
  shouldSelfUpdate,
  shouldGuardAlreadyRunning,
  resolveSettingsDescriptorPath,
  resolveOwnConfigTargetPath,
} = require('../utils/runtimeOptions');
const { ALREADY_RUNNING_MESSAGE, isPortInUse, buildAlreadyRunningNotice } = require('../utils/alreadyRunning');

test('normalizeEmbeddedOptions: 未指定は既定値（自己更新は未指定・二重起動検知は有効）', () => {
  assert.deepEqual(normalizeEmbeddedOptions(), {
    appTitle: null,
    resourceRoot: null,
    selfUpdate: null,
    settingsDescriptorPath: null,
    singleInstance: true,
  });
});

test('normalizeEmbeddedOptions: 指定値を正規化し、不明なキーは捨てる', () => {
  const result = normalizeEmbeddedOptions({
    appTitle: '  VK Orchestrator ',
    resourceRoot: '/Applications/X.app/Contents/Resources/vk-terminals',
    selfUpdate: false,
    settingsDescriptorPath: '/tmp/settings.json',
    singleInstance: false,
    unknown: 1,
  });
  assert.equal(result.appTitle, 'VK Orchestrator');
  assert.equal(result.selfUpdate, false);
  assert.equal(result.singleInstance, false);
  assert.equal('unknown' in result, false);
});

test('normalizeEmbeddedOptions: 型違い・相対パスは例外にする', () => {
  assert.throws(() => normalizeEmbeddedOptions('x'), TypeError);
  assert.throws(() => normalizeEmbeddedOptions({ appTitle: '  ' }), TypeError);
  assert.throws(() => normalizeEmbeddedOptions({ resourceRoot: 'relative/dir' }), TypeError);
  assert.throws(() => normalizeEmbeddedOptions({ settingsDescriptorPath: 'a.json' }), TypeError);
  assert.throws(() => normalizeEmbeddedOptions({ selfUpdate: 'no' }), TypeError);
  assert.throws(() => normalizeEmbeddedOptions({ singleInstance: 1 }), TypeError);
});

test('setEmbeddedOptions / getEmbeddedOptions: 設定前は null（electron . と同じ）', () => {
  resetEmbeddedOptions();
  assert.equal(getEmbeddedOptions(), null);
  setEmbeddedOptions({ appTitle: 'X' });
  assert.equal(getEmbeddedOptions().appTitle, 'X');
  resetEmbeddedOptions();
});

test('resolveAppTitle: 組み込みの指定 > 環境変数 > 既定', () => {
  const embedded = normalizeEmbeddedOptions({ appTitle: 'VK Orchestrator' });
  assert.equal(resolveAppTitle({ embedded, env: { VK_TERMINALS_APP_TITLE: 'Env' } }), 'VK Orchestrator');
  assert.equal(resolveAppTitle({ embedded: null, env: { VK_TERMINALS_APP_TITLE: ' Env ' } }), 'Env');
  assert.equal(resolveAppTitle({ embedded: null, env: {} }), 'VK Terminals');
});

test('resolveResourceRoot: 指定が無ければ main.js のあるフォルダ', () => {
  const embedded = normalizeEmbeddedOptions({ resourceRoot: '/res' });
  assert.equal(resolveResourceRoot({ embedded, defaultRoot: '/app' }), '/res');
  assert.equal(resolveResourceRoot({ embedded: null, defaultRoot: '/app' }), '/app');
  assert.equal(resolveResourceRoot({ embedded: normalizeEmbeddedOptions({}), defaultRoot: '/app' }), '/app');
});

test('shouldSelfUpdate: electron . （packaged でも組み込みでもない）は従来どおり更新する', () => {
  assert.equal(shouldSelfUpdate({ isPackaged: false, embedded: null }), true);
});

test('shouldSelfUpdate: app.isPackaged なら更新しない（組み込み側が true と言っても）', () => {
  assert.equal(shouldSelfUpdate({ isPackaged: true, embedded: null }), false);
  const embedded = normalizeEmbeddedOptions({ selfUpdate: true });
  assert.equal(shouldSelfUpdate({ isPackaged: true, embedded }), false);
});

test('shouldSelfUpdate: 組み込みの入口から起動したら既定で更新しない。明示すれば従う', () => {
  assert.equal(shouldSelfUpdate({ isPackaged: false, embedded: normalizeEmbeddedOptions({}) }), false);
  assert.equal(shouldSelfUpdate({ isPackaged: false, embedded: normalizeEmbeddedOptions({ selfUpdate: true }) }), true);
  assert.equal(shouldSelfUpdate({ isPackaged: false, embedded: normalizeEmbeddedOptions({ selfUpdate: false }) }), false);
});

test('isBundledRun: packaged か組み込みの入口なら true、electron . は false', () => {
  assert.equal(isBundledRun({ isPackaged: false, embedded: null }), false);
  assert.equal(isBundledRun({ isPackaged: true, embedded: null }), true);
  assert.equal(isBundledRun({ isPackaged: false, embedded: normalizeEmbeddedOptions({}) }), true);
});

test('shouldGuardAlreadyRunning: electron . は検知しない。packaged・組み込みは検知する', () => {
  assert.equal(shouldGuardAlreadyRunning({ isPackaged: false, embedded: null }), false);
  assert.equal(shouldGuardAlreadyRunning({ isPackaged: true, embedded: null }), true);
  assert.equal(shouldGuardAlreadyRunning({ isPackaged: false, embedded: normalizeEmbeddedOptions({}) }), true);
  assert.equal(
    shouldGuardAlreadyRunning({ isPackaged: false, embedded: normalizeEmbeddedOptions({ singleInstance: false }) }),
    false
  );
});

test('resolveSettingsDescriptorPath: 組み込みの指定 > 環境変数 > null', () => {
  const embedded = normalizeEmbeddedOptions({ settingsDescriptorPath: '/a/settings.json' });
  assert.equal(resolveSettingsDescriptorPath({ embedded, env: { VK_TERMINALS_SETTINGS: '/env.json' } }), '/a/settings.json');
  assert.equal(resolveSettingsDescriptorPath({ embedded: null, env: { VK_TERMINALS_SETTINGS: '/env.json' } }), '/env.json');
  assert.equal(resolveSettingsDescriptorPath({ embedded: null, env: { VK_TERMINALS_SETTINGS: '  ' } }), null);
});

test('resolveOwnConfigTargetPath: 書き込める置き場所なら従来どおり（既存優先、無ければ資源側）', () => {
  const base = { dataDir: '/home/.vk-terminals', resourceRoot: '/repo', resourceRootWritable: true };
  assert.equal(
    resolveOwnConfigTargetPath({ ...base, existsSync: (p) => p === '/home/.vk-terminals/config.json' }),
    '/home/.vk-terminals/config.json'
  );
  assert.equal(resolveOwnConfigTargetPath({ ...base, existsSync: (p) => p === '/repo/config.json' }), '/repo/config.json');
  assert.equal(resolveOwnConfigTargetPath({ ...base, existsSync: () => false }), '/repo/config.json');
});

test('resolveOwnConfigTargetPath: 読み取り専用の置き場所には書かず、dataDir を保存先にする', () => {
  const base = { dataDir: '/home/.vk-terminals', resourceRoot: '/app.asar', resourceRootWritable: false };
  assert.equal(resolveOwnConfigTargetPath({ ...base, existsSync: () => false }), '/home/.vk-terminals/config.json');
  // 資源側に config.json があっても保存先にはしない
  assert.equal(
    resolveOwnConfigTargetPath({ ...base, existsSync: (p) => p === '/app.asar/config.json' }),
    '/home/.vk-terminals/config.json'
  );
});

test('isPortInUse: 実際に埋まっているポートは true、空いていれば false', async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  assert.equal(await isPortInUse(port, '127.0.0.1'), true);
  await new Promise((resolve) => server.close(resolve));
  assert.equal(await isPortInUse(port, '127.0.0.1'), false);
});

test('isPortInUse: EADDRINUSE 以外のエラーは判定不能として false（起動を止めない）', async () => {
  const createServer = () => {
    const handlers = {};
    return {
      once: (name, fn) => { handlers[name] = fn; },
      listen: () => handlers.error({ code: 'EACCES' }),
      close: () => {},
    };
  };
  assert.equal(await isPortInUse(80, '127.0.0.1', { createServer }), false);
});

test('buildAlreadyRunningNotice: 案内文は「すでに起動しています。終了してから開いてください。」', () => {
  assert.equal(ALREADY_RUNNING_MESSAGE, 'すでに起動しています。終了してから開いてください。');
  const lock = buildAlreadyRunningNotice({ appTitle: 'VK Orchestrator', reason: 'lock', port: 13847 });
  assert.equal(lock.message, ALREADY_RUNNING_MESSAGE);
  assert.equal(lock.title, 'VK Orchestrator');
  const port = buildAlreadyRunningNotice({ appTitle: 'VK Orchestrator', reason: 'port', port: 13847 });
  assert.match(port.detail, /13847/);
});

// ─── main.js の配線（Electron を起動せずソースで確認する。tests/clipboardLimits.test.js と同じ方式）───
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('main.js: 資源は RESOURCE_ROOT から読み、__dirname 直参照は資源ルートの既定値と git 更新だけ', () => {
  const lines = mainSource.split('\n').filter((l) => l.includes('__dirname') && !l.trim().startsWith('//'));
  assert.equal(lines.length, 2, `想定外の __dirname 参照: ${lines.join(' | ')}`);
  assert.ok(lines.some((l) => l.includes('defaultRoot: __dirname')));
  assert.ok(lines.some((l) => l.includes('const appDir = __dirname')));
});

test('main.js: checkAndUpdate は先頭で shouldSelfUpdate を見て、git より前に抜ける', () => {
  const start = mainSource.indexOf('async function checkAndUpdate()');
  const guard = mainSource.indexOf('shouldSelfUpdate(', start);
  const firstGit = mainSource.indexOf("execFileAsync(\n    'git'", start) >= 0
    ? mainSource.indexOf("execFileAsync(\n    'git'", start)
    : mainSource.indexOf("'git'", start);
  assert.ok(start >= 0 && guard > start && guard < firstGit);
});

test('main.js: 二重起動の判定は electron . で動かない（GUARD_ALREADY_RUNNING で囲われている）', () => {
  assert.match(mainSource, /if \(GUARD_ALREADY_RUNNING\) \{\s*\n\s*if \(!app\.requestSingleInstanceLock\(\)\)/);
  assert.match(mainSource, /if \(GUARD_ALREADY_RUNNING\) \{\s*\n\s*const apiHost/);
});
