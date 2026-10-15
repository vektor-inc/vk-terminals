// 自動処理用 Codex のタスク用ポリシー（issue #428）の検証。
// 入力検証・起動コマンドの組み立て・専用 CODEX_HOME の生成・新規作成と再起動の実効ポリシーの一致・
// 否定ケース（広い個人設定・未知キー・不正値・競合・再起動）をまとめて確認する。
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const claudeModel = require('../renderer/claudeModel');
const {
  CODEX_TASK_POLICY_PRESETS,
  ORCHESTRATED_TASK_ALLOWED_COMMANDS,
  prepareCodexTaskPolicyHome,
  resolveCodexTaskPolicyLaunchOptions,
} = require('../utils/codexTaskPolicy');
const { validateRestartAgentRequest } = require('../utils/restartAgent');

const { validateCodexLaunchOptions, buildCodexLaunchCommand, buildEngineAwareLaunchCommand } = claudeModel;

// 一時ディレクトリ上に「個人の CODEX_HOME」「アプリのデータ」「引き継ぎ先」を作る。
function createSandbox(personalConfigToml) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-codex-policy-'));
  const personalCodexHome = path.join(root, 'personal-codex');
  fs.mkdirSync(personalCodexHome, { recursive: true });
  fs.writeFileSync(path.join(personalCodexHome, 'auth.json'), '{"token":"secret"}');
  if (personalConfigToml !== undefined) fs.writeFileSync(path.join(personalCodexHome, 'config.toml'), personalConfigToml);
  return {
    root,
    personalCodexHome,
    deps: {
      validateCodexLaunchOptions,
      dataDir: path.join(root, 'data'),
      handoffDir: path.join(root, 'handoff'),
      personalCodexHome,
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

const sha256 = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

// ─── 入力検証 ────────────────────────────────────────────────────────────

test('preset の許可リストは、生成側のテンプレートと同じ名前だけを持つ', () => {
  assert.deepEqual([...claudeModel.ALLOWED_CODEX_POLICY_PRESETS].sort(), Object.keys(CODEX_TASK_POLICY_PRESETS).sort());
  assert.deepEqual([...claudeModel.ALLOWED_CODEX_POLICY_KEYS], ['preset']);
});

test('codexPolicy: 固定の preset だけを受理し、正規化した値を返す', () => {
  assert.deepEqual(
    validateCodexLaunchOptions('codex', { codexPolicy: { preset: 'orchestrated-task' } }),
    { ok: true, approvalPolicy: undefined, sandboxMode: undefined, codexPolicy: { preset: 'orchestrated-task' } },
  );
  assert.equal(validateCodexLaunchOptions('codex', {}).codexPolicy, undefined);
});

test('codexPolicy: 未知キー・不正値・不正な型を拒否する', () => {
  const cases = [
    [{ preset: 'orchestrated-task', args: ['--add-dir', '/'] }, 'unknown codexPolicy key: args'],
    [{ preset: 'orchestrated-task', addDirs: ['/tmp'] }, 'unknown codexPolicy key: addDirs'],
    [{ preset: 'orchestrated-task', network: true }, 'unknown codexPolicy key: network'],
    [{ preset: 'orchestrated-task', __proto__x: 1 }, 'unknown codexPolicy key: __proto__x'],
    [{}, 'invalid codexPolicy preset'],
    [{ preset: 'full-access' }, 'invalid codexPolicy preset'],
    [{ preset: "orchestrated-task'; rm -rf ~; '" }, 'invalid codexPolicy preset'],
    [{ preset: ['orchestrated-task'] }, 'invalid codexPolicy preset'],
    [{ preset: '' }, 'invalid codexPolicy preset'],
    ['orchestrated-task', 'invalid codexPolicy'],
    [null, 'invalid codexPolicy'],
    [['orchestrated-task'], 'invalid codexPolicy'],
    [42, 'invalid codexPolicy'],
  ];
  for (const [codexPolicy, error] of cases) {
    assert.deepEqual(validateCodexLaunchOptions('codex', { codexPolicy }), { ok: false, error }, JSON.stringify(codexPolicy));
  }
});

test('codexPolicy: Codex 以外のエンジンでは拒否する', () => {
  for (const engine of ['claude', 'gemini', undefined]) {
    assert.deepEqual(
      validateCodexLaunchOptions(engine, { codexPolicy: { preset: 'orchestrated-task' } }),
      { ok: false, error: 'Codex options require engine "codex"' },
    );
  }
});

test('restart-agent 検証: codexPolicy を同じ規則で検証し、新規作成と同じ値に正規化する', () => {
  const validators = {
    isValidEngine: claudeModel.isValidEngine,
    isValidModelForEngine: claudeModel.isValidModelForEngine,
    validateCodexLaunchOptions,
  };
  const ok = validateRestartAgentRequest({
    termId: '1', expectedGeneration: 2, engine: 'codex', approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' },
  }, validators);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.codexPolicy, { preset: 'orchestrated-task' });
  assert.equal(validateRestartAgentRequest({
    termId: '1', expectedGeneration: 2, codexPolicy: { preset: 'orchestrated-task' },
  }, validators).error, 'Codex options require engine "codex"');
  assert.equal(validateRestartAgentRequest({
    termId: '1', expectedGeneration: 2, engine: 'codex', codexPolicy: { preset: 'orchestrated-task', x: 1 },
  }, validators).error, 'unknown codexPolicy key: x');
});

// ─── 起動コマンド ────────────────────────────────────────────────────────

test('起動コマンド: ポリシー付きは専用 CODEX_HOME と sandbox を明示し、シェル文字列にユーザー入力を混ぜない', () => {
  const home = '/Users/test user/.vk-terminals/codex-task-policy/orchestrated-task';
  assert.equal(
    buildCodexLaunchCommand('gpt-5.6-sol', { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' }, codexPolicyHome: home }),
    `CODEX_HOME='${home}' codex --no-daemon --model 'gpt-5.6-sol' --ask-for-approval 'never' --sandbox 'workspace-write'`,
  );
  // 明示した sandbox（より狭い read-only）は上書きしない。
  assert.match(
    buildCodexLaunchCommand(undefined, { sandboxMode: 'read-only', codexPolicy: { preset: 'orchestrated-task' }, codexPolicyHome: home }),
    /--sandbox 'read-only'$/,
  );
});

test('起動コマンド: 専用 CODEX_HOME が無い・不正なときは起動コマンドを作らず例外で止める', () => {
  const options = { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } };
  assert.throws(() => buildCodexLaunchCommand(undefined, options), /policy home/);
  for (const codexPolicyHome of ['relative/path', "/tmp/a'b", '/tmp/a\nb', '', 42, null]) {
    assert.throws(() => buildCodexLaunchCommand(undefined, { ...options, codexPolicyHome }), /policy home/, String(codexPolicyHome));
  }
  assert.throws(
    () => buildCodexLaunchCommand(undefined, { codexPolicy: { preset: 'x' }, codexPolicyHome: '/tmp/ok' }),
    /invalid codex task policy/,
  );
});

test('起動コマンド: ポリシー無しの Codex（手動の通常セッション等）と Claude Code は従来どおり', () => {
  assert.equal(buildCodexLaunchCommand(undefined), 'codex --no-daemon');
  // codexPolicyHome だけが紛れ込んでも、ポリシー指定が無ければ CODEX_HOME は付かない。
  assert.equal(buildCodexLaunchCommand(undefined, { codexPolicyHome: '/tmp/x' }), 'codex --no-daemon');
  const claude = buildEngineAwareLaunchCommand('claude', 'sonnet', {
    codexPolicy: { preset: 'orchestrated-task' }, codexPolicyHome: '/tmp/x', approvalPolicy: 'never',
  });
  assert.equal(claude.command, "claude --model 'sonnet'");
});

// ─── 専用 CODEX_HOME の生成 ──────────────────────────────────────────────

test('生成: 個人設定が広くても継承せず、個人の config.toml は変更しない', () => {
  const broadPersonalConfig = [
    'sandbox_mode = "danger-full-access"',
    'approval_policy = "never"',
    'profile = "wide"',
    '[sandbox_workspace_write]',
    'network_access = true',
    'writable_roots = ["/", "/Users/someone/.ssh"]',
    '[projects."/"]',
    'trust_level = "trusted"',
  ].join('\n');
  const sandbox = createSandbox(broadPersonalConfig);
  try {
    const personalConfigPath = path.join(sandbox.personalCodexHome, 'config.toml');
    const before = sha256(personalConfigPath);
    const result = prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps });
    assert.equal(result.ok, true);
    const config = fs.readFileSync(path.join(result.home, 'config.toml'), 'utf8');
    assert.match(config, /^sandbox_mode = "workspace-write"$/m);
    assert.match(config, /^network_access = false$/m);
    assert.match(config, new RegExp(`^writable_roots = \\[${JSON.stringify(sandbox.deps.handoffDir).replace(/[\\/]/g, '\\$&')}\\]$`, 'm'));
    for (const forbidden of ['danger-full-access', 'network_access = true', '"/"', '.ssh', 'profile', 'trust_level']) {
      assert.equal(config.includes(forbidden), false, forbidden);
    }
    assert.equal(sha256(personalConfigPath), before);
    assert.deepEqual(fs.readdirSync(sandbox.personalCodexHome).sort(), ['auth.json', 'config.toml']);
    // ログイン状態だけは共有する（個人の設定ファイルは共有しない）。
    assert.equal(fs.readlinkSync(path.join(result.home, 'auth.json')), path.join(sandbox.personalCodexHome, 'auth.json'));
    assert.equal(fs.existsSync(path.join(result.home, 'hooks.json')), false);
    assert.equal(fs.existsSync(sandbox.deps.handoffDir), true);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: 許可コマンドは固定の Git / GitHub 入口だけで、範囲の広い操作を含まない', () => {
  const sandbox = createSandbox();
  try {
    const { home } = prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps });
    const rules = fs.readFileSync(path.join(home, 'rules', 'vk-terminals-task.rules'), 'utf8');
    const ruleLines = rules.split('\n').filter((line) => line.startsWith('prefix_rule('));
    assert.equal(ruleLines.length, ORCHESTRATED_TASK_ALLOWED_COMMANDS.length);
    assert.ok(ruleLines.every((line) => line.endsWith('decision="allow")')));
    assert.ok(rules.includes('prefix_rule(pattern=["git","commit"], decision="allow")'));
    for (const forbidden of ['"push"', '"reset"', '"api"', '"merge"', '"bash"', '"sh"', '"curl"', '"rm"']) {
      assert.equal(rules.includes(forbidden), false, forbidden);
    }
  } finally {
    sandbox.cleanup();
  }
});

