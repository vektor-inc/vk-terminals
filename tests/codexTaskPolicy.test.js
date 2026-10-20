// 自動処理用 Codex のタスク用ポリシー（issue #428）の検証。
// 入力検証・起動コマンドの組み立て・専用 CODEX_HOME の生成・新規作成と再起動の実効ポリシーの一致・
// 否定ケース（広い個人設定・未知キー・不正値・競合・再起動）をまとめて確認する。
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
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

// 偽の codex。起動引数・環境・標準入力を記録し、`-o` の出力ファイルへ結果を書く。
// 入力に FAIL が含まれれば終了コード 3、SLEEP が含まれれば短く待ってから終わる（状態の観測用）。
const FAKE_CODEX_SCRIPT = (recordPath) => [
  `#!${process.execPath}`,
  "const fs = require('fs');",
  'const input = fs.readFileSync(0, \'utf8\');',
  `fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, input, cwd: process.cwd() }));`,
  "const outIndex = process.argv.indexOf('-o');",
  "if (outIndex >= 0) fs.writeFileSync(process.argv[outIndex + 1], JSON.stringify({ ok: true }));",
  "console.log('fake codex output');",
  "if (input.includes('SLEEP')) setTimeout(() => process.exit(0), 1500);",
  "else process.exit(input.includes('FAIL') ? 3 : 0);",
  '',
].join('\n');

// 一時ディレクトリ上に「個人の CODEX_HOME」「アプリのデータ」「引き継ぎ先」「ホーム」「タスクのリポジトリ」を作る。
function createSandbox(personalConfigToml, { origin = 'https://github.com/vektor-inc/vk-terminals.git' } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-codex-policy-')));
  const personalCodexHome = path.join(root, 'personal-codex');
  fs.mkdirSync(personalCodexHome, { recursive: true });
  fs.writeFileSync(path.join(personalCodexHome, 'auth.json'), '{"token":"secret"}');
  if (personalConfigToml !== undefined) fs.writeFileSync(path.join(personalCodexHome, 'config.toml'), personalConfigToml);
  const homeDir = path.join(root, 'home');
  fs.mkdirSync(homeDir);
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => childProcess.execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  if (origin) git('remote', 'add', 'origin', origin);
  // メンバー起動の試験用に、本物の Codex の代わりになる偽の codex を最優先の探索先へ置く（実機の Codex の有無に依存させない）。
  const codexBinDir = path.join(root, 'fake-codex-bin');
  fs.mkdirSync(codexBinDir);
  const codexRecord = path.join(root, 'codex-record.json');
  fs.writeFileSync(path.join(codexBinDir, 'codex'), FAKE_CODEX_SCRIPT(codexRecord), { mode: 0o755 });
  const toolDirs = [codexBinDir, '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', ...String(process.env.PATH).split(path.delimiter).filter(path.isAbsolute)];
  return {
    root,
    personalCodexHome,
    homeDir,
    repo,
    git,
    codexBinDir,
    codexRecord,
    toolDirs,
    deps: {
      toolDirs,
      validateCodexLaunchOptions,
      dataDir: path.join(root, 'data'),
      handoffDir: path.join(root, 'handoff'),
      personalCodexHome,
      homeDir,
      cwd: repo,
      // 試験の作業フォルダは一時フォルダの中にあるため、一時フォルダの書き込み許可の判定は既定では外す（専用のテストで指定する）。
      tmpRoots: [],
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
    termId: '1', expectedGeneration: 2, engine: 'codex', approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' }, cwd: '/tmp',
  }, validators);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.codexPolicy, { preset: 'orchestrated-task' });
  assert.equal(validateRestartAgentRequest({
    termId: '1', expectedGeneration: 2, codexPolicy: { preset: 'orchestrated-task' },
  }, validators).error, 'Codex options require engine "codex"');
  // 操作を拘束するリポジトリは cwd から決めるため、ポリシー付きでは cwd が必須。
  assert.equal(validateRestartAgentRequest({
    termId: '1', expectedGeneration: 2, engine: 'codex', codexPolicy: { preset: 'orchestrated-task' },
  }, validators).error, 'codexPolicy requires cwd');
  assert.equal(validateRestartAgentRequest({
    termId: '1', expectedGeneration: 2, engine: 'codex', cwd: '/tmp',
  }, validators).ok, true);
  assert.equal(validateRestartAgentRequest({
    termId: '1', expectedGeneration: 2, engine: 'codex', codexPolicy: { preset: 'orchestrated-task', x: 1 }, cwd: '/tmp',
  }, validators).error, 'unknown codexPolicy key: x');
});

// ─── 起動コマンド ────────────────────────────────────────────────────────

test('起動コマンド: ポリシー付きは専用 CODEX_HOME と sandbox を明示し、シェル文字列にユーザー入力を混ぜない', () => {
  const home = '/Users/test user/.vk-terminals/codex-task-policy/orchestrated-task';
  assert.equal(
    buildCodexLaunchCommand('gpt-5.6-sol', { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' }, codexPolicyHome: home, codexPolicyTmpdir: '/var/folders/x y/T' }),
    `TMPDIR='/var/folders/x y/T' CODEX_HOME='${home}' codex --no-daemon --model 'gpt-5.6-sol' --ask-for-approval 'never' --sandbox 'workspace-write'`,
  );
  // 明示した sandbox（より狭い read-only）は上書きしない。
  assert.match(
    buildCodexLaunchCommand(undefined, { sandboxMode: 'read-only', codexPolicy: { preset: 'orchestrated-task' }, codexPolicyHome: home, codexPolicyTmpdir: '/tmp' }),
    /--sandbox 'read-only'$/,
  );
});

test('起動コマンド: 専用 CODEX_HOME が無い・不正なときは起動コマンドを作らず例外で止める', () => {
  const options = { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } };
  assert.throws(() => buildCodexLaunchCommand(undefined, options), /policy home/);
  for (const codexPolicyHome of ['relative/path', "/tmp/a'b", '/tmp/a\nb', '', 42, null]) {
    assert.throws(() => buildCodexLaunchCommand(undefined, { ...options, codexPolicyHome }), /policy home/, String(codexPolicyHome));
  }
  // 判定に使った TMPDIR が無い・不正なときも止める。
  for (const codexPolicyTmpdir of [undefined, 'relative', "/tmp/a'b", '/tmp/a\nb', '', 42, null]) {
    assert.throws(() => buildCodexLaunchCommand(undefined, { ...options, codexPolicyHome: '/tmp/ok', codexPolicyTmpdir }), /policy tmpdir/, String(codexPolicyTmpdir));
  }
  assert.throws(
    () => buildCodexLaunchCommand(undefined, { codexPolicy: { preset: 'x' }, codexPolicyHome: '/tmp/ok', codexPolicyTmpdir: '/tmp' }),
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
const HOME_ENTRIES = ['AGENTS.md', 'auth.json', 'config.toml', 'gh', 'gitconfig', 'member', 'member-runs', 'rules', 'vk-task-ops', 'vk-task-ops.js'];
const modeOf = (target) => fs.lstatSync(target).mode & 0o777;
const prepare = (sandbox, extra = {}) => prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...sandbox.deps, ...extra });
const launchHomes = (sandbox) => (fs.existsSync(sandbox.policyBase) ? fs.readdirSync(sandbox.policyBase) : []);

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
    assert.equal(result.ok, true, result.error);
    const config = fs.readFileSync(path.join(result.home, 'config.toml'), 'utf8');
    assert.match(config, /^sandbox_mode = "workspace-write"$/m);
    assert.match(config, /^network_access = false$/m);
    assert.match(config, /^\[features\]\napps = false$/m);
    assert.equal((config.match(/^\[features\]$/gm) || []).length, 1);
    // 書き込める場所は、引き継ぎ先と、メンバー起動の入出力フォルダ（この起動ぶんの専用フォルダ）だけ。
    const ioDir = path.join(sandbox.deps.dataDir, 'codex-task-io', path.basename(result.home));
    const expectedRoots = [sandbox.deps.handoffDir, ioDir].map((dir) => JSON.stringify(dir)).join(', ');
    assert.match(config, new RegExp(`^writable_roots = \\[${expectedRoots.replace(/[\\/]/g, '\\$&')}\\]$`, 'm'));
    // 外部コマンドの事前読み込みにつながる環境変数は、Codex が起動するコマンドへ渡さない。
    assert.match(config, /^exclude = \[.*"LD_\*".*"DYLD_\*".*"NODE_\*".*"GIT_\*".*"GH_\*".*\]$/m);
    for (const forbidden of ['danger-full-access', 'network_access = true', '"/"', '.ssh', 'profile', 'trust_level = "trusted"']) {
      assert.equal(config.includes(forbidden), false, forbidden);
    }
    // 拘束するリポジトリは「信頼しない」と記録する（個人設定の信頼済みプロジェクトは引き継がない）。
    assert.match(config, new RegExp(`^\\[projects\\.${JSON.stringify(fs.realpathSync(sandbox.repo)).replace(/[\\/]/g, '\\$&')}\\]\\ntrust_level = "untrusted"$`, 'm'));
    assert.equal(sha256(personalConfigPath), before);
    assert.deepEqual(fs.readdirSync(sandbox.personalCodexHome).sort(), ['auth.json', 'config.toml']);
    // ログイン状態だけは共有する（個人の設定ファイルは共有しない）。
    assert.equal(fs.readlinkSync(path.join(result.home, 'auth.json')), fs.realpathSync(path.join(sandbox.personalCodexHome, 'auth.json')));
    // 中身は許可した生成物だけ（hooks.json など他のファイルは無い）。
    assert.deepEqual(fs.readdirSync(result.home).sort(), HOME_ENTRIES);
    assert.deepEqual(fs.readdirSync(path.join(result.home, 'rules')), ['vk-terminals-task.rules']);
    assert.equal(fs.existsSync(sandbox.deps.handoffDir), true);
  } finally {
    sandbox.cleanup();
  }
});

// ─── プロジェクト側の .codex 層（config.toml・rules・hooks）による実効ポリシーの拡大 ───────────

// 実際の Codex（app-server の config/read）に、専用 CODEX_HOME と作業フォルダを渡して実効設定を読ませる。
// Codex が無い環境では null を返し、呼び出し側のテストは skip する。
function readEffectiveCodexConfig(codexHome, cwd) {
  return new Promise((resolve) => {
    const child = childProcess.spawn('codex', ['app-server'], { env: { ...process.env, CODEX_HOME: codexHome }, cwd, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 30000);
    child.on('error', () => finish(null));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch (_error) { continue; }
        if (message.id === 1) {
          child.stdin.write(`${JSON.stringify({ method: 'initialized' })}\n${JSON.stringify({ id: 2, method: 'config/read', params: { includeLayers: true, cwd } })}\n`);
        } else if (message.id === 2) {
          finish(message.result ? message.result.config : null);
        }
      }
    });
    child.stdin.write(`${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'vk-terminals-test', version: '0' } } })}\n`);
  });
}

const CODEX_AVAILABLE = childProcess.spawnSync('codex', ['--version'], { encoding: 'utf8' }).status === 0;
const WIDENING_PROJECT_CONFIG = [
  'sandbox_mode = "danger-full-access"',
  'approval_policy = "never"',
  '[sandbox_workspace_write]',
  'network_access = true',
  'writable_roots = ["/"]',
  '',
].join('\n');

