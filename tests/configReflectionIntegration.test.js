'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const policy = require('../utils/configLiveReload');

// Electron を起動せず、実際の main の監視処理を境界の依存だけ差し替えて検証する。
function createMainHarness(initial) {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const handlers = {};
  const sent = [];
  let raw = initial;
  let reads = 0;
  let tick;
  const context = vm.createContext({
    ...policy, path, DATA_DIR: '/config', MENU_MAX_SECTIONS: 10,
    fs: { existsSync: (file) => file === '/config/config.json' },
    readSmallJson: () => { reads++; if (raw instanceof Error) throw raw; return raw; },
    userConfigCandidatePaths: () => ['/config/config.json'],
    validateMenuSection: (section) => ({ ok: !!section.id }),
    win: { isDestroyed: () => false, webContents: { send: (...args) => sent.push(args) } },
    pushMenuUpdate: () => sent.push(['menu:update']),
    ipcMain: { handle: (name, handler) => { handlers[name] = handler; } },
    setInterval: (callback) => { tick = callback; return { unref() {} }; },
  });
  vm.runInContext(source.slice(source.indexOf('let liveConfig = null;'), source.indexOf("ipcMain.handle('app:restart-required'")), context);
  return { state: () => handlers['app:config-reflection'](), update: (value) => { raw = value; tick(); }, sent, reads: () => reads };
}

test('main の監視だけで起動時の読み込み失敗から復旧し、メニューを通知する', () => {
  const main = createMainHarness(new Error('broken JSON'));
  assert.equal(main.state().config, null);
  const reads = main.reads();
  main.state();
  assert.equal(main.reads(), reads, 'invoke はファイルを読み直さない');
  main.update({ confirmClose: 'always', menuItems: [{ id: 'fixed' }] });
  assert.equal(main.state().config.confirmClose, 'always');
  assert.ok(main.state().changedKeys.includes('confirmClose'));
  assert.ok(main.sent.some(([channel]) => channel === 'menu:update'));
});

test('main のメニュー検証失敗では設定を採用せず、復旧後に差分を通知する', () => {
  const main = createMainHarness({ menuItems: [{ id: 'old' }] });
  main.update({ confirmClose: 'always', menuItems: [{}] });
  assert.equal(main.state().config.menuItems[0].id, 'old');
  assert.equal(main.state().config.confirmClose, 'busy');
  assert.equal(main.state().failedFiles.length, 1);
  main.update({ confirmClose: 'always', menuItems: [{ id: 'new' }] });
  assert.equal(main.state().failedFiles.length, 0);
  assert.ok(main.state().changedKeys.includes('menuItems'));
});

test('renderer は changedKeys が空でも値を受け取り、同じ失敗集合でDOMと警告を繰り返さない', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  let domUpdates = 0;
  const notices = [0, 1].map(() => ({ dataset: {}, querySelector: () => ({ replaceChildren: () => { domUpdates++; } }) }));
  const messages = [];
  const context = vm.createContext({
    document: { querySelectorAll: () => notices, createElement: () => ({}) },
    window: { VKConfigReflectionPolicy: require('../renderer/configReflectionPolicy') },
    showGenericToast: (message) => messages.push(message),
    updatePartialConfigReflectionNotices() {},
    setTimeout: () => 1, clearTimeout() {},
    newPaneStartupDir: '', newPaneAutoLaunchClaude: false, confirmClosePref: 'busy',
    terminalLinkClickModePref: 'click', waitingExcludeCwdPatterns: [],
  });
  vm.runInContext(source.slice(source.indexOf('let configReflectionInitialized'), source.indexOf('function updatePartialConfigReflectionNotices()')), context);
  const config = policy.normalizeLiveConfig({ confirmClose: 'always', newPaneStartupDir: '/fixed' });
  context.updateConfigReflection({ revision: 1, config, changedKeys: [], failedFiles: ['/bad'] });
  context.updateConfigReflection({ revision: 2, config, changedKeys: [], failedFiles: ['/bad', '/bad'] });
  assert.equal(context.confirmClosePref, 'always');
  assert.equal(context.newPaneStartupDir, '/fixed');
  assert.equal(domUpdates, 2, 'サイドバーと設定パネルの各1回のみ');
  assert.equal(messages.length, 1);
  context.updateConfigReflection({ revision: 3, config, changedKeys: [], failedFiles: [] });
  context.updateConfigReflection({ revision: 4, config, changedKeys: [], failedFiles: [] });
  assert.equal(messages.length, 2, '復旧の通知も一度だけ');
});