test('生成: 再実行で改ざん・余計な rules を元の固定内容へ戻す', () => {
  const sandbox = createSandbox();
  try {
    const { home } = prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps });
    const configPath = path.join(home, 'config.toml');
    const expected = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, `${expected}\n[sandbox_workspace_write]\nnetwork_access = true\n`);
    fs.writeFileSync(path.join(home, 'rules', 'extra.rules'), 'prefix_rule(pattern=["rm"], decision="allow")\n');
    const again = prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps });
    assert.equal(again.ok, true);
    assert.equal(fs.readFileSync(configPath, 'utf8'), expected);
    assert.deepEqual(fs.readdirSync(path.join(home, 'rules')), ['vk-terminals-task.rules']);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: 固定できないときは ok: false と理由を返す（未知 preset・危険なパス・シンボリックリンク・書き込み不可）', () => {
  const sandbox = createSandbox();
  try {
    assert.match(prepareCodexTaskPolicyHome({ preset: 'other', ...sandbox.deps }).error, /unknown preset/);
    assert.match(prepareCodexTaskPolicyHome({ preset: 'toString', ...sandbox.deps }).error, /unknown preset/);
    assert.match(
      prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps, handoffDir: "/tmp/a'b" }).error,
      /unsafe directory path/,
    );
    assert.match(
      prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps, dataDir: 'relative' }).error,
      /unsafe directory path/,
    );

    // 生成先がシンボリックリンクに差し替えられている場合は書き込まない。
    const elsewhere = path.join(sandbox.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.mkdirSync(path.join(sandbox.deps.dataDir, 'codex-task-policy'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(sandbox.deps.dataDir, 'codex-task-policy', 'orchestrated-task'));
    const linked = prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps });
    assert.equal(linked.ok, false);
    assert.match(linked.error, /^codex task policy unavailable/);
    assert.deepEqual(fs.readdirSync(elsewhere).filter((name) => name === 'config.toml'), []);

    // ファイルシステムが書き込めない場合。
    const failingFs = { ...fs, mkdirSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
    assert.deepEqual(
      prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps, fs: failingFs }),
      { ok: false, error: 'codex task policy unavailable: EACCES' },
    );
  } finally {
    sandbox.cleanup();
  }
});

