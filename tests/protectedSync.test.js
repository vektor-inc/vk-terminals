// 固定対応表と OS 制限の両方を通る同期、および書き込み前の拒否を検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { runTaskCommand, parseTaskCommand, restrictWrites, getProtectedSyncCapabilities, PROTECTED_SYNC_TARGETS, buildMemberCodexArgs, readBinding } = require('../utils/codexTaskOps');
const { CODEX_TASK_POLICY_PRESETS, prepareCodexTaskPolicyHome } = require('../utils/codexTaskPolicy');
const [target] = PROTECTED_SYNC_TARGETS;
const gitPath = fs.realpathSync(cp.execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim());
function git(cwd, ...args) { return cp.execFileSync(gitPath, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }); }
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'protected-sync-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'remote', 'add', 'origin', `https://github.com/${target.repo}.git`);
  for (const relative of [target.source, target.target]) {
    fs.mkdirSync(path.dirname(path.join(repo, relative)), { recursive: true });
    fs.writeFileSync(path.join(repo, relative), 'original\n');
  }
  git(repo, 'add', '.');
  git(repo, 'commit', '-qm', 'initial');
  const worktree = path.join(root, 'worktree');
  git(repo, 'worktree', 'add', '-qb', 'work/test', worktree);
  const home = path.join(root, 'home');
  fs.mkdirSync(home);
  const config = path.join(root, 'author');
  fs.writeFileSync(config, '[user]\nname = Test\nemail = test@example.com\n');
  const env = { VK_TASK_ROOT: repo, VK_TASK_REPO: target.repo, VK_TASK_GIT: gitPath, VK_TASK_HOME: home, VK_TASK_GITCONFIG: config, VK_TASK_GH: '/usr/bin/true', VK_TASK_GHCONFIG: home };
  const invoke = (args = ['protected-sync', target.target], extra = {}) => {
    let error = '';
    const status = runTaskCommand(args, { cwd: worktree, env, write: (text) => { error += text; },
      spawnSync: (bin, argv, options) => cp.spawnSync(bin, argv, { ...options, stdio: 'pipe' }), ...extra });
    return { status, error };
  };
  return { root, repo, worktree, env, invoke, source: path.join(worktree, target.source), destination: path.join(worktree, target.target) };
}
const realCapability = getProtectedSyncCapabilities();

test('対応表は深く固定され、登録先以外・追加引数・パストラバーサルを拒否する', () => {
  assert.ok(Object.isFrozen(PROTECTED_SYNC_TARGETS));
  assert.ok(Object.isFrozen(target));
  for (const value of ['.git/config', '.codex/config.toml', '../' + target.target, '/' + target.target, target.target + '/..', 'alias/SKILL.md']) {
    assert.equal(parseTaskCommand(['protected-sync', value]).ok, false, value);
  }
  assert.equal(parseTaskCommand(['protected-sync', target.target, target.source]).ok, false);
  assert.equal(parseTaskCommand(['protected-sync', target.target]).ok, true);
});

test('能力照会は副作用なく、実行と同じ OS 制限の起動成否を返す', () => {
  const calls = [];
  const fakeFs = new Proxy(fs, { get(object, property) {
    if (/^(mkdir|write|rename|unlink|open)/.test(property)) return () => { throw new Error('unexpected mutation'); };
    return object[property];
  } });
  const available = getProtectedSyncCapabilities({ platform: 'darwin', fs: { ...fakeFs, lstatSync: () => ({ isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false, uid: 0, gid: 0, mode: 0o755 }) }, spawnSync: (...args) => { calls.push(args); return { status: 0 }; } });
  assert.equal(available.available, true);
  assert.equal(available.reason, null);
  assert.equal(calls.length, 1);
  assert.deepEqual(available.targets, PROTECTED_SYNC_TARGETS);
  for (const platform of ['win32', 'freebsd']) assert.equal(getProtectedSyncCapabilities({ platform }).available, false);
  assert.equal(getProtectedSyncCapabilities({ platform: 'darwin', spawnSync: () => ({ status: 1 }) }).available, false);
});