test('プロジェクト側の .codex: 拘束するリポジトリと作業フォルダ（サブフォルダ・worktree を含む）を、新規作成でも再起動でも「信頼しない」と記録する', () => {
  const sandbox = createSandbox();
  try {
    const subdir = path.join(sandbox.repo, 'packages', 'app');
    fs.mkdirSync(subdir, { recursive: true });
    const deps = { ...sandbox.deps, cwd: subdir };
    const restartRequest = { termId: '3', expectedGeneration: 1, cwd: subdir, engine: 'codex', approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } };
    const fromNewPane = resolveCodexTaskPolicyLaunchOptions('codex', { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } }, deps);
    const fromRestart = resolveCodexTaskPolicyLaunchOptions('codex', restartRequest, deps);
    for (const resolved of [fromNewPane, fromRestart]) {
      assert.equal(resolved.ok, true, resolved.error);
      const config = fs.readFileSync(path.join(resolved.options.codexPolicyHome, 'config.toml'), 'utf8');
      const projects = [...config.matchAll(/^\[projects\.("(?:[^"\\]|\\.)*")\]\ntrust_level = "(\w+)"$/gm)].map((match) => [JSON.parse(match[1]), match[2]]);
      assert.deepEqual(projects, [[fs.realpathSync(sandbox.repo), 'untrusted'], [fs.realpathSync(subdir), 'untrusted']]);
      assert.equal(/trust_level = "trusted"/.test(config), false);
    }
    // 作業フォルダがリポジトリのルートそのものなら 1 件だけ。
    const atRoot = prepare(sandbox);
    assert.equal(atRoot.ok, true, atRoot.error);
    assert.equal((fs.readFileSync(path.join(atRoot.home, 'config.toml'), 'utf8').match(/^\[projects\./gm) || []).length, 1);
  } finally {
    sandbox.cleanup();
  }
});

test('プロジェクト側の .codex: 特殊文字を含むパスも TOML のキーとして壊れず、別の設定を差し込めない', () => {
  const sandbox = createSandbox();
  try {
    const odd = path.join(sandbox.repo, 'a"b]\\c [x]');
    fs.mkdirSync(odd);
    const result = prepare(sandbox, { cwd: odd });
    assert.equal(result.ok, true, result.error);
    const config = fs.readFileSync(path.join(result.home, 'config.toml'), 'utf8');
    assert.ok(config.includes(`[projects.${JSON.stringify(fs.realpathSync(odd))}]`));
    assert.equal((config.match(/^trust_level = /gm) || []).length, 2);
  } finally {
    sandbox.cleanup();
  }
});

test('プロジェクト側の .codex: 実際の Codex で、リポジトリ側の config.toml が network_access や writable_roots を広げても実効設定に反映されない（信頼済みの対照つき）',
  { skip: !CODEX_AVAILABLE && 'codex コマンドが無い環境' },
  async () => {
    const sandbox = createSandbox();
    try {
      fs.mkdirSync(path.join(sandbox.repo, '.codex'));
      fs.writeFileSync(path.join(sandbox.repo, '.codex', 'config.toml'), WIDENING_PROJECT_CONFIG);
      const subdir = path.join(sandbox.repo, 'sub');
      fs.mkdirSync(subdir);
      for (const cwd of [sandbox.repo, subdir]) {
        const policyOptions = { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } };
        const resolved = resolveCodexTaskPolicyLaunchOptions('codex', policyOptions, { ...sandbox.deps, cwd });
        assert.equal(resolved.ok, true, resolved.error);
        const effective = await readEffectiveCodexConfig(resolved.options.codexPolicyHome, cwd);
        assert.notEqual(effective, null, 'Codex の実効設定を読めなかった');
        assert.equal(effective.sandbox_mode, 'workspace-write');
        assert.equal(effective.sandbox_workspace_write.network_access, false);
        const ioDir = path.join(fs.realpathSync(sandbox.deps.dataDir), 'codex-task-io', path.basename(resolved.options.codexPolicyHome));
        assert.deepEqual(effective.sandbox_workspace_write.writable_roots, [fs.realpathSync(sandbox.deps.handoffDir), ioDir]);
        // 子の Codex 用 CODEX_HOME も、書き込み範囲・ネットワーク・sandbox は親と同じ（承認だけ求めない）。
        const child = await readEffectiveCodexConfig(path.join(resolved.options.codexPolicyHome, 'member'), cwd);
        assert.notEqual(child, null, '子用 CODEX_HOME の実効設定を読めなかった');
        assert.equal(child.sandbox_mode, 'workspace-write');
        assert.equal(child.approval_policy, 'never');
        assert.equal(child.sandbox_workspace_write.network_access, false);
        assert.deepEqual(child.sandbox_workspace_write.writable_roots, effective.sandbox_workspace_write.writable_roots);

        // 対照: 同じリポジトリを「信頼済み」にすると、リポジトリ側の設定が実効設定へ反映される（この検証が意味を持つ確認）。
        const configPath = path.join(resolved.options.codexPolicyHome, 'config.toml');
        const trusted = fs.readFileSync(configPath, 'utf8').replace(/trust_level = "untrusted"/g, 'trust_level = "trusted"');
        fs.writeFileSync(configPath, trusted);
        const widened = await readEffectiveCodexConfig(resolved.options.codexPolicyHome, cwd);
        assert.equal(widened.sandbox_mode, 'danger-full-access');
        assert.equal(widened.sandbox_workspace_write.network_access, true);
      }
    } finally {
      sandbox.cleanup();
    }
  });

test('生成: rules は信頼済みランチャーの実行だけを許可し、Git / GitHub / node の先頭一致は持たない', () => {
  const sandbox = createSandbox();
  try {
    const { home } = prepare(sandbox);
    const rules = fs.readFileSync(path.join(home, 'rules', 'vk-terminals-task.rules'), 'utf8');
    const ruleLines = rules.split('\n').filter((line) => line.startsWith('prefix_rule('));
    assert.deepEqual(ruleLines, [`prefix_rule(pattern=${JSON.stringify([path.join(home, 'vk-task-ops')])}, decision="allow")`]);
    // PATH で解決される `node` / `git` / `gh` を先頭に持つ許可は無い（後続の引数や環境を制限できないため）。
    for (const forbidden of ['"node"', '"git"', '"gh"', '"push"', '"api"', '"merge"', '"bash"', '"sh"', '"curl"', '"rm"']) {
      assert.equal(rules.includes(forbidden), false, forbidden);
    }
    // 入口は検証ロジック本体の複製で、案内（AGENTS.md）は入口と許可する操作だけを示す。
    assert.equal(fs.readFileSync(path.join(home, 'vk-task-ops.js'), 'utf8'), OPS_SOURCE);
    const guide = fs.readFileSync(path.join(home, 'AGENTS.md'), 'utf8');
    assert.ok(guide.includes(`${path.join(home, 'vk-task-ops')} <git|gh|prepare|member>`));
    assert.equal(guide.includes(`'${path.join(home, 'vk-task-ops')}'`), false);
    assert.match(guide, /引用符・`cd`・パイプ・リダイレクト・`2>&1` を付けず/);
    assert.match(guide, /workdir で指定/);
    assert.equal(guide.includes('node '), false);
    for (const operation of ORCHESTRATED_TASK_OPERATIONS) assert.ok(guide.includes(`\`${operation}\``), operation);
    assert.match(guide, /`gh issue create` は `--title <題> --body <本文>` が必須/);
    assert.match(guide, /--assignee/);
    assert.match(guide, /--label/);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: ランチャーは環境を空にして検証済みの絶対パスの Node を起動し、拘束するリポジトリを固定する', () => {
  const sandbox = createSandbox();
  try {
    const { home } = prepare(sandbox);
    const launcher = fs.readFileSync(path.join(home, 'vk-task-ops'), 'utf8');
    assert.match(launcher, /^#!\/bin\/sh\n/);
    assert.match(launcher, /^exec '\/usr\/bin\/env' -i \\$/m);
    const assign = (name) => new RegExp(`^  '${name}=(.*)' \\\\$`, 'm').exec(launcher)[1];
    assert.equal(assign('VK_TASK_ROOT'), sandbox.repo);
    assert.equal(assign('VK_TASK_REPO'), 'vektor-inc/vk-terminals');
    assert.equal(assign('VK_TASK_HOME'), sandbox.homeDir);
    assert.equal(assign('VK_TASK_GITCONFIG'), path.join(home, 'gitconfig'));
    assert.equal(assign('VK_TASK_GHCONFIG'), path.join(home, 'gh'));
    for (const name of ['VK_TASK_GIT', 'VK_TASK_GH']) assert.ok(path.isAbsolute(assign(name)), name);
    // 実行ファイルは PATH 解決ではなく絶対パス。
    const lastLine = launcher.trimEnd().split('\n').pop();
    const [nodePath, scriptPath] = [...lastLine.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.ok(path.isAbsolute(nodePath));
    assert.equal(scriptPath, path.join(home, 'vk-task-ops.js'));
    assert.ok(lastLine.endsWith('"$@"'));
    // origin が GitHub でないリポジトリでは owner/repo を固定できず、空になる（gh は拒否される）。
    sandbox.git('remote', 'set-url', 'origin', 'https://example.com/o/r.git');
    const other = prepare(sandbox);
    assert.match(fs.readFileSync(path.join(other.home, 'vk-task-ops'), 'utf8'), /^  'VK_TASK_REPO=' \\$/m);
  } finally {
    sandbox.cleanup();
  }
});

test('ランチャー: 環境変数で Node 起動前にコードを差し込めず、拘束した以外のリポジトリでは動かない', () => {
  const sandbox = createSandbox();
  try {
    const { home } = prepare(sandbox);
    const launcher = path.join(home, 'vk-task-ops');
    const marker = path.join(sandbox.root, 'preload-ran');
    const preload = path.join(sandbox.root, 'preload.js');
    fs.writeFileSync(preload, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    const poisoned = {
      ...process.env, NODE_OPTIONS: `--require ${preload}`, NODE_PATH: sandbox.root, GIT_DIR: '/nonexistent', GH_REPO: 'evil/repo',
      GIT_CONFIG_GLOBAL: path.join(sandbox.root, 'evil-gitconfig'), BASH_ENV: preload, ENV: preload,
    };
    const ok = childProcess.spawnSync(launcher, ['git', 'status', '--short'], { cwd: sandbox.repo, env: poisoned, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    assert.equal(fs.existsSync(marker), false);

    const other = path.join(sandbox.root, 'other');
    fs.mkdirSync(other);
    childProcess.execFileSync('git', ['init', '-q'], { cwd: other });
    const rejected = childProcess.spawnSync(launcher, ['git', 'status'], { cwd: other, env: poisoned, encoding: 'utf8' });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /not the bound repository/);
    const refusedOp = childProcess.spawnSync(launcher, ['git', 'diff', `--output=${path.join(sandbox.root, 'written')}`], { cwd: sandbox.repo, env: poisoned, encoding: 'utf8' });
    assert.equal(refusedOp.status, 2);
    assert.equal(fs.existsSync(path.join(sandbox.root, 'written')), false);
  } finally {
    sandbox.cleanup();
  }
});

test('ランチャー: sandbox の中から呼ぶと固有の終了コードと呼び直し案内で止まり、外なら従来どおり動く', () => {
  const sandbox = createSandbox();
  try {
    const { home } = prepare(sandbox);
    const launcher = path.join(home, 'vk-task-ops');
    const blocked = childProcess.spawnSync(launcher, ['git', 'status', '--short'], {
      cwd: sandbox.repo, env: { ...process.env, CODEX_SANDBOX: 'seatbelt' }, encoding: 'utf8',
    });
    assert.equal(blocked.status, 78);
    assert.match(blocked.stderr, /サンドボックスの中で呼ばれました/);
    assert.ok(blocked.stderr.includes(`${launcher} gh …`));
    assert.match(blocked.stderr, /引用符・cd・パイプを付けずに単独で呼び直してください/);

    const allowedEnv = { ...process.env };
    delete allowedEnv.CODEX_SANDBOX;
    const allowed = childProcess.spawnSync(launcher, ['git', 'status', '--short'], {
      cwd: sandbox.repo, env: allowedEnv, encoding: 'utf8',
    });
    assert.equal(allowed.status, 0, allowed.stderr);
  } finally {
    sandbox.cleanup();
  }
});

test('生成: 入口パスに空白や引用符を含む場合は事前確認・本生成とも拒否する', () => {
  for (const unsafeName of ['data with space', 'data\'quote']) {
    const sandbox = createSandbox();
    try {
      const dataDir = path.join(sandbox.root, unsafeName);
      const actual = prepare(sandbox, { dataDir });
      assert.equal(actual.ok, false, unsafeName);
      assert.match(actual.error, /unsafe directory path|launcher path contains unsafe characters/, unsafeName);
      const dryRun = prepare(sandbox, { dataDir, dryRun: true });
      assert.equal(dryRun.ok, false, unsafeName);
      assert.match(dryRun.error, /unsafe directory path|launcher path contains unsafe characters/, unsafeName);
    } finally {
      sandbox.cleanup();
    }
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
    assert.deepEqual(fs.readdirSync(second.home).sort(), HOME_ENTRIES);
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
    assert.deepEqual(fs.readdirSync(clean.home).sort(), HOME_ENTRIES);
    assert.notEqual(fs.readFileSync(path.join(clean.home, 'AGENTS.md'), 'utf8'), 'planted');

    // 専用フォルダの名前が衝突し、事前配置済みのフォルダだった場合は再利用せず拒否する（事前配置の物は消さない）。
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
    const expectedOf = (dir) => {
      const fileSpec = (name) => ({ content: fs.readFileSync(path.join(dir, name), 'utf8'), mode: modeOf(path.join(dir, name)) });
      return {
        files: Object.fromEntries(['config.toml', 'AGENTS.md', 'gitconfig', 'vk-task-ops.js', 'vk-task-ops'].map((name) => [name, fileSpec(name)])),
        ghFiles: { 'config.yml': fileSpec('gh/config.yml') },
        rulesBody: fs.readFileSync(path.join(dir, 'rules', 'vk-terminals-task.rules'), 'utf8'),
        authTarget,
      };
    };
    const pristine = { ...expectedOf(home), member: expectedOf(path.join(home, 'member')) };
    const uid = process.getuid();
    assert.doesNotThrow(() => verifyPolicyHome(fs, home, pristine, uid));

    // 子用 CODEX_HOME・実行の記録フォルダにも、許可した生成物以外のファイル・緩い権限・中身の違いがあれば拒否する。
    fs.writeFileSync(path.join(home, 'member', 'hooks.json'), '{}');
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /unexpected entries/);
    fs.rmSync(path.join(home, 'member', 'hooks.json'));
    fs.writeFileSync(path.join(home, 'member-runs', 'stray'), '');
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /unexpected entries/);
    fs.rmSync(path.join(home, 'member-runs', 'stray'));
    fs.chmodSync(path.join(home, 'member', 'vk-task-ops'), 0o700);
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /permissions are not 0500/);
    fs.chmodSync(path.join(home, 'member', 'vk-task-ops'), 0o500);
    assert.throws(() => verifyPolicyHome(fs, home, { ...pristine, member: undefined }, uid), /unexpected entries/);

    fs.writeFileSync(path.join(home, 'hooks.json'), '{}');
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /unexpected entries/);
    fs.rmSync(path.join(home, 'hooks.json'));

    fs.writeFileSync(path.join(home, 'rules', 'extra.rules'), '');
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /unexpected entries/);
    fs.rmSync(path.join(home, 'rules', 'extra.rules'));

    fs.chmodSync(path.join(home, 'config.toml'), 0o644);
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /permissions are not 0600/);
    fs.chmodSync(path.join(home, 'config.toml'), 0o600);

    // ランチャー・入口が書き換え可能になっていたら拒否する。
    fs.chmodSync(path.join(home, 'vk-task-ops'), 0o700);
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /permissions are not 0500/);
    fs.chmodSync(path.join(home, 'vk-task-ops'), 0o500);

    fs.chmodSync(path.join(home, 'AGENTS.md'), 0o600);
    fs.appendFileSync(path.join(home, 'AGENTS.md'), 'tampered');
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /could not be verified/);

    assert.throws(() => verifyPolicyHome(fs, home, { ...pristine, authTarget: null }, uid), /unexpected entries/);

    // gh の専用設定フォルダに余計なファイル・緩い権限・中身の違いがあれば拒否する。
    fs.writeFileSync(path.join(home, 'gh', 'extra.yml'), 'http_unix_socket: /tmp/x\n');
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /unexpected entries/);
    fs.rmSync(path.join(home, 'gh', 'extra.yml'));
    fs.chmodSync(path.join(home, 'gh', 'config.yml'), 0o644);
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /permissions are not 0600/);
    fs.chmodSync(path.join(home, 'gh', 'config.yml'), 0o600);
    fs.appendFileSync(path.join(home, 'gh', 'config.yml'), 'http_unix_socket: /tmp/x\n');
    assert.throws(() => verifyPolicyHome(fs, home, pristine, uid), /could not be verified/);
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
    assert.match(prepare(sandbox).error, /symbolic link/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.rmSync(sandbox.deps.dataDir);
    fs.rmSync(sandbox.deps.handoffDir, { recursive: true, force: true });

    fs.symlinkSync(elsewhere, sandbox.deps.handoffDir);
    assert.match(prepare(sandbox).error, /symbolic link/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
  } finally {
    sandbox.cleanup();
  }
});

