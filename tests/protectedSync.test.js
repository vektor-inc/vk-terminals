// 固定対応表と OS 制限の両方を通る同期、および書き込み前の拒否を検証する。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { runTaskCommand, parseTaskCommand, restrictWrites, getProtectedSyncCapabilities, getProtectedSyncCapabilitiesAsync, listToolSearchDirs, PROTECTED_SYNC_TARGETS, buildMemberCodexArgs, readBinding, protectedSyncChild, protectedSourceChild, prepareRestrictedFetch } = require('../utils/codexTaskOps');
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
  fs.mkdirSync(home, { mode: 0o700 });
  const config = path.join(root, 'author');
  fs.writeFileSync(config, '[user]\nname = Test\nemail = test@example.com\n');
  const env = { VK_TASK_ROOT: repo, VK_TASK_REPO: target.repo, VK_TASK_GIT: gitPath, VK_TASK_HOME: home, VK_TASK_GITCONFIG: config, VK_TASK_GH: '/usr/bin/true', VK_TASK_GHCONFIG: home };
  const invoke = (args = ['protected-sync', target.target], extra = {}) => {
    let error = '';
    const status = runTaskCommand(args, { cwd: worktree, env, write: (text) => { error += text; },
      spawnSync: (bin, argv, options) => cp.spawnSync(bin, argv, { ...options, stdio: options.stdio || 'pipe' }), ...extra });
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

test('能力照会は Git の版・Node の信頼性・書き込み bind を検証する', () => {
  for (const platform of ['win32', 'freebsd']) assert.equal(getProtectedSyncCapabilities({ platform }).available, false);
  const calls = [];
  const spawnSync = (bin, args, options) => {
    calls.push({ bin, args, options });
    if (args[0] === 'version') return { status: 0, stdout: 'git version 2.46.0' };
    if (args[0] === '--help') return { status: 0, stdout: '--bind-fd' };
    return { status: 0 };
  };
  const probeFs = new Proxy(fs, { get(object, key) {
    if (key === 'lstatSync') return (file) => file === '/usr/bin/sandbox-exec' ? fs.lstatSync('/usr/bin/true') : fs.lstatSync(file);
    return object[key];
  } });
  const available = getProtectedSyncCapabilities({ platform: 'darwin', spawnSync, fs: probeFs });
  assert.equal(available.available, true);
  assert.ok(calls.some(({ bin, args }) => bin === '/usr/bin/sandbox-exec' && args.includes(process.execPath)));
  assert.ok(calls.some(({ args }) => args.includes('process.exit(0)') && args.includes('ALLOW0=/usr')));
  assert.ok(calls.every(({ args }) => !args.some((arg) => arg.includes('protected-sync-probe-'))));
  assert.equal(getProtectedSyncCapabilities({ platform: 'darwin', fs: probeFs, spawnSync: (_bin, args) => ({ status: 0, stdout: args[0] === 'version' ? 'git version 2.39.0' : '' }) }).available, false);
  const untrustedNode = new Proxy(fs, { get(object, key) {
    if (key === 'lstatSync') return (file) => { if (file === process.execPath) throw new Error('untrusted node'); return fs.lstatSync(file); };
    return object[key];
  } });
  assert.equal(getProtectedSyncCapabilities({ fs: untrustedNode, spawnSync }).available, false);
});

test('Linux は検査したディレクトリ記述子を stdio 3 に渡し bind-fd で固定する', (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bind-fd-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const stat = { uid: 0, gid: 0, mode: 0o755, dev: 1, ino: 1, isDirectory: () => true, isFile: () => true, isSymbolicLink: () => false };
  const fakeFs = new Proxy(fs, { get(object, key) {
    if (key === 'lstatSync' || key === 'statSync') return (file) => file.startsWith('/usr') ? stat : fs[key](file);
    return object[key];
  } });
  const command = restrictWrites({ bin: '/trusted/node', args: ['-e', 'fixed'], allowWrite: [dir] }, { platform: 'linux', fs: fakeFs, spawnSync: () => ({ status: 0, stdout: '--bind-fd' }) });
  try {
    assert.equal(command.bin, '/usr/bin/bwrap');
    assert.ok(command.args.includes('--bind-fd'));
    assert.ok(command.args.includes('--unshare-net'));
    assert.deepEqual(command.args.slice(0, 3), ['--ro-bind', '/', '/']);
    assert.ok(command.args.includes('--new-session'));
    const tmpfs = command.args.indexOf('--tmpfs');
    assert.equal(command.args[tmpfs + 1], '/run');
    const index = command.args.indexOf('--bind-fd');
    assert.deepEqual(command.args.slice(index, index + 3), ['--bind-fd', '3', '/run/vk-protected-sync/target0']);
    assert.equal(fs.fstatSync(command.stdio[3]).ino, fs.statSync(dir).ino);
  } finally { command.close(); }
  assert.throws(() => fs.fstatSync(command.stdio[3]), /EBADF/);
  const expected = fs.statSync(dir);
  assert.throws(() => restrictWrites({ bin: '/node', args: [], allowWrite: [dir], snapshot: [{ path: dir, dev: expected.dev, ino: expected.ino + 1 }] }, { platform: 'linux', fs: fakeFs, spawnSync: () => ({ status: 0, stdout: '--bind-fd' }) }), /write directory changed/);
  assert.throws(() => restrictWrites({ bin: '/node', args: [], allowWrite: [dir] }, { platform: 'linux', fs: fakeFs, spawnSync: () => ({ status: 0, stdout: 'old help' }) }), /not available/);
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
  let result;
  try { result = cp.spawnSync(command.bin, command.args, { env: {}, encoding: 'utf8', stdio: command.stdio }); }
  finally { if (command.close) command.close(); }
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /EACCES|EPERM|EROFS/);
  assert.equal(fs.existsSync(outside), false);
});


