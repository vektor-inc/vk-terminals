'use strict';
// utils/gpu.js（GUI の GPU 起動モード）のテスト。
// - モード解決（env / プラットフォーム既定 / 未知値フォールバック）
// - モード→Chromium スイッチ・追加 env の写像
// - argv に明示スイッチがある場合は介入しないこと（orchestrator との競合回避）

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  GPU_MODES,
  defaultGpuMode,
  isWsl,
  parseWslVersionOutput,
  readWslVersion,
  detectAutoGpu,
  resolveGpuDecision,
  resolveGpuMode,
  hasExplicitGpuSwitch,
  gpuSwitches,
  applyGpuMode,
  getGpuStartup,
} = require('../utils/gpu');

// 開発機が WSL でも本物の wsl.exe が呼ばれて結果が変わらないよう、WSL ではない環境を注入する。
const NOT_WSL = { isWsl: () => false };

test('GPU_MODES: 取りうる値の一覧（off / default の2択）', () => {
  assert.deepEqual(GPU_MODES, ['off', 'default']);
});

test('defaultGpuMode: macOS は default、それ以外は off', () => {
  assert.equal(defaultGpuMode('darwin'), 'default');
  assert.equal(defaultGpuMode('linux'), 'off');
  assert.equal(defaultGpuMode('win32'), 'off');
});

test('resolveGpuMode: 未設定はプラットフォーム既定にフォールバック', () => {
  assert.equal(resolveGpuMode({}, 'linux', undefined, NOT_WSL), 'off');
  assert.equal(resolveGpuMode({}, 'darwin', undefined, NOT_WSL), 'default');
});

test('resolveGpuMode: VK_TERMINALS_GPU を採用し正規化する', () => {
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: 'off' }, 'darwin'), 'off');
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: '  Default ' }, 'linux'), 'default');
});

test('resolveGpuMode: 未知値・空文字は既定にフォールバック', () => {
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: 'turbo' }, 'linux', undefined, NOT_WSL), 'off');
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: '' }, 'darwin', undefined, NOT_WSL), 'default');
});

test('resolveGpuMode: config.json の gpu を採用し正規化する（env 未指定時）', () => {
  assert.equal(resolveGpuMode({}, 'darwin', 'off'), 'off');
  assert.equal(resolveGpuMode({}, 'linux', ' Default '), 'default');
});

test('resolveGpuMode: env が config を上回る', () => {
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: 'default' }, 'linux', 'off'), 'default');
});

test('resolveGpuMode: config が未知値なら次候補（プラットフォーム既定）へ', () => {
  assert.equal(resolveGpuMode({}, 'linux', 'turbo', NOT_WSL), 'off');
  assert.equal(resolveGpuMode({}, 'darwin', '', NOT_WSL), 'default');
});

test('resolveGpuMode: env が未知値でも config に有効値があればそちらを採用する', () => {
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: 'turbo' }, 'linux', 'default'), 'default');
});

test('applyGpuMode: configMode を採用する（env 未指定時・プラットフォーム既定を上書き）', () => {
  const called = [];
  const fakeApp = { commandLine: { appendSwitch: (...a) => called.push(a) } };
  const env = {};
  // darwin の既定は 'default' だが、config で 'off' を指定すれば off になる
  const mode = applyGpuMode(fakeApp, { argv: ['electron', '.'], env, platform: 'darwin', configMode: 'off' });
  assert.equal(mode, 'off');
  assert.deepEqual(called, [['disable-gpu'], ['disable-software-rasterizer']]);
});

test('hasExplicitGpuSwitch: GPU 関連スイッチの有無を検出する', () => {
  assert.equal(hasExplicitGpuSwitch(['electron', '.', '--disable-gpu']), true);
  assert.equal(hasExplicitGpuSwitch(['electron', '.', '--use-gl=angle']), true);
  assert.equal(hasExplicitGpuSwitch(['electron', '.', '--ignore-gpu-blocklist']), true);
  assert.equal(hasExplicitGpuSwitch(['electron', '.', '--disable-gpu-sandbox']), true);
  assert.equal(hasExplicitGpuSwitch(['electron', '.', '--no-claude']), false);
  assert.equal(hasExplicitGpuSwitch(['electron', '.']), false);
});

test('gpuSwitches: off は GPU 無効スイッチ、追加 env は無し', () => {
  const { switches, env } = gpuSwitches('off');
  assert.deepEqual(switches, [['disable-gpu'], ['disable-software-rasterizer']]);
  assert.deepEqual(env, {});
});

