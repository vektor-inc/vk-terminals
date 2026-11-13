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

for (const suffix of ['\x1b=', '\x1b(B', '\x1b]133;B\x1b\\']) {
  test(`短い制御シーケンスと複数 OSC を除いてプロンプトを検知する: ${JSON.stringify(suffix)}`, { timeout: 1000 }, async () => {
    const observer = createObserver();
    observer.listeners.get('data')(`\x1b]0;title\x1b\\PS /tmp> ${suffix}`);
    observer.input('\x1b[1;1R');
    assert.equal((await observer.ready).status, 'ready');
  });
}

test('プロンプトの後に別の出力が来たら位置応答を受け付けない', async () => {
  const observer = createObserver();
  let resolved = false;
  observer.ready.then(() => { resolved = true; });
  observer.listeners.get('data')('PS sample> ');
  observer.listeners.get('data')('loading...\r\n');
  observer.input('\x1b[1;1R');
  await Promise.resolve();
  assert.equal(resolved, false);
  observer.expire();
  assert.equal((await observer.ready).status, 'timeout');
  observer.input('\x1b[1;1R');
  assert.equal(observer.listeners.size, 0);
});

test('時間切れの解決値に通常入力の有無を残す（位置応答は除外）', async () => {
  for (const input of ['ssh host\r', '\x1b[1;1R']) {
    const observer = createObserver();
    observer.input(input);
    observer.expire();
    assert.deepEqual(await observer.ready, { status: 'timeout', userInput: input.startsWith('ssh') });
  }
});

// 配線は実際の main.js の文を実行し、生成・登録・引き渡しをまとめて検証する。
test('main の監視生成と WeakMap 登録、遅延起動への引き渡し', () => {
  const source = require('node:fs').readFileSync(require.resolve('../main.js'), 'utf8');
  const vm = require('node:vm');
  const context = {
    ptyProcess: {}, shell: '/tmp/pwsh', shellStartupReadiness: new WeakMap(),
    observePowerShellReady: (pty, shell) => {
      assert.equal(pty, context.ptyProcess);
      assert.equal(shell, context.shell);
      return { ready: Promise.resolve() };
    },
    ptys: new Map(), id: '1', launchCommand: 'claude', initialLaunchToken: {},
    agentLifecycles: {}, discardFailedLaunch() {}, guideLaunchSucceeded() {},
    scheduleLaunchCommand: (options) => {
      assert.ok(options.shellReady instanceof Promise);
      assert.equal(options.shellReady, context.shellStartupReadiness.get(context.ptyProcess));
    },
  };
  const start = source.indexOf('  const shellStartup = observePowerShellReady(');
  const end = source.indexOf('\n\n', start);
  const launch = source.indexOf('    scheduleLaunchCommand({', end);
  const launchEnd = source.indexOf('\n    });', launch) + '\n    });'.length;
  vm.runInNewContext(source.slice(start, end) + '\n' + source.slice(launch, launchEnd), context);
});

for (const userInput of [false, true]) {
  test(`main の initialCommand は準備完了後に待ち始め、時間切れと入力が重なったら中止: ${userInput}`, async () => {
    const source = require('node:fs').readFileSync(require.resolve('../main.js'), 'utf8');
    const start = source.indexOf('    const startInitialCommandTimer =');
    const end = source.indexOf('\n\n    promptWatcher =', start);
    let release;
    const shellReady = new Promise((resolve) => { release = resolve; });
    const timers = [];
    const ptyProcess = {};
    const watcher = () => {};
    const context = { promptWatcher: watcher, promptWatcherTimeoutId: null };
    const sandbox = {
      shellReady, ptys: new Map([['1', ptyProcess]]), id: '1', ptyProcess,
      isFirstTerminal: true, config: { initialCommand: 'hello' }, resolvedEngine: 'claude',
      WATCH_TIMEOUT_MS: 10000, setTimeout: (callback, delay) => timers.push({ callback, delay }),
      ...context,
      stopWatchingIfDone() {},
    };
    require('node:vm').runInNewContext(source.slice(start, end), sandbox);
    assert.equal(timers.length, 0);
    release({ status: 'timeout', userInput });
    await Promise.resolve();
    assert.equal(timers.length, userInput ? 0 : 1);
    assert.equal(sandbox.promptWatcher, userInput ? null : watcher);
    if (!userInput) assert.equal(timers[0].delay, 10000);
  });
}

