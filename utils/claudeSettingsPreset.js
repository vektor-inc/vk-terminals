'use strict';

const { quoteShellArgument } = require('./restartAgent');
const { classifyShell, quoteShellPath } = require('./shellQuoting');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { resolveTrustedExecutableDetailed, resolveTrustedPath } = require('./codexTaskOps');
const { listToolSearchDirs } = require('./codexTaskPolicy');

const HOOK_UNAVAILABLE = 'Claude settings preset hook is unavailable';
const PRESET = 'vk-orchestrator-work-pane';
const ALLOWED_CLAUDE_SETTINGS_PRESETS = Object.freeze([PRESET]);
const SETTINGS_PATH_PATTERN = /^\/[^\x00-\x1f\x7f]+$/;
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

// Electron はフックの子プロセスだけ Node.js モードにし、ペインへ環境変数を渡さない。
function resolveHookLauncher(options = {}) {
  const fsImpl = options.fs || fs;
  if (options.electronHookExecPath !== undefined) {
    const execPath = options.electronHookExecPath;
    if (typeof execPath !== 'string' || !SETTINGS_PATH_PATTERN.test(execPath)) return null;
    try {
      const { realPath } = resolveTrustedPath(fsImpl, execPath, { finalKind: 'file', uid: options.uid });
      if (!SETTINGS_PATH_PATTERN.test(realPath) || (fsImpl.statSync(realPath).mode & 0o111) === 0) return null;
      return `/usr/bin/env ELECTRON_RUN_AS_NODE=1 ${quoteShellArgument(execPath)}`;
    } catch (_) {
      return null;
    }
  }
  const node = resolveTrustedExecutableDetailed(fsImpl, 'node',
    options.nodeSearchDirs || listToolSearchDirs(options.homeDir, options.pathEnv), { uid: options.uid });
  return node && SAFE_LAUNCHER_PATH_PATTERN.test(node.path) ? quoteShellArgument(node.path) : null;
}

function resolveClaudeSettingsHookCommands(options = {}) {
  const fsImpl = options.fs || fs;
  const runtimeLauncher = resolveHookLauncher(options);
  const installedRoot = path.resolve(__dirname, '..', '..', '..');
  const orchestratorEntry = resolveVkOrchestratorEntry(options.vkOrchestratorRoot || installedRoot, fsImpl, { uid: options.uid });
  if (!runtimeLauncher || !orchestratorEntry) {
    throw new Error(HOOK_UNAVAILABLE);
  }
  // 未対応の旧版で未知のサブコマンドが通常起動へ進むのを防ぐ。
  try {
    resolveTrustedPath(fsImpl, path.join(path.dirname(path.dirname(orchestratorEntry)), 'src', 'engine', 'sensitive-output-hook.js'), {
      finalKind: 'file', rejectFinalLink: true, uid: options.uid,
    });
  } catch (_error) {
    throw new Error(HOOK_UNAVAILABLE);
  }
  const launcher = `${runtimeLauncher} ${quoteShellArgument(orchestratorEntry)}`;
  return {
    stop: `${launcher} check-turn-end-status-hook`,
    preToolUse: `${launcher} check-sensitive-output-hook`,
  };
}

