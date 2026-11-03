'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const childProcess = require('child_process');

const {
  isValidClaudeSettingsPreset,
  validateClaudeSettingsPresetForEngine,
  resolveVkOrchestratorEntry,
  resolveClaudeSettingsHookCommand,
  prepareClaudeSettingsPreset,
  buildClaudeSettingsArgument,
} = require('../utils/claudeSettingsPreset');
const { buildClaudeLaunchCommand } = require('../renderer/claudeModel');

const PRESET = 'vk-orchestrator-work-pane';
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const rendererSource = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'app.js'), 'utf8');

function createFixture(t, prefix = 'vk-terminals-claude-preset-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dataDir = path.join(root, 'data');
  const toolsDir = path.join(root, 'tools');
  const orchestratorRoot = path.join(root, 'vk-orchestrator');
  fs.mkdirSync(toolsDir);
  fs.mkdirSync(path.join(orchestratorRoot, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(toolsDir, 'node'), '#!/bin/sh\n', { mode: 0o700 });
  fs.writeFileSync(path.join(orchestratorRoot, 'package.json'), '{"name":"vk-orchestrator"}\n');
  fs.writeFileSync(path.join(orchestratorRoot, 'bin', 'vk-orchestrator.js'), '#!/usr/bin/env node\n');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dataDir, toolsDir, orchestratorRoot };
}

test('未指定時の Claude 起動コマンドは従来と同一', () => {
  assert.equal(buildClaudeLaunchCommand(undefined), 'claude');
  assert.equal(buildClaudeLaunchCommand('sonnet'), "claude --model 'sonnet'");
});

test('許可済みプリセットだけを受け付け、Codex と noClaude では拒否する', () => {
  assert.equal(isValidClaudeSettingsPreset(PRESET), true);
  for (const value of ['', '../x', '/tmp/x.json', '{"hooks":{}}', 1, {}, null]) {
    assert.equal(isValidClaudeSettingsPreset(value), false);
    assert.deepEqual(validateClaudeSettingsPresetForEngine('claude', false, value), {
      ok: false,
      error: 'invalid claudeSettingsPreset',
    });
  }
  assert.deepEqual(validateClaudeSettingsPresetForEngine('codex', false, PRESET), {
    ok: false,
    error: 'claudeSettingsPreset requires engine "claude"',
  });
  assert.deepEqual(validateClaudeSettingsPresetForEngine('claude', true, PRESET), {
    ok: false,
    error: 'claudeSettingsPreset cannot be used with noClaude',
  });
});

test('管理済み settings を生成し、安全に --settings へ渡す', (t) => {
  const fixture = createFixture(t);
  const settingsPath = prepareClaudeSettingsPreset(fixture.dataDir, PRESET, {
    nodeSearchDirs: [fixture.toolsDir], vkOrchestratorRoot: fixture.orchestratorRoot,
  });
  const actual = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(actual.hooks.Stop[0].hooks[0], {
    type: 'command',
    command: `'${path.join(fixture.toolsDir, 'node')}' '${fs.realpathSync(path.join(fixture.orchestratorRoot, 'bin', 'vk-orchestrator.js'))}' check-turn-end-status-hook`,
  });
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
  const options = {
    claudeSettingsPreset: PRESET,
    claudeSettingsPath: settingsPath,
    buildClaudeSettingsArgument,
  };
  assert.equal(
    buildClaudeLaunchCommand(undefined, options),
    `claude --settings '${settingsPath}'`
  );
  assert.equal(
    buildClaudeLaunchCommand('sonnet', options),
    `claude --model 'sonnet' --settings '${settingsPath}'`
  );
});

test('VK Orchestrator と Node の固定パスを検証し、解決できない場合は拒否する', (t) => {
  const fixture = createFixture(t);
  assert.equal(resolveVkOrchestratorEntry(fixture.orchestratorRoot), fs.realpathSync(path.join(fixture.orchestratorRoot, 'bin', 'vk-orchestrator.js')));
  assert.match(resolveClaudeSettingsHookCommand({ nodeSearchDirs: [fixture.toolsDir], vkOrchestratorRoot: fixture.orchestratorRoot }), /check-turn-end-status-hook$/);
  assert.throws(() => resolveClaudeSettingsHookCommand({ nodeSearchDirs: [], vkOrchestratorRoot: fixture.orchestratorRoot }), /unavailable/);
  fs.writeFileSync(path.join(fixture.orchestratorRoot, 'package.json'), '{"name":"wrong"}\n');
  assert.equal(resolveVkOrchestratorEntry(fixture.orchestratorRoot), null);
  fs.writeFileSync(path.join(fixture.orchestratorRoot, 'package.json'), '{"name":"vk-orchestrator"}\n');
  fs.unlinkSync(path.join(fixture.orchestratorRoot, 'bin', 'vk-orchestrator.js'));
  fs.symlinkSync(path.join(fixture.toolsDir, 'node'), path.join(fixture.orchestratorRoot, 'bin', 'vk-orchestrator.js'));
  assert.equal(resolveVkOrchestratorEntry(fixture.orchestratorRoot), null);
  assert.equal(resolveVkOrchestratorEntry("/tmp/vk-orchestrator'bad"), null);
});

