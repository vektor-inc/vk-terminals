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
  ORCHESTRATED_TASK_OPERATIONS,
  prepareCodexTaskPolicyHome,
  verifyPolicyHome,
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
    policyBase: path.join(root, 'data', 'codex-task-policy', 'orchestrated-task'),
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

const OPS_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'utils', 'codexTaskOps.js'), 'utf8');
const modeOf = (target) => fs.lstatSync(target).mode & 0o777;
const prepare = (sandbox, extra = {}) => prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps, ...extra });

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
    const result = prepare(sandbox);
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
    assert.equal(fs.readlinkSync(path.join(result.home, 'auth.json')), fs.realpathSync(path.join(sandbox.personalCodexHome, 'auth.json')));
    // 中身は許可した生成物だけ（hooks.json など他のファイルは無い）。
    assert.deepEqual(fs.readdirSync(result.home).sort(), ['AGENTS.md', 'auth.json', 'config.toml', 'rules', 'vk-task-ops.js']);
    assert.deepEqual(fs.readdirSync(path.join(result.home, 'rules')), ['vk-terminals-task.rules']);
    assert.equal(fs.existsSync(sandbox.deps.handoffDir), true);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: rules は検証付きの固定入口の実行だけを許可し、Git / GitHub の先頭一致は持たない', () => {
  const sandbox = createSandbox();
  try {
    const { home } = prepare(sandbox);
    const rules = fs.readFileSync(path.join(home, 'rules', 'vk-terminals-task.rules'), 'utf8');
    const ruleLines = rules.split('\n').filter((line) => line.startsWith('prefix_rule('));
    assert.deepEqual(ruleLines, [`prefix_rule(pattern=${JSON.stringify(['node', path.join(home, 'vk-task-ops.js')])}, decision="allow")`]);
    // `git` / `gh` を先頭に持つ許可は無い（後続の引数を制限できないため）。
    for (const forbidden of ['"git"', '"gh"', '"push"', '"api"', '"merge"', '"bash"', '"sh"', '"curl"', '"rm"']) {
      assert.equal(rules.includes(forbidden), false, forbidden);
    }
    // 入口は検証ロジック本体の複製で、案内（AGENTS.md）は入口と許可する操作だけを示す。
    assert.equal(fs.readFileSync(path.join(home, 'vk-task-ops.js'), 'utf8'), OPS_SOURCE);
    const guide = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
    assert.ok(guide.includes(`node '${path.join(home, 'vk-task-ops.js')}'`));
    for (const operation of ORCHESTRATED_TASK_OPERATIONS) assert.ok(guide.includes(`\`${operation}\``), operation);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: 起動のたびに新しい専用フォルダを作り、前回の内容や改ざんを引き継がない', () => {
  const sandbox = createSandbox();
  try {
    const first = prepare(sandbox);
    fs.writeFileSync(path.join(first.home, 'config.toml'), '[sandbox_workspace_write]\nnetwork_access = true\n');
    fs.writeFileSync(path.join(first.home, 'rules', 'extra.rules'), 'prefix_rule(pattern=["rm"], decision="allow")\n');
    fs.writeFileSync(path.join(first.home, 'hooks.json'), '{}');
    const second = prepare(sandbox);
    assert.equal(second.ok, true);
    assert.notEqual(second.home, first.home);
    assert.deepEqual(fs.readdirSync(second.home).sort(), ['AGENTS.md', 'auth.json', 'config.toml', 'rules', 'vk-task-ops.js']);
    assert.match(fs.readFileSync(path.join(second.home, 'config.toml'), 'utf8'), /^network_access = false$/m);
    assert.deepEqual(fs.readdirSync(path.join(second.home, 'rules')), ['vk-terminals-task.rules']);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: 事前に置かれた AGENTS.md・hooks.json・未知のファイルは読まれない場所に留まり、同名の専用フォルダは使わず拒否する', () => {
  const sandbox = createSandbox();
  try {
    // preset フォルダ（Codex の CODEX_HOME にはならない場所）へ事前に置かれた物は、新しい専用フォルダに混ざらない。
    fs.mkdirSync(sandbox.policyBase, { recursive: true, mode: 0o700 });
    for (const name of ['AGENTS.md', 'hooks.json', 'config.toml', 'unknown.toml']) fs.writeFileSync(path.join(sandbox.policyBase, name), 'planted');
    fs.mkdirSync(path.join(sandbox.policyBase, 'rules'));
    const clean = prepare(sandbox);
    assert.equal(clean.ok, true);
    assert.deepEqual(fs.readdirSync(clean.home).sort(), ['AGENTS.md', 'auth.json', 'config.toml', 'rules', 'vk-task-ops.js']);
    assert.notEqual(fs.readFileSync(path.join(clean.home, 'AGENTS.md'), 'utf8'), 'planted');

    // 専用フォルダの名前が衝突し、事前配置済みのフォルダだった場合は再利用せず拒否する。
    const planted = path.join(sandbox.policyBase, 'a'.repeat(24));
    fs.mkdirSync(path.join(planted, 'rules'), { recursive: true, mode: 0o700 });
    for (const name of ['AGENTS.md', 'hooks.json', 'config.toml']) fs.writeFileSync(path.join(planted, name), 'planted');
    const refused = prepare(sandbox, { randomId: () => 'a'.repeat(24) });
    assert.deepEqual(refused, { ok: false, error: 'codex task policy unavailable: EEXIST' });
    assert.equal(fs.readFileSync(path.join(planted, 'AGENTS.md'), 'utf8'), 'planted');
  } finally {
    sandbox.cleanup();
  }
});

