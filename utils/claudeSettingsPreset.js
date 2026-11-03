'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveTrustedExecutableDetailed } = require('./codexTaskOps');
const { listToolSearchDirs } = require('./codexTaskPolicy');

const PRESET = 'vk-orchestrator-work-pane';
const ALLOWED_CLAUDE_SETTINGS_PRESETS = Object.freeze([PRESET]);
const SETTINGS_PATH_PATTERN = /^\/[^'\x00-\x1f\x7f]+$/;
const SAFE_LAUNCHER_PATH_PATTERN = /^[A-Za-z0-9/._-]+$/;

function isValidClaudeSettingsPreset(value) {
  return value === PRESET;
}

function validateClaudeSettingsPresetForEngine(engine, noClaude, preset) {
  if (preset === undefined) return { ok: true, preset: undefined };
  if (!isValidClaudeSettingsPreset(preset)) return { ok: false, error: 'invalid claudeSettingsPreset' };
  if (engine !== 'claude') return { ok: false, error: 'claudeSettingsPreset requires engine "claude"' };
  if (noClaude === true) return { ok: false, error: 'claudeSettingsPreset cannot be used with noClaude' };
  return { ok: true, preset };
}

// VK Orchestrator の実体だけを受け付け、作業リポジトリ内の同名コマンドを実行しない。
function resolveVkOrchestratorEntry(root, fsImpl = fs) {
  if (typeof root !== 'string' || !path.isAbsolute(root) || !SAFE_LAUNCHER_PATH_PATTERN.test(root)) return null;
  try {
    const rootStat = fsImpl.lstatSync(root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return null;
    const pkg = JSON.parse(fsImpl.readFileSync(path.join(root, 'package.json'), 'utf8'));
    if (pkg.name !== 'vk-orchestrator') return null;
    const entry = path.join(root, 'bin', 'vk-orchestrator.js');
    const entryStat = fsImpl.lstatSync(entry);
    if (entryStat.isSymbolicLink() || !entryStat.isFile() || !SAFE_LAUNCHER_PATH_PATTERN.test(entry)) return null;
    return entry;
  } catch (_error) {
    return null;
  }
}

function resolveClaudeSettingsHookCommand(options = {}) {
  const fsImpl = options.fs || fs;
  const node = resolveTrustedExecutableDetailed(
    fsImpl,
    'node',
    options.nodeSearchDirs || listToolSearchDirs(options.homeDir, options.pathEnv),
    { uid: options.uid }
  );
  const installedRoot = path.resolve(__dirname, '..', '..', '..');
  const orchestratorEntry = resolveVkOrchestratorEntry(options.vkOrchestratorRoot || installedRoot, fsImpl);
  if (!node || !SAFE_LAUNCHER_PATH_PATTERN.test(node.path) || !orchestratorEntry) {
    throw new Error('Claude settings preset hook is unavailable');
  }
  return `'${node.path}' '${orchestratorEntry}' check-turn-end-status-hook`;
}

function buildPreset(command) {
  return { hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } };
}

function prepareClaudeSettingsPreset(dataDir, preset, options = {}) {
  if (!isValidClaudeSettingsPreset(preset)) throw new Error('invalid claudeSettingsPreset');
  const presetDir = path.join(dataDir, 'claude-settings-presets');
  const settingsPath = path.join(presetDir, `${preset}.json`);
  fs.mkdirSync(presetDir, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(presetDir);
  const uid = options.uid === undefined && typeof process.getuid === 'function' ? process.getuid() : options.uid;
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) throw new Error('Claude settings preset directory must be a regular directory');
  if ((uid !== undefined && directoryStat.uid !== uid) || (directoryStat.mode & 0o022) !== 0) {
    throw new Error('Claude settings preset directory has unsafe ownership or permissions');
  }
  const command = resolveClaudeSettingsHookCommand({ ...options, uid });
  // 一時ファイルから rename し、既存のシンボリックリンクを辿らず置き換える。
  const temporaryPath = path.join(presetDir, `.${preset}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(buildPreset(command), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryPath, settingsPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (_error) {}
  }
  return settingsPath;
}

function buildClaudeSettingsArgument(preset, settingsPath) {
  if (!isValidClaudeSettingsPreset(preset) || typeof settingsPath !== 'string' || !SETTINGS_PATH_PATTERN.test(settingsPath)) {
    throw new Error('invalid prepared Claude settings preset');
  }
  return `--settings '${settingsPath}'`;
}

module.exports = {
  ALLOWED_CLAUDE_SETTINGS_PRESETS,
  SAFE_LAUNCHER_PATH_PATTERN,
  isValidClaudeSettingsPreset,
  validateClaudeSettingsPresetForEngine,
  resolveVkOrchestratorEntry,
  resolveClaudeSettingsHookCommand,
  prepareClaudeSettingsPreset,
  buildClaudeSettingsArgument,
};
