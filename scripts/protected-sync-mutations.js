// 一時コピーだけを壊し、検査の欠落をテストが検出できるかを確認する。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const root = path.resolve(__dirname, '..');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'protected-sync-mutations-'));
const source = fs.readFileSync(path.join(root, 'utils/codexTaskOps.js'), 'utf8');
const removeLine = (fragment) => (text) => text.split('\n').filter((line) => !line.includes(fragment)).join('\n');
const parent = removeLine("throw new Error('parent changed after verification')");
const mutations = [
  ['OS wrapper', (s) => s.replace("const command = restrictWrites({ bin: node, args: ['-e', `(${protectedSyncChild.toString()})()`], allowWrite: [parent], snapshot, directoryFds: linux ? [parentFd] : [] }, deps);", "const command = { bin: node, args: ['-e', `(${protectedSyncChild.toString()})()`] }; ")],
  ['repository table', removeLine("protected-sync repository is not registered")],
  ['worktree list', removeLine("throw new TrustError('worktree is not registered')")],
  ['child parent', parent],
  ['source fstat', removeLine("throw new TrustError('source changed after verification')")],
  ['readback', removeLine("throw new Error('copied bytes do not match')")],
  ['atomic rename', (s) => s.replace(/    temporary = path\.join\(directory, `\.protected-sync-\$\{crypto\.randomBytes\(16\)\.toString\('hex'\)\}`\);[\s\S]*?    temporary = undefined;/, '    fs.writeFileSync(destination, content);')],
  ['non-darwin fetch', removeLine("if ((deps.platform || process.platform) !== 'darwin') return { ok: false")],
  ['async failure', (s) => s.replace('resolve(error ? unavailable : JSON.parse(stdout))', 'resolve(error ? { ...unavailable, available: true } : JSON.parse(stdout))')],
  ['fd identity', removeLine("throw new TrustError('write directory changed')")],
  ['read-only binding', removeLine('protected-sync requires write access')],
  ['bind-fd support', removeLine("!String(help.stdout).includes('--bind-fd')")],
  ['parent snapshot', (s) => s.replace('snapshot: [{ ...snapshot.find((item) => item.path === parent),', 'snapshot: [{ dev: -1, ino: -1,')],
  ['bound Git', (s) => s.replace('getProtectedSyncCapabilities({ ...deps, git: binding.git })', 'getProtectedSyncCapabilities(deps)')],
  ['network isolation', (s) => s.replace("'--die-with-parent', '--unshare-net',", "'--die-with-parent',")],
  ['Git version', removeLine("throw new Error('unsupported Git')")],
  ['capability probe', (s) => s.replace("    if (!capability.available) throw new TrustError(capability.reason);", '')],
];
if (process.platform === 'linux') mutations.push(
  ['fd traversal', (s) => s.replace('fsImpl.openSync(`/proc/self/fd/${parent}/${segment}`,', 'fsImpl.openSync(current,')],
  ['chain nofollow', (s) => s.replace('nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK | (file', 'nodeFs.constants.O_NONBLOCK | (file')],
  ['sandbox target', (s) => s.replace("String(2 + fds.length), `/run/vk-protected-sync/target${index}`", 'String(2 + fds.length), dir')],
  ['parent fd close', (s) => s.replace('finally { if (command.close) command.close(); }', 'finally {}')],
  ['Linux descriptor pin', (s) => s.replace("const directory = process.platform === 'linux' ? `/proc/self/fd/${directoryFd}` : parent;", 'const directory = parent;')],
);

let failures = 0;
try {
  for (const directory of ['utils', 'tests']) fs.cpSync(path.join(root, directory), path.join(temporary, directory), { recursive: true });
  fs.copyFileSync(path.join(root, 'main.js'), path.join(temporary, 'main.js'));
  const baseline = cp.spawnSync(process.execPath, ['--test', 'tests/protectedSync.test.js'], { cwd: temporary, encoding: 'utf8', timeout: 120000 });
  if (baseline.status !== 0) throw new Error(`baseline failed: ${baseline.stdout}\n${baseline.stderr}`);
  console.log('BASELINE: PASS');
  for (const [name, mutate] of mutations) {
    const changed = mutate(source);
    if (changed === source) throw new Error(`mutation did not apply: ${name}`);
    new (require('node:vm').Script)(changed);
    fs.writeFileSync(path.join(temporary, 'utils/codexTaskOps.js'), changed);
    const result = cp.spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'tests/protectedSync.test.js'], { cwd: temporary, encoding: 'utf8', timeout: 120000 });
    const detected = result.status !== 0 && /^not ok /m.test(result.stdout);
    console.log(`${detected ? 'DETECTED' : 'SURVIVED'}: ${name}`);
    if (!detected) failures++;
  }
} finally { fs.rmSync(temporary, { recursive: true, force: true }); }
process.exitCode = failures ? 1 : 0;