test('能力 API は非同期で照会し既存の認証規則を使う', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const start = source.indexOf("    if (req.method === 'GET' && url.pathname === '/api/codex-task-capabilities')");
  const end = source.indexOf('    // GET /api/health', start);
  const gate = source.indexOf('    if (!isAuthExemptPath(req.method, url.pathname) && authRequired)', source.indexOf('function startHttpApi()'));
  assert.ok(gate !== -1 && start > gate);
  const route = new Function('req', 'url', 'res', 'getProtectedSyncCapabilitiesAsync', source.slice(start, end));
  let body;
  route({ method: 'GET' }, { pathname: '/api/codex-task-capabilities' }, { writeHead: (code) => assert.equal(code, 200), end: (text) => { body = JSON.parse(text); } }, async () => ({ available: false }));
  assert.equal(body, undefined);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(body.capabilities.protectedSync.available, false);
  assert.equal(require('../utils/apiAuth').isAuthExemptPath('GET', '/api/codex-task-capabilities'), false);
});

test('OS 実機: clone 本体も登録済み worktree として同期できる', { skip: !realCapability.available && realCapability.reason }, (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, target.source), 'clone update');
  const result = f.invoke(undefined, { cwd: f.repo });
  assert.equal(result.status, 0, result.error);
  assert.equal(fs.readFileSync(path.join(f.repo, target.target), 'utf8'), 'clone update');
});

test('OS 実機: bind 起動前に親がリンクに差し替わっても外へ書き込まない', { skip: !realCapability.available && realCapability.reason }, (t) => {
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
    return cp.spawnSync(bin, args, { ...options, stdio: options.stdio || 'pipe' });
  } });
  assert.equal(swapped, true);
  assert.equal(result.status, process.platform === 'linux' ? 0 : 2);
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside');
  assert.equal(fs.readFileSync(path.join(parent + '-original', 'SKILL.md'), 'utf8'), process.platform === 'linux' ? 'changed' : 'original\n');
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
      return cp.spawnSync(bin, args, { ...options, stdio: options.stdio || 'pipe' });
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

// OS の起動可否に依存せず、子の各検査を独立した競合条件で検証する。
function childFixture(t, hooks = {}, platform = process.platform) {
  const f = fixture(t);
  const parent = path.dirname(f.destination);
  const snapshot = [f.worktree, parent, f.destination].map((file) => {
    const stat = fs.lstatSync(file);
    return { path: file, dev: stat.dev, ino: stat.ino, file: stat.isFile() };
  });
  const input = JSON.stringify({ parent, snapshot, target: f.destination, bytes: Buffer.from('new bytes').toString('base64'), mode: 0o644 });
  const fakeFs = new Proxy(fs, { get(object, key) {
    if (hooks[key]) return (...args) => hooks[key](...args);
    if (key === 'readFileSync') return (file, ...args) => file === 0 ? input : fs.readFileSync(file, ...args);
    return object[key];
  } });
  const proc = { platform, stderr: { write: () => {} }, exitCode: 0 };
  const execute = () => require('node:vm').runInNewContext(`(${protectedSyncChild.toString()})()`, {
    require: (name) => name === 'node:fs' ? fakeFs : require(name), process: proc, Buffer,
  });
  return { ...f, parent, snapshot, proc, execute };
}

for (const check of ['parent', 'readback', 'atomic']) {
  test(`子の独立検査: ${check}`, (t) => {
    let f;
    const hooks = {};
    if (check === 'parent') hooks.fstatSync = (fd) => {
      const stat = fs.fstatSync(fd);
      return stat.isDirectory() ? new Proxy(stat, { get: (obj, key) => key === 'ino' ? obj.ino + 1 : typeof obj[key] === 'function' ? obj[key].bind(obj) : obj[key] }) : stat;
    };
    if (check === 'readback') hooks.readFileSync = (file, ...args) => file === 0 ? JSON.stringify({ parent: f.parent, snapshot: f.snapshot, target: f.destination, bytes: Buffer.from('new bytes').toString('base64'), mode: 0o644 }) : Buffer.from('corrupted');
    if (check === 'atomic') hooks.writeFileSync = (file, content) => {
      fs.writeFileSync(file, content.subarray(0, 1));
      throw new Error('interrupted write');
    };
    f = childFixture(t, hooks);
    f.execute();
    assert.equal(f.proc.exitCode, 2);
    if (check !== 'readback') assert.equal(fs.readFileSync(f.destination, 'utf8'), 'original\n');
    assert.equal(fs.readdirSync(f.parent).some((name) => name.startsWith('.protected-sync-')), false);
  });
}

