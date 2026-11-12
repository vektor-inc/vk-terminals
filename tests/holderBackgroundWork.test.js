'use strict';

// 保持役（tmux）を使うときのバックグラウンド作業の接続情報の保存・復元（issue #587）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const {
  isPrivateFile, writePrivateJson, bindToHolderPane, restoreHolderConnection, revokeStaleHolderDirectories, parseHolderOwner,
} = require('../utils/holderBackgroundWork');
const { createBackgroundWorkStore, SUBAGENT_TTL_MS } = require('../utils/backgroundWork');
const { createAgentLifecycleStore } = require('../utils/agentLifecycle');
const { cleanupBackgroundWorkSettings } = require('../utils/claudeSettingsPreset');

const START = 'Fri Nov 6 12:00:00 2026';
const OTHER_START = 'Fri Nov 6 13:00:00 2026';
const EPOCH = 'a'.repeat(48);
const row = (pid, ppid, pgid, tpgid, stat = 'S', lstart = START) => ({ pid, ppid, pgid, tpgid, stat, lstart });
const table = (...rows) => new Map(rows.map(process => [process.pid, process]));
const identity = { paneId: '%3', pid: 100, windowId: '@3' };
const shellOnly = () => table(row(1, 0, 1, 0), row(100, 1, 100, 200), row(200, 100, 200, 200), row(201, 200, 200, 200));
const config = { token: 'new-token', url: 'http://127.0.0.1:2/api/background-work' };

// 再起動前のアプリが作った状態（0700 のフォルダに 0600 のファイル）を用意する。
function savedPane(t, { owner = {}, connection = {} } = {}) {
  const dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk587-')));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const name = 'background-work-abc123';
  const directory = path.join(dataDir, name);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ termId: '5', epoch: EPOCH, token: 'old-token', url: 'http://127.0.0.1:1/api/background-work', ...connection }), { mode: 0o600, flag: 'wx' });
  bindToHolderPane(directory, { termId: '5', generation: 2, tmuxPaneId: '%3', panePid: 100, paneLstart: START, ...owner });
  return { dataDir, name, directory };
}

function restore(saved, overrides = {}) {
  return restoreHolderConnection({ dataDir: saved.dataDir, name: saved.name, identity, termId: '5', generation: 2, config, processes: shellOnly(), ...overrides });
}

function readConnection(directory) {
  return JSON.parse(fs.readFileSync(path.join(directory, 'connection.json'), 'utf8'));
}

function assertPrivate(directory) {
  assert.equal(fs.lstatSync(directory).mode & 0o777, 0o700);
  for (const name of ['owner.json', 'connection.json']) assert.equal(isPrivateFile(path.join(directory, name)), true, name);
}

test('検査を通った接続情報は、保存した合言葉のまま受け口の接続先とトークンだけを今の値へ合わせる', t => {
  const saved = savedPane(t);
  const result = restore(saved);
  assert.equal(result.restored, true);
  assert.equal(result.epoch, EPOCH);
  assert.deepEqual(readConnection(saved.directory), { termId: '5', token: 'new-token', url: config.url, epoch: EPOCH });
  assertPrivate(saved.directory);
});

test('権限が緩んだ合言葉のファイルは読まずに失効させ、同じ場所へ新しい合言葉で作り直す', t => {
  for (const [label, file, mode] of [['connection.json が 0644', 'connection.json', 0o644], ['connection.json が 0640', 'connection.json', 0o640], ['owner.json が 0604', 'owner.json', 0o604]]) {
    const saved = savedPane(t);
    fs.chmodSync(path.join(saved.directory, file), mode);
    const result = restore(saved);
    assert.equal(result.restored, false, label);
    assert.notEqual(result.epoch, EPOCH, label);
    assert.equal(readConnection(saved.directory).epoch, result.epoch, label);
    assertPrivate(saved.directory);
  }
});

test('フォルダの権限が 0700 でない場合も復元しない（chmod で直して使い続けない）', t => {
  const saved = savedPane(t);
  fs.chmodSync(saved.directory, 0o750);
  const result = restore(saved);
  assert.equal(result.restored, false);
  assert.notEqual(result.epoch, EPOCH);
  assertPrivate(saved.directory);
});

test('シンボリックリンクにされた合言葉のファイルは読まず、リンク先にも触れずに作り直す', t => {
  const saved = savedPane(t);
  const outside = path.join(saved.dataDir, 'outside.json');
  fs.writeFileSync(outside, JSON.stringify({ termId: '5', epoch: 'b'.repeat(48), token: 'x', url: 'x' }), { mode: 0o600 });
  fs.rmSync(path.join(saved.directory, 'connection.json'));
  fs.symlinkSync(outside, path.join(saved.directory, 'connection.json'));
  const result = restore(saved);
  assert.equal(result.restored, false);
  assert.notEqual(result.epoch, 'b'.repeat(48));
  assert.equal(fs.lstatSync(path.join(saved.directory, 'connection.json')).isSymbolicLink(), false);
  assert.equal(JSON.parse(fs.readFileSync(outside, 'utf8')).epoch, 'b'.repeat(48));
  assertPrivate(saved.directory);
});