test('gpuSwitches: default はスイッチ・env とも空', () => {
  assert.deepEqual(gpuSwitches('default'), { switches: [], env: {} });
});

test('applyGpuMode: off モードで appendSwitch を呼ぶ（env 追加なし）', () => {
  const called = [];
  const fakeApp = { commandLine: { appendSwitch: (...a) => called.push(a) } };
  const env = {};
  const mode = applyGpuMode(fakeApp, { argv: ['electron', '.'], env, platform: 'linux', deps: NOT_WSL });
  assert.equal(mode, 'off');
  assert.deepEqual(called, [['disable-gpu'], ['disable-software-rasterizer']]);
});

test('applyGpuMode: argv に GPU スイッチがあれば介入しない（null 返し・appendSwitch 未呼び出し）', () => {
  const called = [];
  const fakeApp = { commandLine: { appendSwitch: (...a) => called.push(a) } };
  const env = {};
  const mode = applyGpuMode(fakeApp, { argv: ['electron', '.', '--use-gl=angle'], env, platform: 'linux' });
  assert.equal(mode, null);
  assert.deepEqual(called, []);
});

// ---- WSL の版による自動判定 ----

const utf16 = (text, bom = true) => Buffer.concat([bom ? Buffer.from([0xff, 0xfe]) : Buffer.alloc(0), Buffer.from(text, 'utf16le')]);
const WSL3_EN = 'WSL version: 3.0.5.0\r\nKernel version: 6.18.58.1-1\r\nWindows version: 10.0.26200.1\r\n';
const WSL3_JA = 'WSL バージョン: 3.0.5.0\r\nカーネル バージョン: 6.18.58.1-1\r\nWindows バージョン: 10.0.26200.1\r\n';

test('parseWslVersionOutput: 英語・日本語（UTF-16LE・BOM 付き）から版を取り出す', () => {
  assert.deepEqual(parseWslVersionOutput(utf16(WSL3_EN)), { ok: true, version: '3.0.5.0', major: 3 });
  assert.deepEqual(parseWslVersionOutput(utf16(WSL3_JA)), { ok: true, version: '3.0.5.0', major: 3 });
});

test('parseWslVersionOutput: BOM なしの UTF-16LE は NUL バイトで判別する', () => {
  assert.equal(parseWslVersionOutput(utf16(WSL3_EN, false)).major, 3);
});

test('parseWslVersionOutput: UTF-8（WSL_UTF8=1）・BOM 付き UTF-8 も読める', () => {
  assert.equal(parseWslVersionOutput(Buffer.from(WSL3_JA, 'utf8')).version, '3.0.5.0');
  const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(WSL3_EN, 'utf8')]);
  assert.equal(parseWslVersionOutput(withBom).version, '3.0.5.0');
});

test('parseWslVersionOutput: WSL 2 の版は major 2', () => {
  assert.deepEqual(parseWslVersionOutput(utf16('WSL version: 2.6.1.0\r\n')), { ok: true, version: '2.6.1.0', major: 2 });
});

test('parseWslVersionOutput: 先頭の空行を読み飛ばし、空でない最初の行だけを見る', () => {
  assert.equal(parseWslVersionOutput(Buffer.from('\r\n\r\nWSL version: 3.0.5.0\r\n', 'utf8')).major, 3);
  // 2 行目以降に 3.x があっても使わない
  assert.equal(parseWslVersionOutput(Buffer.from('WSL version: 2.6.1.0\nOther: 3.0.5.0\n', 'utf8')).major, 2);
});

test('parseWslVersionOutput: 空・使い方の説明だけ・先頭行が Windows の版（10.0.x）は「分からない」', () => {
  assert.equal(parseWslVersionOutput(Buffer.alloc(0)).ok, false);
  assert.equal(parseWslVersionOutput(Buffer.from('  \r\n \r\n')).ok, false);
  assert.equal(parseWslVersionOutput(utf16('Copyright (c) Microsoft Corporation. All rights reserved.\r\nUsage: wsl.exe [Argument]\r\n')).ok, false);
  assert.equal(parseWslVersionOutput(utf16('Windows version: 10.0.26200.1\r\n')).ok, false);
  assert.equal(parseWslVersionOutput(Buffer.from('version: 0.0.0.1\n')).ok, false);
});

const okResult = (stdout) => ({ status: 0, stdout });