test('Linux 実機: 子は親の rename 後も開いた記述子へ書き込む', { skip: process.platform !== 'linux' }, (t) => {
  let f;
  let swapped = false;
  f = childFixture(t, { openSync: (file, flags, ...args) => {
    if (!swapped && typeof file === 'string' && file.includes('.protected-sync-')) {
      fs.renameSync(f.parent, f.parent + '-old');
      fs.mkdirSync(f.parent);
      fs.writeFileSync(f.destination, 'outside');
      swapped = true;
    }
    return fs.openSync(file, flags, ...args);
  } });
  f.execute();
  assert.equal(f.proc.exitCode, 0);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'outside');
  assert.equal(fs.readFileSync(path.join(f.parent + '-old', 'SKILL.md'), 'utf8'), 'new bytes');
});

test('対応表の照合は binding と origin が両方別でも拒否する', (t) => {
  const f = fixture(t);
  git(f.repo, 'remote', 'set-url', 'origin', 'https://github.com/vektor-inc/other.git');
  const result = f.invoke(undefined, { env: { ...f.env, VK_TASK_REPO: 'vektor-inc/other' } });
  assert.equal(result.status, 2);
  assert.match(result.error, /repository is not registered/);
});

test('生成元の記述子の同一性を検証する', { skip: !realCapability.available || process.platform !== 'linux' }, (t) => {
  const f = fixture(t);
  let reads = 0;
  const fakeFs = new Proxy(fs, { get(object, key) {
    if (key === 'fstatSync') return (fd) => {
      const stat = fs.fstatSync(fd);
      if (stat.ino === fs.statSync(f.source).ino && ++reads === (process.platform === 'linux' ? 2 : 1)) {
        return new Proxy(stat, { get: (obj, name) => name === 'ino' ? obj.ino + 1 : typeof obj[name] === 'function' ? obj[name].bind(obj) : obj[name] });
      }
      return stat;
    };
    return object[key];
  } });
  const result = f.invoke(undefined, { fs: fakeFs });
  assert.equal(result.status, 2);
  assert.match(result.error, /source changed/);
});

test('登録 worktree 一覧から消えた場合は拒否する', (t) => {
  const f = fixture(t);
  const result = f.invoke(undefined, { spawnSync: (bin, args, options) => args.includes('list') && args.includes('worktree') ? { status: 0, stdout: '' } : cp.spawnSync(bin, args, { ...options, stdio: options.stdio || 'pipe' }) });
  assert.equal(result.status, 2);
  assert.match(result.error, /worktree is not registered/);
});

test('読み取り専用メンバーの引数と、親が read-only の入口での同期拒否', (t) => {
  const args = buildMemberCodexArgs({ root: '/repo', schemaPath: '/schema', outPath: '/out', model: null, readonly: true });
  assert.ok(args.includes('--ignore-rules'));
  assert.ok(args.includes('read-only'));
  const f = fixture(t);
  const env = { ...f.env, VK_TASK_CODEX: process.execPath, VK_TASK_MEMBER_HOME: f.root, VK_TASK_MEMBER_IO: f.root, VK_TASK_MEMBER_RUNS: f.root, VK_TASK_PARENT_CWD: f.repo, VK_TASK_PARENT_SANDBOX: 'read-only' };
  const result = f.invoke(undefined, { env });
  assert.equal(result.status, 2);
  assert.match(result.error, /requires write access/);
});

test('非 macOS の fetch 準備は副作用より前に拒否する', () => {
  const result = prepareRestrictedFetch({ deps: { platform: 'linux' }, fsImpl: new Proxy({}, { get: () => { throw new Error('must not inspect'); } }) });
  assert.equal(result.ok, false);
  assert.match(result.error, /not available/);
});

test('同期の spawn は OS 制限で包まれ、Linux は bind-fd を継承する', (t) => {
  const f = fixture(t);
  let launched = false;
  let parentFd;
  const result = f.invoke(undefined, { spawnSync: (bin, args, options) => {
    if (bin === process.execPath && options.input) return cp.spawnSync(bin, args, options);
    if (options.input) {
      launched = true;
      assert.equal(bin, process.platform === 'darwin' ? '/usr/bin/sandbox-exec' : '/usr/bin/bwrap');
      if (process.platform === 'linux') { assert.ok(args.includes('--bind-fd')); assert.ok(args.includes('--unshare-net')); parentFd = options.stdio[3]; assert.ok(parentFd >= 0); }
      return { status: 0 };
    }
    if (args[0] === '--help') return { status: 0, stdout: '--bind-fd' };
    if (bin.endsWith('sandbox-exec') || bin.endsWith('bwrap')) {
      if (process.platform === 'darwin') assert.ok(args.includes('ALLOW0=/usr'));
      else { const index = args.indexOf('--bind-fd'); assert.equal(args[index + 2], '/run/vk-protected-sync/target0'); }
      return { status: 0 };
    }
    return cp.spawnSync(bin, args, { ...options, stdio: options.stdio || 'pipe' });
  } });
  assert.equal(result.status, 0, result.error);
  assert.equal(launched, true);
  if (parentFd !== undefined) assert.throws(() => fs.fstatSync(parentFd), /EBADF/);
});

