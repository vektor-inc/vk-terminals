'use strict';

const { quoteShellPath } = require('../utils/shellQuoting');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createBackgroundWorkStore, inspectBackgroundProcesses, agentTranscriptPaths, readAgentEvidence, SUBAGENT_TTL_MS } = require('../utils/backgroundWork');
const { deriveStatus, deriveDisplayStatus } = require('../renderer/statusState');
const { getStatusPresentation } = require('../renderer/statusPresentation');

const start = 'Fri Nov 6 12:00:00 2026';
const root = { pid: 10, ppid: 1, pgid: 10, tpgid: 10, stat: 'S', lstart: start };
const snapshot = { state: 'running', shellPid: 1, trackedGroups: new Map([[10, new Map([[10, start]])]]) };
function table(background = true) {
  const items = [root, { pid: 11, ppid: 10, pgid: 10, tpgid: 10, stat: 'S', lstart: start }];
  if (background) items.push({ pid: 20, ppid: 10, pgid: 20, tpgid: 0, stat: 'S', lstart: start }, { pid: 21, ppid: 20, pgid: 20, tpgid: 0, stat: 'S', lstart: start });
  return new Map(items.map(p => [p.pid, p]));
}
const input = { agent_id: 'agent123', session_id: 'session123', transcript_path: '/home/test/.claude/projects/-tmp/session123.jsonl', hook_event_name: 'SubagentStart' };
function fixture(overrides = {}) {
  let clock = 1000000, processes = table(false), evidence = {}, current = snapshot;
  const changes = [];
  const store = createBackgroundWorkStore({ getEntry: () => current, listProcesses: async () => { if (!processes) throw Error('ps failed'); return processes; }, homeDir: '/home/test', now: () => clock, readEvidence: () => evidence, onChange: (...args) => changes.push(args), ...overrides });
  const epoch = store.begin('pane', 1);
  return { store, epoch, changes, recordHookEvent: (event = {}) => store.recordHookEvent({ termId: 'pane', epoch, input: { ...input, ...event } }), advance: ms => { clock += ms; }, processes: value => { processes = value; }, evidence: value => { evidence = value; }, snapshot: value => { current = value; } };
}

test('コマンドは連続した確認後に実行中になり、終了時は直ちに解除する（孫も追跡）', async () => {
  const f = fixture(); f.processes(table());
  await f.store.poll(); assert.equal(f.store.isRunning('pane'), false);
  await f.store.poll(); assert.equal(f.store.isRunning('pane'), true);
  const grandchildren = table(); grandchildren.delete(20); grandchildren.get(21).ppid = 10;
  f.processes(grandchildren); await f.store.poll(); assert.equal(f.store.isRunning('pane'), true);
  f.processes(table(false)); await f.store.poll(); assert.equal(f.store.isRunning('pane'), false);
});

test('常駐 MCP・短命プロセス・PID 再利用・ゾンビは数えない', () => {
  assert.equal(inspectBackgroundProcesses(snapshot, table(false)).running, false);
  const first = inspectBackgroundProcesses(snapshot, table());
  assert.equal(first.running, false);
  const reused = table(); reused.get(20).lstart = 'Fri Nov 6 12:01:00 2026'; reused.delete(21);
  assert.equal(inspectBackgroundProcesses(snapshot, reused, first.candidates).running, false);
  reused.get(20).stat = 'Z'; assert.equal(inspectBackgroundProcesses(snapshot, reused).candidates.size, 0);
});

test('終了フック・finished の早いほうで名前付きエージェントを解除する', async () => {
  const f = fixture(); assert.equal(f.recordHookEvent(), true); assert.equal(f.store.isRunning('pane'), true);
  f.recordHookEvent({ hook_event_name: 'SubagentStop' }); assert.equal(f.store.isRunning('pane'), false);
  f.recordHookEvent(); assert.equal(f.store.isRunning('pane'), false);
  f.recordHookEvent({ agent_id: 'named2' }); f.evidence({ finished: true });
  await f.store.poll(); assert.equal(f.store.isRunning('pane'), false);
});

