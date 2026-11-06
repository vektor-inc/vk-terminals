'use strict';
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
  if (background) items.push({ pid: 20, ppid: 10, pgid: 20, tpgid: -1, stat: 'S', lstart: start }, { pid: 21, ppid: 20, pgid: 20, tpgid: -1, stat: 'S', lstart: start });
  return new Map(items.map(p => [p.pid, p]));
}
const input = { agent_id: 'agent123', session_id: 'session123', transcript_path: '/home/test/.claude/projects/-tmp/session123.jsonl', hook_event_name: 'SubagentStart' };
function fixture(overrides = {}) {
  let clock = 1000000, processes = table(false), evidence = {}, current = snapshot;
  const changes = [];
  const store = createBackgroundWorkStore({ getSnapshot: () => current, listProcesses: async () => { if (!processes) throw Error('ps failed'); return processes; }, homeDir: '/home/test', now: () => clock, readEvidence: () => evidence, onChange: (...args) => changes.push(args), ...overrides });
  const epoch = store.begin('pane', 1);
  return { store, epoch, changes, event: (event = {}) => store.event({ termId: 'pane', epoch, input: { ...input, ...event } }), advance: ms => { clock += ms; }, processes: value => { processes = value; }, evidence: value => { evidence = value; }, snapshot: value => { current = value; } };
}

test('コマンドは連続した確認後に実行中になり、終了時は直ちに解除する（孫も追跡）', async () => {
  const f = fixture(); f.processes(table());
  await f.store.poll(); assert.equal(f.store.get('pane'), false);
  await f.store.poll(); assert.equal(f.store.get('pane'), true);
  const grandchildren = table(); grandchildren.delete(20); grandchildren.get(21).ppid = 10;
  f.processes(grandchildren); await f.store.poll(); assert.equal(f.store.get('pane'), true);
  f.processes(table(false)); await f.store.poll(); assert.equal(f.store.get('pane'), false);
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
  const f = fixture(); assert.equal(f.event(), true); assert.equal(f.store.get('pane'), true);
  f.event({ hook_event_name: 'SubagentStop' }); assert.equal(f.store.get('pane'), false);
  f.event(); assert.equal(f.store.get('pane'), false);
  f.event({ agent_id: 'named2' }); f.evidence({ finished: true });
  await f.store.poll(); assert.equal(f.store.get('pane'), false);
});

test('jsonl の最終更新から10分で必ず解除し、更新中は延長する', async () => {
  const f = fixture(); f.event(); f.advance(SUBAGENT_TTL_MS - 1);
  await f.store.poll(); assert.equal(f.store.get('pane'), true);
  f.evidence({ modifiedAt: 1000000 + SUBAGENT_TTL_MS - 1 }); f.advance(1);
  await f.store.poll(); assert.equal(f.store.get('pane'), true);
  f.advance(SUBAGENT_TTL_MS); await f.store.poll(); assert.equal(f.store.get('pane'), false);
});

test('読めない記録でも開始から10分で解除する', async () => {
  const f = fixture(); f.event(); f.advance(SUBAGENT_TTL_MS);
  await f.store.poll(); assert.equal(f.store.get('pane'), false);
});

test('ps失敗は実行中の根拠にせず、親終了・世代交代・ペイン終了で記録を解除する', async () => {
  const f = fixture(); f.processes(table()); await f.store.poll(); await f.store.poll();
  f.processes(null); await f.store.poll(); assert.equal(f.store.get('pane'), false);
  f.processes(table(false)); f.event(); f.snapshot(null); await f.store.poll(); assert.equal(f.store.get('pane'), false);
  assert.equal(f.event({ agent_id: 'late-agent' }), false);
  f.store.begin('pane', 2); assert.equal(f.event(), false);
  f.store.delete('pane'); assert.equal(f.store.get('pane'), false); assert.equal(f.event(), false);
});

test('不正なパス・別 agent_id・別 session・古い epoch を拒否する', () => {
  const f = fixture(); assert.equal(f.event({ transcript_path: '/etc/passwd' }), false);
  assert.equal(f.event({ agent_id: '../bad' }), false);
  assert.equal(f.event({ agent_id: 123 }), false);
  assert.equal(f.event({ agent_transcript_path: '/home/test/.claude/projects/-tmp/session123/subagents/agent-other.jsonl' }), false);
  assert.equal(f.event(), true);
  assert.equal(f.event({ hook_event_name: 'SubagentStop', session_id: 'other', transcript_path: '/home/test/.claude/projects/-tmp/other.jsonl' }), false);
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
  const a = prepareBackgroundWorkSettings(dir, { token: 'synthetic', termId: 'a' }, original, { nodeSearchDirs: [tools] });
  const b = prepareBackgroundWorkSettings(dir, { token: 'synthetic', termId: 'b' }, null, { nodeSearchDirs: [tools] });
  const settings = JSON.parse(fs.readFileSync(a.filename, 'utf8'));
  assert.deepEqual(settings.hooks.Stop, stop);
  assert.equal(settings.hooks.SubagentStart.length, 1); assert.equal(settings.hooks.SubagentStop.length, 1);
  assert.notEqual(a.filename, b.filename);
  assert.equal(fs.statSync(path.dirname(a.filename)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(path.dirname(a.filename), 'connection.json')).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(settings).includes('synthetic'), false);
  const command = buildClaudeLaunchCommand(null, { claudeSettingsPreset: 'vk-orchestrator-work-pane', backgroundWorkSettingsPath: a.filename });
  assert.equal((command.match(/--settings/g) || []).length, 1);
  a.discard(); b.discard(); assert.equal(fs.existsSync(a.filename), false);
});

test('フックの実行ファイルは Bearer 認証とペイン識別を送り、会話本文を送らない', async t => {
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
  child.stdin.end(JSON.stringify({ ...input, last_assistant_message: 'private conversation' }));
  assert.equal(await exit, 0);
  const request = await received;
  assert.equal(request.authorization, 'Bearer synthetic'); assert.equal(request.body.termId, 'pane');
  assert.equal(request.body.epoch, 'epoch'); assert.equal(request.body.input.last_assistant_message, undefined);
});


test('同じプロセスのセッション変更でも旧記録を混ぜない', () => {
  const f = fixture(); f.event();
  assert.equal(f.event({ agent_id: 'new-agent', session_id: 'next', transcript_path: '/home/test/.claude/projects/-tmp/next.jsonl' }), true);
  assert.equal(f.event(), false);
  f.event({ hook_event_name: 'SubagentStop', agent_id: 'new-agent', session_id: 'next', transcript_path: '/home/test/.claude/projects/-tmp/next.jsonl' });
  assert.equal(f.store.get('pane'), false);
});