test('能力検証の起動に失敗したら本体を起動しない', (t) => {
  const f = fixture(t);
  let executed = false;
  const result = f.invoke(undefined, { spawnSync: (bin, args, options) => {
    if (options.input) { executed = true; return { status: 0 }; }
    if (args[0] === '--help') return { status: 0, stdout: '--bind-fd' };
    if (bin.endsWith('sandbox-exec') || bin.endsWith('bwrap')) return { status: 1 };
    return cp.spawnSync(bin, args, { ...options, stdio: options.stdio || 'pipe' });
  } });
  assert.equal(result.status, 2);
  assert.equal(executed, false);
});

test('Linux OS 実機: bind 前のリンク差し替えでも外へ書き込まない', { skip: process.platform !== 'linux' || !realCapability.available }, (t) => {
  const f = fixture(t);
  const parent = path.dirname(f.destination);
  const outside = path.join(f.root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'SKILL.md'), 'outside');
  const expected = fs.statSync(parent);
  fs.renameSync(parent, parent + '-old');
  fs.symlinkSync(path.relative(path.dirname(parent), outside), parent);
  assert.throws(() => restrictWrites({ bin: process.execPath, args: ['-e', 'process.exit(0)'],
    allowWrite: [parent], snapshot: [{ path: parent, dev: expected.dev, ino: expected.ino }] }), /ELOOP|ENOTDIR|write directory changed/);
  assert.equal(fs.readFileSync(path.join(outside, 'SKILL.md'), 'utf8'), 'outside');
  assert.equal(fs.readFileSync(path.join(parent + '-old', 'SKILL.md'), 'utf8'), 'original\n');
});

// 照会は一時領域を作らず、API と入口が同じ無書き込みの確認を使う。
test('能力確認はファイルを生成・変更・削除しない', () => {
  const guarded = new Proxy(fs, { get(object, key) {
    if (/^(mkdtemp|mkdir|write|rm|unlink|rename)/.test(key)) return () => { throw new Error('unexpected mutation'); };
    if (key === 'lstatSync') return (file) => file === '/usr/bin/sandbox-exec' ? fs.lstatSync('/usr/bin/true') : fs.lstatSync(file);
    return object[key];
  } });
  assert.equal(getProtectedSyncCapabilities({ platform: 'darwin', fs: guarded,
    spawnSync: (_bin, args) => ({ status: 0, stdout: args[0] === 'version' ? 'git version 2.46.0' : '' }) }).available, true);
});

test('非同期照会はメモリ上のコードを使い、失敗後に再試行できる', async () => {
  const codeCalls = [];
  const execFile = (_bin, args, _options, done) => { codeCalls.push(args[1]); done(new Error('unavailable'), ''); };
  assert.equal((await getProtectedSyncCapabilitiesAsync({ execFile })).available, false);
  assert.equal((await getProtectedSyncCapabilitiesAsync({ execFile })).available, false);
  assert.equal(codeCalls.length, 2);
  assert.ok(codeCalls.every((code) => !code.includes('require(' + JSON.stringify(require.resolve('../utils/codexTaskOps')))));
  assert.ok(codeCalls.every((code) => !code.includes('mkdtempSync') && !code.includes('rmSync')));
  let output = '';
  let probeArgs;
  const fsApi = new Proxy(fs, { get(object, key) {
    if (key === 'lstatSync') return (file) => file === '/usr/bin/sandbox-exec' ? fs.lstatSync('/usr/bin/true') : fs.lstatSync(file);
    if (/^(mkdtemp|mkdir|write|rm|unlink|rename)/.test(key)) throw new Error('unexpected mutation');
    return object[key];
  } });
  require('node:vm').runInNewContext(codeCalls[0], {
    require: (name) => name === 'node:fs' ? fsApi : name === 'node:child_process' ? {
      spawnSync: (_bin, args) => { if (args[0] === 'version') return { status: 0, stdout: 'git version 2.46.0' }; probeArgs = args; return { status: 0 }; },
    } : require(name),
    process: { platform: 'darwin', execPath: process.execPath, getuid: () => process.getuid(), env: {}, stdout: { write: (text) => { output += text; } } },
  });
  assert.equal(JSON.parse(output).available, true);
  assert.ok(probeArgs.includes('ALLOW0=/usr'));

  const absent = new Proxy(fs, { get(object, key) { if (key === 'lstatSync') return () => { throw new Error('missing'); }; return object[key]; } });
  assert.equal((await getProtectedSyncCapabilitiesAsync({ fs: absent })).available, false);
  await getProtectedSyncCapabilitiesAsync({ execFile });
  assert.equal(codeCalls.length, 3);
  assert.deepEqual(listToolSearchDirs('/home/example', '/custom/bin'), require('../utils/codexTaskPolicy').listToolSearchDirs('/home/example', '/custom/bin'));
});