test('jsonl の最終更新から10分で必ず解除し、更新中は延長する', async () => {
  const f = fixture(); f.recordHookEvent(); f.advance(SUBAGENT_TTL_MS - 1);
  await f.store.poll(); assert.equal(f.store.isRunning('pane'), true);
  f.evidence({ modifiedAt: 1000000 + SUBAGENT_TTL_MS - 1 }); f.advance(1);
  await f.store.poll(); assert.equal(f.store.isRunning('pane'), true);
  f.advance(SUBAGENT_TTL_MS); await f.store.poll(); assert.equal(f.store.isRunning('pane'), false);
});

test('読めない記録でも開始から10分で解除する', async () => {
  const f = fixture(); f.recordHookEvent(); f.advance(SUBAGENT_TTL_MS);
  await f.store.poll(); assert.equal(f.store.isRunning('pane'), false);
});

test('ps失敗は実行中の根拠にせず、親終了・世代交代・ペイン終了で記録を解除する', async () => {
  const f = fixture(); f.processes(table()); await f.store.poll(); await f.store.poll();
  f.processes(null); await f.store.poll(); assert.equal(f.store.isRunning('pane'), false);
  f.processes(table(false)); f.recordHookEvent(); f.snapshot(null); await f.store.poll(); assert.equal(f.store.isRunning('pane'), false);
  assert.equal(f.recordHookEvent({ agent_id: 'late-agent' }), false);
  f.store.begin('pane', 2); assert.equal(f.recordHookEvent(), false);
  f.store.delete('pane'); assert.equal(f.store.isRunning('pane'), false); assert.equal(f.recordHookEvent(), false);
});

test('不正なパス・別 agent_id・別 session・古い epoch を拒否する', () => {
  const f = fixture(); assert.equal(f.recordHookEvent({ transcript_path: '/etc/passwd' }), false);
  assert.equal(f.recordHookEvent({ agent_id: '../bad' }), false);
  assert.equal(f.recordHookEvent({ agent_id: 123 }), false);
  assert.equal(f.recordHookEvent({ agent_transcript_path: '/home/test/.claude/projects/-tmp/session123/subagents/agent-other.jsonl' }), false);
  assert.equal(f.recordHookEvent(), true);
  assert.equal(f.recordHookEvent({ hook_event_name: 'SubagentStop', session_id: 'other', transcript_path: '/home/test/.claude/projects/-tmp/other.jsonl' }), false);
});

test('実ファイルの finished と mtime を読み、symlink の逃げ道を拒否する', t => {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk561-evidence-')));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = agentTranscriptPaths({ ...input, transcript_path: path.join(home, '.claude/projects/-tmp/session123.jsonl') }, home);
  fs.mkdirSync(path.dirname(paths.jsonl), { recursive: true });
  fs.writeFileSync(paths.jsonl, '{}'); fs.writeFileSync(paths.meta, '{"finished":true}');
  assert.equal(readAgentEvidence(paths).finished, true); assert.ok(readAgentEvidence(paths).modifiedAt > 0);
  fs.unlinkSync(paths.meta); fs.symlinkSync(paths.jsonl, paths.meta); assert.equal(readAgentEvidence(paths).finished, false);
});

test('裏の作業は出力停止・打鍵でも点滅せず、status は不変。待ち・完了・見守りを優先する', () => {
  const options = { now: 10000, lastOutputTime: 0, lastInputTime: 10000, runningIdleTimeoutMs: 1500, runningInputGuardMs: 200, backgroundWorkRunning: true };
  assert.equal(deriveStatus(options), 'idle'); assert.equal(deriveDisplayStatus(options), 'running');
  assert.equal(deriveDisplayStatus({ ...options, backgroundWorkRunning: false }), 'idle');
  assert.equal(deriveDisplayStatus({ ...options, localWaiting: true }), 'waiting');
  assert.equal(getStatusPresentation(deriveDisplayStatus(options), 'done').label, '完了');
  assert.equal(getStatusPresentation(deriveDisplayStatus(options), 'watching').label, '見守り中');
  assert.equal(getStatusPresentation(deriveDisplayStatus({ ...options, localWaiting: true }), 'done').label, '入力待ち');
});