// PTY の登録より先に監視を設定する、terminal:create の実際の順序を再現する。
function createInitialCommandWatcher({ shellReady = null, engine = 'claude' } = {}) {
  const source = require('node:fs').readFileSync(require.resolve('../main.js'), 'utf8');
  const start = source.indexOf('    const config = isFirstTerminal ? loadUserConfig() : {};');
  const end = source.indexOf('\n    // restartAgentInTerminal が同じ pty', start);
  const timers = new Map();
  const writes = [];
  const warnings = [];
  let nextTimer = 0;
  const context = {
    shellReady, ptys: new Map(), id: '1', ptyProcess: { write: (data) => writes.push(data) },
    isFirstTerminal: true, loadUserConfig: () => ({ initialCommand: 'hello' }), resolvedEngine: engine,
    promptWatcher: null, promptWatcherTimeoutId: null, spawnTime: 0, taskPolicyLaunch: false,
    RESOLVED_TRUST_WINDOW_MS: 30000, RESOLVED_READY_GRACE_MS: 1000, WATCH_TIMEOUT_MS: 10000,
    LOG_PREFIX: 'test', performance: { now: () => 0 }, stripAnsiForPattern: (data) => data,
    READY_PATTERN: /READY/, console: { log() {}, warn: (message) => warnings.push(message) },
    createTrustPromptGate: () => ({
      shouldStopWatching: () => false, canAutoRespondToPrompt: (buffer) => buffer.includes('TRUST'),
      markTrustHandled() {}, markReadyDetected() {}, disableDelayedRestrictedResponse() {},
    }),
    setTimeout: (callback, delay) => { timers.set(++nextTimer, { callback, delay }); return nextTimer; },
    clearTimeout: (id) => timers.delete(id),
  };
  require('node:vm').runInNewContext(source.slice(start, end), context);
  return { context, timers, writes, warnings, register: () => context.ptys.set('1', context.ptyProcess),
    output: (data) => { if (context.promptWatcher) context.promptWatcher(data); } };
}

for (const engine of ['claude', 'codex']) {
  test(`shellReady なしでは PTY 登録前にタイマーを1本設定する: ${engine}`, () => {
    const watcher = createInitialCommandWatcher({ engine });
    assert.equal(watcher.context.ptys.size, 0);
    assert.equal(watcher.timers.size, 1);
    assert.equal([...watcher.timers.values()][0].delay, 10000);
    watcher.register();
    [...watcher.timers.values()][0].callback();
    assert.deepEqual(watcher.writes, engine === 'claude' ? ['hello\r'] : []);
    assert.equal(watcher.warnings.length, 1);
    // Codex は時間切れ後でも ready を検知すれば送信できる。
    if (engine === 'codex') {
      watcher.output('READY');
      assert.deepEqual(watcher.writes, ['hello\r']);
    }
  });
}

for (const closed of [false, true]) {
  test(`準備待ち中の PTY 登録・閉鎖後にタイマーを照合する: ${closed}`, async () => {
    let release;
    const watcher = createInitialCommandWatcher({ shellReady: new Promise((resolve) => { release = resolve; }) });
    assert.equal(watcher.timers.size, 0);
    watcher.register();
    if (closed) watcher.context.ptys.delete('1');
    release({ status: 'ready', userInput: false });
    await Promise.resolve();
    assert.equal(watcher.timers.size, closed ? 0 : 1);
  });
}

for (const trustBeforeCancel of [false, true]) {
  test(`中止後の ready 出力では送信せず、既存タイマーも解放する: ${trustBeforeCancel}`, async () => {
    let release;
    const watcher = createInitialCommandWatcher({ shellReady: new Promise((resolve) => { release = resolve; }) });
    watcher.register();
    if (trustBeforeCancel) watcher.output('TRUST');
    assert.equal(watcher.timers.size, trustBeforeCancel ? 1 : 0);
    watcher.writes.length = 0;
    release({ status: 'timeout', userInput: true });
    await Promise.resolve();
    assert.equal(watcher.context.promptWatcher, null);
    assert.equal(watcher.context.promptWatcherTimeoutId, null);
    assert.equal(watcher.timers.size, 0);
    watcher.output('READY');
    assert.deepEqual(watcher.writes, []);
  });
}

// initialCommand の対象は起動時に通常の初期ペインとして作った場合だけ。
for (const [initialPane, expected] of [[false, false], [true, true]]) {
  test(`initialCommand 対象の判定: initialPane=${initialPane}`, () => {
    const source = require('node:fs').readFileSync(require.resolve('../main.js'), 'utf8');
    const line = source.match(/const isFirstTerminal = ([^;]+);/)[1];
    const isFirstTerminal = require('node:vm').runInNewContext(line, {
      options: { initialPane }, firstTerminalCreated: false, setupLaunch: false, guideLaunch: false,
    });
    assert.equal(isFirstTerminal, expected);
  });
}