test('信頼境界: データ・引き継ぎ先・ホーム・認証元の祖先が他人に書き込める、または他人の所有なら拒否する', () => {
  const makeWritable = (target) => fs.chmodSync(target, 0o777);
  const cases = [
    ['データフォルダの親', (sandbox) => { fs.mkdirSync(path.join(sandbox.root, 'shared')); makeWritable(path.join(sandbox.root, 'shared')); return { dataDir: path.join(sandbox.root, 'shared', 'data') }; }, /writable by other users/],
    ['データフォルダ自体', (sandbox) => { fs.mkdirSync(sandbox.deps.dataDir); makeWritable(sandbox.deps.dataDir); return {}; }, /writable by other users/],
    ['引き継ぎ先の親', (sandbox) => { fs.mkdirSync(path.join(sandbox.root, 'shared')); makeWritable(path.join(sandbox.root, 'shared')); return { handoffDir: path.join(sandbox.root, 'shared', 'handoff') }; }, /writable by other users/],
    ['引き継ぎ先自体', (sandbox) => { fs.mkdirSync(sandbox.deps.handoffDir); makeWritable(sandbox.deps.handoffDir); return {}; }, /writable by other users/],
    ['認証元の親', (sandbox) => { makeWritable(sandbox.personalCodexHome); return {}; }, /writable by other users/],
    ['認証元のファイル', (sandbox) => { fs.chmodSync(path.join(sandbox.personalCodexHome, 'auth.json'), 0o666); return {}; }, /writable by other users/],
  ];
  for (const [label, setup, pattern] of cases) {
    const sandbox = createSandbox();
    try {
      const extra = setup(sandbox);
      const result = prepare(sandbox, extra);
      assert.equal(result.ok, false, label);
      assert.match(result.error, pattern, label);
      assert.deepEqual(launchHomes(sandbox), [], label);
    } finally {
      sandbox.cleanup();
    }
  }
  // 所有者が違う（実行ユーザーでも root でもない）場合。
  const sandbox = createSandbox();
  try {
    assert.match(prepare(sandbox, { uid: process.getuid() + 1 }).error, /not owned by/);
  } finally {
    sandbox.cleanup();
  }
});

// ─── gh の専用設定（個人の ~/.config/gh を継承しない） ─────────────────────

