const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_TIMEOUT_MS = 10000;
const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

function findExecutable(name, existsSync) {
  for (const directory of TOOL_DIRS) {
    const candidate = path.join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function failure(reason, message) {
  return { ok: false, reason, message };
}

/**
 * GitHub 到達確認の失敗を、外部 API の固定した3分類へ変換する。
 * 判定不能な終了は、恒久的な到達不能と断定せず transient に倒す。
 */
function classifyGitHubReachabilityResult(result) {
  if (result?.error?.code === 'ETIMEDOUT' || result?.signal === 'SIGTERM') {
    return failure('transient', 'GitHub への到達確認が時間切れになりました');
  }
  const output = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  if (/\b(?:401|403)\b|authentication failed|bad credentials|http basic: access denied|not logged in/i.test(output)) {
    return failure('auth_invalid', 'GitHub のログイン情報が無効です');
  }
  if (/\b5\d\d\b|service unavailable|bad gateway|gateway timeout|internal server error/i.test(output)) {
    return failure('transient', 'GitHub 側で一時的な障害が発生しています');
  }
  if (/could not resolve host|name or service not known|connection refused|failed to connect|network is unreachable|no route to host/i.test(output)) {
    return failure('unreachable', 'GitHub に接続できません');
  }
  return failure('transient', 'GitHub への到達確認を完了できませんでした');
}

/**
 * 個人の環境変数を引き継がず、固定入口と同じ gh ログイン元で対象リポジトリを読み取る。
 */
function checkGitHubReachability({
  cwd,
  homeDir,
  repo,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  spawnSync = childProcess.spawnSync,
  existsSync = fs.existsSync,
  mkdtempSync = fs.mkdtempSync,
  rmSync = fs.rmSync,
  tmpdir = os.tmpdir(),
}) {
  const gh = findExecutable('gh', existsSync);
  if (gh === null) return failure('unreachable', 'GitHub の確認に必要な gh を利用できません');
  const authEnv = {
    HOME: homeDir,
    PATH: '/usr/bin:/bin',
    GH_CONFIG_DIR: path.join(homeDir, '.config', 'gh'),
    GH_PROMPT_DISABLED: '1',
    NO_COLOR: '1',
  };
  // 個人設定からログイン情報だけを取得し、通信時にはその他の gh 設定を持ち込まない。
  const authTimeoutMs = Math.min(timeoutMs, 2000);
  const tokenResult = spawnSync(gh, ['auth', 'token', '--hostname', 'github.com'], {
    cwd,
    env: authEnv,
    encoding: 'utf8',
    timeout: authTimeoutMs,
    killSignal: 'SIGTERM',
  });
  if (tokenResult?.error?.code === 'ETIMEDOUT' || tokenResult?.signal === 'SIGTERM') {
    return failure('transient', 'GitHub への到達確認が時間切れになりました');
  }
  if (tokenResult.status !== 0 || String(tokenResult.stdout || '').trim() === '') {
    return failure('auth_invalid', 'GitHub のログイン情報が無効です');
  }

  const emptyGhConfigDir = mkdtempSync(path.join(tmpdir, 'vk-github-reachability-'));
  try {
    const env = {
      HOME: homeDir,
      PATH: '/usr/bin:/bin',
      GH_CONFIG_DIR: emptyGhConfigDir,
      GH_PROMPT_DISABLED: '1',
      GH_TOKEN: String(tokenResult.stdout).trim(),
      NO_COLOR: '1',
    };
    // 10秒で打ち切り、renderer のペイン作成待ち（15秒）より先に必ず結果を返す。
    const result = spawnSync(gh, ['repo', 'view', repo, '--json', 'name'], {
      cwd,
      env,
      encoding: 'utf8',
      timeout: Math.max(1, timeoutMs - authTimeoutMs),
      killSignal: 'SIGTERM',
    });
    if (result.status === 0) return { ok: true };
    return classifyGitHubReachabilityResult(result);
  } finally {
    rmSync(emptyGhConfigDir, { recursive: true, force: true });
  }
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  checkGitHubReachability,
  classifyGitHubReachabilityResult,
};