test('Linux の bwrap は絶対パス・root 所有・他者書き込み不可を検証し、実パスだけ bind する', () => {
  const stat = { uid: 0, gid: 0, mode: 0o755, dev: 1, ino: 1, isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false };
  const fakeFs = { lstatSync: () => stat, statSync: () => stat, realpathSync: () => '/real/parent' };
  const command = restrictWrites({ bin: '/trusted/node', args: ['-e', 'fixed'], allowWrite: ['/alias'] }, { platform: 'linux', fs: fakeFs });
  assert.equal(command.bin, '/usr/bin/bwrap');
  assert.deepEqual(command.args, ['--ro-bind', '/', '/', '--dev', '/dev', '--new-session', '--die-with-parent', '--unshare-net', '--bind', '/real/parent', '/real/parent', '--', '/trusted/node', '-e', 'fixed']);
  for (const altered of [{ uid: 1000 }, { mode: 0o777 }]) {
    const untrusted = { ...fakeFs, statSync: () => ({ ...stat, ...altered }) };
    assert.equal(getProtectedSyncCapabilities({ platform: 'linux', fs: untrusted, spawnSync: () => { throw new Error('must not launch'); } }).available, false);
  }
  assert.equal(getProtectedSyncCapabilities({ platform: 'linux', fs: { lstatSync: () => { throw new Error('missing'); } } }).available, false);
  assert.equal(getProtectedSyncCapabilities({ platform: 'linux', fs: fakeFs, spawnSync: () => ({ error: new Error('namespace disabled') }) }).available, false);
});

for (const [name, change] of [
  ['生成元リンク', (f) => { fs.unlinkSync(f.source); fs.symlinkSync(f.destination, f.source); }],
  ['配布先リンク', (f) => { fs.unlinkSync(f.destination); fs.symlinkSync(f.source, f.destination); }],
  ['生成元の途中のフォルダリンク', (f) => { const dir = path.dirname(f.source); fs.renameSync(dir, dir + '-real'); fs.symlinkSync(dir + '-real', dir); }],
  ['途中のフォルダリンク', (f) => { const dir = path.dirname(f.destination); fs.renameSync(dir, dir + '-real'); fs.symlinkSync(dir + '-real', dir); }],
  ['生成元ハードリンク', (f) => fs.linkSync(f.source, path.join(f.root, 'hardlink'))],
  ['配布先ハードリンク', (f) => fs.linkSync(f.destination, path.join(f.root, 'hardlink'))],
  ['未追跡の配布先', (f) => git(f.worktree, 'rm', '--cached', target.target)],
  ['上限超過', (f) => fs.writeFileSync(f.source, Buffer.alloc(256 * 1024 + 1))],
  ['通常ファイル以外', (f) => { fs.unlinkSync(f.source); fs.mkdirSync(f.source); }],
]) {
  test(`書き込み前の拒否: ${name}`, (t) => {
    const f = fixture(t);
    change(f);
    const before = fs.readFileSync(f.destination);
    const result = f.invoke();
    assert.equal(result.status, 2, result.error);
    assert.match(result.error, /task command rejected:/);
    assert.deepEqual(fs.readFileSync(f.destination), before);
    assert.equal(fs.readdirSync(path.dirname(f.destination)).some((name) => name.startsWith('.protected-sync-')), false);
  });
}

test('競合はマーカーでなく index の未解決エントリから拒否する（生成元・配布先）', (t) => {
  const f = fixture(t);
  for (const relative of [target.source, target.target]) {
    const blob = git(f.worktree, 'rev-parse', `HEAD:${relative}`).trim();
    cp.execFileSync(gitPath, ['update-index', '--index-info'], { cwd: f.worktree, input: `0 ${'0'.repeat(40)}\t${relative}\n100644 ${blob} 1\t${relative}\n100644 ${blob} 2\t${relative}\n` });
    assert.match(f.invoke().error, /unresolved index/);
    git(f.worktree, 'reset', '-q', 'HEAD', '--', relative);
  }
});

test('別リポジトリ・未登録 worktree・サブフォルダは拒否する', (t) => {
  const f = fixture(t);
  assert.equal(f.invoke(undefined, { env: { ...f.env, VK_TASK_REPO: 'vektor-inc/other' } }).status, 2);
  assert.equal(f.invoke(undefined, { cwd: path.dirname(f.source) }).status, 2);
  const copied = path.join(f.root, 'copy');
  fs.cpSync(f.worktree, copied, { recursive: true });
  assert.equal(f.invoke(undefined, { cwd: copied }).status, 2);
});

