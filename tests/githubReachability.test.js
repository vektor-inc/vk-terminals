const test = require('node:test');
const assert = require('node:assert/strict');

const {
  checkGitHubReachability,
  classifyGitHubReachabilityResult,
  resolveE2EGitHubReachabilityOverride,
  runGitHubReachabilityGate,
} = require('../utils/githubReachability');

test('GitHub 到達確認の e2e 固定値: e2e の印がある非パッケージ版で完全一致した値だけを採用する', () => {
  for (const value of ['ok', 'unreachable', 'auth_invalid', 'transient']) {
    const result = resolveE2EGitHubReachabilityOverride({
      VK_TERMINALS_E2E: '1',
      VK_TERMINALS_E2E_GITHUB_REACHABILITY: value,
    }, false);
    assert.equal(result.ok, value === 'ok');
    if (value !== 'ok') {
      assert.equal(result.reason, value);
      assert.equal(typeof result.message, 'string');
    }
  }
  for (const [env, isPackaged] of [
    [{ VK_TERMINALS_E2E_GITHUB_REACHABILITY: 'ok' }, false],
    [{ VK_TERMINALS_E2E: '1', VK_TERMINALS_E2E_GITHUB_REACHABILITY: 'OK' }, false],
    [{ VK_TERMINALS_E2E: '1', VK_TERMINALS_E2E_GITHUB_REACHABILITY: 'unreachable ' }, false],
    [{ VK_TERMINALS_E2E: '1', VK_TERMINALS_E2E_GITHUB_REACHABILITY: 'ok' }, true],
  ]) {
    assert.equal(resolveE2EGitHubReachabilityOverride(env, isPackaged), null);
  }
});

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
    [{ error: new Error('failed'), stderr: 'error connecting to nonexistent-host.invalid\ncheck your internet connection or https://githubstatus.com' }, 'unreachable'],
    [{ error: new Error('failed'), stderr: 'HTTP 401: Bad credentials' }, 'auth_invalid'],
    [{ error: Object.assign(new Error('timeout'), { code: null, killed: true, signal: 'SIGTERM' }) }, 'transient'],
    [{ error: new Error('failed'), stderr: 'HTTP 503: Service Unavailable' }, 'transient'],
    [{ error: new Error('failed'), stderr: 'HTTP 403: API rate limit exceeded' }, 'transient'],
    [{ error: new Error('failed'), stderr: 'GraphQL: Could not resolve to a Repository with the name x/y. (repository)' }, 'auth_invalid'],
    [{ error: Object.assign(new Error('failed'), { code: 4 }), stderr: 'To get started with GitHub CLI, please run:  gh auth login' }, 'auth_invalid'],
    [{ error: new Error('failed'), stderr: 'connect: permission denied' }, 'transient'],
    [{ error: new Error('failed'), stderr: 'HTTP 403: permission denied' }, 'auth_invalid'],
    [{ error: new Error('failed'), stderr: 'SSO authorization required' }, 'auth_invalid'],
  ];
  for (const [input, expected] of cases) assert.equal(classifyGitHubReachabilityResult(input).reason, expected);
  const outputLimit = classifyGitHubReachabilityResult({
    error: Object.assign(new Error('stdout maxBuffer exceeded'), { killed: true, signal: undefined }),
  });
  assert.equal(outputLimit.reason, 'transient');
  assert.equal(outputLimit.message.includes('時間内'), false);
});

test('GitHub 到達確認: gh が使えない場合は auth_invalid、例外は transient にし、一時フォルダを回収する', async () => {
  const missing = await checkGitHubReachability({ ghPath: null });
  assert.equal(missing.reason, 'auth_invalid');
  let removed = false;
  const thrown = await checkGitHubReachability({
    cwd: '/repo', ghPath: '/trusted/gh', ghConfig: 'version: "1"\n', ghHosts: 'github.com:\n', homeDir: '/home', repo: 'o/r', tmpdir: '/tmp',
    fsImpl: {
      mkdtempSync: () => '/tmp/test', chmodSync: () => {}, writeFileSync: () => {},
      rmSync: () => { removed = true; },
    },
    execFile() { throw new Error('boom'); },
  });
  assert.equal(thrown.reason, 'transient');
  assert.equal(removed, true);
});

test('GitHub 到達確認: hosts.yml を再生成できない場合は gh を実行せずログイン案内を返す', async () => {
  let called = false;
  const result = await checkGitHubReachability({ ghPath: '/trusted/gh', ghHosts: null, execFile() { called = true; } });
  assert.equal(result.reason, 'auth_invalid');
  assert.equal(result.message, 'GitHub にログインしていません。ターミナルで gh auth login を実行してから、もう一度お試しください');
  assert.equal(called, false);
});

test('HTTP 到達確認ゲート: 失敗時は503を返して本番処理を呼ばず、成功時だけ本番処理を呼ぶ', async () => {
  for (const policyCheck of [null, { ok: true, options: {} }]) {
    let checked = false;
    let proceeded = false;
    const skipped = await runGitHubReachabilityGate(policyCheck, {
      check: async () => { checked = true; return { ok: false }; },
      proceed: () => { proceeded = true; return { ok: true, operation: 'restartAgentInTerminal' }; },
    });
    assert.equal(checked, false);
    assert.equal(proceeded, true);
    assert.equal(skipped.ok, true);
  }
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
  let called = false;
  const success = await runGitHubReachabilityGate({ githubCheck: {} }, {
    check: async () => ({ ok: true }),
    proceed: async () => { called = true; return { ok: true, operation: 'terminal:request-new-pane' }; },
  });
  assert.equal(called, true);
  assert.equal(success.operation, 'terminal:request-new-pane');
});

test('GitHub 到達確認: 応答には標準エラーの生の内容を含めない', () => {
  const secret = 'secret-token-value';
  const result = classifyGitHubReachabilityResult({ error: new Error('failed'), stderr: `HTTP 401 ${secret}` });
  assert.equal(JSON.stringify(result).includes(secret), false);
});