test('readWslVersion: PATH 上の wsl.exe を 2 秒の時間制限・windowsHide で呼ぶ', () => {
  const calls = [];
  const spawnSync = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return okResult(utf16(WSL3_EN)); };
  assert.equal(readWslVersion({ spawnSync }).version, '3.0.5.0');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'wsl.exe');
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal(calls[0].opts.timeout, 2000);
  assert.equal(calls[0].opts.windowsHide, true);
});

test('readWslVersion: PATH に無ければ /mnt/c/Windows/System32/wsl.exe を試す', () => {
  const cmds = [];
  const spawnSync = (cmd) => {
    cmds.push(cmd);
    return cmd === 'wsl.exe' ? { error: Object.assign(new Error('x'), { code: 'ENOENT' }) } : okResult(utf16(WSL3_EN));
  };
  assert.equal(readWslVersion({ spawnSync }).major, 3);
  assert.deepEqual(cmds, ['wsl.exe', '/mnt/c/Windows/System32/wsl.exe']);
});

test('readWslVersion: どちらも見つからない・終了コード 0 以外・読み取れない出力は「分からない」', () => {
  const enoent = () => ({ error: Object.assign(new Error('x'), { code: 'ENOENT' }) });
  assert.deepEqual(readWslVersion({ spawnSync: enoent }), { ok: false, reason: 'wsl.exe not found' });
  assert.match(readWslVersion({ spawnSync: () => ({ status: 1, stdout: Buffer.alloc(0) }) }).reason, /exit code 1/);
  assert.equal(readWslVersion({ spawnSync: () => okResult(Buffer.from('usage\n')) }).ok, false);
  // 終了コード 0 でも出力が空なら分からない
  assert.equal(readWslVersion({ spawnSync: () => okResult(Buffer.alloc(0)) }).ok, false);
});

test('readWslVersion: 時間切れは「timeout」とし、次の候補は試さない', () => {
  let count = 0;
  const spawnSync = () => { count += 1; return { error: Object.assign(new Error('t'), { code: 'ETIMEDOUT' }) }; };
  assert.deepEqual(readWslVersion({ spawnSync }), { ok: false, reason: 'timeout' });
  assert.equal(count, 1);
});

test('isWsl: Linux で WSL_DISTRO_NAME か /proc/version の microsoft があれば true', () => {
  const noProc = () => { throw new Error('ENOENT'); };
  assert.equal(isWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: 'Ubuntu' }, readFileSync: noProc }), true);
  assert.equal(isWsl({ platform: 'linux', env: {}, readFileSync: () => 'Linux version 6.1 (microsoft-standard-WSL2)' }), true);
  assert.equal(isWsl({ platform: 'linux', env: { WSL_DISTRO_NAME: ' ' }, readFileSync: () => 'Linux version 6.1 generic' }), false);
  assert.equal(isWsl({ platform: 'linux', env: {}, readFileSync: noProc, osRelease: () => '6.1.0-microsoft' }), true);
  assert.equal(isWsl({ platform: 'linux', env: {}, readFileSync: noProc, osRelease: () => '6.1.0-generic' }), false);
  assert.equal(isWsl({ platform: 'darwin', env: { WSL_DISTRO_NAME: 'Ubuntu' } }), false);
  assert.equal(isWsl({ platform: 'win32', env: {} }), false);
});

const wslDeps = ({ dxg = true, version }) => ({
  isWsl: () => true,
  hasDxg: () => dxg,
  readWslVersion: () => version,
});

test('detectAutoGpu: WSL 3 以降かつ /dev/dxg ありは default', () => {
  const r = detectAutoGpu('linux', wslDeps({ version: { ok: true, version: '3.0.5.0', major: 3 } }));
  assert.equal(r.mode, 'default');
  assert.equal(r.reason, 'WSL 3.0.5.0');
});

test('detectAutoGpu: WSL 2 は off', () => {
  const r = detectAutoGpu('linux', wslDeps({ version: { ok: true, version: '2.6.1.0', major: 2 } }));
  assert.equal(r.mode, 'off');
  assert.equal(r.versionUnknown, false);
});

test('detectAutoGpu: WSL 3 でも /dev/dxg が無ければ off（wsl.exe は呼ばない）', () => {
  let called = false;
  const deps = { isWsl: () => true, hasDxg: () => false, readWslVersion: () => { called = true; } };
  assert.equal(detectAutoGpu('linux', deps).mode, 'off');
  assert.equal(called, false);
});

test('detectAutoGpu: 版が分からない WSL は off（理由に原因を含む）', () => {
  const r = detectAutoGpu('linux', wslDeps({ version: { ok: false, reason: 'timeout' } }));
  assert.equal(r.mode, 'off');
  assert.equal(r.versionUnknown, true);
  assert.equal(r.reason, 'WSL version unknown: timeout');
});

