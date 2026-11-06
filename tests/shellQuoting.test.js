'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  buildChangeDirectoryCommand,
  buildFileDropText,
  classifyShell,
  quoteShellPath,
} = require('../utils/shellQuoting');

const PATHS = [
  '/tmp/plain.txt',
  '/tmp/with space.txt',
  "/tmp/it's.txt",
  "/tmp/back\\'slash.txt",
  '/tmp/trailing\\',
  '/tmp/a;b&c|d.txt',
  '/tmp/$(printf x).txt',
  '/tmp/`printf x`.txt',
  '/tmp/$HOME.txt',
  '/tmp/*.txt',
  '/tmp/double"quote.txt',
  '/tmp/\u2018left\u2019right\u201alow\u201bhigh.txt',
  '/tmp/日本語 ファイル.txt',
];

function findShell(name) {
  const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function withArgvHelper(callback) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-file-drop-'));
  const helper = path.join(dir, 'argv.js');
  fs.writeFileSync(helper, 'process.stdout.write(JSON.stringify(process.argv.slice(2)));');
  try {
    callback(helper);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertRoundTrip(shell, shellArgs, kind, prefixFor) {
  withArgvHelper((helper) => {
    for (const value of PATHS) {
      const command = `${prefixFor(helper)} ${quoteShellPath(value, kind)}`;
      const result = spawnSync(shell, [...shellArgs, command], { encoding: 'utf8' });
      assert.equal(result.status, 0, `${value}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), [value]);
    }
  });
}

test('シェルの種類は OS ではなく実行ファイル名で決まる', () => {
  const cases = [
    ['/bin/zsh', 'posix'],
    ['/bin/bash', 'posix'],
    ['C:\\Program Files\\Git\\bin\\bash.exe', 'posix'],
    ['/usr/bin/bash', 'posix'],
    ['C:\\Windows\\System32\\cmd.exe', 'cmd'],
    ['C:\\WINDOWS\\SYSTEM32\\CMD.EXE', 'cmd'],
    ['powershell.exe', 'powershell'],
    ['C:\\Program Files\\PowerShell\\7\\pwsh.exe', 'powershell'],
    ['/opt/homebrew/bin/pwsh', 'powershell'],
    ['/opt/homebrew/bin/fish', 'fish'],
    ['/opt/homebrew/bin/pwsh-preview', 'powershell'],
    ['/bin/tcsh', 'unknown'],
    ['/opt/homebrew/bin/nu', 'unknown'],
    ['C:\\Windows\\cmd.bat', 'unknown'],
  ];
  for (const [shell, expected] of cases) assert.equal(classifyShell(shell), expected, shell);
});

test('POSIX 系のシェルでは 1 つの引数として渡る', () => {
  assertRoundTrip('/bin/sh', ['-c'], 'posix', (helper) => `'${process.execPath}' '${helper}'`);
});

for (const shellName of ['bash', 'zsh', 'dash']) {
  test(`${shellName} の実物でも 1 つの引数として渡る`, { skip: !findShell(shellName) }, () => {
    assertRoundTrip(findShell(shellName), ['-c'], 'posix', (helper) => `'${process.execPath}' '${helper}'`);
  });
}

test('fish の実物でも 1 つの引数として渡る', { skip: !findShell('fish') }, () => {
  assertRoundTrip(findShell('fish'), ['--no-config', '-c'], 'fish', (helper) => `'${process.execPath}' '${helper}'`);
});

test('PowerShell の実物でも 1 つの引数として渡る', { skip: !findShell('pwsh') }, () => {
  assertRoundTrip(findShell('pwsh'), ['-NoProfile', '-Command'], 'powershell', (helper) => `& '${process.execPath}' '${helper}'`);
});

test('cmd.exe の実物でも 1 つの引数として渡る', { skip: process.platform !== 'win32' }, () => {
  const paths = PATHS.filter((value) => quoteShellPath(value, 'cmd') !== null && !value.endsWith('\\'));
  withArgvHelper((helper) => {
    for (const value of paths) {
      const command = `""${process.execPath}" "${helper}" ${quoteShellPath(value, 'cmd')}"`;
      const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
        encoding: 'utf8',
        windowsVerbatimArguments: true,
      });
      assert.equal(result.status, 0, `${value}: ${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout), [value]);
    }
  });
});

test('cmd.exe は二重引用符で囲み、単一引用符を引用符として扱わない', () => {
  assert.equal(quoteShellPath("C:\\a b\\it's&c.txt", 'cmd'), '"C:\\a b\\it\'s&c.txt"');
});

test('fish と PowerShell は実物が無い環境でも引用の形を固定する', () => {
  assert.equal(quoteShellPath("a'\u2018\u2019\u201a\u201bb", 'powershell'), "'a''\u2018\u2018\u2019\u2019\u201a\u201a\u201b\u201bb'");
  assert.equal(quoteShellPath("a\\'b", 'fish'), "'a\\\\\\'b'");
});

test('cmd.exe では % と二重引用符を含むパスを入力しない', () => {
  assert.equal(quoteShellPath('C:\\100%.txt', 'cmd'), null);
  assert.equal(quoteShellPath('C:\\%PATH%.txt', 'cmd'), null);
  assert.equal(quoteShellPath('C:\\a"b.txt', 'cmd'), null);
});

test('制御文字を含むパスはどのシェルでも入力しない', () => {
  const values = ['/tmp/a\nb', '/tmp/a\rb', '/tmp/a\u0003b', '/tmp/a\u0015b', '/tmp/a\u001bb', '/tmp/a\u007fb', '/tmp/a\u009bb', '/tmp/a\u0000b'];
  for (const kind of ['posix', 'fish', 'powershell', 'cmd']) {
    for (const value of values) assert.equal(quoteShellPath(value, kind), null, JSON.stringify([kind, value]));
  }
});

test('文字列以外・空文字・未知の種類は入力しない', () => {
  assert.equal(quoteShellPath('', 'posix'), null);
  assert.equal(quoteShellPath(null, 'posix'), null);
  assert.equal(quoteShellPath('/tmp/a', 'unknown'), null);
});

test('入力できるパスだけを空白で連結し、対象外の件数を返す', () => {
  assert.deepEqual(buildFileDropText(['/tmp/a', '/tmp/b\rc', '/tmp/d e'], '/bin/zsh'), {
    text: "'/tmp/a' '/tmp/d e'",
    rejectedCount: 1,
  });
});

test('cmd.exe で 2 つのパスにまたがる % の対を作らない', () => {
  assert.deepEqual(buildFileDropText(['C:\\d\\x%USERNAME', 'C:\\d\\y%.txt'], 'cmd.exe'), {
    text: '',
    rejectedCount: 2,
  });
});

test('POSIX 系と判定できないシェルには何も入力しない', () => {
  assert.deepEqual(buildFileDropText(['/tmp/a'], '/bin/tcsh'), { text: '', rejectedCount: 1 });
});

test('シェルが分からないペインには何も入力しない', () => {
  assert.deepEqual(buildFileDropText(['/tmp/a'], undefined), { text: '', rejectedCount: 1 });
  assert.deepEqual(buildFileDropText('/tmp/a', '/bin/zsh'), { text: '', rejectedCount: 0 });
});

test('作業フォルダの移動はシェルに合うコマンドになる', () => {
  assert.equal(buildChangeDirectoryCommand("/tmp/it's", '/bin/zsh'), "cd -- '/tmp/it'\\''s'");
  assert.equal(buildChangeDirectoryCommand("/tmp/x\\'y", '/usr/bin/fish'), "cd -- '/tmp/x\\\\\\'y'");
  assert.equal(buildChangeDirectoryCommand("/tmp/a\u2019b", '/usr/bin/pwsh'), "Set-Location -LiteralPath '/tmp/a\u2019\u2019b'");
});

test('正しく表せない作業フォルダやシェルでは移動のコマンドを作らない', () => {
  assert.equal(buildChangeDirectoryCommand('/tmp/a\u0003b', '/bin/bash'), null);
  assert.equal(buildChangeDirectoryCommand('/tmp/a', '/bin/tcsh'), null);
  assert.equal(buildChangeDirectoryCommand('/tmp/a\\b', '/usr/bin/pwsh'), null);
  assert.equal(buildChangeDirectoryCommand('/tmp/FileSystem::a', '/usr/bin/pwsh'), null);
  assert.equal(buildChangeDirectoryCommand('relative', '/bin/bash'), null);
  assert.equal(buildChangeDirectoryCommand('~', '/usr/bin/pwsh'), null);
  assert.equal(buildChangeDirectoryCommand('C:\\a', 'cmd.exe'), null);
  assert.equal(buildChangeDirectoryCommand('/tmp/a', undefined), null);
  assert.equal(buildChangeDirectoryCommand(undefined, '/bin/bash'), null);
});

function assertChangesDirectory(shell, shellArgs, printDirectory, acceptsBackslash = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-shell-cd-'));
  try {
    const names = ["it's", "x\\'; touch marker; echo \\'y", 'a\u2019; touch marker; \u2019b', 'dir[1]', '$(touch marker)', '`touch marker`'];
    for (const name of names.filter((value) => acceptsBackslash || !value.includes('\\'))) {
      const directory = path.join(root, name);
      fs.mkdirSync(directory);
      const command = `${buildChangeDirectoryCommand(directory, shell)}; ${printDirectory}`;
      const result = spawnSync(shell, [...shellArgs, command], { encoding: 'utf8', cwd: root });
      assert.equal(result.status, 0, `${name}: ${result.stderr}`);
      assert.equal(fs.realpathSync(result.stdout.trim()), fs.realpathSync(directory));
      assert.equal(fs.existsSync(path.join(root, 'marker')), false, name);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

for (const shellName of ['bash', 'zsh', 'dash']) {
  test(`${shellName} の実物で作業フォルダを移動できる`, { skip: !findShell(shellName) }, () => {
    assertChangesDirectory(findShell(shellName), ['-c'], 'pwd');
  });
}

test('fish の実物で作業フォルダを移動できる', { skip: !findShell('fish') }, () => {
  assertChangesDirectory(findShell('fish'), ['--no-config', '-c'], 'pwd');
});

test('PowerShell の実物で作業フォルダを移動できる', { skip: !findShell('pwsh') }, () => {
  assertChangesDirectory(findShell('pwsh'), ['-NoProfile', '-Command'], '(Get-Location).ProviderPath', false);
});

test('restart-agent は移動のコマンドを共通の処理で作り、AI を止める準備より前に断る', () => {
  const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.doesNotMatch(mainSource, /cd -- /);
  const handler = mainSource.slice(mainSource.indexOf("url.pathname === '/api/restart-agent'"));
  const commandAt = handler.indexOf('buildChangeDirectoryCommand(request.cwd, ptyShellExecutables.get(request.termId))');
  const rejectedAt = handler.indexOf('changeDirectoryCommand === null');
  const launchAt = handler.indexOf('launchResolution = resolveCodexLaunchOptions(');
  const restartAt = handler.indexOf('restartAgentInTerminal(ptyProcess, request, launchOptions, lifecycleLaunch, changeDirectoryCommand)');
  assert.ok(commandAt >= 0 && rejectedAt > commandAt && launchAt > rejectedAt && restartAt > launchAt);
  const restartFunction = mainSource.slice(mainSource.indexOf('async function restartAgentInTerminal'));
  assert.match(restartFunction, /ptyProcess\.write\(`\$\{changeDirectoryCommand\}\\r`\)/);
});
