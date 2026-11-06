'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveTrustedExecutableDetailed, resolveTrustedPath } = require('./codexTaskOps');
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
function resolveVkOrchestratorEntry(root, fsImpl = fs, options = {}) {
  if (typeof root !== 'string' || !SETTINGS_PATH_PATTERN.test(root)) return null;
  try {
    const resolvedRoot = resolveTrustedPath(fsImpl, root, { finalKind: 'directory', rejectFinalLink: true, uid: options.uid }).realPath;
    if (!SETTINGS_PATH_PATTERN.test(resolvedRoot)) return null;
    const pkg = JSON.parse(fsImpl.readFileSync(path.join(resolvedRoot, 'package.json'), 'utf8'));
    if (pkg.name !== 'vk-orchestrator') return null;
    const entry = path.join(resolvedRoot, 'bin', 'vk-orchestrator.js');
    if (!SETTINGS_PATH_PATTERN.test(entry)) return null;
    const resolvedEntry = resolveTrustedPath(fsImpl, entry, { finalKind: 'file', rejectFinalLink: true, uid: options.uid }).realPath;
    return SETTINGS_PATH_PATTERN.test(resolvedEntry) ? resolvedEntry : null;
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
  const orchestratorEntry = resolveVkOrchestratorEntry(options.vkOrchestratorRoot || installedRoot, fsImpl, { uid: options.uid });
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

// 起動ごとに分離した設定へフックを足し、Stop など既存のイベントを保つ。
function prepareBackgroundWorkSettings(dataDir, config, settingsPath, options = {}) {
  const node = resolveTrustedExecutableDetailed(fs, 'node', options.nodeSearchDirs || listToolSearchDirs(options.homeDir, options.pathEnv));
  if (!node || !SAFE_LAUNCHER_PATH_PATTERN.test(node.path)) throw new Error('Background work hook runtime unavailable');
  const directory = fs.mkdtempSync(path.join(dataDir, 'background-work-'));
  fs.chmodSync(directory, 0o700);
  const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
  try {
    const configPath = path.join(directory, 'connection.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    const settings = settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    settings.hooks = settings.hooks || {};
    const command = `${quote(node.path)} ${quote(path.join(__dirname, 'backgroundWorkHook.js'))} ${quote(configPath)}`;
    for (const event of ['SubagentStart', 'SubagentStop']) {
      settings.hooks[event] = [...(settings.hooks[event] || []), { hooks: [{ type: 'command', command, timeout: 3 }] }];
    }
    const filename = path.join(directory, 'settings.json');
    fs.writeFileSync(filename, JSON.stringify(settings), { mode: 0o600, flag: 'wx' });
    return { filename, discard: () => fs.rmSync(directory, { recursive: true, force: true }) };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = {
  prepareBackgroundWorkSettings,
  ALLOWED_CLAUDE_SETTINGS_PRESETS,
  SAFE_LAUNCHER_PATH_PATTERN,
  isValidClaudeSettingsPreset,
  validateClaudeSettingsPresetForEngine,
  resolveVkOrchestratorEntry,
  resolveClaudeSettingsHookCommand,
  prepareClaudeSettingsPreset,
  buildClaudeSettingsArgument,
};