function buildPreset(commands) {
  return { hooks: {
    Stop: [{ hooks: [{ type: 'command', command: commands.stop }] }],
    PreToolUse: [{ matcher: 'Bash|Read|Grep', hooks: [{ type: 'command', timeout: 5, command: commands.preToolUse }] }],
  } };
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
  const commands = resolveClaudeSettingsHookCommands({ ...options, uid });
  // 一時ファイルから rename し、既存のシンボリックリンクを辿らず置き換える。
  const temporaryPath = path.join(presetDir, `.${preset}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(buildPreset(commands), null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    fs.renameSync(temporaryPath, settingsPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (_error) {}
  }
  return settingsPath;
}

// 設定ファイルのパスをペインのシェルに合わせて引用する。
function quoteClaudeSettingsPath(filename, shellExecutable) {
  const kind = classifyShell(shellExecutable);
  if (kind === 'unknown' && typeof filename === 'string' && /^[A-Za-z0-9/._-]+$/.test(filename)) return quoteShellPath(filename, 'posix');
  return quoteShellPath(filename, kind);
}

// 使えない一時設定は回収し、必須プリセットは起動前に検証する。
function prepareClaudeSettingsForShell(options, shellExecutable, prepared) {
  const quote = (filename) => quoteClaudeSettingsPath(filename, shellExecutable);
  try {
    if (options.claudeSettingsPreset !== undefined) {
      buildClaudeSettingsArgument(options.claudeSettingsPreset, options.claudeSettingsPath, shellExecutable);
    }
  } catch (error) {
    prepared?.discard();
    throw error;
  }
  if (prepared && quote(prepared.filename) === null) {
    prepared.discard();
    prepared = undefined;
  }
  return {
    options: {
      ...options,
      shellExecutable,
      quoteClaudeSettingsPath: quote,
      ...(prepared ? { backgroundWorkSettingsPath: prepared.filename } : {}),
    },
    prepared,
  };
}

function buildClaudeSettingsArgument(preset, settingsPath, shellExecutable) {
  if (!isValidClaudeSettingsPreset(preset) || typeof settingsPath !== 'string' || !SETTINGS_PATH_PATTERN.test(settingsPath)) {
    throw new Error('invalid prepared Claude settings preset');
  }
  const argument = quoteClaudeSettingsPath(settingsPath, shellExecutable);
  if (argument === null) throw new Error('invalid prepared Claude settings preset');
  return `--settings ${argument}`;
}

// PID と開始時刻が一致する別インスタンスの設定には触れない。
async function cleanupBackgroundWorkSettings(dataDir, listProcesses = require('./agentLifecycle').listProcessTable) {
  const { isSameProcessStart } = require('./agentLifecycle');
  let processes;
  try { processes = await listProcesses(); } catch (_) { return; }
  for (const name of fs.readdirSync(dataDir)) {
    if (!/^background-work-[A-Za-z0-9]+$/.test(name)) continue;
    const directory = path.join(dataDir, name);
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) continue;
      const ownerPath = path.join(directory, 'owner.json');
      const ownerStat = fs.lstatSync(ownerPath);
      if (!ownerStat.isFile() || ownerStat.isSymbolicLink() || ownerStat.size > 4096) continue;
      const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !Number.isFinite(Date.parse(owner.lstart))) continue;
      const live = processes.get(owner.pid);
      if (live && isSameProcessStart(live.lstart, owner.lstart)) continue;
      // ps 採取後に起動されたプロセスも保護する。再利用 PID は保守的に残す。
      try { process.kill(owner.pid, 0); continue; } catch (error) { if (error.code !== 'ESRCH') continue; }
      fs.rmSync(directory, { recursive: true, force: true });
    } catch (_) {}
  }
}

// 自プロセスの起動時刻は変わらないため、最初に取得した値を保持する。
let processStartTime;

// 起動ごとに分離した設定へフックを足し、Stop など既存のイベントを保つ。
function prepareBackgroundWorkSettings(dataDir, config, settingsPath, options = {}) {
  const runtimeLauncher = resolveHookLauncher(options);
  if (!runtimeLauncher) throw new Error('Background work hook runtime unavailable');
  const directory = fs.mkdtempSync(path.join(dataDir, 'background-work-'));
  fs.chmodSync(directory, 0o700);
  try {
    processStartTime ??= require('node:child_process').execFileSync('ps', ['-p', String(process.pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C' } }).trim();
    fs.writeFileSync(path.join(directory, 'owner.json'), JSON.stringify({ pid: process.pid, lstart: processStartTime }), { mode: 0o600, flag: 'wx' });
    const configPath = path.join(directory, 'connection.json');
    fs.writeFileSync(configPath, JSON.stringify(config), { mode: 0o600, flag: 'wx' });
    const settings = settingsPath ? JSON.parse(fs.readFileSync(settingsPath, 'utf8')) : {};
    settings.hooks = settings.hooks || {};
    const command = `${runtimeLauncher} ${quoteShellArgument(path.join(__dirname, 'backgroundWorkHook.js'))} ${quoteShellArgument(configPath)}`;
    for (const event of ['SessionStart', 'SubagentStart', 'SubagentStop']) {
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
  quoteClaudeSettingsPath,
  prepareClaudeSettingsForShell,
  cleanupBackgroundWorkSettings,
  prepareBackgroundWorkSettings,
  ALLOWED_CLAUDE_SETTINGS_PRESETS,
  SAFE_LAUNCHER_PATH_PATTERN,
  isValidClaudeSettingsPreset,
  validateClaudeSettingsPresetForEngine,
  resolveVkOrchestratorEntry,
  resolveClaudeSettingsHookCommands,
  HOOK_UNAVAILABLE,
  prepareClaudeSettingsPreset,
  buildClaudeSettingsArgument,
};
