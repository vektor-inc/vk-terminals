const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { pickTerminalShell } = require('../utils/terminalShell');

function pickLinux(env, userInfo, existing) {
  return pickTerminalShell({
    platform: 'linux',
    env,
    userInfo,
    isExecutableShell: (candidate) => existing.includes(candidate),
  });
}

test('Linux: SHELL が無ければログインシェルを使う', () => {
  assert.equal(pickLinux({}, { shell: '/bin/fish' }, ['/bin/fish']), '/bin/fish');
});

test('Linux: 実行可能な SHELL はログインシェルより優先する', () => {
  assert.equal(pickLinux({ SHELL: '/bin/zsh' }, { shell: '/bin/fish' }, ['/bin/zsh', '/bin/fish']), '/bin/zsh');
});

test('Linux: 制御文字を含む候補は飛ばす', () => {
  assert.equal(pickLinux({ SHELL: '/bin/zsh\n' }, { shell: '/bin/fish' }, ['/bin/zsh\n', '/bin/fish']), '/bin/fish');
  assert.equal(pickLinux({}, { shell: '/bin/fish\u007f' }, ['/bin/fish\u007f', '/bin/bash']), '/bin/bash');
});

test('Linux: SHELL とログインシェルが無ければ /bin/bash を使う', () => {
  assert.equal(pickLinux({}, {}, ['/bin/bash', '/bin/sh']), '/bin/bash');
});

test('Linux: userInfo が null でも /bin/bash へフォールバックする', () => {
  assert.equal(pickLinux({}, null, ['/bin/bash', '/bin/sh']), '/bin/bash');
});

test('Linux: SHELL が相対パスまたは存在しない場合は次の候補を使う', () => {
  assert.equal(pickLinux({ SHELL: '/missing/zsh' }, { shell: '/bin/fish' }, ['/bin/fish']), '/bin/fish');
  assert.equal(pickLinux({ SHELL: 'zsh' }, { shell: '/bin/fish' }, ['zsh', '/bin/fish']), '/bin/fish');
});

test('Linux: 全候補が使えない場合は探した候補を含むエラーを投げる', () => {
  assert.throws(
    () => pickLinux({ SHELL: '/missing/zsh' }, { shell: '/missing/fish' }, []),
    /No executable shell found\. Searched: \/missing\/zsh, \/missing\/fish, \/bin\/bash, \/bin\/sh/,
  );
});

test('macOS と Windows は従来の選択順を維持する', () => {
  const neverExists = () => false;
  assert.equal(pickTerminalShell({ platform: 'darwin', env: { SHELL: 'zsh' }, userInfo: {}, isExecutableShell: neverExists }), 'zsh');
  assert.equal(pickTerminalShell({ platform: 'darwin', env: {}, userInfo: {}, isExecutableShell: neverExists }), '/bin/zsh');
  assert.equal(pickTerminalShell({ platform: 'win32', env: { SHELL: 'bash', COMSPEC: 'cmd.exe' }, userInfo: {}, isExecutableShell: neverExists }), 'bash');
  assert.equal(pickTerminalShell({ platform: 'win32', env: { COMSPEC: 'cmd.exe' }, userInfo: {}, isExecutableShell: neverExists }), 'cmd.exe');
  assert.equal(pickTerminalShell({ platform: 'win32', env: {}, userInfo: {}, isExecutableShell: neverExists }), 'powershell.exe');
});

test('main.js の terminal:create は選択したシェルを spawn と restart 用 Map に使う', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  const start = source.indexOf("ipcMain.handle('terminal:create'");
  const end = source.indexOf("ipcMain.on('terminal:input'", start);
  const handler = source.slice(start, end);
  assert.match(handler, /const shell = pickTerminalShell\(\{/);
  assert.ok(handler.indexOf('const shell = pickTerminalShell({') < handler.indexOf('const id = String(nextId++);'));
  assert.match(handler, /if \(process\.platform !== 'darwin' && process\.platform !== 'win32'\) \{[\s\S]*?userInfo = os\.userInfo\(\);/);
  assert.match(handler, /pty\.spawn\(shell,/);
  assert.match(source, /function registerTerminalProcess[\s\S]*?ptyShellExecutables\.set\(id, shell\)/);
  assert.match(handler, /registerTerminalProcess\(id, ptyProcess, shell,/);
});