test('起動設定は Stop を保持し、接続情報を非公開にして起動ごとに分離する', t => {
  const { prepareBackgroundWorkSettings } = require('../utils/claudeSettingsPreset');
  const { buildClaudeLaunchCommand } = require('../renderer/claudeModel');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk561-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const tools = path.join(dir, 'tools'); fs.mkdirSync(tools);
  fs.writeFileSync(path.join(tools, 'node'), '#!/bin/sh\n', { mode: 0o700 });
  const original = path.join(dir, 'preset.json');
  const stop = [{ hooks: [{ type: 'command', command: 'existing-stop' }] }];
  fs.writeFileSync(original, JSON.stringify({ hooks: { Stop: stop } }));
  // 複数ペインの準備でも ps は一度だけ実行し、待ち時間に上限を付ける。
  const childProcess = require('node:child_process');
  const psCalls = [];
  t.mock.method(childProcess, 'execFileSync', (...args) => { psCalls.push(args); return start; });
  const a = prepareBackgroundWorkSettings(dir, { token: 'synthetic', termId: 'a' }, original, { nodeSearchDirs: [tools] });
  const b = prepareBackgroundWorkSettings(dir, { token: 'synthetic', termId: 'b' }, null, { nodeSearchDirs: [tools] });
  assert.equal(psCalls.length, 1);
  assert.equal(psCalls[0][0], 'ps');
  assert.equal(psCalls[0][2].timeout, 2000);
  assert.equal(psCalls[0][2].killSignal, 'SIGKILL');
  for (const prepared of [a, b]) {
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(path.dirname(prepared.filename), 'owner.json'), 'utf8')), { pid: process.pid, lstart: start });
  }
  const settings = JSON.parse(fs.readFileSync(a.filename, 'utf8'));
  assert.deepEqual(settings.hooks.Stop, stop);
  assert.equal(settings.hooks.SubagentStart.length, 1); assert.equal(settings.hooks.SubagentStop.length, 1);
  assert.notEqual(a.filename, b.filename);
  assert.equal(fs.statSync(path.dirname(a.filename)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(path.dirname(a.filename), 'connection.json')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(settings).includes('synthetic'), false);
  const command = buildClaudeLaunchCommand(null, { claudeSettingsPreset: 'vk-orchestrator-work-pane', backgroundWorkSettingsPath: a.filename, quoteClaudeSettingsPath: (value) => quoteShellPath(value, 'posix') });
  assert.equal((command.match(/--settings/g) || []).length, 1);
  a.discard(); b.discard(); assert.equal(fs.existsSync(a.filename), false);
});

test('フックの実行ファイルは Bearer 認証とペイン識別を送り、会話本文を送らない', { timeout: 10000 }, async t => {
  const http = require('node:http');
  const { spawn } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk561-hook-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let resolveRequest;
  const received = new Promise(resolve => { resolveRequest = resolve; });
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      resolveRequest({ authorization: req.headers.authorization, body: JSON.parse(body) }); res.end('{}');
    });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ token: 'synthetic', termId: 'pane', epoch: 'epoch', url: `http://127.0.0.1:${server.address().port}/api/background-work` }));
  const child = spawn(process.execPath, [path.join(__dirname, '../utils/backgroundWorkHook.js'), config], { stdio: ['pipe', 'ignore', 'ignore'] });
  const exit = new Promise(resolve => child.on('exit', resolve));
  child.stdin.end(JSON.stringify({ ...input, source: 'resume', last_assistant_message: 'private conversation'.repeat(10000) }));
  assert.equal(await exit, 0);
  const request = await received;
  assert.equal(request.authorization, 'Bearer synthetic'); assert.equal(request.body.termId, 'pane');
  assert.equal(request.body.input.source, 'resume');
  assert.equal(request.body.epoch, 'epoch'); assert.equal(request.body.input.last_assistant_message, undefined);
});


test('同じプロセスのセッション変更でも旧記録を混ぜない', () => {
  const f = fixture(); f.recordHookEvent();
  assert.equal(f.recordHookEvent({ agent_id: 'new-agent', session_id: 'next', transcript_path: '/home/test/.claude/projects/-tmp/next.jsonl' }), true);
  assert.equal(f.recordHookEvent(), false);
  f.recordHookEvent({ hook_event_name: 'SubagentStop', agent_id: 'new-agent', session_id: 'next', transcript_path: '/home/test/.claude/projects/-tmp/next.jsonl' });
  assert.equal(f.store.isRunning('pane'), false);
});