test('実行時の能力照会は拘束された Git を使う', (t) => {
  const f = fixture(t);
  const fixedGit = path.join(f.root, 'fixed-git');
  fs.copyFileSync(gitPath, fixedGit);
  fs.chmodSync(fixedGit, 0o755);
  let versionBin;
  const result = f.invoke(undefined, { env: { ...f.env, VK_TASK_GIT: fixedGit }, spawnSync: (bin, args, options) => {
    if (args[0] === 'version') { versionBin = bin; return { status: 0, stdout: 'git version 2.46.0' }; }
    if (args[0] === '--help') return { status: 0, stdout: '--bind-fd' };
    if (bin.endsWith('sandbox-exec') || bin.endsWith('bwrap')) return { status: 0 };
    return cp.spawnSync(bin === process.execPath ? bin : gitPath, args, { ...options, stdio: options.stdio || 'pipe' });
  } });
  assert.equal(result.status, 0, result.error);
  assert.equal(versionBin, fixedGit);
});

test('Linux 実機: 能力照会を反復しても既存ファイルを保持する', { skip: process.platform !== 'linux' || !realCapability.available }, async (t) => {
  const f = fixture(t);
  const outside = path.join(f.root, 'preserved');
  fs.mkdirSync(outside);
  for (let index = 0; index < 400; index++) fs.writeFileSync(path.join(outside, String(index)), 'original');
  const guarded = new Proxy(fs, { get(object, key) {
    if (/^(mkdtemp|mkdir|write|rm|unlink|rename)/.test(key)) return () => { throw new Error('unexpected mutation'); };
    return object[key];
  } });
  for (let index = 0; index < 5; index++) {
    assert.equal(getProtectedSyncCapabilities({ fs: guarded }).available, true);
    assert.equal((await getProtectedSyncCapabilitiesAsync()).available, true);
  }
  assert.equal(fs.readdirSync(outside).length, 400);
  for (const file of fs.readdirSync(outside)) assert.equal(fs.readFileSync(path.join(outside, file), 'utf8'), 'original');
});

// 段階を固定してフォルダを交換し、OS の外側にあるファイルが保持されることを確認する。
for (const side of ['source', 'target']) {
  for (const stage of ['before-open', 'after-open', 'after-stat']) {
    test(`OS 実機: ${side} の ${stage} で途中のフォルダを交換する`, { skip: !realCapability.available }, (t) => {
      const f = fixture(t);
      fs.writeFileSync(f.source, 'new bytes');
      const relative = side === 'source' ? 'src/help' : '.agents/skills';
      const directory = path.join(f.worktree, relative);
      const outside = path.join(f.root, 'outside');
      fs.mkdirSync(outside);
      const suffix = side === 'source' ? 'helper-skill.md' : 'vk-orchestrator-helper/SKILL.md';
      const outsideFile = path.join(outside, suffix);
      fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
      fs.writeFileSync(outsideFile, 'outside');
      let swapped = false;
      let watchedFd;
      const swap = () => {
        if (swapped) return;
        fs.renameSync(directory, directory + '-saved');
        fs.symlinkSync(outside, directory);
        swapped = true;
      };
      const fakeFs = new Proxy(fs, { get(object, key) {
        if (key === 'openSync') return (file, ...args) => {
          const watched = file === directory || (process.platform === 'linux' && String(file).startsWith('/proc/self/fd/') && path.basename(file) === path.basename(directory));
          if (watched && stage === 'before-open') swap();
          const fd = fs.openSync(file, ...args);
          if (watched) { watchedFd = fd; if (stage === 'after-open') swap(); }
          return fd;
        };
        if (key === 'fstatSync') return (fd) => { const stat = fs.fstatSync(fd); if (fd === watchedFd && stage === 'after-stat') swap(); return stat; };
        if (key === 'lstatSync') return (file) => {
          const stat = fs.lstatSync(file);
          if (process.platform === 'darwin' && file === directory && stage === 'after-stat') swap();
          return stat;
        };
        return object[key];
      } });
      // macOS の階層検査は lstat の直後に交換する。他の段階は子の起動直前に固定する。
      const result = f.invoke(undefined, { fs: fakeFs, spawnSync: (bin, args, options) => {
        if (process.platform === 'darwin' && options.input && !swapped) swap();
        return cp.spawnSync(bin, args, { ...options, stdio: options.stdio || 'pipe' });
      } });
      assert.equal(swapped, true);
      assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'outside');
      assert.deepEqual(fs.readdirSync(path.dirname(outsideFile)), [path.basename(outsideFile)]);
      if (result.status === 0) {
        const actual = side === 'target' ? path.join(directory + '-saved', suffix) : f.destination;
        assert.equal(fs.readFileSync(actual, 'utf8'), 'new bytes');
      } else assert.equal(result.status, 2, result.error);
    });
  }
}