test('検証: 許可した生成物以外のファイル・リンク・緩い権限・中身の違いがあれば拒否する', () => {
  const sandbox = createSandbox();
  try {
    const { home } = prepare(sandbox);
    const authTarget = fs.realpathSync(path.join(sandbox.personalCodexHome, 'auth.json'));
    const pristine = {
      files: {
        'config.toml': fs.readFileSync(path.join(home, 'config.toml'), 'utf8'),
        'AGENTS.md': fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8'),
        'vk-task-ops.js': OPS_SOURCE,
      },
      rulesBody: fs.readFileSync(path.join(home, 'rules', 'vk-terminals-task.rules'), 'utf8'),
      authTarget,
    };
    const expected = () => pristine;
    const uid = process.getuid();
    assert.doesNotThrow(() => verifyPolicyHome(fs, home, expected(), uid));

    fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
    assert.throws(() => verifyPolicyHome(fs, home, expected(), uid), /unexpected entries/);
    fs.rmSync(path.join(home, 'hooks.json'));

    fs.writeFileSync(path.join(home, 'rules', 'extra.rules'), '');
    assert.throws(() => verifyPolicyHome(fs, home, expected(), uid), /unexpected entries/);
    fs.rmSync(path.join(home, 'rules', 'extra.rules'));

    fs.chmodSync(path.join(home, 'config.toml'), 0o644);
    assert.throws(() => verifyPolicyHome(fs, home, expected(), uid), /permissions are not 0600/);
    fs.chmodSync(path.join(home, 'config.toml'), 0o600);

    fs.appendFileSync(path.join(home, 'AGENTS.md'), 'tampered');
    assert.throws(() => verifyPolicyHome(fs, home, expected(), uid), /could not be verified/);

    assert.throws(() => verifyPolicyHome(fs, home, { ...expected(), authTarget: null }, uid), /unexpected entries/);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: 親フォルダ・専用フォルダがシンボリックリンクなら書き込まず拒否する', () => {
  for (const linkAt of [['codex-task-policy'], ['codex-task-policy', 'orchestrated-task']]) {
    const sandbox = createSandbox();
    try {
      const elsewhere = path.join(sandbox.root, 'elsewhere');
      fs.mkdirSync(elsewhere);
      const linkPath = path.join(sandbox.deps.dataDir, ...linkAt);
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(elsewhere, linkPath);
      const result = prepare(sandbox);
      assert.equal(result.ok, false, linkAt.join('/'));
      assert.match(result.error, /not a plain directory/);
      assert.deepEqual(fs.readdirSync(elsewhere), []);
    } finally {
      sandbox.cleanup();
    }
  }
});

test('生成: データフォルダ自体・引き継ぎ先がシンボリックリンクなら拒否する', () => {
  const sandbox = createSandbox();
  try {
    const elsewhere = path.join(sandbox.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.symlinkSync(elsewhere, sandbox.deps.dataDir);
    assert.match(prepare(sandbox).error, /not a plain directory/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.rmSync(sandbox.deps.dataDir);
    fs.rmSync(sandbox.deps.handoffDir, { recursive: true, force: true });

    fs.symlinkSync(elsewhere, sandbox.deps.handoffDir);
    assert.match(prepare(sandbox).error, /not a plain directory/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: 固定ファイル・一時ファイルの位置にリンクが置かれていても、リンク先へ書かずに失敗する', () => {
  const sandbox = createSandbox();
  try {
    const victim = path.join(sandbox.root, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    // 名前が衝突した専用フォルダに、固定ファイル・一時ファイル名のリンクが先回りで置かれている状況。
    const planted = path.join(sandbox.policyBase, 'b'.repeat(24));
    fs.mkdirSync(planted, { recursive: true, mode: 0o700 });
    for (const name of ['config.toml', 'AGENTS.md', 'vk-task-ops.js', 'config.toml.tmp', 'auth.json']) {
      fs.symlinkSync(victim, path.join(planted, name));
    }
    const result = prepare(sandbox, { randomId: () => 'b'.repeat(24) });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'original');
    // 直接ファイルを作る関数側もリンクを追跡しない（O_EXCL | O_NOFOLLOW）。
    const home = prepare(sandbox).home;
    assert.throws(() => fs.openSync(path.join(planted, 'config.toml'), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600), /EEXIST/);
    assert.equal(fs.readFileSync(victim, 'utf8'), 'original');
    assert.equal(fs.existsSync(home), true);
  } finally {
    sandbox.cleanup();
  }
});

test('権限: 緩い既存フォルダは 0700 に直し、生成物は 0700 / 0600 で作る', () => {
  const sandbox = createSandbox();
  try {
    fs.mkdirSync(sandbox.policyBase, { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(sandbox.policyBase), 0o755);
    fs.chmodSync(sandbox.policyBase, 0o755);
    const result = prepare(sandbox);
    assert.equal(result.ok, true);
    for (const dir of [path.dirname(sandbox.policyBase), sandbox.policyBase, result.home, path.join(result.home, 'rules')]) {
      assert.equal(modeOf(dir), 0o700, dir);
    }
    for (const file of ['config.toml', 'AGENTS.md', 'vk-task-ops.js', path.join('rules', 'vk-terminals-task.rules')]) {
      assert.equal(modeOf(path.join(result.home, file)), 0o600, file);
    }
  } finally {
    sandbox.cleanup();
  }
});

test('権限: 緩い権限を直せない・所有者が違うときは拒否する', () => {
  const sandbox = createSandbox();
  try {
    fs.mkdirSync(sandbox.policyBase, { recursive: true, mode: 0o755 });
    fs.chmodSync(sandbox.policyBase, 0o755);
    const cannotChmod = { ...fs, fchmodSync: () => {} };
    assert.match(prepare(sandbox, { fs: cannotChmod }).error, /permissions could not be restricted/);
    assert.match(prepare(sandbox, { uid: process.getuid() + 1 }).error, /not owned by the current user/);
  } finally {
    sandbox.cleanup();
  }
});

test('auth.json: 共有元が無ければ専用側にも作らず、種別・リンク先が不正なら拒否する', () => {
  const sandbox = createSandbox();
  try {
    const authPath = path.join(sandbox.personalCodexHome, 'auth.json');
    // 以前の起動で古い auth.json が残っていても、新しい専用フォルダには持ち込まれない。
    const before = prepare(sandbox);
    fs.rmSync(authPath);
    fs.rmSync(path.join(before.home, 'auth.json'));
    fs.writeFileSync(path.join(before.home, 'auth.json'), 'stale');
    const without = prepare(sandbox);
    assert.equal(without.ok, true);
    assert.equal(fs.existsSync(path.join(without.home, 'auth.json')), false);

    // 共有元が通常ファイルでない（ディレクトリ）・リンク切れ・他人の所有は拒否する。
    fs.mkdirSync(authPath);
    assert.match(prepare(sandbox).error, /not a regular file/);
    fs.rmdirSync(authPath);
    fs.symlinkSync(path.join(sandbox.root, 'missing'), authPath);
    assert.match(prepare(sandbox).error, /broken link/);
    fs.rmSync(authPath);
    fs.writeFileSync(authPath, '{}');
    assert.match(prepare(sandbox, { uid: process.getuid() + 1 }).error, /not owned by the current user/);

    // 共有元がリンクなら、リンクの最終的な実体を指す。
    const realAuth = path.join(sandbox.root, 'dotfiles-auth.json');
    fs.rmSync(authPath);
    fs.writeFileSync(realAuth, '{}');
    fs.symlinkSync(realAuth, authPath);
    const linked = prepare(sandbox);
    assert.equal(fs.readlinkSync(path.join(linked.home, 'auth.json')), fs.realpathSync(realAuth));
  } finally {
    sandbox.cleanup();
  }
});

test('掃除: 古い起動ごとの専用フォルダだけを消し、新しいもの・形式の違うものは残す', () => {
  const sandbox = createSandbox();
  try {
    const first = prepare(sandbox, { now: () => 0 });
    const stray = path.join(sandbox.policyBase, 'hooks.json');
    fs.writeFileSync(stray, 'x');
    const day = 24 * 60 * 60 * 1000;
    const old = new Date(Date.now() - 40 * day);
    fs.utimesSync(first.home, old, old);
    const recent = prepare(sandbox);
    const second = prepare(sandbox);
    assert.equal(fs.existsSync(first.home), false);
    assert.equal(fs.existsSync(recent.home), true);
    assert.equal(fs.existsSync(second.home), true);
    assert.equal(fs.existsSync(stray), true);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: 固定できないときは ok: false と理由を返す（未知 preset・危険なパス・書き込み不可）', () => {
  const sandbox = createSandbox();
  try {
    assert.match(prepare(sandbox, { preset: 'other' }).error, /unknown preset/);
    assert.match(prepare(sandbox, { preset: 'toString' }).error, /unknown preset/);
    assert.match(prepare(sandbox, { handoffDir: "/tmp/a'b" }).error, /unsafe directory path/);
    assert.match(prepare(sandbox, { dataDir: 'relative' }).error, /unsafe directory path/);
    assert.match(prepare(sandbox, { randomId: () => '../escape' }).error, /invalid launch directory name/);

    // ファイルシステムが書き込めない場合。
    const failingFs = { ...fs, mkdirSync: () => { const e = new Error('denied'); e.code = 'EACCES'; throw e; } };
    assert.deepEqual(prepare(sandbox, { fs: failingFs }), { ok: false, error: 'codex task policy unavailable: EACCES' });
  } finally {
    sandbox.cleanup();
  }
});

// ─── 新規作成と再起動の実効ポリシー ─────────────────────────────────────

test('新規作成と再起動は同じ入力から（専用フォルダ名以外）同じ起動コマンドになり、再起動を繰り返しても広がらない', () => {
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
    const commandOf = (resolved) => buildEngineAwareLaunchCommand('codex', 'gpt-5.6-sol', resolved.options).command;
    const normalized = (resolved) => commandOf(resolved).replace(resolved.options.codexPolicyHome, '<home>');
    assert.equal(normalized(fromRestart), normalized(fromNewPane));
    assert.ok(commandOf(fromNewPane).startsWith(`CODEX_HOME='${fromNewPane.options.codexPolicyHome}' codex --no-daemon`));
    assert.ok(!commandOf(fromNewPane).includes('/etc'));

    // 再起動を繰り返しても、生成物は同じ固定内容になる。
    const contentOf = (resolved) => fs.readFileSync(path.join(resolved.options.codexPolicyHome, 'config.toml'), 'utf8');
    for (let i = 0; i < 3; i += 1) {
      const again = resolveCodexTaskPolicyLaunchOptions('codex', restartRequest, sandbox.deps);
      assert.equal(normalized(again), normalized(fromNewPane));
      assert.equal(contentOf(again), contentOf(fromNewPane));
    }

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

// ─── 事前確認と本番の食い違い（HTTP は通るが IPC 側で失敗する競合） ──────────

test('事前確認（dryRun）は専用フォルダを作らず、通った後に本番の準備だけが失敗する場合は起動オプションを返さない', () => {
  const sandbox = createSandbox();
  try {
    const request = { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } };
    const dry = resolveCodexTaskPolicyLaunchOptions('codex', request, { ...sandbox.deps, dryRun: true });
    assert.equal(dry.ok, true);
    assert.equal('codexPolicyHome' in dry.options, false);
    assert.deepEqual(fs.readdirSync(sandbox.policyBase), []);

    // 事前確認の後に、専用フォルダの作成先が差し替えられた（リンクにされた）ケース。
    const elsewhere = path.join(sandbox.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.rmSync(sandbox.policyBase, { recursive: true });
    fs.symlinkSync(elsewhere, sandbox.policyBase);
    const real = resolveCodexTaskPolicyLaunchOptions('codex', request, sandbox.deps);
    assert.equal(real.ok, false);
    assert.equal('options' in real, false);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    sandbox.cleanup();
  }
});

test('terminal:create は PTY を作る前に起動オプションを解決し、失敗したら例外で返す（Codex 未起動のペインを成功にしない）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const handlerStart = source.indexOf("ipcMain.handle('terminal:create'");
  const handlerEnd = source.indexOf("ipcMain.on('terminal:input'");
  const handler = source.slice(handlerStart, handlerEnd);
  const resolveAt = handler.indexOf('resolveCodexLaunchOptions(resolvedEngine, options)');
  const throwAt = handler.indexOf('throw new Error(launchResolution.error)');
  const spawnAt = handler.indexOf('pty.spawn(');
  assert.ok(resolveAt > 0 && throwAt > resolveAt && spawnAt > throwAt, 'resolve → throw → pty.spawn の順であること');
  // 失敗を握りつぶして PTY を作り続ける分岐（ログだけ出して続行）が無いこと。
  assert.equal(handler.includes('codex launch refused (terminal'), false);
  // 起動コマンドの組み立ても PTY 作成より前にあり、作成後に失敗して PTY が残る経路が無いこと。
  assert.ok(handler.indexOf('buildEngineAwareLaunchCommand(') < spawnAt);
});