test('シンボリックリンクにされたフォルダはリンクだけを消し、リンク先のフォルダは残す', t => {
  const saved = savedPane(t);
  const elsewhere = path.join(saved.dataDir, 'elsewhere');
  fs.renameSync(saved.directory, elsewhere);
  fs.symlinkSync(elsewhere, saved.directory);
  const result = restore(saved);
  assert.equal(result.restored, false);
  assert.notEqual(result.epoch, EPOCH);
  assert.equal(fs.lstatSync(saved.directory).isSymbolicLink(), false);
  assert.equal(JSON.parse(fs.readFileSync(path.join(elsewhere, 'connection.json'), 'utf8')).epoch, EPOCH);
  assertPrivate(saved.directory);
});

test('世代番号・ペイン・シェルの起動時刻のどれかが違えば、古い合言葉を失効させる', t => {
  const cases = [
    ['世代番号が上がった', { generation: 3 }],
    ['別のペイン', { identity: { ...identity, paneId: '%4' } }],
    ['シェルが入れ替わった', { processes: table(row(1, 0, 1, 0), row(100, 1, 100, 0, 'S', OTHER_START)) }],
  ];
  for (const [label, overrides] of cases) {
    const saved = savedPane(t);
    const result = restore(saved, overrides);
    assert.equal(result.restored, false, label);
    assert.notEqual(result.epoch, EPOCH, label);
  }
});

test('ペインのシェルが見つからなければ失効だけを行い、接続情報を残さない', t => {
  const saved = savedPane(t);
  const result = restore(saved, { processes: table(row(1, 0, 1, 0)) });
  assert.equal(result.restored, false);
  assert.equal(result.directory, null);
  assert.equal(fs.existsSync(saved.directory), false);
});

test('フォルダ名が想定の形でなければ何も読まない', t => {
  const saved = savedPane(t);
  for (const name of [null, '../background-work-abc123', 'background-work-a/b']) {
    const result = restore(saved, { name });
    assert.equal(result.restored, false);
    assert.equal(result.directory, null);
  }
  assert.equal(readConnection(saved.directory).epoch, EPOCH);
});

test('書く前にも検査し、権限が緩んだ既存のファイルへは書かない', t => {
  const saved = savedPane(t);
  fs.chmodSync(path.join(saved.directory, 'owner.json'), 0o644);
  assert.throws(() => writePrivateJson(saved.directory, 'owner.json', {}), /unsafe background work file/);
  fs.chmodSync(path.join(saved.directory, 'owner.json'), 0o600);
  fs.chmodSync(saved.directory, 0o755);
  assert.throws(() => writePrivateJson(saved.directory, 'owner.json', {}), /unsafe background work directory/);
});

test('起動時の掃除は、持ち主の保持役のペインが残っている接続情報を消さない', async t => {
  const live = savedPane(t);
  const dead = path.join(live.dataDir, 'background-work-dead1');
  fs.mkdirSync(dead, { mode: 0o700 });
  bindToHolderPane(dead, { termId: '6', generation: 1, tmuxPaneId: '%9', panePid: 2147483646, paneLstart: START });
  await cleanupBackgroundWorkSettings(live.dataDir, async () => table(row(100, 1, 100, 0)));
  assert.equal(fs.existsSync(live.directory), true);
  assert.equal(fs.existsSync(dead), false);
});

test('復元に使わなかった生存ペインの古い接続情報は失効させ、他のペインのものは残す', t => {
  const saved = savedPane(t);
  const stale = path.join(saved.dataDir, 'background-work-stale1');
  fs.mkdirSync(stale, { mode: 0o700 });
  bindToHolderPane(stale, { termId: '5', generation: 1, tmuxPaneId: '%3', panePid: 100, paneLstart: START });
  const other = path.join(saved.dataDir, 'background-work-other1');
  fs.mkdirSync(other, { mode: 0o700 });
  bindToHolderPane(other, { termId: '7', generation: 1, tmuxPaneId: '%7', panePid: 700, paneLstart: START });
  revokeStaleHolderDirectories(saved.dataDir, new Set([saved.name]), new Set([100]));
  assert.equal(fs.existsSync(saved.directory), true);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(other), true);
});