test('OS 実機: 途中のフォルダの連続交換中も外部ファイルを保持する', { skip: !process.env.VK_PROTECTED_SYNC_RACE_ATTEMPTS || !realCapability.available }, async (t) => {
  const f = fixture(t);
  const executable = path.join(f.root, 'swap');
  cp.execFileSync('cc', [path.join(__dirname, '../scripts/protected-sync-linux/swap.c'), '-O2', '-o', executable]);
  fs.writeFileSync(f.source, 'new bytes');
  const outside = path.join(f.root, 'outside');
  const outsideFile = path.join(outside, 'vk-orchestrator-helper/SKILL.md');
  fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
  fs.writeFileSync(outsideFile, 'outside');
  const directory = path.join(f.worktree, '.agents/skills');
  const alternate = directory + '-alternate';
  fs.symlinkSync(outside, alternate);
  const worker = cp.spawn(executable, [directory, alternate], { stdio: ['ignore', 'pipe', 'inherit'] });
  let attempts = 0;
  let outsideWrites = 0;
  const outcomes = {};
  const closed = new Promise((resolve) => worker.once('close', (code, signal) => resolve({ code, signal })));
  try {
    await new Promise((resolve, reject) => { worker.stdout.once('data', resolve); worker.once('error', reject); worker.once('exit', () => reject(new Error('exchange worker stopped'))); });
    for (; attempts < Number(process.env.VK_PROTECTED_SYNC_RACE_ATTEMPTS); attempts++) {
      const result = f.invoke();
      const outcome = result.status === 0 ? 'success' : result.error.trim();
      outcomes[outcome] = (outcomes[outcome] || 0) + 1;
      if (fs.readFileSync(outsideFile, 'utf8') !== 'outside' || fs.readdirSync(path.dirname(outsideFile)).length !== 1) outsideWrites++;
    }
  } finally {
    worker.kill('SIGKILL');
    const exit = await closed;
    assert.equal(exit.signal, 'SIGKILL', JSON.stringify(exit));
  }
  t.diagnostic(JSON.stringify({ platform: process.platform, attempts, outsideWrites, outcomes }));
  assert.equal(outsideWrites, 0);
});

// 読み取り子の作業フォルダをモデル化し、各検査の間の実体変更を注入する。
function sourceChildModel(change = '') {
  let level = 0;
  let output;
  let nextFd = 10;
  const opened = new Map();
  const closed = [];
  const stat = (ino, directory = true) => ({ dev: 1, ino, size: 4, nlink: 1, isDirectory: () => directory, isFile: () => !directory });
  const fakeFs = {
    constants: fs.constants,
    readFileSync: () => JSON.stringify({ rootIdentity: { dev: 1, ino: 1 }, segments: target.source.split('/'), limit: 256 }),
    statSync: (name) => {
      assert.equal(name, '.');
      return stat(change === `cwd-${level}` ? 999 : level + 1);
    },
    openSync: (name, flags) => {
      assert.equal(name, target.source.split('/')[level]);
      assert.ok(flags & fs.constants.O_NOFOLLOW);
      if (level < 2) assert.ok(flags & fs.constants.O_DIRECTORY);
      if (change === `open-${level}`) throw new Error('changed path');
      const fd = nextFd++;
      opened.set(fd, stat(level + 2, level < 2));
      return fd;
    },
    fstatSync: (fd) => {
      const actual = opened.get(fd);
      if (level === 2 && change === 'nlink') return { ...actual, nlink: 2 };
      if (level < 2 && change === `kind-${level}`) return stat(actual.ino, false);
      return actual;
    },
    lstatSync: (name) => {
      assert.equal(name, target.source.split('/').at(-1));
      if (change === 'name-missing') throw new Error('missing source');
      if (change === 'name-replaced') return stat(999, false);
      if (change === 'name-kind') return stat(4);
      if (change === 'name-dev') return { ...stat(4, false), dev: 2 };
      return { ...stat(4, false), nlink: change === 'name-nlink' ? 2 : 1 };
    },
    readSync: (_fd, buffer, offset) => { if (offset) return 0; buffer.write('data'); return 4; },
    closeSync: (fd) => closed.push(fd),
  };
  const proc = { chdir: () => { level++; }, stdout: { write: (bytes) => { output = Buffer.from(bytes); } }, stderr: { write: () => {} }, exitCode: 0 };
  require('node:vm').runInNewContext(`(${protectedSourceChild.toString()})()`, { require: () => fakeFs, process: proc, Buffer });
  assert.deepEqual(closed, [...opened.keys()].reverse());
  return { output, status: proc.exitCode };
}

test('生成元の固定子は各段の flags と記述子を検証してバイト列を返す', () => {
  const result = sourceChildModel();
  assert.equal(result.status, 0);
  assert.deepEqual(result.output, Buffer.from('data'));
});
for (const stage of ['cwd-0', 'cwd-1', 'cwd-2', 'open-0', 'open-1', 'open-2', 'kind-0', 'kind-1', 'nlink', 'name-missing', 'name-replaced', 'name-kind', 'name-dev', 'name-nlink']) {
  test(`生成元の固定子は段階変更を拒否する: ${stage}`, () => {
    const result = sourceChildModel(stage);
    assert.equal(result.status, 2);
    assert.equal(result.output, undefined);
  });
}

test('非同期能力照会は JSON の破損を利用不可にする', async () => {
  const result = await getProtectedSyncCapabilitiesAsync({ execFile: (_bin, _args, _opts, callback) => callback(null, '{') });
  assert.equal(result.available, false);
});

