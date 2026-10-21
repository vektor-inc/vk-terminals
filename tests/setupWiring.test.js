'use strict';
// セットアップ状況の一覧（issue #456）の組み込みオプションの検証と、配線の静的チェック。
//   - setupPane / getSetupStatus の検証
//   - オプションが無いとき（electron . ・zip 版）は IPC も画面の要素も作らないこと
//   - claude '<prompt>' を作る経路が検証済みプロンプトの 1 本だけであること
//   - doctor の文字列を innerHTML で描かないこと

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  normalizeEmbeddedOptions,
  resolveSetupFeature,
  isSetupPrompt,
} = require('../utils/runtimeOptions');
const { buildSetupPaneLaunchCommand } = require('../utils/setupPaneLaunch');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const goodPane = () => ({ cwd: os.tmpdir(), prompt: '/vk-orchestrator-setup' });
const goodGetter = async () => ({ requirements: [], summary: { allRequiredOk: true } });

test('isSetupPrompt: /^\\/[a-z0-9-]+$/ に一致するスキル名だけを通す', () => {
  ['/vk-orchestrator-setup', '/a', '/a1-b2'].forEach((value) => assert.equal(isSetupPrompt(value), true, value));
  [
    '', '/', 'vk-setup', '/Upper', '/with space', "/quote'", '/semi;colon', '/back`tick', '/$(x)', '/a\n', '/a/b', '/a_b', 42, null, undefined,
  ].forEach((value) => assert.equal(isSetupPrompt(value), false, String(value)));
});

test('normalizeEmbeddedOptions: getSetupStatus と setupPane を対で受け取る', () => {
  const options = normalizeEmbeddedOptions({ getSetupStatus: goodGetter, setupPane: goodPane() });
  assert.equal(options.getSetupStatus, goodGetter);
  assert.deepEqual(options.setupPane, goodPane());
});

test('normalizeEmbeddedOptions: どちらも渡さなければ null（一覧は出ない）', () => {
  const options = normalizeEmbeddedOptions({ appTitle: 'X' });
  assert.equal(options.getSetupStatus, null);
  assert.equal(options.setupPane, null);
});

test('normalizeEmbeddedOptions: 片方だけは例外', () => {
  assert.throws(() => normalizeEmbeddedOptions({ getSetupStatus: goodGetter }), /given together/);
  assert.throws(() => normalizeEmbeddedOptions({ setupPane: goodPane() }), /given together/);
});

test('normalizeEmbeddedOptions: getSetupStatus は関数だけ', () => {
  assert.throws(() => normalizeEmbeddedOptions({ getSetupStatus: 'doctor', setupPane: goodPane() }), /getSetupStatus must be a function/);
});