// 受け取った環境変数と引数を記録するだけの偽の gh。実行ファイルの探索先として渡す。
function createFakeGh(sandbox) {
  const binDir = path.join(sandbox.root, 'fake-bin');
  fs.mkdirSync(binDir);
  const record = path.join(sandbox.root, 'gh-record.json');
  fs.writeFileSync(path.join(binDir, 'gh'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }));\n`, { mode: 0o755 });
  return { toolDirs: [binDir, ...sandbox.toolDirs], readRecord: () => JSON.parse(fs.readFileSync(record, 'utf8')) };
}

const PERSONAL_HOSTS = [
  'github.com:',
  '    http_unix_socket: /tmp/evil.sock',
  '    browser: /tmp/evil-browser',
  '    editor: /tmp/evil-editor',
  '    users:',
  '        octocat:',
  '            oauth_token: gho_secretToken123',
  '        keyring-user:',
  '    git_protocol: ssh',
  '    user: octocat',
  'evil.example.com:',
  '    oauth_token: other_host_token',
  '    user: other',
  '',
].join('\n');

test('gh: 個人の ~/.config/gh を継承せず、専用フォルダには固定の設定と github.com の認証だけを置く', () => {
  const sandbox = createSandbox();
  try {
    const fakeGh = createFakeGh(sandbox);
    const personalGh = path.join(sandbox.homeDir, '.config', 'gh');
    fs.mkdirSync(personalGh, { recursive: true });
    fs.writeFileSync(path.join(personalGh, 'config.yml'), 'http_unix_socket: /tmp/evil.sock\nbrowser: /tmp/evil\npager: /tmp/evil\naliases:\n    issue: "!/tmp/evil"\n');
    fs.writeFileSync(path.join(personalGh, 'hosts.yml'), PERSONAL_HOSTS);
    const result = prepare(sandbox, { toolDirs: fakeGh.toolDirs });
    assert.equal(result.ok, true, result.error);

    const ghDir = path.join(result.home, 'gh');
    assert.equal(modeOf(ghDir), 0o700);
    assert.deepEqual(fs.readdirSync(ghDir).sort(), ['config.yml', 'hosts.yml']);
    const config = fs.readFileSync(path.join(ghDir, 'config.yml'), 'utf8');
    for (const forbidden of ['http_unix_socket', 'browser', 'editor', 'aliases', 'evil']) assert.equal(config.includes(forbidden), false, forbidden);
    // 認証だけを引き継ぐ。通信設定・他のホスト・元の git_protocol は引き継がない。
    const hosts = fs.readFileSync(path.join(ghDir, 'hosts.yml'), 'utf8');
    assert.equal(modeOf(path.join(ghDir, 'hosts.yml')), 0o600);
    assert.match(hosts, /^github\.com:$/m);
    assert.match(hosts, /^    user: octocat$/m);
    assert.match(hosts, /^            oauth_token: gho_secretToken123$/m);
    assert.match(hosts, /^        keyring-user:$/m);
    for (const forbidden of ['http_unix_socket', 'browser', 'editor', 'evil', 'other_host_token', 'ssh']) assert.equal(hosts.includes(forbidden), false, forbidden);
    // 個人の設定は変更しない。
    assert.equal(fs.readFileSync(path.join(personalGh, 'hosts.yml'), 'utf8'), PERSONAL_HOSTS);

    // ランチャー経由の gh は、専用フォルダだけを設定として見る。
    const launcher = path.join(result.home, 'vk-task-ops');
    const run = childProcess.spawnSync(launcher, ['gh', 'issue', 'view', '1'], {
      cwd: sandbox.repo, env: { ...process.env, GH_CONFIG_DIR: personalGh, XDG_CONFIG_HOME: path.join(sandbox.homeDir, '.config') }, encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    const { env } = fakeGh.readRecord();
    assert.equal(env.GH_CONFIG_DIR, ghDir);
    assert.equal(env.XDG_CONFIG_HOME, result.home);
    assert.equal(env.HOME, sandbox.homeDir);
  } finally {
    sandbox.cleanup();
  }
});

test('gh: 個人の hosts.yml が無い・認証項目が読めない・不正な値だけのときは認証を引き継がない', () => {
  const cases = [
    ['hosts.yml が無い', undefined],
    ['他のホストだけ', 'evil.example.com:\n    oauth_token: abc\n    user: other\n'],
    ['不正なトークン・ユーザー名', "github.com:\n    oauth_token: 'a b;rm -rf'\n    user: '../x'\n    users:\n        '../y':\n            oauth_token: z\n"],
    ['通信設定だけ', 'github.com:\n    http_unix_socket: /tmp/evil.sock\n'],
  ];
  for (const [label, content] of cases) {
    const sandbox = createSandbox();
    try {
      const fakeGh = createFakeGh(sandbox);
      const personalGh = path.join(sandbox.homeDir, '.config', 'gh');
      fs.mkdirSync(personalGh, { recursive: true });
      if (content !== undefined) fs.writeFileSync(path.join(personalGh, 'hosts.yml'), content);
      const result = prepare(sandbox, { toolDirs: fakeGh.toolDirs });
      assert.equal(result.ok, true, `${label}: ${result.error}`);
      assert.deepEqual(fs.readdirSync(path.join(result.home, 'gh')), ['config.yml'], label);
    } finally {
      sandbox.cleanup();
    }
  }
});

test('gh: 認証元の hosts.yml の祖先・実体が他人に書ける、または途中のリンクが書込可能な場所を通る場合は拒否する', () => {
  const cases = [
    ['hosts.yml が他人に書ける', (sandbox, personalGh) => fs.chmodSync(path.join(personalGh, 'hosts.yml'), 0o666), /writable by other users/],
    ['gh 設定フォルダが他人に書ける', (sandbox, personalGh) => fs.chmodSync(personalGh, 0o777), /writable by other users/],
    ['リンクの向き先が書込可能なフォルダ', (sandbox, personalGh) => {
      const open = path.join(sandbox.root, 'open');
      fs.mkdirSync(open);
      fs.renameSync(path.join(personalGh, 'hosts.yml'), path.join(open, 'hosts.yml'));
      fs.chmodSync(open, 0o777);
      fs.symlinkSync(path.join(open, 'hosts.yml'), path.join(personalGh, 'hosts.yml'));
    }, /writable by other users/],
  ];
  for (const [label, setup, pattern] of cases) {
    const sandbox = createSandbox();
    try {
      const fakeGh = createFakeGh(sandbox);
      const personalGh = path.join(sandbox.homeDir, '.config', 'gh');
      fs.mkdirSync(personalGh, { recursive: true });
      fs.writeFileSync(path.join(personalGh, 'hosts.yml'), PERSONAL_HOSTS);
      setup(sandbox, personalGh);
      const result = prepare(sandbox, { toolDirs: fakeGh.toolDirs });
      assert.equal(result.ok, false, label);
      assert.match(result.error, pattern, label);
      assert.deepEqual(launchHomes(sandbox), [], label);
    } finally {
      sandbox.cleanup();
    }
  }
});

// ─── 元の絶対パスの階層ごとの検証 ───────────────────────────────────────

test('信頼境界: 元のパスの祖先にあるリンクも検証する（書込可能なフォルダ内のリンクは拒否し、何も作らない）', () => {
  const sandbox = createSandbox();
  try {
    const open = path.join(sandbox.root, 'open');
    const elsewhere = path.join(sandbox.root, 'elsewhere');
    fs.mkdirSync(open);
    fs.mkdirSync(elsewhere);
    fs.chmodSync(open, 0o777);
    // 書込可能なフォルダの中にあるリンク（他人が張り替えられる）を、データフォルダの祖先にする。
    fs.symlinkSync(elsewhere, path.join(open, 'link'));
    const result = prepare(sandbox, { dataDir: path.join(open, 'link', 'data') });
    assert.equal(result.ok, false);
    assert.match(result.error, /writable by other users/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);

    // 引き継ぎ先も同じ。検証より先に再帰作成しないので、書込可能な親の下には何も作られない。
    const handoff = prepare(sandbox, { handoffDir: path.join(open, 'new', 'deep', 'handoff') });
    assert.equal(handoff.ok, false);
    assert.match(handoff.error, /writable by other users/);
    assert.deepEqual(fs.readdirSync(open), ['link']);
  } finally {
    sandbox.cleanup();
  }
});

test('信頼境界: 自分所有のリンクを祖先に持つデータ・引き継ぎ先は、向き先まで検証して実パスで使う。無い階層は 1 段ずつ作る', () => {
  const sandbox = createSandbox();
  try {
    const real = path.join(sandbox.root, 'real');
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(sandbox.root, 'via-link'));
    const result = prepare(sandbox, {
      dataDir: path.join(sandbox.root, 'via-link', 'data', 'nested'),
      handoffDir: path.join(sandbox.root, 'via-link', 'handoff', 'deeper'),
    });
    assert.equal(result.ok, true, result.error);
    assert.ok(result.home.startsWith(path.join(real, 'data', 'nested')));
    assert.equal(modeOf(path.join(real, 'data')), 0o700);
    assert.equal(modeOf(path.join(real, 'handoff', 'deeper')), 0o700);
    const rootsPattern = `"${path.join(real, 'handoff', 'deeper')}", "${path.join(real, 'data', 'nested', 'codex-task-io')}/[0-9a-f]{24}"`;
    assert.match(fs.readFileSync(path.join(result.home, 'config.toml'), 'utf8'), new RegExp(`writable_roots = \\[${rootsPattern.replace(/[\\/]/g, '\\$&')}\\]`));
  } finally {
    sandbox.cleanup();
  }
});

test('信頼境界: 認証元（auth.json）のリンクは途中の階層まで検証し、書込可能な場所を通るものは共有しない', () => {
  const sandbox = createSandbox();
  try {
    const open = path.join(sandbox.root, 'open');
    fs.mkdirSync(open);
    fs.renameSync(path.join(sandbox.personalCodexHome, 'auth.json'), path.join(open, 'auth.json'));
    fs.chmodSync(open, 0o777);
    fs.symlinkSync(path.join(open, 'auth.json'), path.join(sandbox.personalCodexHome, 'auth.json'));
    const result = prepare(sandbox);
    assert.equal(result.ok, false);
    assert.match(result.error, /writable by other users/);
    assert.deepEqual(launchHomes(sandbox), []);
    // 検証を通る場所へのリンク（dotfiles 管理など）は共有できる。
    fs.chmodSync(open, 0o700);
    const shared = prepare(sandbox);
    assert.equal(shared.ok, true, shared.error);
    assert.equal(fs.readlinkSync(path.join(shared.home, 'auth.json')), path.join(open, 'auth.json'));
  } finally {
    sandbox.cleanup();
  }
});

test('信頼境界: 検証した祖先が準備の途中で差し替えられたら、作った専用フォルダを片付けて拒否する', () => {
  const sandbox = createSandbox();
  try {
    let swapped = false;
    // 専用フォルダの書き込み後（返す直前の再確認より前）に、検証済みのデータフォルダの親を別の物へ入れ替える。
    const swappingFs = {
      ...fs,
      readFileSync: (...args) => {
        if (!swapped && String(args[0]).endsWith('gitconfig')) {
          swapped = true;
          fs.renameSync(sandbox.deps.handoffDir, `${sandbox.deps.handoffDir}-old`);
          fs.mkdirSync(sandbox.deps.handoffDir);
        }
        return fs.readFileSync(...args);
      },
    };
    const result = prepare(sandbox, { fs: swappingFs });
    assert.equal(swapped, true);
    assert.equal(result.ok, false);
    assert.match(result.error, /changed after it was verified/);
    assert.deepEqual(launchHomes(sandbox), []);
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
    for (const name of ['config.toml', 'AGENTS.md', 'vk-task-ops.js', 'vk-task-ops', 'gitconfig', 'config.toml.tmp', 'auth.json']) {
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

test('権限: 緩い既存フォルダは 0700 に直し、生成物は所定の権限で作る', () => {
  const sandbox = createSandbox();
  try {
    fs.mkdirSync(sandbox.policyBase, { recursive: true, mode: 0o755 });
    fs.chmodSync(path.dirname(sandbox.policyBase), 0o755);
    fs.chmodSync(sandbox.policyBase, 0o755);
    const result = prepare(sandbox);
    assert.equal(result.ok, true, result.error);
    for (const dir of [path.dirname(sandbox.policyBase), sandbox.policyBase, result.home, path.join(result.home, 'rules')]) {
      assert.equal(modeOf(dir), 0o700, dir);
    }
    const expectedModes = { 'config.toml': 0o600, 'AGENTS.md': 0o600, gitconfig: 0o600, 'vk-task-ops.js': 0o400, 'vk-task-ops': 0o500 };
    for (const [file, mode] of Object.entries({ ...expectedModes, [path.join('rules', 'vk-terminals-task.rules')]: 0o600 })) {
      assert.equal(modeOf(path.join(result.home, file)), mode, file);
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
    assert.match(prepare(sandbox, { uid: process.getuid() + 1 }).error, /not owned by/);
    assert.deepEqual(launchHomes(sandbox), []);
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

    // 共有元が通常ファイルでない（ディレクトリ）・リンク切れは拒否する。
    fs.mkdirSync(authPath);
    assert.match(prepare(sandbox).error, /not a regular file/);
    fs.rmdirSync(authPath);
    fs.symlinkSync(path.join(sandbox.root, 'missing'), authPath);
    assert.match(prepare(sandbox).error, /broken link/);
    fs.rmSync(authPath);

    // 共有元がリンクなら、リンクの最終的な実体を指す。
    const realAuth = path.join(sandbox.root, 'dotfiles-auth.json');
    fs.writeFileSync(realAuth, '{}');
    fs.symlinkSync(realAuth, authPath);
    const linked = prepare(sandbox);
    assert.equal(fs.readlinkSync(path.join(linked.home, 'auth.json')), fs.realpathSync(realAuth));
  } finally {
    sandbox.cleanup();
  }
});

test('拘束: 作業フォルダが無い・Git 管理外・ホームそのもの・外部実行設定のあるリポジトリでは専用フォルダを作らず拒否する', () => {
  const sandbox = createSandbox();
  try {
    const without = prepare(sandbox, { cwd: undefined });
    assert.deepEqual(without, { ok: false, error: 'codex task policy unavailable: working directory required' });
    assert.match(prepare(sandbox, { cwd: 'relative' }).error, /unsafe directory path/);

    const plain = path.join(sandbox.root, 'plain');
    fs.mkdirSync(plain);
    assert.match(prepare(sandbox, { cwd: plain }).error, /not inside a git repository/);
    assert.match(prepare(sandbox, { cwd: sandbox.repo, homeDir: sandbox.repo }).error, /not a project directory/);

    sandbox.git('config', 'filter.evil.clean', 'cat');
    assert.match(prepare(sandbox).error, /can run external commands/);
    sandbox.git('config', '--unset', 'filter.evil.clean');
    assert.equal(prepare(sandbox).ok, true);
    assert.equal(launchHomes(sandbox).length, 1);

    // 部分クローンの設定（不足オブジェクトの自動取得につながる）も、専用フォルダを増やさず拒否する。
    for (const key of ['remote.origin.promisor', 'remote.origin.partialclonefilter', 'extensions.partialclone']) {
      sandbox.git('config', key, 'true');
      const rejected = prepare(sandbox);
      assert.equal(rejected.ok, false, key);
      assert.ok(rejected.error.includes('can run external commands') && rejected.error.includes(key), rejected.error);
      sandbox.git('config', '--unset', key);
      assert.equal(launchHomes(sandbox).length, 1, key);
    }
  } finally {
    sandbox.cleanup();
  }
});

test('信頼済みの実行ファイル: 見つからない・信頼できない場所のものは使わず、検証を通ったものだけをランチャーへ固定する', () => {
  const sandbox = createSandbox();
  try {
    assert.match(prepare(sandbox, { toolDirs: [] }).error, /trusted node\/git\/env executable not found/);
    assert.deepEqual(launchHomes(sandbox), []);
    // 他人が書き込める場所の node は候補から外れる。
    const open = path.join(sandbox.root, 'open');
    fs.mkdirSync(open);
    fs.writeFileSync(path.join(open, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(open, 0o777);
    const realDirs = process.env.PATH.split(path.delimiter).filter(path.isAbsolute);
    const result = prepare(sandbox, { toolDirs: [open, ...realDirs] });
    assert.equal(result.ok, true, result.error);
    assert.equal(fs.readFileSync(path.join(result.home, 'vk-task-ops'), 'utf8').includes(open), false);
  } finally {
    sandbox.cleanup();
  }
});

test('自動削除はしない: 古い専用フォルダも起動で消さず、削除は利用者の責務', () => {
  const sandbox = createSandbox();
  try {
    const first = prepare(sandbox);
    const old = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
    fs.utimesSync(first.home, old, old);
    const second = prepare(sandbox);
    const third = prepare(sandbox);
    for (const result of [first, second, third]) assert.equal(fs.existsSync(result.home), true);
    assert.equal(launchHomes(sandbox).length, 3);
    const source = fs.readFileSync(path.join(__dirname, '..', 'utils', 'codexTaskPolicy.js'), 'utf8');
    assert.equal(/pruneStale|STALE_LAUNCH/.test(source), false);
  } finally {
    sandbox.cleanup();
  }
});

test('回収: 使われなかった専用フォルダは作った本人だけが片付け、差し替えられたものは消さない', () => {
  const sandbox = createSandbox();
  try {
    const mine = prepare(sandbox);
    const other = prepare(sandbox);
    assert.equal(mine.discard(), true);
    assert.equal(fs.existsSync(mine.home), false);
    assert.equal(mine.discard(), false);
    assert.equal(fs.existsSync(other.home), true);

    // 作ったフォルダが別の物（同名の別フォルダ・リンク）に入れ替わっていたら消さない。
    const replaced = prepare(sandbox);
    fs.rmSync(replaced.home, { recursive: true });
    fs.mkdirSync(replaced.home, { mode: 0o700 });
    fs.writeFileSync(path.join(replaced.home, 'keep'), 'x');
    assert.equal(replaced.discard(), false);
    assert.equal(fs.existsSync(path.join(replaced.home, 'keep')), true);

    const linked = prepare(sandbox);
    const elsewhere = path.join(sandbox.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.writeFileSync(path.join(elsewhere, 'keep'), 'x');
    fs.rmSync(linked.home, { recursive: true });
    fs.symlinkSync(elsewhere, linked.home);
    assert.equal(linked.discard(), false);
    assert.equal(fs.existsSync(path.join(elsewhere, 'keep')), true);

    // 事前確認（dryRun）は作るものが無く、回収は何もしない。
    const dry = prepare(sandbox, { dryRun: true });
    assert.equal(dry.discard(), false);
  } finally {
    sandbox.cleanup();
  }
});

test('回収: 生成の途中・検証で失敗したら、その呼び出しで作った専用フォルダを残さない', () => {
  const sandbox = createSandbox();
  try {
    const kept = prepare(sandbox);
    const failures = {
      '書き込み失敗': { ...fs, writeFileSync: (target, content) => { if (typeof target === 'number') throw Object.assign(new Error('disk full'), { code: 'ENOSPC' }); return fs.writeFileSync(target, content); } },
      '読み戻しの不一致': { ...fs, readFileSync: (target, encoding) => (String(target).endsWith('config.toml') ? 'tampered' : fs.readFileSync(target, encoding)) },
      'リンク作成失敗': { ...fs, symlinkSync: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } },
    };
    for (const [label, failingFs] of Object.entries(failures)) {
      const result = prepare(sandbox, { fs: failingFs });
      assert.equal(result.ok, false, label);
      assert.deepEqual(launchHomes(sandbox), [path.basename(kept.home)], label);
    }
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
    assert.match(prepare(sandbox, { homeDir: 'relative' }).error, /unsafe directory path/);
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
      termId: '3', expectedGeneration: 1, cwd: sandbox.repo, engine: 'codex', model: 'gpt-5.6-sol', ...newPaneOptions,
      codexPolicyHome: '/etc', codexPolicyTmpdir: '/etc',
    };
    const fromNewPane = resolveCodexTaskPolicyLaunchOptions('codex', { ...newPaneOptions, codexPolicyHome: '/etc', codexPolicyTmpdir: '/etc' }, sandbox.deps);
    const fromRestart = resolveCodexTaskPolicyLaunchOptions('codex', restartRequest, sandbox.deps);
    assert.equal(fromNewPane.ok, true, fromNewPane.error);
    const commandOf = (resolved) => buildEngineAwareLaunchCommand('codex', 'gpt-5.6-sol', resolved.options).command;
    const normalized = (resolved) => commandOf(resolved).replace(resolved.options.codexPolicyHome, '<home>');
    assert.equal(normalized(fromRestart), normalized(fromNewPane));
    assert.ok(commandOf(fromNewPane).startsWith(`TMPDIR='${fromNewPane.options.codexPolicyTmpdir}' CODEX_HOME='${fromNewPane.options.codexPolicyHome}' codex --no-daemon`));
    assert.ok(!commandOf(fromNewPane).includes('/etc'));

    // 再起動を繰り返しても、生成物は同じ固定内容になる。
    const contentOf = (resolved) => fs.readFileSync(path.join(resolved.options.codexPolicyHome, 'config.toml'), 'utf8').replace(path.basename(resolved.options.codexPolicyHome), '<launch>');
    for (let i = 0; i < 3; i += 1) {
      const again = resolveCodexTaskPolicyLaunchOptions('codex', restartRequest, sandbox.deps);
      assert.equal(normalized(again), normalized(fromNewPane));
      assert.equal(contentOf(again), contentOf(fromNewPane));
    }

    // ポリシー無しで再起動した場合は専用 CODEX_HOME を付けない（権限が持ち越されない）。
    const withoutPolicy = resolveCodexTaskPolicyLaunchOptions('codex', { approvalPolicy: 'never' }, sandbox.deps);
    assert.equal(withoutPolicy.options.codexPolicyHome, undefined);
    assert.equal(withoutPolicy.discard(), false);
    assert.ok(!buildEngineAwareLaunchCommand('codex', undefined, withoutPolicy.options).command.includes('CODEX_HOME'));
  } finally {
    sandbox.cleanup();
  }
});

test('解決: Claude Code にはポリシーを適用せず、固定できない場合は Codex を起動できない結果を返す', () => {
  const sandbox = createSandbox();
  try {
    const request = { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' }, codexPolicyHome: '/etc' };
    const claude = resolveCodexTaskPolicyLaunchOptions('claude', request, sandbox.deps);
    assert.deepEqual({ ok: claude.ok, options: claude.options }, { ok: true, options: {} });
    assert.equal(claude.discard(), false);
    assert.equal(resolveCodexTaskPolicyLaunchOptions('codex', { codexPolicy: { preset: 'x' } }, sandbox.deps).ok, false);
    assert.equal(
      resolveCodexTaskPolicyLaunchOptions('codex', { codexPolicy: { preset: 'orchestrated-task', args: [] } }, sandbox.deps).ok,
      false,
    );
    const unavailable = resolveCodexTaskPolicyLaunchOptions('codex', request, { ...sandbox.deps, handoffDir: 'relative' });
    assert.equal(unavailable.ok, false);
    assert.match(unavailable.error, /^codex task policy unavailable/);
    assert.equal('options' in unavailable, false);
    // 作業フォルダが無ければ（ポリシー付きでは必須）、専用フォルダを作らず拒否する。
    const noCwd = resolveCodexTaskPolicyLaunchOptions('codex', request, { ...sandbox.deps, cwd: undefined });
    assert.equal(noCwd.error, 'codex task policy unavailable: working directory required');
    assert.deepEqual(launchHomes(sandbox), []);
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
    assert.equal(dry.ok, true, dry.error);
    assert.equal('codexPolicyHome' in dry.options, false);
    assert.deepEqual(fs.readdirSync(sandbox.policyBase), []);
    // 事前確認でも、作業フォルダ・リポジトリの検証は本番と同じ（固定できない状態は事前に分かる）。
    const plain = path.join(sandbox.root, 'plain');
    fs.mkdirSync(plain);
    assert.match(resolveCodexTaskPolicyLaunchOptions('codex', request, { ...sandbox.deps, dryRun: true, cwd: plain }).error, /not inside a git repository/);

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

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');

test('terminal:create は PTY を作る前に起動オプションを解決し、失敗したら例外で返す（Codex 未起動のペインを成功にしない）', () => {
  const handlerStart = mainSource.indexOf("ipcMain.handle('terminal:create'");
  const handlerEnd = mainSource.indexOf("ipcMain.on('terminal:input'");
  const handler = mainSource.slice(handlerStart, handlerEnd);
  const resolveAt = handler.indexOf('resolveCodexLaunchOptions(resolvedEngine, options, { cwd: resolvedCwd })');
  const throwAt = handler.indexOf('throw new Error(launchResolution.error)');
  const spawnAt = handler.indexOf('pty.spawn(');
  assert.ok(resolveAt > 0 && throwAt > resolveAt && spawnAt > throwAt, 'resolve → throw → pty.spawn の順であること');
  // 失敗を握りつぶして PTY を作り続ける分岐（ログだけ出して続行）が無いこと。
  assert.equal(handler.includes('codex launch refused (terminal'), false);
  // 起動コマンドの組み立ても PTY 作成より前にあり、作成後に失敗して PTY が残る経路が無いこと。
  assert.ok(handler.indexOf('buildEngineAwareLaunchCommand(') < spawnAt);
  // 組み立て・PTY 作成の失敗で、使われない専用フォルダを回収すること。
  const afterSpawn = handler.slice(spawnAt);
  assert.ok(/catch \(error\) \{\s*discardLaunchHome\(\);\s*throw error;/.test(handler.slice(resolveAt, spawnAt + afterSpawn.indexOf('});'))));
  assert.equal((handler.match(/discardLaunchHome\(\);/g) || []).length, 2);
});

test('restart-agent: 専用フォルダは待機・存在確認・世代確認の後、AI を止める前にだけ作り、使われなければ回収する', () => {
  const start = mainSource.indexOf("url.pathname === '/api/restart-agent'");
  const end = mainSource.indexOf("url.pathname === '/api/close-pane'");
  const handler = mainSource.slice(start, end);
  const at = (needle) => {
    const index = handler.indexOf(needle);
    assert.ok(index >= 0, needle);
    return index;
  };
  const dryRunAt = at('{ dryRun: true, cwd: request.cwd }');
  const waitAt = at('restartAgentOperations.get(request.termId)))');
  const notFoundAt = at('not found');
  const mismatchAt = at('generation mismatch');
  const prepareAt = at('resolveCodexLaunchOptions(request.engine, request, { cwd: request.cwd })');
  const operationAt = at('restartAgentInTerminal(ptyProcess');
  assert.ok(dryRunAt < waitAt && waitAt < notFoundAt && notFoundAt < mismatchAt && mismatchAt < prepareAt && prepareAt < operationAt);
  // 本番の準備から operation の登録までに await を挟まない（直列化の隙間を作らない）。
  assert.equal(/await/.test(handler.slice(prepareAt, at('restartAgentOperations.set('))), false);
  // 停止失敗・PTY 消滅・例外のどれでも、起動に使われなかった専用フォルダを回収する。
  assert.ok(/finally \{\s*if \(!launchHomeInUse\) launchResolution\.discard\(\);/.test(handler));
  assert.ok(handler.indexOf('launchHomeInUse = true;') > handler.indexOf("error: 'failed to stop agent'"));
});

test('new-pane: ポリシー付きは cwd が必須で、事前確認にも同じ cwd を渡す', () => {
  const start = mainSource.indexOf("url.pathname === '/api/new-pane'");
  const handler = mainSource.slice(start, mainSource.indexOf("url.pathname === '/api/restart-agent'"));
  assert.ok(handler.includes("error: 'codexPolicy requires cwd'"));
  assert.ok(handler.includes('{ dryRun: true, cwd: requestedCwd }'));
});

// ─── git push / prepare worktree（issue #440。実ランチャー経由） ───────────────

// 一時フォルダの bare リポジトリを GitHub の代わりにする（remoteBase は prepareCodexTaskPolicyHome のテスト用引数。
// main.js からも API の入力からも渡せず、実ランチャーに固定される）。
function createPushSandbox() {
  const sandbox = createSandbox();
  const gitIn = (cwd, ...args) => childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(sandbox.homeDir, '.gitconfig'), '[user]\n\tname = Policy Tester\n\temail = policy@example.com\n');
  sandbox.git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  const remoteBase = path.join(sandbox.root, 'remote');
  const bare = path.join(remoteBase, 'vektor-inc', 'vk-terminals.git');
  fs.mkdirSync(bare, { recursive: true });
  gitIn(bare, 'init', '-q', '--bare', '-b', 'main');
  sandbox.git('push', '-q', bare, 'main:main');
  const fakeGh = createFakeGh(sandbox);
  const launch = prepare(sandbox, { remoteBase, toolDirs: fakeGh.toolDirs });
  assert.equal(launch.ok, true, launch.error);
  const launcher = path.join(launch.home, 'vk-task-ops');
  const ops = (cwd, ...args) => childProcess.spawnSync(launcher, args, { cwd, env: { ...process.env, GIT_DIR: '/nonexistent', NODE_OPTIONS: '' }, encoding: 'utf8' });
  const remoteRef = (ref) => {
    try {
      return gitIn(bare, 'rev-parse', '--verify', '-q', ref);
    } catch (_error) {
      return null;
    }
  };
  return { sandbox, launch, launcher, ops, bare, remoteBase, remoteRef, gitIn };
}

test('ランチャー: push 先の基点は本番では GitHub に固定され、テスト用の差し替えは絶対パスだけで API の入力からは渡せない', () => {
  const sandbox = createSandbox();
  try {
    const defaults = prepare(sandbox);
    assert.equal(defaults.ok, true, defaults.error);
    const launcher = fs.readFileSync(path.join(defaults.home, 'vk-task-ops'), 'utf8');
    assert.match(launcher, /^  'VK_TASK_REMOTE_BASE=https:\/\/github\.com' \\$/m);
    for (const remoteBase of ['relative/path', 'https://evil.example', "/tmp/a'b", '']) {
      const result = prepare(sandbox, { remoteBase });
      assert.equal(result.ok, false, remoteBase);
      assert.match(result.error, /unsafe remote base/);
    }
    // API の入力（codexPolicy）に基点を入れても、未知のキーとして拒否される。
    assert.equal(validateCodexLaunchOptions('codex', { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task', remoteBase: '/tmp/x' } }).ok, false);
    // 案内文には、追加した 2 つの操作と、許可外の指定が使えないことが書かれている。
    const guide = fs.readFileSync(path.join(defaults.home, 'AGENTS.md'), 'utf8');
    assert.match(guide, /`git push`/);
    assert.match(guide, /`prepare worktree`/);
    assert.match(guide, /強制上書き・削除・タグは使えない/);
  } finally {
    sandbox.cleanup();
  }
});

test('ランチャー: 拘束先と worktree の両方から push が通り、force 系・既定ブランチ・別リポジトリ・同じ origin の別クローンからは通らない', () => {
  const env = createPushSandbox();
  const { sandbox } = env;
  try {
    // 拘束先（通常のクローン）から。
    sandbox.git('checkout', '-q', '-b', 'feature/440-root');
    sandbox.git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'root work');
    let result = env.ops(sandbox.repo, 'git', 'push', 'feature/440-root');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(env.remoteRef('refs/heads/feature/440-root'), sandbox.git('rev-parse', 'HEAD').trim());

    // worktree から。
    const worktree = path.join(sandbox.repo, '.claude', 'worktrees', 'plain');
    sandbox.git('worktree', 'add', '-q', '-b', 'feature/440-wt', worktree);
    const wt = fs.realpathSync(worktree);
    childProcess.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'wt work'], { cwd: wt });
    result = env.ops(wt, 'git', 'push', 'feature/440-wt');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(env.remoteRef('refs/heads/feature/440-wt'), env.gitIn(wt, 'rev-parse', 'HEAD'));

    // 許可外は、送られない。
    const mainBefore = env.remoteRef('refs/heads/main');
    for (const args of [
      ['git', 'push', '--force', 'feature/440-wt'],
      ['git', 'push', '--force-with-lease', 'feature/440-wt'],
      ['git', 'push', '--delete', 'feature/440-wt'],
      ['git', 'push', '--tags'],
      ['git', 'push', '--mirror'],
      ['git', 'push', 'origin', 'feature/440-wt'],
      ['git', 'push', '+feature/440-wt'],
      ['git', 'push', 'feature/440-wt:main'],
      ['git', 'push', ':feature/440-wt'],
      ['git', 'push', 'main'],
      ['git', 'push', 'feature/440-never'],
    ]) {
      result = env.ops(wt, ...args);
      assert.equal(result.status, 2, args.join(' '));
    }
    assert.equal(env.remoteRef('refs/heads/main'), mainBefore);
    assert.equal(env.remoteRef('refs/heads/feature/440-wt'), env.gitIn(wt, 'rev-parse', 'HEAD'));

    // 同じ origin を持つ別クローン・別のリポジトリ。
    const clone = path.join(sandbox.root, 'clone');
    fs.mkdirSync(clone);
    for (const [dir, origin] of [[clone, 'https://github.com/vektor-inc/vk-terminals.git'], [path.join(sandbox.root, 'stranger'), 'https://github.com/other/repo.git']]) {
      fs.mkdirSync(dir, { recursive: true });
      childProcess.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      childProcess.execFileSync('git', ['remote', 'add', 'origin', origin], { cwd: dir });
      childProcess.execFileSync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: dir });
      childProcess.execFileSync('git', ['checkout', '-q', '-b', 'feature/440-other'], { cwd: dir });
      result = env.ops(dir, 'git', 'push', 'feature/440-other');
      assert.equal(result.status, 2, dir);
      assert.match(result.stderr, /not the bound repository/, dir);
      result = env.ops(dir, 'prepare', 'worktree', 'main', '440', 'feature/440-z', 'z');
      assert.equal(result.status, 2, dir);
    }
    assert.equal(env.remoteRef('refs/heads/feature/440-other'), null);
  } finally {
    sandbox.cleanup();
  }
});

test('ランチャー: prepare で作った worktree で、そのまま add・commit・push が通る', () => {
  const env = createPushSandbox();
  const { sandbox } = env;
  try {
    const prepared = env.ops(sandbox.repo, 'prepare', 'worktree', 'main', '440', 'feature/440-flow', 'codex-440');
    assert.equal(prepared.status, 0, prepared.stderr);
    const worktree = path.join(fs.realpathSync(sandbox.repo), '.claude', 'worktrees', 'codex-440');
    assert.match(prepared.stdout, new RegExp(`^TARGET_REPO=${worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\nWORK_BRANCH=feature/440-flow\\nBASE_SHA=${env.remoteRef('refs/heads/main')}\\n$`));
    // 通常のクローンは main のまま切り替わらない。
    assert.equal(sandbox.git('symbolic-ref', '--short', 'HEAD').trim(), 'main');
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'feature\n');
    let result = env.ops(worktree, 'git', 'add', '--', 'feature.txt');
    assert.equal(result.status, 0, result.stderr);
    result = env.ops(worktree, 'git', 'commit', '-m', '[ 機能追加 ] 例');
    assert.equal(result.status, 0, result.stderr);
    result = env.ops(worktree, 'git', 'push', 'feature/440-flow');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(env.remoteRef('refs/heads/feature/440-flow'), env.gitIn(worktree, 'rev-parse', 'HEAD'));
    assert.equal(env.gitIn(env.bare, 'log', '-1', '--format=%s', 'feature/440-flow'), '[ 機能追加 ] 例');
    assert.equal(env.gitIn(env.bare, 'log', '-1', '--format=%an', 'feature/440-flow'), 'Policy Tester');

    // 同名のブランチ・パスは作り直さない。許可外の引数は実行前に拒否される。
    assert.equal(env.ops(sandbox.repo, 'prepare', 'worktree', 'main', '440', 'feature/440-flow', 'other-name').status, 2);
    assert.equal(env.ops(sandbox.repo, 'prepare', 'worktree', 'main', '440', 'feature/440-second', 'codex-440').status, 2);
    assert.equal(env.ops(sandbox.repo, 'prepare', 'worktree', 'main', '440', 'feature/440-third', '../escape').status, 2);
    assert.equal(fs.existsSync(path.join(sandbox.repo, '.claude', 'escape')), false);
  } finally {
    sandbox.cleanup();
  }
});

// ─── メンバー起動（issue #441。子用 CODEX_HOME・入出力フォルダ・実ランチャー経由） ───────────

const launcherAssignments = (launcherPath) => {
  const launcher = fs.readFileSync(launcherPath, 'utf8');
  return Object.fromEntries([...launcher.matchAll(/^  '(VK_TASK_[A-Z_]+)=(.*)' \\$/gm)].map((match) => [match[1], match[2]]));
};

test('生成: 子用 CODEX_HOME とランチャーが親と一緒に作られ、子側の許可・設定は親と同じ範囲で、member 操作だけを持たない', () => {
  const sandbox = createSandbox();
  try {
    const result = prepare(sandbox);
    assert.equal(result.ok, true, result.error);
    const parentHome = result.home;
    const childHome = path.join(parentHome, 'member');
    const ioDir = path.join(sandbox.deps.dataDir, 'codex-task-io', path.basename(parentHome));
    const runsDir = path.join(parentHome, 'member-runs');
    const fakeCodex = path.join(sandbox.codexBinDir, 'codex');

    // 子用の専用フォルダは、親と同じ生成物だけ。入出力フォルダと実行の記録フォルダは空の 0700。
    assert.deepEqual(fs.readdirSync(childHome).sort(), HOME_ENTRIES.filter((name) => !name.startsWith('member')));
    for (const dir of [childHome, ioDir, runsDir]) assert.equal(modeOf(dir), 0o700, dir);
    assert.deepEqual(fs.readdirSync(ioDir), []);
    assert.deepEqual(fs.readdirSync(runsDir), []);
    assert.equal(fs.readlinkSync(path.join(childHome, 'auth.json')), fs.readlinkSync(path.join(parentHome, 'auth.json')));
    for (const name of ['gitconfig', 'vk-task-ops.js', 'gh/config.yml']) {
      assert.equal(fs.readFileSync(path.join(childHome, name), 'utf8'), fs.readFileSync(path.join(parentHome, name), 'utf8'), name);
    }
    assert.equal(modeOf(path.join(childHome, 'vk-task-ops')), 0o500);

    // 親のランチャーだけがメンバー起動の設定を持ち、子のランチャーでは空（member 操作が無効）。
    const parentBinding = launcherAssignments(path.join(parentHome, 'vk-task-ops'));
    const childBinding = launcherAssignments(path.join(childHome, 'vk-task-ops'));
    assert.equal(parentBinding.VK_TASK_CODEX, fakeCodex);
    assert.equal(parentBinding.VK_TASK_MEMBER_HOME, childHome);
    assert.equal(parentBinding.VK_TASK_MEMBER_IO, ioDir);
    assert.equal(parentBinding.VK_TASK_MEMBER_RUNS, runsDir);
    for (const name of ['VK_TASK_CODEX', 'VK_TASK_MEMBER_HOME', 'VK_TASK_MEMBER_IO', 'VK_TASK_MEMBER_RUNS', 'VK_TASK_PARENT_CWD', 'VK_TASK_PARENT_SANDBOX']) assert.equal(childBinding[name], '', name);
    // 親を起動した作業フォルダ（実パス）と sandbox が固定される（既定は workspace-write）。
    assert.equal(parentBinding.VK_TASK_PARENT_CWD, fs.realpathSync(sandbox.repo));
    assert.equal(parentBinding.VK_TASK_PARENT_SANDBOX, 'workspace-write');
    // 拘束先・実行ファイル・fetch 元は親と同じで、子の設定ファイルは子用の専用フォルダ内のもの。
    for (const name of ['VK_TASK_ROOT', 'VK_TASK_REPO', 'VK_TASK_GIT', 'VK_TASK_GH', 'VK_TASK_HOME', 'VK_TASK_REMOTE_BASE']) assert.equal(childBinding[name], parentBinding[name], name);
    assert.equal(childBinding.VK_TASK_GITCONFIG, path.join(childHome, 'gitconfig'));
    assert.equal(childBinding.VK_TASK_GHCONFIG, path.join(childHome, 'gh'));

    // 子の許可は子のランチャーの実行だけ。
    const childRules = fs.readFileSync(path.join(childHome, 'rules', 'vk-terminals-task.rules'), 'utf8');
    assert.deepEqual(childRules.split('\n').filter((line) => line.startsWith('prefix_rule(')), [`prefix_rule(pattern=${JSON.stringify([path.join(childHome, 'vk-task-ops')])}, decision="allow")`]);
    assert.equal(childRules.includes(parentHome + '/vk-task-ops'), false);

    // 設定は親と同じ範囲（sandbox・ネットワーク・書き込み先・信頼しないプロジェクト）。違うのは承認だけ（子は承認を求める相手がいない）。
    const parentConfig = fs.readFileSync(path.join(parentHome, 'config.toml'), 'utf8');
    const childConfig = fs.readFileSync(path.join(childHome, 'config.toml'), 'utf8');
    assert.match(parentConfig, /^approval_policy = "on-request"$/m);
    assert.match(childConfig, /^approval_policy = "never"$/m);
    assert.equal(childConfig.replace('approval_policy = "never"', 'approval_policy = "on-request"'), parentConfig);
    const rootsLine = `writable_roots = [${JSON.stringify(sandbox.deps.handoffDir)}, ${JSON.stringify(ioDir)}]`;
    assert.ok(parentConfig.split('\n').includes(rootsLine));
    assert.match(childConfig, /^sandbox_mode = "workspace-write"$/m);
    assert.match(childConfig, /^network_access = false$/m);
    for (const config of [parentConfig, childConfig]) {
      assert.match(config, /^\[features\]\napps = false$/m);
      assert.equal((config.match(/^\[features\]$/gm) || []).length, 1);
    }

    // 案内: 親には member の使い方と入出力フォルダ、子には member の案内が無い。
    const parentGuide = fs.readFileSync(path.join(parentHome, 'AGENTS.md'), 'utf8');
    const childGuide = fs.readFileSync(path.join(childHome, 'AGENTS.md'), 'utf8');
    assert.match(parentGuide, /`member start`/);
    assert.match(parentGuide, /`member status`/);
    assert.ok(parentGuide.includes(`\`${ioDir}\``));
    assert.equal(childGuide.includes('member start'), false);
    assert.equal(childGuide.includes('member status'), false);
    assert.ok(childGuide.includes(`${path.join(childHome, 'vk-task-ops')} <git|gh|prepare>`));

    // 使われなければ、入出力フォルダも一緒に回収される。
    assert.equal(result.discard(), true);
    assert.equal(fs.existsSync(parentHome), false);
    assert.equal(fs.existsSync(ioDir), false);
  } finally {
    sandbox.cleanup();
  }
});

