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
  resolveGpuMode,
  hasExplicitGpuSwitch,
  gpuSwitches,
  applyGpuMode,
} = require('../utils/gpu');

test('GPU_MODES: 取りうる値の一覧', () => {
  assert.deepEqual(GPU_MODES, ['off', 'hardware', 'default']);
});

test('defaultGpuMode: macOS は default、それ以外は off', () => {
  assert.equal(defaultGpuMode('darwin'), 'default');
  assert.equal(defaultGpuMode('linux'), 'off');
  assert.equal(defaultGpuMode('win32'), 'off');
});

test('resolveGpuMode: 未設定はプラットフォーム既定にフォールバック', () => {
  assert.equal(resolveGpuMode({}, 'linux'), 'off');
  assert.equal(resolveGpuMode({}, 'darwin'), 'default');
});

test('resolveGpuMode: VK_TERMINALS_GPU を採用し正規化する', () => {
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: 'hardware' }, 'linux'), 'hardware');
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: '  Default ' }, 'linux'), 'default');
});

test('resolveGpuMode: 未知値・空文字は既定にフォールバック', () => {
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: 'turbo' }, 'linux'), 'off');
  assert.equal(resolveGpuMode({ VK_TERMINALS_GPU: '' }, 'darwin'), 'default');
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

test('gpuSwitches: hardware は ANGLE(GL)＋サンドボックス無効＋ブロックリスト無視、env に GALLIUM_DRIVER', () => {
  const { switches, env } = gpuSwitches('hardware');
  const names = switches.map((s) => s.join('='));
  assert.ok(names.includes('use-gl=angle'));
  assert.ok(names.includes('use-angle=gl'));
  assert.ok(names.includes('ignore-gpu-blocklist'));
  assert.ok(names.includes('disable-gpu-sandbox'));
  assert.equal(env.GALLIUM_DRIVER, 'd3d12');
});

test('gpuSwitches: default はスイッチ・env とも空', () => {
  assert.deepEqual(gpuSwitches('default'), { switches: [], env: {} });
});

test('applyGpuMode: off モードで appendSwitch を呼ぶ（env 追加なし）', () => {
  const called = [];
  const fakeApp = { commandLine: { appendSwitch: (...a) => called.push(a) } };
  const env = {};
  const mode = applyGpuMode(fakeApp, { argv: ['electron', '.'], env, platform: 'linux' });
  assert.equal(mode, 'off');
  assert.deepEqual(called, [['disable-gpu'], ['disable-software-rasterizer']]);
});

test('applyGpuMode: hardware で GALLIUM_DRIVER を設定し ANGLE スイッチを適用', () => {
  const called = [];
  const fakeApp = { commandLine: { appendSwitch: (...a) => called.push(a) } };
  const env = { VK_TERMINALS_GPU: 'hardware' };
  const mode = applyGpuMode(fakeApp, { argv: ['electron', '.'], env, platform: 'linux' });
  assert.equal(mode, 'hardware');
  assert.equal(env.GALLIUM_DRIVER, 'd3d12');
  const names = called.map((s) => s.join('='));
  assert.ok(names.includes('use-gl=angle'));
  assert.ok(names.includes('ignore-gpu-blocklist'));
  assert.ok(names.includes('disable-gpu-sandbox'));
});

test('applyGpuMode: argv に GPU スイッチがあれば介入しない（null 返し・appendSwitch 未呼び出し）', () => {
  const called = [];
  const fakeApp = { commandLine: { appendSwitch: (...a) => called.push(a) } };
  const env = {};
  const mode = applyGpuMode(fakeApp, { argv: ['electron', '.', '--use-gl=angle'], env, platform: 'linux' });
  assert.equal(mode, null);
  assert.deepEqual(called, []);
});

test('applyGpuMode: 既存の GALLIUM_DRIVER は上書きしない', () => {
  const fakeApp = { commandLine: { appendSwitch: () => {} } };
  const env = { VK_TERMINALS_GPU: 'hardware', GALLIUM_DRIVER: 'zink' };
  applyGpuMode(fakeApp, { argv: ['electron', '.'], env, platform: 'linux' });
  assert.equal(env.GALLIUM_DRIVER, 'zink');
});
