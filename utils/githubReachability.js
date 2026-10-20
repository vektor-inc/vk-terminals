const childProcess = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildChildEnvironment } = require('./codexTaskOps');

const DEFAULT_TIMEOUT_MS = 10000;

function failure(reason, message) {
  return { ok: false, reason, message };
}

function unknownFailure() {
  return failure('transient', 'GitHub への接続を確認できませんでした。しばらく待ってもう一度試し、続く場合は VK Terminals を再起動してください');
}

/** GitHub 到達確認の失敗を、外部 API の固定した3分類へ変換する。 */
function classifyGitHubReachabilityResult(result) {
  if (result?.error?.code === 'ETIMEDOUT') {
    return failure('transient', 'GitHub からの応答が時間内に得られませんでした。しばらく待ってから、もう一度お試しください');
  }
  const output = `${result?.stdout || ''}\n${result?.stderr || ''}`;
  if (/rate limit|secondary rate limit|api rate limit exceeded/i.test(output)) {
    return failure('transient', 'GitHub の利用回数の上限に達しました。しばらく待ってから、もう一度お試しください');
  }
  if (/HTTP\s+5\d\d\b|service unavailable|bad gateway|gateway timeout|internal server error/i.test(output)) {
    return failure('transient', 'GitHub 側で一時的な問題が起きています。しばらく待ってから、もう一度お試しください');
  }
  if (/error connecting to|could not resolve host|name or service not known|connection refused|failed to connect|network is unreachable|no route to host/i.test(output)) {
    return failure('unreachable', 'GitHub に接続できません。ネットワーク接続を確認してから、もう一度お試しください');
  }
  if (/\b(?:403|404)\b|could not resolve to a repository|resource not accessible|sso|permission denied/i.test(output)) {
    return failure('auth_invalid', 'このリポジトリを GitHub のログインで読み取れません。アカウントのアクセス権を確認してから、もう一度お試しください');
  }
  if (/\b401\b|authentication failed|bad credentials|http basic: access denied|not logged in|authentication required/i.test(output)) {
    return failure('auth_invalid', 'GitHub のログインが無効になっています。ターミナルで gh auth login を実行してから、もう一度お試しください');
  }
  return unknownFailure();
}

/** 固定入口と同じ gh 設定を一時フォルダへ作り、対象リポジトリを非同期で読み取る。 */
async function checkGitHubReachability({
  cwd,
  ghConfig,
  ghPath,
  ghHosts,
  homeDir,
  repo,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  execFile = childProcess.execFile,
  fsImpl = fs,
  tmpdir = os.tmpdir(),
}) {
  if (typeof ghPath !== 'string' || ghPath === '') {
    return failure('auth_invalid', 'GitHub CLI（gh）が見つからないか、安全に使えません。gh をインストールし、ターミナルで gh auth login を実行してから、もう一度お試しください');
  }
  let temporaryDir = null;
  try {
    // 認証情報以外の個人設定を持ち込まないよう、固定内容だけを新規作成する。
    temporaryDir = fsImpl.mkdtempSync(path.join(tmpdir, 'vk-github-reachability-'));
    fsImpl.chmodSync(temporaryDir, 0o700);
    fsImpl.writeFileSync(path.join(temporaryDir, 'config.yml'), ghConfig, { mode: 0o600, flag: 'wx' });
    if (typeof ghHosts === 'string') fsImpl.writeFileSync(path.join(temporaryDir, 'hosts.yml'), ghHosts, { mode: 0o600, flag: 'wx' });
    const env = buildChildEnvironment({ git: ghPath, gh: ghPath, home: homeDir, gitConfig: '/dev/null', ghConfig: temporaryDir });
    const result = await new Promise((resolve) => {
      execFile(ghPath, ['repo', 'view', '--json', 'name', '--', repo], {
        cwd,
        env,
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGTERM',
        maxBuffer: 64 * 1024,
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    if (!result.error) return { ok: true };
    return classifyGitHubReachabilityResult(result);
  } catch (_error) {
    return unknownFailure();
  } finally {
    if (temporaryDir !== null) {
      try {
        fsImpl.rmSync(temporaryDir, { recursive: true, force: true });
      } catch (_error) {
        // 回収失敗で HTTP 応答まで失わない。
      }
    }
  }
}

/** 差し替えた確認関数の例外も HTTP 応答可能な結果へ変換する。 */
async function resolveGitHubReachability(policyCheck, check = checkGitHubReachability) {
  try {
    return await check(policyCheck.githubCheck);
  } catch (_error) {
    return unknownFailure();
  }
}

/** HTTP 入口で dryRun の直後に1回だけ確認し、後続処理を呼ぶか決める。 */
async function runGitHubReachabilityGate(policyCheck, { check = checkGitHubReachability, proceed }) {
  const githubReachability = await resolveGitHubReachability(policyCheck, check);
  if (!githubReachability.ok) return { ok: false, status: 503, error: 'github unreachable', githubReachability };
  return proceed(githubReachability);
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  checkGitHubReachability,
  classifyGitHubReachabilityResult,
  resolveGitHubReachability,
  runGitHubReachabilityGate,
};
