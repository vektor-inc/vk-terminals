'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  CLAUDE_SETTINGS_PRESETS,
  isValidClaudeSettingsPreset,
  validateClaudeSettingsPresetForEngine,
  prepareClaudeSettingsPreset,
  buildClaudeSettingsArgument,
} = require('../utils/claudeSettingsPreset');
const { buildClaudeLaunchCommand } = require('../renderer/claudeModel');

const PRESET = 'vk-orchestrator-work-pane';

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-claude-preset-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const settingsPath = prepareClaudeSettingsPreset(dataDir, PRESET);
  const actual = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  assert.deepEqual(actual, CLAUDE_SETTINGS_PRESETS[PRESET]);
  assert.deepEqual(actual.hooks.Stop[0].hooks[0], {
    type: 'command',
    command: 'vk-orchestrator check-turn-end-status-hook',
  });
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

test('コマンド組み立て側でもプリセット名と生成パスを再検証する', () => {
  assert.throws(() => buildClaudeSettingsArgument('../x', '/tmp/settings.json'));
  assert.throws(() => buildClaudeSettingsArgument(PRESET, "'/tmp/settings.json"));
  assert.throws(() => buildClaudeLaunchCommand(undefined, { claudeSettingsPreset: PRESET }));
});
