'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { normalizeEmbeddedOptions } = require('../utils/runtimeOptions');
const { isHelpEngine, normalizeHelpStatus, buildHelpLaunchCommand, createHelpStatusChecker, createGuideOpener } = require('../utils/helpFeature');
const { insertTab, TAB_ID } = require('../renderer/helpEntry');
const status = (engine = 'codex') => ({ engine, engines: ['claude', 'codex'].map((name) => ({ engine: name, state: name === engine ? 'available' : 'unavailable', reason: '認証が必要です', preparation: 'ログインしてください' })) });

test('ヘルプ契約は対で必須、実在 HTML・cwd・厳密なエンジン別プロンプトのみを許可', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-help-'));
  t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const documentPath = path.join(cwd, 'help.html');
  fs.writeFileSync(documentPath, '<html></html>');
  const help = { documentPath, cwd, prompts: { claude: '/vk-orchestrator-helper', codex: '$vk-orchestrator-helper' } };
  const getHelpStatus = async () => status();
  const normalized = normalizeEmbeddedOptions({ help, getHelpStatus });
  assert.equal(normalized.help.documentPath, fs.realpathSync(documentPath));
  assert.ok(Object.isFrozen(normalized.help.prompts));
  for (const options of [{ help }, { getHelpStatus }, { help, getHelpStatus: true }]) assert.throws(() => normalizeEmbeddedOptions(options));
  for (const documentPath of ['help.html', cwd, path.join(cwd, 'absent.html'), path.join(cwd, 'help.sh')]) {
    assert.throws(() => normalizeEmbeddedOptions({ help: { ...help, documentPath }, getHelpStatus }));
  }
  for (const engine of ['claude', 'codex']) {
    for (const prompt of ['bad', '/bad;pwd', '$bad name', '/upperCase', '/bad\n', '$bad\n']) {
      assert.throws(() => normalizeEmbeddedOptions({ help: { ...help, prompts: { ...help.prompts, [engine]: prompt } }, getHelpStatus }));
    }
  }
  assert.throws(() => normalizeEmbeddedOptions({ help: { ...help, prompts: { ...help.prompts, shell: '/bad' } }, getHelpStatus }));
});

test('Codex の $ プロンプトをシェル展開せず、既存 --no-daemon を維持', () => {
  const command = buildHelpLaunchCommand('codex', '$vk-orchestrator-helper');
  assert.match(command, /^codex --no-daemon /);
  const args = execFileSync('/bin/sh', ['-c', `codex() { printf '%s\\n' "$@"; }; ${command}`], { encoding: 'utf8' });
  assert.equal(args, '--no-daemon\n$vk-orchestrator-helper\n');
  assert.equal(buildHelpLaunchCommand('claude', '/helper'), "claude '/helper'");
  assert.throws(() => buildHelpLaunchCommand('shell', '/helper'));
});

test('状態の矛盾・未知エンジン・不正な文言を main で拒否', () => {
  assert.equal(normalizeHelpStatus(status()).engine, 'codex');
  assert.equal(normalizeHelpStatus(status(null)).engine, null);
  for (const value of [{ ...status(), engine: 'shell' }, { ...status(), engine: { toString: () => 'codex' } }, { ...status(), engine: null }, { ...status(), engine: 'claude' }, { engine: null, engines: [] }]) assert.throws(() => normalizeHelpStatus(value));
  const invalid = status(); invalid.engines[0].reason = { html: 'bad' };
  assert.throws(() => normalizeHelpStatus(invalid));
});

test('確認例外・不正応答・タイムアウトを unknown にし、再確認できる', async () => {
  let count = 0;
  const check = createHelpStatusChecker(async () => { if (++count === 1) throw new Error('failure'); return status(); });
  const first = check(); assert.equal(check(), first);
  assert.equal((await first).engines[0].state, 'unknown');
  assert.equal((await check()).engine, 'codex');
  assert.equal((await createHelpStatusChecker(() => ({}))()).engine, null);
  const timeout = createHelpStatusChecker(() => new Promise(() => {}), 5);
  assert.equal((await timeout()).engines[1].state, 'unknown');
});