test('親の範囲: 親の sandbox と作業フォルダがランチャーに固定され、read-only の親や、サブフォルダで起動した親は、子を親より広い範囲では起動できない', async () => {
  const sandbox = createSandbox();
  try {
    const subDir = path.join(sandbox.repo, 'sub');
    fs.mkdirSync(subDir);
    const waitForExit = async (home, id) => {
      for (let i = 0; i < 100 && !fs.existsSync(path.join(home, 'member-runs', id, 'exit')); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    };
    const startArgs = ['member', 'start', '--engine', 'codex', '--prompt', 'prompt.md', '--schema', 'schema.json', '--out', 'out.json'];
    const ops = (launcher, cwd, ...args) => childProcess.spawnSync(launcher, args, { cwd, env: { ...process.env }, encoding: 'utf8' });
    const stage = (home) => {
      const ioDir = path.join(sandbox.deps.dataDir, 'codex-task-io', path.basename(home));
      fs.writeFileSync(path.join(ioDir, 'prompt.md'), 'work\n');
      fs.writeFileSync(path.join(ioDir, 'schema.json'), '{"type":"object"}');
      return ioDir;
    };

    // 親が read-only: 起動引数の sandboxMode が、そのままランチャーに固定される。--readonly を省略しても、子は read-only。
    const resolved = resolveCodexTaskPolicyLaunchOptions('codex', { approvalPolicy: 'never', sandboxMode: 'read-only', codexPolicy: { preset: 'orchestrated-task' } }, sandbox.deps);
    assert.equal(resolved.ok, true, resolved.error);
    const readOnlyHome = resolved.options.codexPolicyHome;
    assert.equal(launcherAssignments(path.join(readOnlyHome, 'vk-task-ops')).VK_TASK_PARENT_SANDBOX, 'read-only');
    stage(readOnlyHome);
    const started = ops(path.join(readOnlyHome, 'vk-task-ops'), sandbox.repo, ...startArgs);
    assert.equal(started.status, 0, started.stderr);
    await waitForExit(readOnlyHome, /^MEMBER_ID=([0-9a-f]{24})$/m.exec(started.stdout)[1]);
    const recorded = JSON.parse(fs.readFileSync(sandbox.codexRecord, 'utf8'));
    assert.deepEqual(recorded.args.slice(5, 7), ['-s', 'read-only']);
    assert.ok(recorded.args.includes('--ignore-rules'));
    // sandboxMode を省略した親は workspace-write、不正な値は準備の段階で拒否される。
    const omitted = resolveCodexTaskPolicyLaunchOptions('codex', { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } }, sandbox.deps);
    assert.equal(launcherAssignments(path.join(omitted.options.codexPolicyHome, 'vk-task-ops')).VK_TASK_PARENT_SANDBOX, 'workspace-write');
    assert.equal(prepare(sandbox, { sandboxMode: 'danger-full-access' }).ok, false);

    // 親をサブフォルダで起動した: 作業フォルダがサブフォルダに固定され、ルートで入口を呼んでも子は起動しない。
    const narrow = prepare(sandbox, { cwd: subDir });
    assert.equal(narrow.ok, true, narrow.error);
    assert.equal(launcherAssignments(path.join(narrow.home, 'vk-task-ops')).VK_TASK_PARENT_CWD, fs.realpathSync(subDir));
    const ioDir = stage(narrow.home);
    const rejected = ops(path.join(narrow.home, 'vk-task-ops'), sandbox.repo, ...startArgs);
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /must run inside the parent working directory/);
    assert.equal(fs.existsSync(path.join(ioDir, 'out.json')), false);
    // サブフォルダ（親の起動 cwd そのもの）から呼べば起動でき、子の -C は親の起動 cwd になる。
    const fromSub = ops(path.join(narrow.home, 'vk-task-ops'), subDir, ...startArgs);
    assert.equal(fromSub.status, 0, fromSub.stderr);
    await waitForExit(narrow.home, /^MEMBER_ID=([0-9a-f]{24})$/m.exec(fromSub.stdout)[1]);
    const narrowRecord = JSON.parse(fs.readFileSync(sandbox.codexRecord, 'utf8'));
    assert.equal(narrowRecord.args[narrowRecord.args.indexOf('-C') + 1], fs.realpathSync(subDir));
  } finally {
    sandbox.cleanup();
  }
});