// 状態ファイルから実際の IPC ハンドラを経由し、renderer の表示判断まで通す。
function createRestartHarness(directory) {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  let handler;
  vm.runInNewContext(source.slice(source.indexOf("ipcMain.handle('app:restart-required'"), source.indexOf("ipcMain.handle('app:restart',")), {
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    getRestartTabIds: () => ['general'], path, DATA_DIR: directory,
    readRestartRequired: require('../utils/restartRequired').readRestartRequired,
  });
  const messages = [];
  const notice = { hidden: true, contains: () => false };
  let now = 100000;
  const context = vm.createContext({
    VKIpc: { invoke: () => handler() },
    document: { querySelectorAll: () => [], getElementById: () => notice },
    window: { VKConfigReflectionPolicy: require('../renderer/configReflectionPolicy') },
    showGenericToast: (message) => messages.push(message),
    Date: { now: () => now }, setTimeout: () => 1, clearTimeout() {},
  });
  const renderer = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  vm.runInContext(renderer.slice(renderer.indexOf('let restartRequiredState'), renderer.indexOf('// サイドバーのラッパー')), context);
  return { context, messages, notice, state: handler, advance: (ms) => { now += ms; },
    run: (code) => vm.runInContext(code, context) };
}

test('破損・形式不正・読み取り失敗は IPC で未確認を返し、案内と保留通知を維持する', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'restart-ipc-'));
  const file = path.join(dir, 'restart-required.json');
  try {
    const app = createRestartHarness(dir);
    fs.writeFileSync(file, JSON.stringify({ restartRequired: true, tabs: ['general'] }));
    await app.context.updateRestartRequired();
    assert.equal(app.notice.hidden, false);
    for (const invalid of ['{', '{}', 'directory']) {
      fs.rmSync(file, { recursive: true, force: true });
      if (invalid === 'directory') fs.mkdirSync(file);
      else fs.writeFileSync(file, invalid);
      assert.equal(app.state().unknown, true);
      app.run('pendingConfigReflection = true');
      await app.context.updateRestartRequired();
      app.context.flushConfigReflectionNotification();
      assert.equal(app.notice.hidden, false);
      assert.equal(app.messages.length, 0);
      assert.equal(app.run('pendingConfigReflection'), true);
    }
    fs.rmSync(file, { recursive: true });
    await app.context.updateRestartRequired();
    app.context.flushConfigReflectionNotification();
    assert.equal(app.notice.hidden, true);
    assert.deepEqual(app.messages, ['設定を反映しました']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('GPU だけの変更では部分反映案内を出さず、期限切れの反映通知も訂正しない', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'restart-gpu-'));
  const file = path.join(dir, 'restart-required.json');
  try {
    const app = createRestartHarness(dir);
    fs.writeFileSync(file, JSON.stringify({ restartRequired: true, tabs: ['general'] }));
    await app.context.updateRestartRequired();
    app.context.flushConfigReflectionNotification();
    assert.equal(app.run('partialConfigReflection'), false);
    assert.equal(app.messages.length, 0);
    fs.rmSync(file);
    await app.context.updateRestartRequired();
    app.run('pendingConfigReflection = true');
    app.context.flushConfigReflectionNotification();
    app.advance(15001);
    fs.writeFileSync(file, JSON.stringify({ restartRequired: true, tabs: ['general'] }));
    await app.context.updateRestartRequired();
    app.context.flushConfigReflectionNotification();
    assert.deepEqual(app.messages, ['設定を反映しました']);
    assert.equal(app.run('lastConfigReflectionMessage'), '');
    fs.rmSync(file);
    await app.context.updateRestartRequired();
    assert.equal(app.run('partialConfigReflection'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('直前の反映通知だけを15秒以内に訂正し、訂正で期限を延長しない', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'restart-correction-'));
  const file = path.join(dir, 'restart-required.json');
  try {
    const app = createRestartHarness(dir);
    await app.context.updateRestartRequired();
    app.run('pendingConfigReflection = true');
    app.context.flushConfigReflectionNotification();
    app.advance(10000);
    fs.writeFileSync(file, JSON.stringify({ restartRequired: true, tabs: ['general'] }));
    await app.context.updateRestartRequired();
    app.context.flushConfigReflectionNotification();
    assert.deepEqual(app.messages, ['設定を反映しました', '一部の設定を反映しました']);
    app.advance(5001);
    fs.rmSync(file);
    await app.context.updateRestartRequired();
    app.context.flushConfigReflectionNotification();
    assert.equal(app.messages.length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('起動時と定期読込は64KB超の本体設定を採用し、状態ファイルは64KBに制限する', () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'config-size-'));
  try {
    const file = path.join(dir, 'config.json');
    const config = { port: 12345, apiHost: '127.0.0.2', confirmClose: 'always', padding: 'x'.repeat(70000) };
    fs.writeFileSync(file, JSON.stringify(config));
    const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
    const start = source.indexOf('function loadUserConfig()');
    const end = source.indexOf('\n}', start) + 2;
    const context = vm.createContext({ fs, normalizeLiveConfig: policy.normalizeLiveConfig, LOG_PREFIX: "test", readSmallJson: policy.readSmallJson, userConfigCandidatePaths: () => [file], console });
    vm.runInContext(source.slice(start, end), context);
    assert.equal(context.loadUserConfig().port, 12345);
    assert.equal(context.loadUserConfig().apiHost, '127.0.0.2');
    assert.throws(() => policy.readSmallJson(file));
    assert.equal(policy.readSmallJson(file, 1048576).confirmClose, 'always');
    fs.writeFileSync(file, JSON.stringify(config) + ' '.repeat(1048576));
    assert.throws(() => policy.readSmallJson(file, 1048576));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