test('能力照会は固定フォルダの所有者を検証する', () => {
  const owner = process.getuid() || 123456;
  let nodeVerified = false;
  const fakeFs = new Proxy(fs, { get(object, key) {
    if (key === 'lstatSync') return (file) => {
      const actual = fs.lstatSync(file);
      if (file === process.execPath) nodeVerified = true;
      if (file === '/usr' && nodeVerified) {
        nodeVerified = false;
        return new Proxy(actual, { get: (obj, name) => name === 'uid' ? owner : typeof obj[name] === 'function' ? obj[name].bind(obj) : obj[name] });
      }
      return actual;
    };
    return object[key];
  } });
  assert.equal(getProtectedSyncCapabilities({ uid: owner, fs: fakeFs, spawnSync: (_bin, args) => ({ status: 0, stdout: args[0] === 'version' ? 'git version 2.46.0' : '--bind-fd' }) }).available, false);
});

test('Linux のトップ・連鎖・親の記述子の flags と終了時の close', { skip: process.platform !== 'linux' || !realCapability.available }, (t) => {
  const f = fixture(t);
  const held = [];
  let duplicates = 0;
  const fakeFs = new Proxy(fs, { get(object, key) {
    if (key === 'openSync') return (file, flags, ...args) => {
      if (file === f.worktree || file.startsWith('/proc/self/fd/')) {
        if (file === f.worktree) assert.ok(flags & fs.constants.O_NOFOLLOW);
        const duplicate = /^\/proc\/self\/fd\/\d+$/.test(file);
        if (duplicate) duplicates++;
        else {
          assert.ok(flags & fs.constants.O_NOFOLLOW);
          if (![path.basename(target.source), path.basename(target.target)].includes(path.basename(file))) assert.ok(flags & fs.constants.O_DIRECTORY);
        }
        const fd = fs.openSync(file, flags, ...args);
        held.push(fd);
        return fd;
      }
      return fs.openSync(file, flags, ...args);
    };
    return object[key];
  } });
  const result = f.invoke(undefined, { fs: fakeFs });
  assert.equal(result.status, 0, result.error);
  assert.equal(duplicates, 1);
  assert.ok(held.length >= 9);
  for (const fd of held) assert.throws(() => fs.fstatSync(fd), /EBADF/);
});

test('Linux は親の複製時にも snapshot を照合する', { skip: process.platform !== 'linux' || !realCapability.available }, (t) => {
  const f = fixture(t);
  let duplicateFd;
  const fakeFs = new Proxy(fs, { get(object, key) {
    if (key === 'openSync') return (file, ...args) => {
      const fd = fs.openSync(file, ...args);
      if (/^\/proc\/self\/fd\/\d+$/.test(file)) duplicateFd = fd;
      return fd;
    };
    if (key === 'fstatSync') return (fd) => {
      const actual = fs.fstatSync(fd);
      return fd === duplicateFd ? new Proxy(actual, { get: (obj, name) => name === 'ino' ? obj.ino + 1 : typeof obj[name] === 'function' ? obj[name].bind(obj) : obj[name] }) : actual;
    };
    return object[key];
  } });
  const result = f.invoke(undefined, { fs: fakeFs });
  assert.equal(result.status, 2);
  assert.match(result.error, /write directory changed/);
});

test('Linux は Git 検証時の worktree とトップ記述子を照合する', { skip: process.platform !== 'linux' || !realCapability.available }, (t) => {
  const f = fixture(t);
  let rootFd;
  const fakeFs = new Proxy(fs, { get(object, key) {
    if (key === 'openSync') return (file, ...args) => { const fd = fs.openSync(file, ...args); if (file === f.worktree) rootFd = fd; return fd; };
    if (key === 'fstatSync') return (fd) => {
      const actual = fs.fstatSync(fd);
      return fd === rootFd ? new Proxy(actual, { get: (obj, name) => name === 'ino' ? obj.ino + 1 : typeof obj[name] === 'function' ? obj[name].bind(obj) : obj[name] }) : actual;
    };
    return object[key];
  } });
  const result = f.invoke(undefined, { fs: fakeFs });
  assert.equal(result.status, 2);
  assert.match(result.error, /worktree root changed/);
});

test('Linux は読み取り直前の生成元のリンク数も検証する', { skip: process.platform !== 'linux' || !realCapability.available }, (t) => {
  const f = fixture(t);
  const ino = fs.statSync(f.source).ino;
  let reads = 0;
  const fakeFs = new Proxy(fs, { get(object, key) {
    if (key === 'fstatSync') return (fd) => {
      const actual = fs.fstatSync(fd);
      if (actual.ino === ino && ++reads === 2) return new Proxy(actual, { get: (obj, name) => name === 'nlink' ? 2 : typeof obj[name] === 'function' ? obj[name].bind(obj) : obj[name] });
      return actual;
    };
    return object[key];
  } });
  const result = f.invoke(undefined, { fs: fakeFs });
  assert.equal(result.status, 2);
  assert.match(result.error, /source changed/);
});