test('実物の ps と detached な多段シェルの木で running を確認する', { timeout: 10000, skip: !fs.existsSync('/bin/zsh') || !fs.existsSync('/bin/bash') }, async t => {
  const { spawn } = require('node:child_process');
  const { once } = require('node:events');
  const { listProcessTable } = require('../utils/agentLifecycle');
  // AI 本体相当の子から、端末を切り離した裏コマンドを起動する。
  const program = `const {spawn}=require('node:child_process'); const child=spawn('/bin/zsh',['-c', 'bash -c \\'bash -c "sleep 30 & wait" & wait\\' & wait'],{detached:true,stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`;
  const parent = spawn(process.execPath, ['-e', program], { stdio: ['ignore', 'pipe', 'inherit'] });
  let detachedPid;
  t.after(() => { if (detachedPid) { try { process.kill(-detachedPid, 'SIGKILL'); } catch (_) {} } parent.kill('SIGKILL'); });
  detachedPid = Number(String((await once(parent.stdout, 'data'))[0]).trim());
  const processes = await listProcessTable();
  const liveRoot = processes.get(parent.pid);
  assert.ok(liveRoot);
  const liveSnapshot = { state: 'running', shellPid: process.pid, trackedGroups: new Map([[liveRoot.pgid, new Map([[parent.pid, liveRoot.lstart]])]]) };
  const store = createBackgroundWorkStore({ getEntry: () => liveSnapshot });
  store.begin('real', 1);
  await store.poll(); await store.poll();
  assert.equal(store.isRunning('real'), true);
  assert.ok(processes.get(detachedPid).tpgid <= 0);
  t.diagnostic(`実測: root=${parent.pid}, detached=${detachedPid}, tpgid=${processes.get(detachedPid).tpgid}, running=${store.isRunning('real')}`);
});

test('ps 失敗でもサブエージェントを維持し、SessionStart で旧記録を除く', async () => {
  const f = fixture(); f.recordHookEvent();
  f.recordHookEvent({ hook_event_name: 'SessionStart', agent_id: undefined });
  assert.equal(f.store.isRunning('pane'), true);
  f.processes(null);
  await f.store.poll(); assert.equal(f.store.isRunning('pane'), true);
  assert.equal(f.recordHookEvent({ hook_event_name: 'SessionStart', agent_id: undefined, session_id: 'cleared', transcript_path: '/home/test/.claude/projects/-tmp/cleared.jsonl' }), true);
  assert.equal(f.store.isRunning('pane'), false);
  assert.equal(f.recordHookEvent(), false);
});

test('SessionStart で A → B → A と再開でき、切り替え前の記録を残さない', () => {
  const f = fixture();
  const sessionB = { session_id: 'sessionB', transcript_path: '/home/test/.claude/projects/-tmp/sessionB.jsonl' };
  const startSession = { hook_event_name: 'SessionStart', agent_id: undefined };
  // A から B へ移り、A の遅延通知を拒否する。
  assert.equal(f.recordHookEvent(startSession), true);
  assert.equal(f.recordHookEvent(), true);
  assert.equal(f.recordHookEvent({ ...sessionB, ...startSession }), true);
  assert.equal(f.store.isRunning('pane'), false);
  assert.equal(f.recordHookEvent(), false);
  assert.equal(f.recordHookEvent({ ...sessionB, agent_id: 'agentB' }), true);
  assert.equal(f.store.isRunning('pane'), true);
  // 正規の再開で A を復帰させ、B の記録と遅延通知を除く。
  assert.equal(f.recordHookEvent(startSession), true);
  assert.equal(f.store.isRunning('pane'), false);
  assert.equal(f.recordHookEvent({ ...sessionB, agent_id: 'lateB' }), false);
  assert.equal(f.recordHookEvent(), true);
  assert.equal(f.store.isRunning('pane'), true);
  assert.equal(f.recordHookEvent({ hook_event_name: 'SubagentStop' }), true);
  assert.equal(f.store.isRunning('pane'), false);
});

test('監視する running 世代がなければ ps を呼ばない', async () => {
  let calls = 0;
  const f = fixture({ listProcesses: async () => { calls++; return table(); } });
  f.snapshot({ ...snapshot, state: 'exited' });
  await f.store.poll(); assert.equal(calls, 0);
});

test('メタ情報が FIFO などの通常ファイル以外なら読まない', () => {
  let reads = 0;
  const fakeFs = { realpathSync: name => name, statSync: () => ({ isFile: () => false, size: 0 }), readFileSync: () => { reads++; return '{}'; } };
  assert.equal(readAgentEvidence({ base: '/safe', jsonl: '/safe/log', meta: '/safe/meta' }, fakeFs).finished, false);
  assert.equal(reads, 0);
});