test('normalizeEmbeddedOptions: setupPane.cwd は実在する絶対パスだけ', () => {
  const file = path.join(os.tmpdir(), `vktm-not-a-dir-${process.pid}`);
  fs.writeFileSync(file, 'x');
  try {
    [
      'relative/dir',
      path.join(os.tmpdir(), `vktm-missing-${process.pid}-${Date.now()}`),
      file, // フォルダではない
      '',
      undefined,
    ].forEach((cwd) => {
      assert.throws(
        () => normalizeEmbeddedOptions({ getSetupStatus: goodGetter, setupPane: { cwd, prompt: '/vk-orchestrator-setup' } }),
        /setupPane\.cwd/,
        String(cwd),
      );
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('normalizeEmbeddedOptions: setupPane.prompt が形に合わなければ例外', () => {
  ["/x y", "/x'; rm -rf ~ #", 'no-slash', ''].forEach((prompt) => {
    assert.throws(
      () => normalizeEmbeddedOptions({ getSetupStatus: goodGetter, setupPane: { cwd: os.tmpdir(), prompt } }),
      /setupPane\.prompt/,
      prompt,
    );
  });
});

test('normalizeEmbeddedOptions: setupPane はオブジェクトだけ', () => {
  assert.throws(() => normalizeEmbeddedOptions({ getSetupStatus: goodGetter, setupPane: '/tmp' }), /setupPane must be an object/);
  assert.throws(() => normalizeEmbeddedOptions({ getSetupStatus: goodGetter, setupPane: [] }), /setupPane must be an object/);
});

test('resolveSetupFeature: 組み込みのオプションが無い・部品が揃っていないときは null', () => {
  assert.equal(resolveSetupFeature(), null);
  assert.equal(resolveSetupFeature({ embedded: null }), null);
  assert.equal(resolveSetupFeature({ embedded: normalizeEmbeddedOptions({ appTitle: 'X' }) }), null);
});

test('resolveSetupFeature: 部品が揃っていれば取り出せる', () => {
  const embedded = normalizeEmbeddedOptions({ getSetupStatus: goodGetter, setupPane: goodPane() });
  const feature = resolveSetupFeature({ embedded });
  assert.equal(feature.getSetupStatus, goodGetter);
  assert.deepEqual(feature.setupPane, goodPane());
});

test('buildSetupPaneLaunchCommand: 検証を通ったプロンプトだけを claude の引数にする', () => {
  assert.equal(buildSetupPaneLaunchCommand('/vk-orchestrator-setup'), "claude '/vk-orchestrator-setup'");
  assert.throws(() => buildSetupPaneLaunchCommand("/x'; echo hi; '"), /invalid setup pane prompt/);
  assert.throws(() => buildSetupPaneLaunchCommand(''), /invalid setup pane prompt/);
  assert.throws(() => buildSetupPaneLaunchCommand(undefined), /invalid setup pane prompt/);
});

test('main.js: setup:* の受け口は SETUP_FEATURE があるときの if の中にだけある', () => {
  const main = read('main.js');
  const blockStart = main.indexOf('if (SETUP_FEATURE) {\n  setupStatusChecker');
  assert.ok(blockStart > 0, 'if (SETUP_FEATURE) のブロックが見つからない');
  const handlerPositions = [...main.matchAll(/ipcMain\.handle\('setup:[a-z-]+'/g)].map((m) => m.index);
  assert.equal(handlerPositions.length, 2);
  // どちらのハンドラも、ブロック開始より後（かつ次のトップレベル宣言の前）にある。
  const blockEnd = main.indexOf('\n}\n', blockStart);
  handlerPositions.forEach((position) => {
    assert.ok(position > blockStart && position < blockEnd, 'setup:* のハンドラが if (SETUP_FEATURE) の外にある');
  });
});

test('main.js: app:get-config の setupPanelEnabled は SETUP_FEATURE があるときだけ足される', () => {
  const main = read('main.js');
  assert.match(main, /\.\.\.\(SETUP_FEATURE \? \{ setupPanelEnabled: true \} : \{\}\)/);
  assert.equal((main.match(/setupPanelEnabled/g) || []).length, 1);
});

test('main.js: terminal:create の setupPane は部品が無いと例外で、作業フォルダ・プロンプトは renderer から受け取らない', () => {
  const main = read('main.js');
  assert.match(main, /const setupLaunch = options\.setupPane === true;\n  if \(setupLaunch && !SETUP_FEATURE\) \{\n    throw new Error\('Setup pane is not available\.'\);/);
  assert.match(main, /SETUP_FEATURE\.setupPane\.cwd/);
  assert.match(main, /buildSetupPaneLaunchCommand\(SETUP_FEATURE\.setupPane\.prompt\)/);
  assert.equal(/options\.setupPane\.(cwd|prompt)/.test(main), false);
});

test("claude '<prompt>' を組み立てる箇所は utils/setupPaneLaunch.js の 1 本だけ", () => {
  const offenders = [];
  ['main.js', 'preload.js', 'renderer/app.js', 'renderer/setupPanel.js', 'utils/setupStatus.js'].forEach((file) => {
    if (/claude '\$\{/.test(read(file))) offenders.push(file);
  });
  assert.deepEqual(offenders, []);
  assert.match(read('utils/setupPaneLaunch.js'), /claude '\$\{prompt\}'/);
});

test('renderer: 組み込みのオプションが無いときはパネルを作らない（createSetupPanelController は setupPanelEnabled のときだけ呼ぶ）', () => {
  const app = read('renderer/app.js');
  const calls = app.match(/createSetupPanelController\(\)/g) || [];
  // 定義 1 + 呼び出し 1。
  assert.equal(calls.length, 2);
  assert.match(app, /cfg && cfg\.setupPanelEnabled === true && !setupPanel\) setupPanel = createSetupPanelController\(\)/);
  assert.match(app, /const mainNodes = setupPanel \? setupPanel\.layout\(newContent\) : \[newContent\];/);
  assert.match(app, /VKIpc\.invoke\('setup:initial-pane'\)/);
});

test('renderer/setupPanel.js: doctor の文字列は textContent だけで描き、innerHTML 系を使わない', () => {
  const source = read('renderer/setupPanel.js');
  assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment/.test(source), false);
});

test('renderer/setupPanel.js: コマンドはコピーだけで、実行する経路（terminal:input など）に触れない', () => {
  const source = read('renderer/setupPanel.js');
  assert.equal(/terminal:input|terminal:create|VKIpc\.send/.test(source), false);
  assert.match(source, /writeClipboard/);
});

test('preload.js: setup:* は invoke の許可リストにあり、main.js のハンドラと対応する', () => {
  const preload = read('preload.js');
  assert.match(preload, /'setup:check',/);
  assert.match(preload, /'setup:initial-pane',/);
});