for (const depth of [0, 1]) {
  test(`macOS 実機: 生成元の段階 ${depth} の open と移動の間の変更を拒否する`, { skip: process.platform !== 'darwin' }, (t) => {
    const f = fixture(t);
    const rootIdentity = fs.statSync(f.worktree);
    const directory = path.join(f.worktree, ...target.source.split('/').slice(0, depth + 1));
    const alternate = path.join(f.root, 'alternate');
    fs.mkdirSync(alternate);
    const input = JSON.stringify({ rootIdentity: { dev: rootIdentity.dev, ino: rootIdentity.ino }, segments: target.source.split('/'), limit: 256 });
    const code = `const fs=require('node:fs');
      const original=fs.fstatSync; let directories=0;
      fs.fstatSync=(fd)=>{ const stat=original(fd); if(stat.isDirectory() && directories++===${depth}) {
        fs.renameSync(${JSON.stringify(directory)}, ${JSON.stringify(directory + '-held')});
        fs.symlinkSync(${JSON.stringify(alternate)}, ${JSON.stringify(directory)});
      } return stat; };
      (${protectedSourceChild.toString()})()`;
    const result = cp.spawnSync(process.execPath, ['-e', code], { cwd: f.worktree, input });
    assert.equal(result.status, 2);
    assert.equal(result.stdout.length, 0);
    assert.match(result.stderr.toString(), /source directory changed/);
  });
}

test('Git 検証後も worktree トップの実体を保持して照合する', { skip: !realCapability.available }, (t) => {
  const f = fixture(t);
  const replacement = path.join(f.root, 'replacement');
  fs.cpSync(f.worktree, replacement, { recursive: true });
  let swapped = false;
  const result = f.invoke(undefined, { spawnSync: (bin, args, options) => {
    const result = cp.spawnSync(bin, args, { ...options, stdio: options.stdio || 'pipe' });
    if (args.includes('ls-files') && args.includes('--error-unmatch')) {
      fs.renameSync(f.worktree, f.worktree + '-verified');
      fs.renameSync(replacement, f.worktree);
      swapped = true;
    }
    return result;
  } });
  assert.equal(swapped, true);
  assert.equal(result.status, 2);
  assert.match(result.error, /worktree root changed|source could not be verified/);
  assert.equal(fs.readFileSync(f.destination, 'utf8'), 'original\n');
});

for (const change of ['missing', 'replaced', 'kind', 'dev', 'nlink']) {
  test(`Linux は読み取り前の生成元の名前を照合する: ${change}`, { skip: process.platform !== 'linux' || !realCapability.available }, (t) => {
    const f = fixture(t);
    const ino = fs.statSync(f.source).ino;
    let reads = 0;
    let checked = false;
    let sourceRead = false;
    const fakeFs = new Proxy(fs, { get(object, key) {
      if (key === 'fstatSync') return (fd) => {
        const actual = fs.fstatSync(fd);
        if (actual.ino === ino && ++reads === 2) {
          if (change === 'missing') fs.unlinkSync(f.source);
          if (change === 'replaced') { fs.renameSync(f.source, f.source + '-previous'); fs.writeFileSync(f.source, 'replacement'); }
          checked = true;
        }
        return actual;
      };
      if (key === 'lstatSync') return (file, ...args) => {
        const actual = fs.lstatSync(file, ...args);
        if (!checked || !String(file).startsWith('/proc/self/fd/') || path.basename(file) !== path.basename(f.source)) return actual;
        return new Proxy(actual, { get(obj, name) {
          if (change === 'kind' && name === 'isFile') return () => false;
          if (change === 'dev' && name === 'dev') return obj.dev + 1;
          if (change === 'nlink' && name === 'nlink') return 2;
          return typeof obj[name] === 'function' ? obj[name].bind(obj) : obj[name];
        } });
      };
      if (key === 'readSync') return (fd, ...args) => { if (fs.fstatSync(fd).ino === ino) sourceRead = true; return fs.readSync(fd, ...args); };
      return object[key];
    } });
    const result = f.invoke(undefined, { fs: fakeFs });
    assert.equal(checked, true);
    assert.equal(result.status, 2);
    assert.equal(sourceRead, false);
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'original\n');
  });
}

for (const change of ['missing', 'replaced']) {
  test(`macOS 固定子は読み取り前の名前の変更を拒否する: ${change}`, { skip: process.platform !== 'darwin' }, (t) => {
    const f = fixture(t);
    const root = fs.statSync(f.worktree);
    const input = JSON.stringify({ rootIdentity: { dev: root.dev, ino: root.ino }, segments: target.source.split('/'), limit: 256 });
    const script = `const fs = require('node:fs');
      const original = fs.fstatSync;
      fs.fstatSync = (fd) => { const stat = original(fd); if (stat.isFile()) {
        if (${JSON.stringify(change)} === 'missing') fs.unlinkSync(${JSON.stringify(f.source)});
        else { fs.renameSync(${JSON.stringify(f.source)}, ${JSON.stringify(f.source + '-previous')}); fs.writeFileSync(${JSON.stringify(f.source)}, 'replacement'); }
      } return stat; };
      (${protectedSourceChild.toString()})();`;
    const result = cp.spawnSync(process.execPath, ['-e', script], { cwd: f.worktree, input });
    assert.equal(result.status, 2);
    assert.equal(result.stdout.length, 0);
    assert.equal(fs.readFileSync(f.destination, 'utf8'), 'original\n');
  });
}