test('Linux 制限が使えない場合は実行せず、配布先を書き換えない', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, 'changed');
  const before = fs.readFileSync(f.destination);
  const result = f.invoke(undefined, { platform: 'linux', fs: new Proxy(fs, { get(object, key) {
    if (key === 'lstatSync') return (file) => { if (file === '/usr/bin/bwrap') throw new Error('missing bwrap'); return fs.lstatSync(file); };
    return object[key];
  } }) });
  assert.equal(result.status, 2);
  assert.match(result.error, /write-restricted execution is not available/);
  assert.deepEqual(fs.readFileSync(f.destination), before);
});

test('読み取り専用メンバーは --ignore-rules により固定入口を使えない', () => {
  const args = buildMemberCodexArgs({ root: '/repo', schemaPath: '/schema', outPath: '/out', model: null, readonly: true });
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('read-only'));
});

for (const member of [false, true]) {
  test(`OS 実機: ${member ? '実装担当' : '親'}の入口で同期・add・commit・push`, { skip: !realCapability.available && realCapability.reason }, (t) => {
    const f = fixture(t);
    // 子入口と同じく member 設定を持たない binding でも同期できる。
    if (!member) Object.assign(f.env, { VK_TASK_CODEX: process.execPath, VK_TASK_MEMBER_HOME: f.root, VK_TASK_MEMBER_IO: f.root, VK_TASK_MEMBER_RUNS: f.root, VK_TASK_PARENT_CWD: f.repo, VK_TASK_PARENT_SANDBOX: 'workspace-write' });
    const remoteBase = path.join(f.root, 'remote');
    const remote = path.join(remoteBase, target.repo + '.git');
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    git(f.repo, 'init', '--bare', '-q', '-b', 'main', remote);
    git(f.repo, 'push', '-q', remote, 'main');
    f.env.VK_TASK_REMOTE_BASE = remoteBase;
    const entry = path.join(f.root, member ? 'member-ops.js' : 'parent-ops.js');
    fs.copyFileSync(path.join(__dirname, '../utils/codexTaskOps.js'), entry);
    const launcher = path.join(f.root, 'vk-task-ops');
    const binding = { ...readBinding(f.env), ...(!member ? { codex: process.execPath, memberHome: f.root, memberIo: f.root, memberRuns: f.root, parentCwd: f.repo, parentSandbox: 'workspace-write' } : {}) };
    fs.writeFileSync(launcher, CODEX_TASK_POLICY_PRESETS['orchestrated-task'].renderLauncher({ envPath: '/usr/bin/env', nodePath: process.execPath, opsScriptPath: entry, launcherPath: launcher, memberEnabled: !member, binding }), { mode: 0o500 });
    const invokeEntry = (args) => {
      const result = cp.spawnSync(launcher, args, { cwd: f.worktree, env: {}, encoding: 'utf8' });
      return { status: result.status, error: result.stderr };
    };
    const bytes = Buffer.from([0, 255, 10, 13, 65]);
    fs.writeFileSync(f.source, bytes);
    assert.deepEqual(invokeEntry(['protected-sync', target.target]), { status: 0, error: '' });
    assert.deepEqual(fs.readFileSync(f.destination), bytes);
    assert.equal(invokeEntry(['git', 'add', target.target]).status, 0);
    assert.equal(invokeEntry(['git', 'commit', '-m', 'sync']).status, 0);
    const pushed = invokeEntry(['git', 'push', 'work/test']);
    assert.equal(pushed.status, 0, pushed.error);
    assert.equal(git(remote, 'rev-parse', 'refs/heads/work/test'), git(f.worktree, 'rev-parse', 'HEAD'));
    assert.equal(fs.readdirSync(path.dirname(f.destination)).some((name) => name.startsWith('.protected-sync-')), false);
  });
}

