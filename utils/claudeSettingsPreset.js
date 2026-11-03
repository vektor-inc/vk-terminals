'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// API から選べる名前と設定内容を同じ表に束縛し、任意のパスや JSON を受け取らない。
const CLAUDE_SETTINGS_PRESETS = Object.freeze({
  'vk-orchestrator-work-pane': Object.freeze({
    hooks: Object.freeze({
      Stop: Object.freeze([Object.freeze({
        hooks: Object.freeze([Object.freeze({
          type: 'command',
          command: 'vk-orchestrator check-turn-end-status-hook',
        })]),
      })]),
    }),
  }),
});
const ALLOWED_CLAUDE_SETTINGS_PRESETS = Object.freeze(Object.keys(CLAUDE_SETTINGS_PRESETS));
const SETTINGS_PATH_PATTERN = /^\/[^'\x00-\x1f\x7f]+$/;

function isValidClaudeSettingsPreset(value) {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(CLAUDE_SETTINGS_PRESETS, value);
}

function validateClaudeSettingsPresetForEngine(engine, noClaude, preset) {
  if (preset === undefined) return { ok: true, preset: undefined };
  if (!isValidClaudeSettingsPreset(preset)) {
    return { ok: false, error: 'invalid claudeSettingsPreset' };
  }
  if (engine !== 'claude') {
    return { ok: false, error: 'claudeSettingsPreset requires engine "claude"' };
  }
  if (noClaude === true) {
    return { ok: false, error: 'claudeSettingsPreset cannot be used with noClaude' };
  }
  return { ok: true, preset };
}

// VK Terminals の管理領域へ固定名で書き出し、利用者やリポジトリの settings は変更しない。
function prepareClaudeSettingsPreset(dataDir, preset) {
  if (!isValidClaudeSettingsPreset(preset)) {
    throw new Error('invalid claudeSettingsPreset');
  }
  const presetDir = path.join(dataDir, 'claude-settings-presets');
  const settingsPath = path.join(presetDir, `${preset}.json`);
  fs.mkdirSync(presetDir, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(presetDir).isSymbolicLink()) {
    throw new Error('Claude settings preset directory must not be a symbolic link');
  }
  // 固定ファイルへ直接書かず、同じ管理フォルダ内の新規ファイルを rename してリンク追跡を防ぐ。
  const temporaryPath = path.join(presetDir, `.${preset}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(CLAUDE_SETTINGS_PRESETS[preset], null, 2)}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporaryPath, settingsPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (_error) {}
  }
  return settingsPath;
}

function buildClaudeSettingsArgument(preset, settingsPath) {
  if (!isValidClaudeSettingsPreset(preset)
    || typeof settingsPath !== 'string'
    || !SETTINGS_PATH_PATTERN.test(settingsPath)) {
    throw new Error('invalid prepared Claude settings preset');
  }
  return `--settings '${settingsPath}'`;
}

module.exports = {
  ALLOWED_CLAUDE_SETTINGS_PRESETS,
  CLAUDE_SETTINGS_PRESETS,
  isValidClaudeSettingsPreset,
  validateClaudeSettingsPresetForEngine,
  prepareClaudeSettingsPreset,
  buildClaudeSettingsArgument,
};