test('持ち主の記録は秘密でない値だけを受け付け、不正な値を捨てる', () => {
  const owner = { holder: 'tmux', termId: '5', generation: 2, tmuxPaneId: '%3', panePid: 100, paneLstart: START };
  assert.deepEqual(parseHolderOwner({ ...owner, agents: [[200, START], ['x', START], [201, 'bad']], session: 's1', project: '-tmp' }).agents, [[200, START]]);
  assert.equal(parseHolderOwner({ ...owner, session: 's1', project: '..' }).session, undefined);
  assert.equal(parseHolderOwner({ ...owner, holder: 'process' }), null);
  assert.equal(parseHolderOwner({ ...owner, tmuxPaneId: '3' }), null);
});

test('再起動後は保存した合言葉で受け口を作り直し、記録ファイルの更新時刻でサブエージェントを見直す', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk587-home-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const subagents = path.join(home, '.claude', 'projects', '-tmp', 'session1', 'subagents');
  fs.mkdirSync(subagents, { recursive: true });
  const now = Date.now();
  const write = (name, mtime) => { const file = path.join(subagents, name); fs.writeFileSync(file, '{}\n'); fs.utimesSync(file, mtime / 1000, mtime / 1000); };
  write('agent-recent.jsonl', now - 1000);
  write('agent-old.jsonl', now - SUBAGENT_TTL_MS - 1000);
  write('agent-done.jsonl', now - 1000);
  fs.writeFileSync(path.join(subagents, 'agent-done.meta.json'), JSON.stringify({ finished: true }));
  write('not-an-agent.jsonl', now);
  const entry = { state: 'running', shellPid: 100, trackedGroups: new Map() };
  const store = createBackgroundWorkStore({ getEntry: () => entry, homeDir: home, now: () => now, listProcesses: async () => table(row(100, 1, 100, 0)) });
  store.restore('5', 2, EPOCH, { session: 'session1', project: '-tmp' });
  // 閉じていた間に始まり、まだ動いているものだけを数える。
  const transcript = path.join(home, '.claude', 'projects', '-tmp', 'session1.jsonl');
  const stop = agentId => store.recordHookEvent({ termId: '5', epoch: EPOCH, input: { hook_event_name: 'SubagentStop', agent_id: agentId, session_id: 'session1', transcript_path: transcript } });
  assert.equal(store.recordHookEvent({ termId: '5', epoch: 'b'.repeat(48), input: { hook_event_name: 'SubagentStop', agent_id: 'recent', session_id: 'session1', transcript_path: transcript } }), false);
  assert.equal(store.isRunning('5'), false);
  assert.equal(store.recordHookEvent({ termId: '5', epoch: EPOCH, input: { hook_event_name: 'SessionStart', session_id: 'session1', transcript_path: transcript } }), true);
  assert.equal(store.isRunning('5'), true);
  assert.equal(stop('recent'), true);
  assert.equal(store.isRunning('5'), false);
});

test('セッションが変わったときに、次の起動で見直すためのセッションを知らせる', () => {
  const sessions = [];
  const store = createBackgroundWorkStore({ getEntry: () => ({ state: 'running' }), homeDir: '/home/test', onSession: (...args) => sessions.push(args), readEvidence: () => ({}) });
  const epoch = store.begin('5', 2);
  const input = { hook_event_name: 'SubagentStart', agent_id: 'a1', session_id: 's1', transcript_path: '/home/test/.claude/projects/-tmp/s1.jsonl' };
  store.recordHookEvent({ termId: '5', epoch, input });
  store.recordHookEvent({ termId: '5', epoch, input: { ...input, agent_id: 'a2' } });
  assert.deepEqual(sessions, [['5', 2, { session: 's1', project: '-tmp' }]]);
});

test('生死の記録は、保存した AI 本体の PID と起動時刻から作り直し、終了したら exited になる', async () => {
  let processes = shellOnly();
  const timers = [];
  const store = createAgentLifecycleStore({ platform: 'darwin', listProcesses: async () => processes, setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer: () => {} });
  store.initialize('5', 2);
  assert.equal(store.restore('5', 2, 100, processes, [[200, START], [201, START]]), true);
  assert.equal(store.get('5', 2), 'running');
  assert.deepEqual(store.trackedIdentities('5', 2).sort(), [[200, START], [201, START]]);
  // 起動時刻が違う同じ PID は別のプロセスとして扱う。
  store.initialize('5', 2);
  assert.equal(store.restore('5', 2, 100, processes, [[200, OTHER_START]]), false);
  assert.equal(store.get('5', 2), null);
  // 終了の合図は分からないため、追跡中のプロセスが消えたら次の確認で終わったと判断する。
  store.initialize('5', 2);
  store.restore('5', 2, 100, processes, [[200, START]]);
  processes = table(row(1, 0, 1, 0), row(100, 1, 100, 100));
  await timers.pop()();
  assert.equal(store.get('5', 2), 'exited');
});