test('親の起動 cwd が親自身の書き込み先（引き継ぎ用フォルダ・入出力フォルダ・一時フォルダ）の中にあるときは、member を有効にせず（子用フォルダ・member 設定を作らず）、入口が member を拒否する。通常のリポジトリ配下では有効', () => {
  const sandbox = createSandbox();
  try {
    const makeRepo = (dir) => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      childProcess.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      childProcess.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/vektor-inc/vk-terminals.git'], { cwd: dir });
      return fs.realpathSync(dir);
    };
    const launchName = 'a'.repeat(24);
    const tmpRoot = path.join(sandbox.root, 'tmp-root');
    fs.mkdirSync(tmpRoot, { mode: 0o700 });
    // /tmp → /private/tmp のようなリンクの先も、実パスで比べる。
    const tmpLink = path.join(sandbox.root, 'tmp-link');
    fs.symlinkSync(tmpRoot, tmpLink);
    fs.mkdirSync(sandbox.deps.handoffDir, { mode: 0o700 });
    fs.mkdirSync(path.join(sandbox.deps.dataDir, 'codex-task-io'), { recursive: true, mode: 0o700 });
    const cases = [
      ['引き継ぎ用フォルダ配下', makeRepo(path.join(sandbox.deps.handoffDir, 'repo'))],
      ['一時フォルダ配下', makeRepo(path.join(tmpRoot, 'repo'))],
    ];
    for (const [label, cwd] of cases) {
      const result = prepare(sandbox, { cwd, randomId: () => launchName, tmpRoots: [tmpLink] });
      assert.equal(result.ok, true, `${label}: ${result.error}`);
      assert.deepEqual(fs.readdirSync(result.home).sort(), HOME_ENTRIES.filter((name) => !name.startsWith('member')), label);
      const assignments = launcherAssignments(path.join(result.home, 'vk-task-ops'));
      for (const name of ['VK_TASK_CODEX', 'VK_TASK_MEMBER_HOME', 'VK_TASK_MEMBER_IO', 'VK_TASK_MEMBER_RUNS', 'VK_TASK_PARENT_CWD', 'VK_TASK_PARENT_SANDBOX']) assert.equal(assignments[name], '', `${label}: ${name}`);
      assert.equal(fs.readFileSync(path.join(result.home, 'AGENTS.md'), 'utf8').includes('member start'), false, label);
      assert.ok(fs.readFileSync(path.join(result.home, 'config.toml'), 'utf8').split('\n').includes(`writable_roots = [${JSON.stringify(sandbox.deps.handoffDir)}]`), label);
      const rejected = childProcess.spawnSync(path.join(result.home, 'vk-task-ops'), ['member', 'start', '--engine', 'codex', '--prompt', 'p.md', '--schema', 's.json', '--out', 'o.json'], { cwd, env: { ...process.env }, encoding: 'utf8' });
      assert.equal(rejected.status, 2, label);
      assert.match(rejected.stderr, /member is not available from this launcher/, label);
      assert.equal(result.discard(), true);
    }
    // 通常のリポジトリ（書き込み先の外の祖先だけ）では有効。
    const normal = prepare(sandbox, { tmpRoots: [tmpLink] });
    assert.equal(normal.ok, true, normal.error);
    assert.deepEqual(fs.readdirSync(normal.home).sort(), HOME_ENTRIES);
    assert.equal(launcherAssignments(path.join(normal.home, 'vk-task-ops')).VK_TASK_PARENT_CWD, fs.realpathSync(sandbox.repo));
  } finally {
    sandbox.cleanup();
  }
});