test('OS 実機: 許可した親以外への Node の書き込みを OS が拒否する', { skip: !realCapability.available && realCapability.reason }, (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'outside');
  const command = restrictWrites({ bin: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(outside)}, 'bad')`], allowWrite: [path.dirname(f.destination)] });
  const result = cp.spawnSync(command.bin, command.args, { env: {}, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(outside), false);
});


test('能力 API は認証後の GET で同じ判定関数の結果をそのまま JSON にする', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("    if (req.method === 'GET' && url.pathname === '/api/codex-task-capabilities')");
  const end = source.indexOf('    // GET /api/health', start);
  const gate = source.indexOf('    if (!isAuthExemptPath(req.method, url.pathname) && authRequired)', source.indexOf('function startHttpApi()'));
  assert.ok(gate !== -1 && start > gate);
  assert.equal(require('../utils/apiAuth').isAuthExemptPath('GET', '/api/codex-task-capabilities'), false);
  const route = new Function('req', 'url', 'res', 'getProtectedSyncCapabilities', source.slice(start, end));
  for (const available of [true, false]) {
    let body;
    let status;
    let called = 0;
    const capability = { available, reason: available ? null : 'write-restricted execution is not available', targets: PROTECTED_SYNC_TARGETS };
    route({ method: 'GET' }, { pathname: '/api/codex-task-capabilities' }, { writeHead: (code) => { status = code; }, end: (text) => { body = JSON.parse(text); } }, () => { called += 1; return capability; });
    assert.equal(status, 200);
    assert.equal(called, 1);
    assert.deepEqual(body, { capabilities: { protectedSync: capability } });
  }
});

test('OS 実機: clone 本体も登録済み worktree として同期できる', { skip: !realCapability.available && realCapability.reason }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, target.source), 'clone update');
  const result = f.invoke(undefined, { cwd: f.repo });
  assert.equal(result.status, 0, result.error);
  assert.equal(fs.readFileSync(path.join(f.repo, target.target), 'utf8'), 'clone update');
});

test('OS 実機: bind 起動前に親がリンクに差し替わると書き込まない', { skip: !realCapability.available && realCapability.reason }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, 'changed');
  const parent = path.dirname(f.destination);
  const outside = path.join(f.root, 'outside-dir');
  fs.mkdirSync(outside);
  const outsideFile = path.join(outside, 'SKILL.md');
  fs.writeFileSync(outsideFile, 'outside');
  let swapped = false;
  const result = f.invoke(undefined, { spawnSync: (bin, args, options) => {
    if (options.input && !swapped) {
      fs.renameSync(parent, parent + '-original');
      fs.symlinkSync(outside, parent);
      swapped = true;
    }
    return cp.spawnSync(bin, args, { ...options, stdio: 'pipe' });
  } });
  assert.equal(swapped, true);
  assert.equal(result.status, 2);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside');
  assert.equal(fs.readFileSync(path.join(parent + '-original', 'SKILL.md'), 'utf8'), 'original\n');
});


test('実環境で OS 制限を起動できないときは配布先を書き換えず拒否する', { skip: realCapability.available }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, 'changed');
  const result = f.invoke();
  assert.equal(result.status, 2);
  assert.match(result.error, /write-restricted execution is not available/);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'original\n');
});

test('Linux の未信頼 bwrap と起動失敗は書き込み前に拒否する', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.source, 'changed');
  for (const failure of ['owner', 'permissions', 'startup']) {
    const fakeFs = new Proxy(fs, { get(object, key) {
      if (key === 'lstatSync' || key === 'statSync') return (file) => {
        if (file === '/usr/bin/bwrap') return { uid: failure === 'owner' ? 1000 : 0, gid: 0, mode: failure === 'permissions' ? 0o777 : 0o755, dev: 1, ino: 1, isFile: () => true, isSymbolicLink: () => false };
        return object[key](file);
      };
      return object[key];
    } });
    const result = f.invoke(undefined, { platform: 'linux', fs: fakeFs, spawnSync: (bin, args, options) => {
      if (bin === '/usr/bin/bwrap') return { status: 1, stderr: 'namespace disabled' };
      return cp.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    } });
    assert.equal(result.status, 2, failure);
    assert.match(result.error, /write-restricted execution is not available/);
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'original\n');
  }
});


test('実機: 専用 CODEX_HOME の作成と信頼済みランチャーの起動', (t) => {
  const f = fixture(t);
  const personal = path.join(f.root, 'empty-personal-codex');
  fs.mkdirSync(personal, { mode: 0o700 });
  const result = prepareCodexTaskPolicyHome({ preset: 'orchestrated-task', cwd: f.repo,
    dataDir: path.join(f.root, 'data'), handoffDir: path.join(f.root, 'handoff'), personalCodexHome: personal,
    homeDir: f.env.VK_TASK_HOME, toolDirs: [path.dirname(process.execPath), path.dirname(gitPath), '/usr/bin', '/bin'],
    tmpdir: f.root, tmpRoots: [],
  });
  assert.equal(result.ok, true, result.error);
  const launched = cp.spawnSync(path.join(result.home, 'vk-task-ops'), ['git', 'status', '--short'], { cwd: f.repo, env: {}, encoding: 'utf8' });
  assert.equal(launched.status, 0, launched.stderr);
});