test('連打・格納相当の生存中は同一ペイン、終了後は操作時だけ再作成、失敗後に再試行', async () => {
  let creates = 0; let alive = true; let fail = false;
  const open = createGuideOpener({ enabled: true, check: async () => status(), isAlive: () => alive, create: async () => { if (fail) throw new Error('spawn'); return { id: String(++creates) }; } });
  const first = open(); assert.equal(open(), first);
  assert.equal((await first).id, '1');
  assert.equal((await open()).id, '1'); assert.equal(creates, 1);
  alive = false; fail = true;
  await assert.rejects(open()); assert.equal(creates, 1);
  fail = false; assert.equal((await open()).id, '2');
  await assert.rejects(createGuideOpener({ enabled: false })());
  assert.deepEqual((await createGuideOpener({ enabled: true, check: async () => status(null) })()).helpStatus, status(null));
});

test('ヘルプはディスクリプタのバージョン情報の直前、タブ無しでも有効', () => {
  assert.deepEqual(insertTab([{ id: 'general' }, { id: 'version', label: 'バージョン情報' }]).map((tab) => tab.id), ['general', TAB_ID, 'version']);
  assert.equal(insertTab([])[0].id, TAB_ID);
});

test('専用 IPC は任意引数を使わず、単体利用を拒否し、汎用作成からガイドを起動しない', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf('// 専用経路は引数を受け取らず');
  const end = source.indexOf("ipcMain.handle('help:open-guide', () => openGuideTerminal());", start) + "ipcMain.handle('help:open-guide', () => openGuideTerminal());".length;
  const handlers = {};
  vm.runInNewContext(source.slice(start, end), {
    ipcMain: { handle: (name, fn) => { handlers[name] = fn; } },
    HELP_FEATURE: null, checkHelpStatus: null, createGuideOpener,
    ptys: new Map(),
  });
  assert.throws(() => handlers['help:check']());
  await assert.rejects(handlers['help:document']());
  await assert.rejects(handlers['help:open-guide']());
  assert.match(source, /if \(options.guidePane !== undefined\) throw/);
  const api = source.slice(source.indexOf("url.pathname === '/api/new-pane'"), source.indexOf("url.pathname === '/api/launch-preview'"));
  assert.doesNotMatch(api, /payload\.guidePane|payload\.help|guide:\s*body/);
});


test('ヘルプのエンジン判定は名前だけを厳密に検証する', () => {
  for (const engine of ['claude', 'codex']) assert.equal(isHelpEngine(engine), true);
  for (const value of ['shell', 'toString', '__proto__', '', null, undefined, {}, ['codex']]) {
    assert.equal(isHelpEngine(value), false);
  }
});

test('単体の通常保存では反映確認の例外後も成功表示で自動クローズする', async () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const refresh = source.slice(source.indexOf('async function refreshConfigReflection('), source.indexOf('function updateConfigReflection('));
  const save = source.slice(source.indexOf('async function saveSettings('), source.indexOf("  modal.querySelector('.settings-save').addEventListener"));
  let fireClose;
  let closed = false;
  const { createAutoCloseController } = require('../renderer/autoClose');
  const autoClose = createAutoCloseController({
    setTimeout(callback) { fireClose = callback; return 1; },
    clearTimeout() {},
    onFire() { closed = true; },
  });
  let saved = false;
  const msg = { textContent: '', className: '', classList: { add() {} } };
  const context = {
    validatable: [], entries: [], msg, configFailedFiles: [],
    lockSettingsFooter() {}, clearDirtyTabs() {}, refreshSettingsContentSavedValues() {},
    autoClose,
    VKIpc: { async invoke(channel) {
      if (channel === 'settings:save') { saved = true; return { ok: true }; }
      throw new Error('反映確認に失敗');
    } },
  };
  // 実際の保存処理と例外処理を組み合わせ、通常保存とガイド起動用保存を比較する。
  vm.createContext(context);
  vm.runInContext(refresh + save, context);
  assert.equal(await context.saveSettings(), true);
  assert.equal(saved, true);
  assert.match(msg.textContent, /^保存しました/);
  assert.equal(autoClose.isArmed, true);
  fireClose();
  assert.equal(closed, true);
  assert.equal(await context.saveSettings({ keepOpen: true }), false);
  assert.match(msg.textContent, /^エラー:/);
  assert.equal(autoClose.isArmed, false);
});