test('親の起動 cwd が ..repo のように .. で始まる普通のフォルダ名の配下でも、書き込み先の中として member を無効にする', () => {
  const sandbox = createSandbox();
  try {
    const makeRepo = (dir) => {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      childProcess.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
      childProcess.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/vektor-inc/vk-terminals.git'], { cwd: dir });
      return fs.realpathSync(dir);
    };
    const tmpRoot = path.join(sandbox.root, 'tmp-root');
    fs.mkdirSync(tmpRoot, { mode: 0o700 });
    fs.mkdirSync(sandbox.deps.handoffDir, { mode: 0o700 });
    const cases = [
      ['引き継ぎ用フォルダ配下の ..repo', makeRepo(path.join(sandbox.deps.handoffDir, '..repo'))],
      ['引き継ぎ用フォルダ配下の ..repo の子', makeRepo(path.join(sandbox.deps.handoffDir, '..repo', 'child'))],
      ['一時フォルダ配下の ..repo', makeRepo(path.join(tmpRoot, '..repo'))],
      ['一時フォルダ配下の ..repo の子', makeRepo(path.join(tmpRoot, '..repo', 'child'))],
    ];
    for (const [label, cwd] of cases) {
      const result = prepare(sandbox, { cwd, tmpRoots: [tmpRoot] });
      assert.equal(result.ok, true, `${label}: ${result.error}`);
      assert.deepEqual(fs.readdirSync(result.home).sort(), HOME_ENTRIES.filter((name) => !name.startsWith('member')), label);
      assert.equal(launcherAssignments(path.join(result.home, 'vk-task-ops')).VK_TASK_PARENT_CWD, '', label);
      assert.equal(result.discard(), true);
    }
  } finally {
    sandbox.cleanup();
  }
});

test('親へ渡す TMPDIR は判定に使った一時フォルダと同じ1つの値（シェル側の TMPDIR に左右されない）。新規作成と再起動の両方で起動コマンドに入る', () => {
  const sandbox = createSandbox();
  try {
    const tmpRoot = path.join(sandbox.root, 'tmp-root');
    fs.mkdirSync(tmpRoot, { mode: 0o700 });
    const tmpLink = path.join(sandbox.root, 'tmp-link');
    fs.symlinkSync(tmpRoot, tmpLink);
    const { tmpRoots: _unused, ...deps } = sandbox.deps;
    // 判定に使う TMPDIR の実パスが、そのまま返る（リンクは解決される）。
    const prepared = prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...deps, tmpdir: tmpLink });
    assert.equal(prepared.ok, true, prepared.error);
    assert.equal(prepared.tmpdir, fs.realpathSync(tmpRoot));
    assert.equal(prepared.discard(), true);
    // 安全でない TMPDIR（相対・単一引用符）は使わず /tmp の実パスに倒す。
    for (const bad of ['relative', "/tmp/a'b"]) {
      const fallback = prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', ...deps, tmpdir: bad });
      assert.equal(fallback.tmpdir, fs.realpathSync('/tmp'), bad);
      assert.equal(fallback.discard(), true);
    }
    // 新規作成も再起動も、同じ値が起動コマンドに入る。
    const request = { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } };
    const before = process.env.TMPDIR;
    process.env.TMPDIR = tmpLink;
    try {
      const fromNewPane = resolveCodexTaskPolicyLaunchOptions('codex', request, deps);
      const fromRestart = resolveCodexTaskPolicyLaunchOptions('codex', { termId: '3', expectedGeneration: 1, cwd: sandbox.repo, engine: 'codex', ...request }, deps);
      for (const resolved of [fromNewPane, fromRestart]) {
        assert.equal(resolved.ok, true, resolved.error);
        assert.equal(resolved.options.codexPolicyTmpdir, fs.realpathSync(tmpRoot));
        const command = buildEngineAwareLaunchCommand('codex', undefined, resolved.options).command;
        assert.ok(command.startsWith(`TMPDIR='${fs.realpathSync(tmpRoot)}' CODEX_HOME='${resolved.options.codexPolicyHome}' codex`), command);
        assert.equal(resolved.discard(), true);
      }
    } finally {
      if (before === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = before;
    }
  } finally {
    sandbox.cleanup();
  }
});

test('生成: codex が見つからなければメンバー起動だけを持たず（入出力フォルダ・子用フォルダを作らない）、途中で失敗したら入出力フォルダも残さない', () => {
  const sandbox = createSandbox();
  try {
    // codex を含まない探索先（node と、通常の探索で見つかる git へのリンクだけを置く）。
    const bin = path.join(sandbox.root, 'no-codex-bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const gitCandidate = sandbox.toolDirs.map((dir) => path.join(dir, 'git')).find((candidate) => fs.existsSync(candidate));
    fs.symlinkSync(gitCandidate, path.join(bin, 'git'));
    const result = prepare(sandbox, { toolDirs: [bin] });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(fs.readdirSync(result.home).sort(), HOME_ENTRIES.filter((name) => !name.startsWith('member')));
    assert.equal(fs.existsSync(path.join(sandbox.deps.dataDir, 'codex-task-io')), false);
    assert.equal(launcherAssignments(path.join(result.home, 'vk-task-ops')).VK_TASK_CODEX, '');
    assert.equal(fs.readFileSync(path.join(result.home, 'AGENTS.md'), 'utf8').includes('member start'), false);
    assert.ok(fs.readFileSync(path.join(result.home, 'config.toml'), 'utf8').split('\n').includes(`writable_roots = [${JSON.stringify(sandbox.deps.handoffDir)}]`));

    // 準備の途中で失敗した場合は、作った入出力フォルダも片付ける。
    const failed = prepare(sandbox, { remoteBase: 'relative/path' });
    assert.equal(failed.ok, false);
    assert.deepEqual(fs.readdirSync(path.join(sandbox.deps.dataDir, 'codex-task-io')), []);
    assert.deepEqual(launchHomes(sandbox).length, 1);
  } finally {
    sandbox.cleanup();
  }
});

test('ランチャー: 親のランチャーは member start/status を通し、子のランチャーは member を拒否する（入れ子の起動を防ぐ）。--repo・絶対パス・..・別リポジトリも拒否', async () => {
  const sandbox = createSandbox();
  try {
    const launch = prepare(sandbox);
    assert.equal(launch.ok, true, launch.error);
    const ioDir = path.join(sandbox.deps.dataDir, 'codex-task-io', path.basename(launch.home));
    const parentLauncher = path.join(launch.home, 'vk-task-ops');
    const childLauncher = path.join(launch.home, 'member', 'vk-task-ops');
    const ops = (launcher, cwd, ...args) => childProcess.spawnSync(launcher, args, { cwd, env: { ...process.env, GIT_DIR: '/nonexistent', NODE_OPTIONS: '' }, encoding: 'utf8' });
    fs.writeFileSync(path.join(ioDir, 'prompt.md'), 'work please\n');
    fs.writeFileSync(path.join(ioDir, 'schema.json'), '{"type":"object"}');
    const startArgs = ['member', 'start', '--engine', 'codex', '--prompt', 'prompt.md', '--schema', 'schema.json', '--out', 'out.json'];

    // 子のランチャーでは member が使えない。一方で Git の閲覧など他の操作は同じ拘束先で使える。
    const nested = ops(childLauncher, sandbox.repo, ...startArgs);
    assert.equal(nested.status, 2);
    assert.match(nested.stderr, /member is not available from this launcher/);
    assert.equal(ops(childLauncher, sandbox.repo, 'member', 'status', '0123456789abcdef01234567').status, 2);
    assert.equal(fs.existsSync(path.join(ioDir, 'out.json')), false);
    assert.equal(ops(childLauncher, sandbox.repo, 'git', 'status', '--short').status, 0);
    assert.equal(ops(childLauncher, path.join(sandbox.root, 'elsewhere-missing'), 'git', 'status').status !== 0, true);

    // 親のランチャーでも、許可外の指定・別リポジトリは起動前に拒否される。
    const stranger = path.join(sandbox.root, 'stranger');
    fs.mkdirSync(stranger);
    childProcess.execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: stranger });
    childProcess.execFileSync('git', ['remote', 'add', 'origin', 'https://github.com/other/repo.git'], { cwd: stranger });
    for (const [cwd, args] of [
      [sandbox.repo, [...startArgs, '--repo', stranger]],
      [sandbox.repo, [...startArgs, '--dangerously-bypass-approvals-and-sandbox']],
      [sandbox.repo, startArgs.map((token) => (token === 'prompt.md' ? '/etc/passwd' : token))],
      [sandbox.repo, startArgs.map((token) => (token === 'out.json' ? '../out.json' : token))],
      [sandbox.repo, startArgs.map((token) => (token === 'codex' ? 'claude' : token))],
      [stranger, startArgs],
    ]) {
      const rejected = ops(parentLauncher, cwd, ...args);
      assert.equal(rejected.status, 2, args.join(' '));
    }
    assert.equal(fs.existsSync(sandbox.codexRecord), false);
    assert.equal(fs.existsSync(path.join(ioDir, 'out.json')), false);
    assert.deepEqual(fs.readdirSync(path.join(launch.home, 'member-runs')), []);

    // 親のランチャー: 起動 → 状態確認。子は子用の CODEX_HOME と親と同じ sandbox の指定で起動する。
    const started = ops(parentLauncher, sandbox.repo, ...startArgs);
    assert.equal(started.status, 0, started.stderr);
    const id = /^MEMBER_ID=([0-9a-f]{24})$/m.exec(started.stdout)[1];
    for (let i = 0; i < 100 && !fs.existsSync(path.join(launch.home, 'member-runs', id, 'exit')); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    const status = ops(parentLauncher, sandbox.repo, 'member', 'status', id);
    assert.equal(status.status, 0, status.stderr);
    assert.match(status.stdout, /^STATE=exited$/m);
    assert.match(status.stdout, /^EXIT_CODE=0$/m);
    assert.equal(fs.readFileSync(path.join(ioDir, 'out.json'), 'utf8'), '{"ok":true}');
    const recorded = JSON.parse(fs.readFileSync(sandbox.codexRecord, 'utf8'));
    assert.equal(recorded.env.CODEX_HOME, path.join(launch.home, 'member'));
    assert.equal(recorded.input, 'work please\n');
    assert.deepEqual(recorded.args.slice(0, 7), ['-a', 'never', 'exec', '-C', fs.realpathSync(sandbox.repo), '-s', 'workspace-write']);
    assert.equal(recorded.args.some((arg) => /dangerously|danger-full-access/.test(arg)), false);
    // 親の環境変数（NODE_OPTIONS・GIT_DIR）は子へ渡らない。
    assert.equal(recorded.env.GIT_DIR, undefined);
    assert.equal(recorded.env.NODE_OPTIONS, undefined);
    // 同じ出力先は再利用できない。
    assert.equal(ops(parentLauncher, sandbox.repo, ...startArgs).status, 2);
  } finally {
    sandbox.cleanup();
  }
});

// ─── 書き込める範囲の事前確認（issue #446。POST /api/codex-policy-context） ───────────────

const { isWithinDirectory } = require('../utils/codexTaskOps');
const { resolveCodexPolicyContext, buildCodexPolicyContext } = require('../utils/codexTaskPolicy');

const CONTEXT_KEYS = ['effectiveWritableRoots', 'preset', 'sandboxMode', 'tmpdir', 'version'];
const CONTEXT_ROOT_KEYS = ['path', 'scope', 'source'];

// 実際の config.toml の writable_roots（TOML の文字列配列）を取り出す。
function readWritableRoots(home) {
  const line = fs.readFileSync(path.join(home, 'config.toml'), 'utf8').split('\n').find((candidate) => candidate.startsWith('writable_roots = '));
  return JSON.parse(line.slice('writable_roots = '.length));
}

// 一覧のどれかの配下に入っているか。
const isCovered = (context, target) => context.effectiveWritableRoots.some((root) => isWithinDirectory(target, root.path));

// TMPDIR 用のリンクつき一時フォルダを足した試験環境。
function createContextSandbox() {
  const sandbox = createSandbox();
  const tmpRoot = path.join(sandbox.root, 'tmp-root');
  fs.mkdirSync(tmpRoot, { mode: 0o700 });
  const tmpLink = path.join(sandbox.root, 'tmp-link');
  fs.symlinkSync(tmpRoot, tmpLink);
  return { sandbox, tmpLink, tmpReal: fs.realpathSync(tmpRoot) };
}