test('detectAutoGpu: macOS・ネイティブ Windows・WSL 以外の Linux は wsl.exe を呼ばず従来どおり', () => {
  const boom = { isWsl: () => { throw new Error('呼ばれない'); }, readWslVersion: () => { throw new Error('呼ばれない'); } };
  assert.equal(detectAutoGpu('darwin', boom).mode, 'default');
  assert.equal(detectAutoGpu('win32', { ...boom, isWsl: () => false }).mode, 'off');
  assert.equal(detectAutoGpu('linux', NOT_WSL).mode, 'off');
});

test('resolveGpuDecision: env・config を指定すれば wsl.exe を呼ばない', () => {
  let count = 0;
  const deps = { isWsl: () => true, hasDxg: () => true, readWslVersion: () => { count += 1; return { ok: true, version: '3.0.5.0', major: 3 }; } };
  assert.equal(resolveGpuDecision({ env: { VK_TERMINALS_GPU: 'off' }, platform: 'linux', deps }).mode, 'off');
  assert.equal(resolveGpuDecision({ env: {}, platform: 'linux', configMode: 'default', deps }).mode, 'default');
  assert.equal(count, 0);
});

test('resolveGpuDecision: 自動のときに 1 回だけ wsl.exe を呼ぶ（未知値の警告があっても二重に呼ばない）', () => {
  let count = 0;
  const deps = { isWsl: () => true, hasDxg: () => true, readWslVersion: () => { count += 1; return { ok: true, version: '3.0.5.0', major: 3 }; } };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const d = resolveGpuDecision({ env: { VK_TERMINALS_GPU: 'turbo' }, platform: 'linux', configMode: 'bogus', deps });
    assert.equal(d.mode, 'default');
    assert.equal(d.source, 'auto');
  } finally {
    console.warn = warn;
  }
  assert.equal(count, 1);
});

test('resolveGpuDecision: autoState は設定パネルの「自動」の文言の元になる', () => {
  const wsl3 = wslDeps({ version: { ok: true, version: '3.0.5.0', major: 3 } });
  const wsl2 = wslDeps({ version: { ok: true, version: '2.6.1.0', major: 2 } });
  const unknown = wslDeps({ version: { ok: false, reason: 'timeout' } });
  assert.equal(resolveGpuDecision({ env: {}, platform: 'linux', deps: wsl3 }).autoState, 'on');
  assert.equal(resolveGpuDecision({ env: {}, platform: 'linux', deps: wsl2 }).autoState, 'off');
  assert.equal(resolveGpuDecision({ env: {}, platform: 'linux', deps: unknown }).autoState, 'wsl-unknown');
  assert.equal(resolveGpuDecision({ env: {}, platform: 'darwin', deps: NOT_WSL }).autoState, 'on');
  // 指定があっても WSL 以外なら環境だけで決まる。WSL では wsl.exe を呼ばないため不明（null）
  assert.equal(resolveGpuDecision({ env: {}, platform: 'win32', configMode: 'default', deps: NOT_WSL }).autoState, 'off');
  assert.equal(resolveGpuDecision({ env: {}, platform: 'linux', configMode: 'off', deps: wsl3 }).autoState, null);
});

test('applyGpuMode: WSL 3 では default（スイッチを足さない）・結果を getGpuStartup で取れる', () => {
  const called = [];
  const fakeApp = { commandLine: { appendSwitch: (...a) => called.push(a) } };
  const deps = wslDeps({ version: { ok: true, version: '3.0.5.0', major: 3 } });
  const mode = applyGpuMode(fakeApp, { argv: ['electron', '.'], env: {}, platform: 'linux', deps });
  assert.equal(mode, 'default');
  assert.deepEqual(called, []);
  assert.equal(getGpuStartup().reason, 'WSL 3.0.5.0');
});

test('applyGpuMode: 明示スイッチがあれば wsl.exe を呼ばず、起動元の指定として記録する', () => {
  let called = false;
  const deps = { isWsl: () => { called = true; return true; } };
  const fakeApp = { commandLine: { appendSwitch: () => {} } };
  assert.equal(applyGpuMode(fakeApp, { argv: ['electron', '.', '--disable-gpu'], env: {}, platform: 'linux', deps }), null);
  assert.equal(called, false);
  assert.equal(getGpuStartup().autoState, 'switch');
});
