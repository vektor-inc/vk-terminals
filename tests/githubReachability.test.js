const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const {
  checkGitHubReachability,
  classifyGitHubReachabilityResult,
} = require('../utils/githubReachability');

test('GitHub 到達確認: 成功時は読み取り専用の repo view を固定環境で実行する', () => {
  const calls = [];
  let removed = false;
  const result = checkGitHubReachability({
    cwd: '/repo',
    homeDir: '/home/user',
    repo: 'vektor-inc/vk-terminals',
    existsSync: () => true,
    spawnSync(bin, args, options) {
      calls.push({ bin, args, options });
      if (args[0] === 'auth') return { status: 0, stdout: 'test-token\n', stderr: '' };
      return { status: 0, stdout: '{"name":"vk-terminals"}', stderr: '' };
    },
    mkdtempSync: () => '/tmp/reachability-test',
    rmSync: () => { removed = true; },
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(calls[1].args, ['repo', 'view', 'vektor-inc/vk-terminals', '--json', 'name']);
  assert.equal(calls[1].options.timeout, 8000);
  assert.deepEqual(Object.keys(calls[1].options.env).sort(), ['GH_CONFIG_DIR', 'GH_PROMPT_DISABLED', 'GH_TOKEN', 'HOME', 'NO_COLOR', 'PATH']);
  assert.equal(calls[1].options.env.GH_CONFIG_DIR, '/tmp/reachability-test');
  assert.equal(removed, true);
});

test('GitHub 到達確認: 到達不能・ログイン無効・時間切れ・GitHub 5xx を区別する', () => {
  assert.equal(classifyGitHubReachabilityResult({ status: 1, stderr: 'Could not resolve host: github.com' }).reason, 'unreachable');
  assert.equal(classifyGitHubReachabilityResult({ status: 1, stderr: 'HTTP 401: Bad credentials' }).reason, 'auth_invalid');
  assert.equal(classifyGitHubReachabilityResult({ status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' } }).reason, 'transient');
  assert.equal(classifyGitHubReachabilityResult({ status: 1, stderr: 'HTTP 503: Service Unavailable' }).reason, 'transient');
});

test('GitHub 到達確認: 応答には標準エラーの生の内容を含めない', () => {
  const secret = 'secret-token-value';
  const result = classifyGitHubReachabilityResult({ status: 1, stderr: `HTTP 401 ${secret}` });
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('API: 到達確認の失敗応答は renderer のペイン作成要求と再起動処理より前にある', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const newPaneHandler = mainSource.slice(mainSource.indexOf("url.pathname === '/api/new-pane'"), mainSource.indexOf("url.pathname === '/api/codex-policy-context'"));
  assert.ok(newPaneHandler.indexOf('if (!policyCheck.ok)') < newPaneHandler.indexOf("win.webContents.send('terminal:request-new-pane'"));

  const restartHandler = mainSource.slice(mainSource.indexOf("url.pathname === '/api/restart-agent'"), mainSource.indexOf("url.pathname === '/api/close-pane'"));
  assert.ok(restartHandler.indexOf('if (!policyCheck.ok)') < restartHandler.indexOf('restartAgentInTerminal('));
  assert.match(newPaneHandler, /githubReachability/);
  assert.match(restartHandler, /githubReachability/);
});
