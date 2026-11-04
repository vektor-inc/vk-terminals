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
