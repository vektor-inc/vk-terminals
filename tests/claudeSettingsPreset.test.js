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
  fs.mkdirSync(path.join(orchestratorRoot, 'src', 'engine'), { recursive: true });
  fs.writeFileSync(path.join(orchestratorRoot, 'src', 'engine', 'sensitive-output-hook.js'), '// fixture\n');
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
  assert.deepEqual(actual.hooks.PreToolUse, [{
    matcher: 'Bash|Read|Grep',
    hooks: [{ type: 'command', timeout: 5, command: actual.hooks.Stop[0].hooks[0].command.replace(/check-turn-end-status-hook$/, 'check-sensitive-output-hook') }],
  }]);
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

// 未対応版と信頼できないモジュールでは、設定を書き出さない。
for (const condition of ['missing', 'symlink', 'group-writable', 'world-writable', 'parent-writable']) {
  test(`秘密出力フックが ${condition} ならプリセットを拒否する`, (t) => {
    const fixture = createFixture(t);
    const modulePath = path.join(fixture.orchestratorRoot, 'src', 'engine', 'sensitive-output-hook.js');
    if (condition === 'missing' || condition === 'symlink') fs.unlinkSync(modulePath);
    if (condition === 'symlink') fs.symlinkSync(path.join(fixture.orchestratorRoot, 'bin', 'vk-orchestrator.js'), modulePath);
    if (condition === 'group-writable') fs.chmodSync(modulePath, 0o664);
    if (condition === 'world-writable') fs.chmodSync(modulePath, 0o646);
    if (condition === 'parent-writable') fs.chmodSync(path.dirname(modulePath), 0o777);
    // entry の単独解決は旧版でも利用できる。
    assert.ok(resolveVkOrchestratorEntry(fixture.orchestratorRoot));
    const options = { nodeSearchDirs: [fixture.toolsDir], vkOrchestratorRoot: fixture.orchestratorRoot };
    assert.throws(() => resolveClaudeSettingsHookCommand(options), /Claude settings preset hook is unavailable/);
    assert.throws(() => prepareClaudeSettingsPreset(fixture.dataDir, PRESET, options), /Claude settings preset hook is unavailable/);
    assert.equal(fs.existsSync(path.join(fixture.dataDir, 'claude-settings-presets', `${PRESET}.json`)), false);
  });
}