test('VK Orchestrator のルートまたは entry が他人に書き込み可能なら拒否する', (t) => {
  const fixture = createFixture(t);
  const entry = path.join(fixture.orchestratorRoot, 'bin', 'vk-orchestrator.js');
  fs.chmodSync(fixture.orchestratorRoot, 0o722);
  assert.equal(resolveVkOrchestratorEntry(fixture.orchestratorRoot), null);
  fs.chmodSync(fixture.orchestratorRoot, 0o700);
  fs.chmodSync(entry, 0o722);
  assert.equal(resolveVkOrchestratorEntry(fixture.orchestratorRoot), null);
});

test('空白を含む VK Orchestrator アプリのパスを3引数のフックコマンドにする', (t) => {
  const fixture = createFixture(t, 'VK Orchestrator.app ');
  const toolsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-tools-'));
  const nodePath = path.join(toolsRoot, 'node');
  fs.writeFileSync(nodePath, '#!/bin/sh\n', { mode: 0o700 });
  t.after(() => fs.rmSync(toolsRoot, { recursive: true, force: true }));
  const command = resolveClaudeSettingsHookCommand({
    nodeSearchDirs: [toolsRoot],
    vkOrchestratorRoot: fixture.orchestratorRoot,
  });
  const args = childProcess.execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '<%s>\\n' "$@"`], { encoding: 'utf8' });
  assert.deepEqual(args.trim().split('\n'), [
    `<${nodePath}>`,
    `<${fs.realpathSync(path.join(fixture.orchestratorRoot, 'bin', 'vk-orchestrator.js'))}>`,
    '<check-turn-end-status-hook>',
  ]);
});

test('管理フォルダと既存 settings のシンボリックリンクを安全に扱う', (t) => {
  const fixture = createFixture(t);
  const presetDir = path.join(fixture.dataDir, 'claude-settings-presets');
  const outside = path.join(fixture.root, 'outside.json');
  fs.mkdirSync(presetDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(outside, 'unchanged');
  fs.symlinkSync(outside, path.join(presetDir, `${PRESET}.json`));
  const options = { nodeSearchDirs: [fixture.toolsDir], vkOrchestratorRoot: fixture.orchestratorRoot };
  prepareClaudeSettingsPreset(fixture.dataDir, PRESET, options);
  assert.equal(fs.readFileSync(outside, 'utf8'), 'unchanged');
  assert.equal(fs.lstatSync(path.join(presetDir, `${PRESET}.json`)).isSymbolicLink(), false);

  fs.rmSync(presetDir, { recursive: true });
  fs.symlinkSync(fixture.toolsDir, presetDir);
  assert.throws(() => prepareClaudeSettingsPreset(fixture.dataDir, PRESET, options), /regular directory/);
});

test('管理フォルダが他人に書き込み可能または他人所有なら拒否する', (t) => {
  const fixture = createFixture(t);
  const presetDir = path.join(fixture.dataDir, 'claude-settings-presets');
  const options = { nodeSearchDirs: [fixture.toolsDir], vkOrchestratorRoot: fixture.orchestratorRoot };
  fs.mkdirSync(presetDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(presetDir, 0o722);
  assert.throws(() => prepareClaudeSettingsPreset(fixture.dataDir, PRESET, options), /unsafe ownership or permissions/);
  fs.chmodSync(presetDir, 0o700);
  assert.throws(
    () => prepareClaudeSettingsPreset(fixture.dataDir, PRESET, { ...options, uid: process.getuid() + 1 }),
    /unsafe ownership or permissions/
  );
});

test('コマンド組み立て側でもプリセット名と生成パスを再検証する', () => {
  assert.throws(() => buildClaudeSettingsArgument('../x', '/tmp/settings.json'));
  assert.throws(() => buildClaudeSettingsArgument(PRESET, "'/tmp/settings.json"));
  assert.throws(() => buildClaudeLaunchCommand(undefined, { claudeSettingsPreset: PRESET }));
});

test('HTTP のプリセットは renderer から terminal:create へ転送される', () => {
  const handler = rendererSource.slice(rendererSource.indexOf("VKIpc.on('terminal:request-new-pane'"));
  assert.match(handler, /claudeSettingsPreset\s*}\s*=\s*payload/);
  assert.match(handler, /typeof claudeSettingsPreset === 'string'[\s\S]*?splitOptions[\s\S]*?claudeSettingsPreset/);
});

test('restart は設定の解決に成功してから AI の停止処理へ渡す', () => {
  const handler = mainSource.slice(mainSource.indexOf("url.pathname === '/api/restart-agent'"));
  const resolvedAt = handler.indexOf('launchOptions = resolveClaudeSettingsLaunchOptions');
  const restartAt = handler.indexOf('restartAgentInTerminal(ptyProcess');
  assert.ok(resolvedAt >= 0 && restartAt > resolvedAt);
  assert.match(handler.slice(resolvedAt, restartAt), /writeHead\(503/);
});

test('new-pane は preset と noClaude・Codex・useDefaults の併用を入口で拒否する', () => {
  const handler = mainSource.slice(mainSource.indexOf("url.pathname === '/api/new-pane'"));
  assert.match(handler, /validateClaudeSettingsPresetForEngine/);
  assert.match(handler, /claudeSettingsPreset cannot be used with useDefaults/);
});