test('完了・見守り中・入力待ちの閉じる確認は表示ラベルと一致する', () => {
  const { getCloseConfirmation } = require('../renderer/statusPresentation');
  for (const [note, label] of [['done', '完了'], ['watching', '見守り中']]) {
    assert.equal(getCloseConfirmation(getStatusPresentation('running', note).label, true), `このペインは「${label}」ですが、裏で作業が動いています。閉じるとセッションは失われます。閉じますか？`);
  }
  assert.match(getCloseConfirmation(getStatusPresentation('waiting', 'done').label, true), /「入力待ち」です（裏で作業が動いています）/);
});

test('停止失敗時は準備した設定だけ捨て、旧監視と接続を保つ', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const stage = source.slice(source.indexOf('function stagePaneBackgroundWork('), source.indexOf('function preparePaneBackgroundWork('));
  let discarded = 0, clears = 0;
  const old = { marker: 'old' };
  const settings = new Map([['pane', old]]);
  const f = fixture(); f.recordHookEvent();
  const context = { prepareClaudeSettingsForShell: require('../utils/claudeSettingsPreset').prepareClaudeSettingsForShell, crypto: require('node:crypto'), apiServerRuntimeStatus: {}, API_PORT: 1, API_TOKEN: 'synthetic', DATA_DIR: '/tmp', os, APP_ORIGINAL_PATH: '', LOG_PREFIX: '', console,
    prepareBackgroundWorkSettings: () => ({ filename: '/tmp/new.json', discard: () => { discarded++; } }),
    clearPaneBackgroundWork: () => { clears++; settings.delete('pane'); f.store.delete('pane'); }, backgroundWork: f.store, backgroundSettings: settings };
  vm.createContext(context); vm.runInContext(stage, context);
  const staged = context.stagePaneBackgroundWork('pane', 2, 'claude', {});
  staged.discard();
  assert.equal(discarded, 1); assert.equal(clears, 0);
  assert.equal(settings.get('pane'), old); assert.equal(f.store.isRunning('pane'), true);
  assert.equal(f.recordHookEvent({ agent_id: 'still-old' }), true);
  const handler = source.slice(source.indexOf('let stagedBackgroundWork;'), source.indexOf("if (req.method === 'POST' && url.pathname === '/api/close-pane')"));
  assert.ok(handler.indexOf('stagedBackgroundWork.commit()') > handler.indexOf("error: 'failed to stop agent'"));
  assert.match(handler, /if \(!launchHomeInUse\) \{\s*launchResolution.discard\(\);\s*stagedBackgroundWork.discard\(\);/);
  assert.equal(handler.includes('clearPaneBackgroundWork(request.termId)'), false);
});

test('ペインの PowerShell で設定パスを組み立て、再起動の準備失敗は旧監視を保つ', () => {
  const vm = require('node:vm');
  const { prepareClaudeSettingsForShell } = require('../utils/claudeSettingsPreset');
  const { buildClaudeLaunchCommand } = require('../renderer/claudeModel');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const stage = source.slice(source.indexOf('function stagePaneBackgroundWork('), source.indexOf('function preparePaneBackgroundWork('));
  const filename = "/tmp/a'‘’‚‛.json";
  let discarded = 0, launchDiscarded = 0, clears = 0, status, body;
  const old = { marker: 'old' };
  const settings = new Map([['pane', old]]);
  const f = fixture(); f.recordHookEvent();
  const context = { prepareClaudeSettingsForShell, crypto: require('node:crypto'), apiServerRuntimeStatus: {},
    API_PORT: 1, API_TOKEN: 'synthetic', DATA_DIR: '/tmp', os, APP_ORIGINAL_PATH: '', LOG_PREFIX: '',
    console: { warn() {}, error() {} },
    prepareBackgroundWorkSettings: () => ({ filename, discard() { discarded++; } }),
    clearPaneBackgroundWork() { clears++; settings.delete('pane'); f.store.delete('pane'); },
    backgroundWork: f.store, backgroundSettings: settings,
    request: { termId: 'pane', engine: 'claude' }, currentGeneration: 1,
    ptyShellExecutables: new Map([['pane', 'pwsh']]),
    launchResolution: { discard() { launchDiscarded++; } },
    res: { writeHead(code) { status = code; }, end(value) { body = JSON.parse(value); } },
  };
  vm.createContext(context); vm.runInContext(stage, context);
  const staged = context.stagePaneBackgroundWork('pane', 2, 'claude', {}, 'pwsh');
  assert.equal(buildClaudeLaunchCommand(undefined, staged.options), "claude --settings '/tmp/a''‘‘’’‚‚‛‛.json'");
  staged.discard();
  assert.equal(discarded, 1);

  // 実際の再起動の準備ブロックで、引用できない必須設定を渡す。
  context.launchOptions = { claudeSettingsPreset: 'vk-orchestrator-work-pane', claudeSettingsPath: filename };
  context.ptyShellExecutables.set('pane', 'unknown');
  const restart = source.slice(source.indexOf('let stagedBackgroundWork;'), source.indexOf('let launchHomeInUse = false;', source.indexOf('let stagedBackgroundWork;')));
  vm.runInContext('function restart() { ' + restart + ' }', context);
  context.restart();
  assert.equal(discarded, 2);
  assert.equal(launchDiscarded, 1);
  assert.equal(status, 503);
  assert.deepEqual(body, { error: 'Claude settings preset hook is unavailable' });
  assert.equal(clears, 0);
  assert.equal(settings.get('pane'), old);
  assert.equal(f.store.isRunning('pane'), true);
  assert.equal(f.recordHookEvent({ agent_id: 'still-old' }), true);
});