test('保存した記録が無い場合は、シェルの前面のプロセスグループから作り直す', () => {
  const store = createAgentLifecycleStore({ platform: 'darwin', listProcesses: async () => shellOnly(), setTimer: () => 1, clearTimer: () => {} });
  store.initialize('5', 2);
  assert.equal(store.restore('5', 2, 100, shellOnly()), true);
  assert.equal(store.get('5', 2), 'running');
  // シェルが前面にいる（AI 本体がいない）場合は作り直さない。
  store.initialize('5', 2);
  assert.equal(store.restore('5', 2, 100, table(row(1, 0, 1, 0), row(100, 1, 100, 100))), false);
  // 世代が違う記録は作り直さない。
  assert.equal(store.restore('5', 3, 100, shellOnly()), false);
});

// main.js の終了処理だけを取り出して、保持役の有無による違いを確かめる。
function loadMainFunctions() {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const pick = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  return [
    pick('function clearPaneBackgroundWork(', '// 新設定の準備中は'),
    pick('function finalizeBeforeQuit()', "app.on('before-quit'"),
  ].join('\n');
}

function runFinalize(settings) {
  const discarded = [];
  const context = { backgroundSettings: settings, backgroundWork: { delete() {} }, stopWidgetWatcher() {}, clearInterval() {}, backgroundWorkTimer: null, fs: { unlinkSync() {} }, STATE_FILE: '', httpServer: null, agentLifecycles: { close: async () => {} }, console, LOG_PREFIX: '' };
  for (const [id, prepared] of settings) prepared.discard = () => discarded.push(id);
  vm.createContext(context);
  vm.runInContext(loadMainFunctions(), context);
  context.finalizeBeforeQuit();
  return discarded;
}

test('オプションが無いときは、終了処理で接続情報をすべて消す（従来どおり）', () => {
  const settings = new Map([['1', {}], ['2', {}]]);
  assert.deepEqual(runFinalize(settings), ['1', '2']);
  assert.equal(settings.size, 0);
});

test('保持役のペインの接続情報は終了処理で消さず、保持役に乗らなかったペインのものだけを消す', () => {
  const settings = new Map([['1', { holderBound: true }], ['2', {}]]);
  assert.deepEqual(runFinalize(settings), ['2']);
  assert.equal(settings.has('1'), true);
});

test('復元できなかったペインを画面から外すときは、接続情報のファイルを残す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const abandon = source.slice(source.indexOf("ipcMain.on('terminal:restore-abandon'"), source.indexOf("ipcMain.handle('terminal:create'"));
  assert.match(abandon, /clearPaneBackgroundWork\(id, \{ keepFiles: true \}\)/);
  const discarded = [];
  const settings = new Map([['1', { discard: () => discarded.push('1') }]]);
  const context = { backgroundSettings: settings, backgroundWork: { delete() {} } };
  vm.createContext(context);
  vm.runInContext(loadMainFunctions(), context);
  context.clearPaneBackgroundWork('1', { keepFiles: true });
  assert.deepEqual(discarded, []);
  assert.equal(settings.has('1'), false);
});

test('tmux 実物: 秘密でない値（フォルダ名と世代番号）だけをペインに置き、一覧で読み戻せる', t => {
  const { TmuxHolder } = require('../utils/paneHolder');
  const tmux = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'tmux')).find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; } });
  if (!tmux) { t.skip('tmux is unavailable'); return; }
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk587-tmux-')));
  const env = { HOME: dir, PATH: process.env.PATH || '/usr/bin:/bin', VK_TERMINALS_HOLDER_RUN_DIR: dir };
  let holder;
  try {
    holder = new TmuxHolder({ env, home: dir, tmux });
    const pane = holder.createPane({ shell: '/bin/sh', cwd: dir, env, termId: '7' });
    assert.deepEqual(holder.listPanes().find(item => item.paneId === pane.paneId), { paneId: pane.paneId, pid: pane.pid, windowId: pane.windowId, termId: '7', backgroundWorkDir: null, agentGeneration: null });
    holder.setBackgroundWorkValues(pane.windowId, { backgroundWorkDir: 'background-work-abc123', agentGeneration: 3 });
    const listed = holder.listPanes().find(item => item.paneId === pane.paneId);
    assert.equal(listed.backgroundWorkDir, 'background-work-abc123');
    assert.equal(listed.agentGeneration, 3);
    assert.throws(() => holder.setBackgroundWorkValues(pane.windowId, { backgroundWorkDir: '../x', agentGeneration: 3 }), /invalid background work directory name/);
    holder.setBackgroundWorkValues(pane.windowId, { backgroundWorkDir: null, agentGeneration: 4 });
    assert.equal(holder.listPanes().find(item => item.paneId === pane.paneId).backgroundWorkDir, null);
  } finally {
    try { holder?.close(); } catch (_) {}
    try { execFileSync(tmux, ['-S', path.join(dir, 'tmux.sock'), 'kill-server'], { env, stdio: 'ignore' }); } catch (_) {}
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
