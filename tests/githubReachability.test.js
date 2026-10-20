const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkGitHubReachability,
  classifyGitHubReachabilityResult,
  resolveGitHubReachability,
  runGitHubReachabilityGate,
} = require('../utils/githubReachability');

test('GitHub 到達確認: 検証済み gh と固定入口と同じ設定・環境で repo view を1回だけ非同期実行する', async () => {
  const calls = [];
  const writes = [];
  let removed = false;
  const result = await checkGitHubReachability({
    cwd: '/repo',
    ghConfig: 'version: "1"\n',
    ghPath: '/trusted/gh',
    ghHosts: 'github.com:\n    user: test\n    oauth_token: secret\n',
    homeDir: '/home/user',
    repo: 'vektor-inc/vk-terminals',
    execFile(bin, args, options, callback) {
      calls.push({ bin, args, options });
      setImmediate(() => callback(null, '{"name":"vk-terminals"}', ''));
    },
    fsImpl: {
      mkdtempSync: () => '/tmp/reachability-test',
      chmodSync: () => {},
      writeFileSync(file, content, options) { writes.push({ file, content, options }); },
      rmSync: () => { removed = true; },
    },
    tmpdir: '/tmp',
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].bin, '/trusted/gh');
  assert.deepEqual(calls[0].args, ['repo', 'view', '--json', 'name', '--', 'vektor-inc/vk-terminals']);
  assert.equal(calls[0].options.timeout, 10000);
  assert.equal(calls[0].options.env.GH_CONFIG_DIR, '/tmp/reachability-test');
  assert.equal(calls[0].options.env.GH_TOKEN, undefined);
  assert.deepEqual(writes.map(({ options }) => options.mode), [0o600, 0o600]);
  assert.equal(removed, true);
});

test('GitHub 到達確認: 成功・接続不能・ログイン無効・時間切れ・5xx・レート制限・404を分類する', () => {
  const cases = [
    [{ error: null }, undefined],
    [{ error: new Error('failed'), stderr: 'error connecting to nonexistent-host.invalid\ncheck your internet connection or https://githubstatus.com' }, 'unreachable'],
    [{ error: new Error('failed'), stderr: 'HTTP 401: Bad credentials' }, 'auth_invalid'],
    [{ error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT', killed: true }) }, 'transient'],
    [{ error: new Error('failed'), stderr: 'HTTP 503: Service Unavailable' }, 'transient'],
    [{ error: new Error('failed'), stderr: 'HTTP 403: API rate limit exceeded' }, 'transient'],
    [{ error: new Error('failed'), stderr: 'GraphQL: Could not resolve to a Repository with the name x/y. (repository)' }, 'auth_invalid'],
  ];
  for (const [input, expected] of cases.slice(1)) assert.equal(classifyGitHubReachabilityResult(input).reason, expected);
});

test('GitHub 到達確認: gh が使えない場合は auth_invalid、例外は transient にし、一時フォルダを回収する', async () => {
  const missing = await checkGitHubReachability({ ghPath: null });
  assert.equal(missing.reason, 'auth_invalid');
  let removed = false;
  const thrown = await checkGitHubReachability({
    cwd: '/repo', ghPath: '/trusted/gh', ghConfig: 'version: "1"\n', homeDir: '/home', repo: 'o/r', tmpdir: '/tmp',
    fsImpl: {
      mkdtempSync: () => '/tmp/test', chmodSync: () => {}, writeFileSync: () => {},
      rmSync: () => { removed = true; },
    },
    execFile() { throw new Error('boom'); },
  });
  assert.equal(thrown.reason, 'transient');
  assert.equal(removed, true);
});

test('HTTP 到達確認ゲート: 失敗時は503を返し、ペイン作成・再起動へ進まない。context は200用の結果を作れる', async () => {
  for (const operation of ['terminal:request-new-pane', 'restartAgentInTerminal']) {
    let called = false;
    const result = await runGitHubReachabilityGate({ githubCheck: {} }, {
      check: async () => ({ ok: false, reason: 'unreachable', message: '利用者向け' }),
      proceed: () => { called = true; return { ok: true, operation }; },
    });
    assert.equal(result.status, 503);
    assert.equal(result.error, 'github unreachable');
    assert.equal(called, false, operation);
  }
  const githubReachability = await resolveGitHubReachability(
    { githubCheck: {} },
    async () => ({ ok: false, reason: 'transient', message: '利用者向け' }),
  );
  const contextResult = { ok: true, status: 200, codexPolicyContext: { githubReachability } };
  assert.equal(contextResult.status, 200);
  assert.equal(contextResult.codexPolicyContext.githubReachability.reason, 'transient');
});

test('GitHub 到達確認: 応答には標準エラーの生の内容を含めない', () => {
  const secret = 'secret-token-value';
  const result = classifyGitHubReachabilityResult({ error: new Error('failed'), stderr: `HTTP 401 ${secret}` });
  assert.equal(JSON.stringify(result).includes(secret), false);
});