test('クラッシュした所有者の設定だけ回収し、生存中・所有者不明を残す', async t => {
  const { cleanupBackgroundWorkSettings } = require('../utils/claudeSettingsPreset');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk561-cleanup-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [suffix, owner] of [['dead', { pid: 2147483647, lstart: start }], ['live', { pid: process.pid, lstart: start }], ['unknown', null]]) {
    const folder = path.join(dir, `background-work-${suffix}`); fs.mkdirSync(folder);
    if (owner) fs.writeFileSync(path.join(folder, 'owner.json'), JSON.stringify(owner));
  }
  await cleanupBackgroundWorkSettings(dir, async () => new Map([[process.pid, { lstart: start }]]));
  assert.equal(fs.existsSync(path.join(dir, 'background-work-dead')), false);
  assert.equal(fs.existsSync(path.join(dir, 'background-work-live')), true);
  assert.equal(fs.existsSync(path.join(dir, 'background-work-unknown')), true);
});

test('フック通知は異なる Origin を拒否し、同一 Origin の通知だけ記録する', () => {
  const vm = require('node:vm');
  const { EventEmitter } = require('node:events');
  const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const route = source.slice(source.indexOf("if (req.method === 'POST' && url.pathname === '/api/background-work')"), source.indexOf('// GET /api/health'));
  let recorded = 0, status;
  const context = { url: { pathname: '/api/background-work' }, isForbiddenOrigin: req => req.forbidden,
    backgroundWork: { recordHookEvent: () => { recorded++; return true; } } };
  vm.createContext(context);
  vm.runInContext('function handle(req, res) { ' + route + ' }', context);
  const res = { writeHead: code => { status = code; }, end: () => {} };
  for (const forbidden of [true, false]) {
    const req = new EventEmitter(); req.method = 'POST'; req.forbidden = forbidden;
    context.handle(req, res);
    req.emit('data', '{}'); req.emit('end');
    assert.equal(status, forbidden ? 403 : 200);
    assert.equal(recorded, forbidden ? 0 : 1);
  }
});

test('退役済みセッションは再開だけ受け付け、source の型を検証する', () => {
  const f = fixture();
  assert.equal(f.recordHookEvent({ hook_event_name: 'SessionStart', source: 'startup' }), true);
  assert.equal(f.recordHookEvent({ hook_event_name: 'SessionStart', source: 'clear', session_id: 'sessionB', transcript_path: '/home/test/.claude/projects/-tmp/sessionB.jsonl' }), true);
  for (const source of ['startup', 'clear', 'compact', 'fork', 'unknown', null, 1, {}, ['resume']]) {
    assert.equal(f.recordHookEvent({ hook_event_name: 'SessionStart', source }), false);
  }
  assert.equal(f.recordHookEvent({ hook_event_name: 'SessionStart', source: 'resume' }), true);
  assert.equal(f.recordHookEvent({ source: {} }), false);
});