test('書き込める範囲: 事前確認と実際の準備で同じ tmpdir と一覧になり、実際の config.toml・TMPDIR・cwd・/tmp が一覧のどれかの配下に入る（メンバー起動あり）', () => {
  const { sandbox, tmpLink, tmpReal } = createContextSandbox();
  try {
    const deps = { ...sandbox.deps, tmpdir: tmpLink, tmpRoots: [tmpLink] };
    const dry = prepare(sandbox, { ...deps, dryRun: true });
    assert.equal(dry.ok, true, dry.error);
    const real = prepare(sandbox, deps);
    assert.equal(real.ok, true, real.error);
    // tmpdir は完全一致（リンクは実パスに解決される）。
    assert.equal(dry.context.tmpdir, tmpReal);
    assert.equal(dry.context.tmpdir, real.context.tmpdir);
    assert.equal(dry.tmpdir, real.tmpdir);
    // 事前確認と実際の準備は、同じ関数から同じ一覧を作る。
    assert.deepEqual(dry.context, real.context);
    assert.deepEqual(dry.context.effectiveWritableRoots.map((root) => root.source), ['workspace', 'tmp', 'tmpdir', 'handoff', 'task-ops-repository', 'task-ops-git-dir', 'member-io']);
    // 固定入口の書き込み先（git add / commit の .git、prepare worktree の <ルート>/.claude/worktrees）も一覧の配下に入る。
    const repoReal = fs.realpathSync(sandbox.repo);
    assert.deepEqual(dry.context.effectiveWritableRoots.filter((root) => root.source.startsWith('task-ops')).map((root) => root.path), [repoReal, path.join(repoReal, '.git')]);
    for (const target of [path.join(repoReal, '.git', 'index'), path.join(repoReal, '.git', 'worktrees'), path.join(repoReal, '.claude', 'worktrees')]) {
      assert.ok(isCovered(dry.context, target), target);
    }
    const memberIo = dry.context.effectiveWritableRoots.find((root) => root.source === 'member-io');
    assert.equal(memberIo.scope, 'child-created-at-launch');
    assert.equal(memberIo.path, path.join(fs.realpathSync(sandbox.deps.dataDir), 'codex-task-io'));
    // 実際の起動で書き込める場所は、全て事前確認の一覧のどれかの配下に入る。
    const writableRoots = readWritableRoots(real.home);
    assert.equal(writableRoots.length, 2);
    for (const target of [...writableRoots, fs.realpathSync(sandbox.repo), fs.realpathSync('/tmp'), real.tmpdir]) {
      assert.ok(isCovered(dry.context, target), target);
    }
    // 起動コマンドに入る TMPDIR は tmpdir と同じ。
    const resolved = resolveCodexTaskPolicyLaunchOptions('codex', { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } }, deps);
    assert.equal(resolved.ok, true, resolved.error);
    assert.equal(resolved.options.codexPolicyTmpdir, dry.context.tmpdir);
    assert.ok(buildEngineAwareLaunchCommand('codex', undefined, resolved.options).command.startsWith(`TMPDIR='${dry.context.tmpdir}' CODEX_HOME=`));
    assert.equal(real.discard(), true);
    assert.equal(resolved.discard(), true);
  } finally {
    sandbox.cleanup();
  }
});

test('書き込める範囲: メンバー起動が無効な配置（codex が無い・cwd が書き込み先の中）では member-io を出さず、実際の準備と一致する', () => {
  const { sandbox, tmpLink } = createContextSandbox();
  try {
    // codex が見つからない配置。
    const bin = path.join(sandbox.root, 'no-codex-bin');
    fs.mkdirSync(bin);
    fs.symlinkSync(process.execPath, path.join(bin, 'node'));
    const gitCandidate = sandbox.toolDirs.map((dir) => path.join(dir, 'git')).find((candidate) => fs.existsSync(candidate));
    fs.symlinkSync(gitCandidate, path.join(bin, 'git'));
    const noCodex = { ...sandbox.deps, tmpdir: tmpLink, tmpRoots: [tmpLink], toolDirs: [bin] };
    // cwd が一時フォルダの中にある配置（作業フォルダは試験用の一時フォルダの中なので、TMPDIR をその親にする）。
    const cwdInTmp = { ...sandbox.deps, tmpdir: path.dirname(sandbox.root), tmpRoots: [path.dirname(sandbox.root)] };
    for (const [label, deps] of [['codex 無し', noCodex], ['cwd が一時フォルダの中', cwdInTmp]]) {
      const dry = prepare(sandbox, { ...deps, dryRun: true });
      assert.equal(dry.ok, true, `${label}: ${dry.error}`);
      const real = prepare(sandbox, deps);
      assert.equal(real.ok, true, `${label}: ${real.error}`);
      assert.equal(dry.context.effectiveWritableRoots.some((root) => root.source === 'member-io'), false, label);
      // メンバー起動が無い配置でも、起動コマンドの TMPDIR は context.tmpdir と同じ。
      const launched = resolveCodexTaskPolicyLaunchOptions('codex', { approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } }, deps);
      assert.equal(launched.ok, true, `${label}: ${launched.error}`);
      assert.equal(launched.options.codexPolicyTmpdir, dry.context.tmpdir, label);
      assert.ok(buildEngineAwareLaunchCommand('codex', undefined, launched.options).command.startsWith(`TMPDIR='${dry.context.tmpdir}' CODEX_HOME=`), label);
      assert.equal(launched.discard(), true);
      assert.deepEqual(dry.context, real.context, label);
      for (const target of [...readWritableRoots(real.home), fs.realpathSync(sandbox.repo), real.tmpdir]) {
        assert.ok(isCovered(dry.context, target), `${label}: ${target}`);
      }
      assert.equal(real.discard(), true);
    }
    // 事前確認では入出力フォルダの親も作らない。
    assert.equal(fs.existsSync(path.join(sandbox.deps.dataDir, 'codex-task-io')), false);
  } finally {
    sandbox.cleanup();
  }
});

test('書き込める範囲: read-only ではシェルの書き込み先が外れ、固定入口とメンバーの入出力フォルダだけが残る（Codex の sandbox の実挙動）', () => {
  const { sandbox, tmpLink } = createContextSandbox();
  try {
    const deps = { ...sandbox.deps, tmpdir: tmpLink, tmpRoots: [tmpLink] };
    const result = resolveCodexPolicyContext({ approvalPolicy: 'never', sandboxMode: 'read-only', codexPolicy: { preset: 'orchestrated-task' } }, deps);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.codexPolicyContext.sandboxMode, 'read-only');
    // シェルからの cwd・/tmp・TMPDIR・引き継ぎ先は外れる。固定入口（sandbox の外で動く）の書き込み先とメンバーの入出力フォルダは残る。
    assert.deepEqual(result.codexPolicyContext.effectiveWritableRoots.map((root) => root.source), ['task-ops-repository', 'task-ops-git-dir', 'member-io']);
    // sandboxMode 省略時は、実際の起動と同じ workspace-write。
    const omitted = resolveCodexPolicyContext({ approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' } }, deps);
    assert.equal(omitted.codexPolicyContext.sandboxMode, 'workspace-write');
  } finally {
    sandbox.cleanup();
  }
});

test('書き込める範囲: linked worktree から起動しても、固定入口の Git 管理領域は元のクローンの共通 .git を指す', () => {
  const { sandbox, tmpLink } = createContextSandbox();
  try {
    sandbox.git('-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
    const linked = path.join(sandbox.root, 'linked');
    sandbox.git('worktree', 'add', '-q', '-b', 'linked-branch', linked);
    const linkedReal = fs.realpathSync(linked);
    const deps = { ...sandbox.deps, cwd: linked, tmpdir: tmpLink, tmpRoots: [tmpLink] };
    const dry = prepare(sandbox, { ...deps, dryRun: true });
    assert.equal(dry.ok, true, dry.error);
    const real = prepare(sandbox, deps);
    assert.equal(real.ok, true, real.error);
    assert.deepEqual(dry.context, real.context);
    const byName = Object.fromEntries(dry.context.effectiveWritableRoots.map((root) => [root.source, root.path]));
    assert.equal(byName['task-ops-repository'], linkedReal);
    // 共通 .git は元のクローンにあり、リンクした作業フォルダの外。重複ではなく別の行として残す。
    assert.equal(byName['task-ops-git-dir'], path.join(fs.realpathSync(sandbox.repo), '.git'));
    assert.equal(isWithinDirectory(byName['task-ops-git-dir'], byName['task-ops-repository']), false);
    assert.equal(real.discard(), true);
  } finally {
    sandbox.cleanup();
  }
});

test('書き込める範囲: 事前確認では専用フォルダ・入出力フォルダを作らない（引き継ぎ先とポリシー用の親フォルダは作る）', () => {
  const { sandbox, tmpLink } = createContextSandbox();
  try {
    const result = resolveCodexPolicyContext({ codexPolicy: { preset: 'orchestrated-task' } }, { ...sandbox.deps, tmpdir: tmpLink, tmpRoots: [tmpLink] });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(fs.readdirSync(sandbox.policyBase), []);
    assert.equal(fs.existsSync(path.join(sandbox.deps.dataDir, 'codex-task-io')), false);
    assert.equal(fs.existsSync(sandbox.deps.handoffDir), true);
  } finally {
    sandbox.cleanup();
  }
});

test('書き込める範囲: 応答は許可した項目だけで、秘密情報（CODEX_HOME・認証・Git の名前とメール・環境変数・信頼しないプロジェクト）を含まない', () => {
  const { sandbox, tmpLink } = createContextSandbox();
  try {
    fs.writeFileSync(path.join(sandbox.homeDir, '.gitconfig'), '[user]\n\tname = Secret Name\n\temail = secret-mail@example.com\n');
    const result = resolveCodexPolicyContext({ codexPolicy: { preset: 'orchestrated-task' } }, { ...sandbox.deps, tmpdir: tmpLink, tmpRoots: [tmpLink] });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(Object.keys(result).sort(), ['codexPolicyContext', 'ok']);
    const context = result.codexPolicyContext;
    assert.deepEqual(Object.keys(context).sort(), CONTEXT_KEYS);
    assert.equal(context.version, 1);
    for (const root of context.effectiveWritableRoots) assert.deepEqual(Object.keys(root).sort(), CONTEXT_ROOT_KEYS);
    const serialized = JSON.stringify(result);
    for (const secret of [sandbox.personalCodexHome, 'auth.json', 'Secret Name', 'secret-mail', 'codex-task-policy', 'untrusted', 'CODEX_HOME']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    // 入力のオブジェクトを丸ごと展開しない（余計な項目を渡しても出てこない）。
    const extra = buildCodexPolicyContext({ preset: 'orchestrated-task', sandboxMode: 'workspace-write', tmpdir: '/tmp', cwd: '/x', handoffDir: '/h', memberIoBaseDir: null, fs, leaked: 'leak-value', env: { A: 'leak-value' } });
    assert.equal(JSON.stringify(extra).includes('leak-value'), false);
  } finally {
    sandbox.cleanup();
  }
});

test('書き込める範囲: codexPolicy 無し・cwd 無しは 400、ポリシーを用意できないときは 503', () => {
  const { sandbox, tmpLink } = createContextSandbox();
  try {
    const deps = { ...sandbox.deps, tmpdir: tmpLink, tmpRoots: [tmpLink] };
    assert.deepEqual(resolveCodexPolicyContext({}, deps), { ok: false, status: 400, error: 'codexPolicy required' });
    assert.deepEqual(resolveCodexPolicyContext({ codexPolicy: { preset: 'full-access' } }, deps), { ok: false, status: 400, error: 'invalid codexPolicy preset' });
    assert.deepEqual(resolveCodexPolicyContext({ codexPolicy: { preset: 'orchestrated-task' } }, { ...deps, cwd: undefined }), { ok: false, status: 400, error: 'codexPolicy requires cwd' });
    const plain = path.join(sandbox.root, 'plain');
    fs.mkdirSync(plain);
    const unavailable = resolveCodexPolicyContext({ codexPolicy: { preset: 'orchestrated-task' } }, { ...deps, cwd: plain });
    assert.equal(unavailable.status, 503);
    assert.match(unavailable.error, /^codex task policy unavailable: /);
  } finally {
    sandbox.cleanup();
  }
});

test('POST /api/codex-policy-context: Codex 以外は 400。ペインの作成・AI の停止・画面側の処理を呼ばず、既存 API の応答は変えない', () => {
  const start = mainSource.indexOf("url.pathname === '/api/codex-policy-context'");
  const handler = mainSource.slice(start, mainSource.indexOf("url.pathname === '/api/restart-agent'"));
  assert.ok(start > 0);
  assert.ok(handler.includes('isForbiddenOrigin(req)'));
  assert.ok(handler.includes("error: 'engine must be \"codex\"'"));
  for (const forbidden of ['webContents.send', 'pendingNewPaneCallbacks', 'restartAgentInTerminal', 'ptyProcess', 'resolveCodexLaunchOptions', 'discard']) {
    assert.equal(handler.includes(forbidden), false, forbidden);
  }
  // 認証はルーティングの前段で全 API に掛かる（この API だけ外れない）。
  assert.ok(mainSource.indexOf('isAuthorizedRequest(req, API_TOKEN)') < start);
  // 実際の起動（new-pane）の応答には値を足さない。
  const newPane = mainSource.slice(mainSource.indexOf("url.pathname === '/api/new-pane'"), start);
  assert.ok(newPane.includes('JSON.stringify({ ok: true, termId: result.termId })'));
  assert.equal(newPane.includes('codexPolicyContext'), false);
});