// ─── 新規作成と再起動の実効ポリシー ─────────────────────────────────────

test('新規作成と再起動は同じ入力から同じ起動コマンドになり、再起動を繰り返しても広がらない', () => {
  const sandbox = createSandbox('[sandbox_workspace_write]\nnetwork_access = true\n');
  try {
    const newPaneOptions = { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } };
    // renderer / HTTP 経由で余計な項目（偽の codexPolicyHome を含む）が混ざっても、検証済みの項目だけが残る。
    const restartRequest = {
      termId: '3', expectedGeneration: 1, cwd: '/tmp', engine: 'codex', model: 'gpt-5.6-sol', ...newPaneOptions,
      codexPolicyHome: '/etc',
    };
    const fromNewPane = resolveCodexTaskPolicyLaunchOptions('codex', { ...newPaneOptions, codexPolicyHome: '/etc' }, sandbox.deps);
    const fromRestart = resolveCodexTaskPolicyLaunchOptions('codex', restartRequest, sandbox.deps);
    assert.equal(fromNewPane.ok, true);
    assert.deepEqual(fromRestart, fromNewPane);
    const commandOf = (resolved) => buildEngineAwareLaunchCommand('codex', 'gpt-5.6-sol', resolved.options).command;
    assert.equal(commandOf(fromRestart), commandOf(fromNewPane));
    assert.ok(commandOf(fromNewPane).startsWith(`CODEX_HOME='${fromNewPane.options.codexPolicyHome}' codex --no-daemon`));
    assert.ok(!commandOf(fromNewPane).includes('/etc'));

    // 再起動を繰り返しても、コマンドも生成物も変わらない。
    const configPath = path.join(fromNewPane.options.codexPolicyHome, 'config.toml');
    const configBefore = fs.readFileSync(configPath, 'utf8');
    for (let i = 0; i < 3; i += 1) {
      assert.equal(commandOf(resolveCodexTaskPolicyLaunchOptions('codex', restartRequest, sandbox.deps)), commandOf(fromNewPane));
    }
    assert.equal(fs.readFileSync(configPath, 'utf8'), configBefore);

    // ポリシー無しで再起動した場合は専用 CODEX_HOME を付けない（権限が持ち越されない）。
    const withoutPolicy = resolveCodexTaskPolicyLaunchOptions('codex', { approvalPolicy: 'never' }, sandbox.deps);
    assert.equal(withoutPolicy.options.codexPolicyHome, undefined);
    assert.ok(!buildEngineAwareLaunchCommand('codex', undefined, withoutPolicy.options).command.includes('CODEX_HOME'));
  } finally {
    sandbox.cleanup();
  }
});

test('解決: Claude Code にはポリシーを適用せず、固定できない場合は Codex を起動できない結果を返す', () => {
  const sandbox = createSandbox();
  try {
    const request = { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' }, codexPolicyHome: '/etc' };
    assert.deepEqual(resolveCodexTaskPolicyLaunchOptions('claude', request, sandbox.deps), { ok: true, options: {} });
    assert.equal(resolveCodexTaskPolicyLaunchOptions('codex', { codexPolicy: { preset: 'x' } }, sandbox.deps).ok, false);
    assert.equal(
      resolveCodexTaskPolicyLaunchOptions('codex', { codexPolicy: { preset: 'orchestrated-task', args: [] } }, sandbox.deps).ok,
      false,
    );
    const unavailable = resolveCodexTaskPolicyLaunchOptions('codex', request, { ...sandbox.deps, handoffDir: 'relative' });
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.error, /^codex task policy unavailable/);
    assert.equal('options' in unavailable, false);
  } finally {
    sandbox.cleanup();
  }
});
