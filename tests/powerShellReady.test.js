const test = require('node:test');
const assert = require('node:assert/strict');
const { observePowerShellReady } = require('../utils/powerShellReady');

function createObserver(shell = '/tmp/pwsh', platform = 'darwin') {
  const listeners = new Map();
  let timeout;
  let cleared = false;
  const subscribe = (name, callback) => {
    listeners.set(name, callback);
    return { dispose: () => listeners.delete(name) };
  };
  const startup = observePowerShellReady({
    onData: (callback) => subscribe('data', callback),
    onExit: (callback) => subscribe('exit', callback),
  }, shell, { platform, setTimer: (callback) => { timeout = callback; return 1; }, clearTimer: () => { cleared = true; } });
  return { ready: startup?.ready ?? null, input: (data) => startup?.onInput(data), listeners, expire: () => timeout(), cleared: () => cleared };
}

test('起動バナーやプロンプトだけでは解放せず、位置照会への応答まで待つ', async () => {
  const observer = createObserver();
  let ready = false;
  observer.ready.then(() => { ready = true; });
  observer.listeners.get('data')('PowerShell 7.6.9\r\n');
  observer.input('\x1b[1;1R');
  await Promise.resolve();
  assert.equal(ready, false);
  observer.listeners.get('data')('\x1b[32mP');
  observer.listeners.get('data')('S /tmp');
  observer.listeners.get('data')('> \x1b[0m');
  await Promise.resolve();
  assert.equal(ready, false);
  observer.input('\x1b[3;40R');
  await observer.ready;
  assert.equal(observer.listeners.size, 0);
  assert.equal(observer.cleared(), true);
});

for (const event of ['exit', 'timeout']) {
  test(`${event} でも待機と監視を解放する`, async () => {
    const observer = createObserver();
    if (event === 'exit') observer.listeners.get('exit')();
    else observer.expire();
    await observer.ready;
    assert.equal(observer.listeners.size, 0);
    assert.equal(observer.cleared(), true);
  });
}

test('Windows と bash・zsh・fish では監視も待機も追加しない', () => {
  for (const shell of ['bash', 'zsh', 'fish']) assert.equal(createObserver(shell).ready, null);
  assert.equal(createObserver('pwsh.exe', 'win32').ready, null);
});

for (const closed of [false, true]) {
  test(`再起動も初期プロンプトを待ち、閉じた PTY は操作しない: ${closed}`, async () => {
    const fs = require('node:fs');
    const vm = require('node:vm');
    const source = fs.readFileSync(require.resolve('../main.js'), 'utf8');
    const start = source.indexOf('async function restartAgentInTerminal(');
    const end = source.indexOf('  if (!stopped) return false;', start);
    let resolveReady;
    const ready = new Promise((resolve) => { resolveReady = resolve; });
    const ptyProcess = { pid: 123 };
    const ptys = new Map([['1', ptyProcess]]);
    const events = [];
    // 停止処理までの実コードを使い、準備待ちより先に旧起動を取り消すことも確かめる。
    const restart = vm.runInNewContext(`(${source.slice(start, end)} return stopped; })`, {
      shellStartupReadiness: new WeakMap([[ptyProcess, ready]]), ptys,
      stopAgentChildren: async () => { events.push('stop'); return false; },
      process: { platform: 'darwin' }, listProcessesForRestart() {},
    });
    const result = restart(ptyProcess, { termId: '1' }, {}, { cancelPending: () => events.push('cancel') });
    await Promise.resolve();
    assert.deepEqual(events, ['cancel']);
    if (closed) ptys.delete('1');
    resolveReady();
    assert.equal(await result, false);
    assert.deepEqual(events, closed ? ['cancel'] : ['cancel', 'stop']);
  });
}