test('生成した PreToolUse command をシェルで実行し deny JSON を受け取る', (t) => {
  const fixture = createFixture(t, "vk-preset ' spaces-");
  const nodePath = path.join(fixture.toolsDir, 'node');
  // 安全な固定パスのランチャーから実際の Node.js を呼び出す。
  fs.writeFileSync(nodePath, `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' "$@"\n`, { mode: 0o700 });
  fs.writeFileSync(path.join(fixture.orchestratorRoot, 'bin', 'vk-orchestrator.js'), `
    if (process.argv[2] !== 'check-sensitive-output-hook') process.exit(1);
    console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } }));
  `);
  // Node の検証では安全な文字だけのパスが必要なため別の配置を使う。
  const toolsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-preset-node-'));
  t.after(() => fs.rmSync(toolsDir, { recursive: true, force: true }));
  fs.copyFileSync(nodePath, path.join(toolsDir, 'node'));
  const settingsPath = prepareClaudeSettingsPreset(fixture.dataDir, PRESET, {
    nodeSearchDirs: [toolsDir], vkOrchestratorRoot: fixture.orchestratorRoot,
  });
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const result = childProcess.spawnSync('/bin/sh', ['-c', settings.hooks.PreToolUse[0].hooks[0].command], { encoding: 'utf8', input: '{}' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
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
  assert.equal(resolveVkOrchestratorEntry("relative/path"), null);
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
  const fixture = createFixture(t, "VK Orchestrator.app '\\ ");
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

test('途中のリンク先の実パスに単一引用符があってもフックを引用する', (t) => {
  const fixture = createFixture(t);
  const linkedRoot = path.join(fixture.root, 'linked-root');
  const actualParent = path.join(fixture.root, "actual'root");
  const actualOrchestratorRoot = path.join(actualParent, 'vk-orchestrator');
  fs.mkdirSync(actualParent);
  fs.renameSync(fixture.orchestratorRoot, actualOrchestratorRoot);
  fs.symlinkSync(actualParent, linkedRoot);
  const orchestratorRoot = path.join(linkedRoot, 'vk-orchestrator');

  assert.equal(resolveVkOrchestratorEntry(orchestratorRoot), fs.realpathSync(actualOrchestratorRoot + '/bin/vk-orchestrator.js'));
  const command = resolveClaudeSettingsHookCommand({ nodeSearchDirs: [fixture.toolsDir], vkOrchestratorRoot: orchestratorRoot });
  const args = childProcess.execFileSync('/bin/sh', ['-c', `set -- ${command}; printf '%s\n' "$2"`], { encoding: 'utf8' });
  assert.equal(args.trim(), fs.realpathSync(actualOrchestratorRoot + '/bin/vk-orchestrator.js'));
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
  assert.throws(() => buildClaudeSettingsArgument(PRESET, "/tmp/settings\n.json"));
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
  assert.match(handler.slice(resolvedAt, restartAt), /Claude settings preset hook is unavailable/);
  assert.doesNotMatch(handler.slice(resolvedAt, restartAt), /JSON\.stringify\(\{ error: error\.message \}\)/);
});

test('new-pane は preset と noClaude・Codex・useDefaults の併用を入口で拒否する', () => {
  const handler = mainSource.slice(mainSource.indexOf("url.pathname === '/api/new-pane'"));
  assert.match(handler, /validateClaudeSettingsPresetForEngine/);
  assert.match(handler, /claudeSettingsPreset cannot be used with useDefaults/);
});

test('new-pane は指定された preset を renderer へ渡す前に用意し、失敗時は 503 でペインを作らない', () => {
  const start = mainSource.indexOf("url.pathname === '/api/new-pane'");
  const handler = mainSource.slice(start, mainSource.indexOf("url.pathname === '/api/restart-agent'", start));
  const presetGuardAt = handler.indexOf('if (requestedClaudeSettingsPreset !== undefined)');
  const prepareAt = handler.indexOf("resolveClaudeSettingsLaunchOptions('claude', false", presetGuardAt);
  const unavailableAt = handler.indexOf('writeHead(503', prepareAt);
  const requestAt = handler.indexOf("win.webContents.send('terminal:request-new-pane'", prepareAt);
  assert.ok(presetGuardAt >= 0 && prepareAt > presetGuardAt);
  assert.ok(unavailableAt > prepareAt && requestAt > unavailableAt);
  assert.match(handler.slice(prepareAt, requestAt), /catch \(error\)[\s\S]*?return;/);
  assert.match(handler.slice(prepareAt, requestAt), /Claude settings preset hook is unavailable/);
  assert.doesNotMatch(handler.slice(prepareAt, requestAt), /JSON\.stringify\(\{ error: error\.message \}\)/);
});

test('terminal:create のプリセット再準備失敗は詳細をログだけに残して固定文言を返す', () => {
  const start = mainSource.indexOf("ipcMain.handle('terminal:create'");
  const handler = mainSource.slice(start, mainSource.indexOf("ipcMain.handle('terminal:write'", start));
  const resolvedAt = handler.indexOf('resolveClaudeSettingsLaunchOptions');
  const catchAt = handler.indexOf('catch (error)', resolvedAt);
  assert.ok(resolvedAt >= 0 && catchAt > resolvedAt);
  assert.match(handler.slice(catchAt), /console\.error\([\s\S]*?error\)/);
  assert.match(handler.slice(catchAt), /throw new Error\('Claude settings preset hook is unavailable'\)/);
});

test('new-pane は preset 未指定なら設定の事前準備を行わない', () => {
  const start = mainSource.indexOf("url.pathname === '/api/new-pane'");
  const handler = mainSource.slice(start, mainSource.indexOf("url.pathname === '/api/restart-agent'", start));
  const presetGuardAt = handler.indexOf('if (requestedClaudeSettingsPreset !== undefined)');
  const prepareAt = handler.indexOf("resolveClaudeSettingsLaunchOptions('claude', false", presetGuardAt);
  const guardEndAt = handler.indexOf('\n        }', prepareAt);
  assert.ok(presetGuardAt >= 0 && prepareAt > presetGuardAt && guardEndAt > prepareAt);
  assert.equal(handler.slice(0, presetGuardAt).includes("resolveClaudeSettingsLaunchOptions('claude', false"), false);
});
