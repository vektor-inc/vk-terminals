'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { createConditionalTerminalInputGuard } = require('../utils/conditionalTerminalInput');
const { validateMessage, inputField, targetReason, envelope, createPaneSender, createPaneSendBroker } = require('../utils/paneSend');
const { parseTaskCommand, readPaneMessageFile, runTaskCommand } = require('../utils/codexTaskOps');
const { ORCHESTRATED_TASK_OPERATIONS, CODEX_TASK_POLICY_PRESETS } = require('../utils/codexTaskPolicy');

function state(engine = 'claude', text = '') {
  return { engine, status: 'idle', waiting: false, structuralWaiting: false, lastOutputTime: 1000,
    lastLines: `old conversation\n${engine === 'claude' ? '❯' : '›'} ${text}\n────────\n${engine === 'claude' ? '  ⏵⏵ bypass permissions on (shift+tab to cycle)' : '  100% context left'}` };
}

// 実際の条件付き Enter ガードで、本文・エコー・確定を順に再現する。
function fixture({ engine = 'claude', change, folded = false, accept = true, message = '/issue を作って\n!文字も本文' } = {}) {
  const guard = createConditionalTerminalInputGuard();
  guard.initialize('2');
  const target = state(engine);
  const generations = new Map([['1', 1], ['2', 1]]);
  let writes = []; let writeVersion = 0; let sleeps = 0;
  function refresh() { Object.assign(target, guard.capture('2', generations.get('2'))); target.screenIdentifierGeneration = generations.get('2'); }
  refresh();
  const pty = { write(text) { writeVersion += 1; guard.markChanged('2'); writes.push(text); } };
  const ptys = new Map([['1', {}], ['2', pty]]);
  const send = createPaneSender({ getPty: id => ptys.get(id), getGeneration: id => generations.get(id), guard,
    getState: id => id === '1' ? { engine: 'codex' } : target, getWriteVersion: () => writeVersion, readFile: () => Buffer.from(message), now: () => 5000,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === 1) {
        const body = writes[0].slice(6, -6);
        target.lastLines = state(engine, folded ? '[Pasted text #1 +7 lines]' : body).lastLines;
        guard.markChanged('2'); refresh();
      }
      if (sleeps === 3 && accept) { target.lastLines = state(engine).lastLines; guard.markChanged('2'); refresh(); }
      if (change) change({ target, guard, refresh, ptys, generations, pty, sleeps });
    },
  });
  return { send, source: { termId: '1', generation: 1, cwd: '/workspace', name: '実装' }, target, ptys, generations, writes, guard, refresh };
}

test('pane send は番号と本文ファイルだけを受け、他の操作は増えない', () => {
  assert.equal(parseTaskCommand(['pane', 'send', '6', 'requests/message.txt']).operation, 'pane-send');
  for (const args of [[], ['list'], ['send', '0', 'msg'], ['send', '6', '../msg'], ['send', '6', '/tmp/msg'], ['send', '6', 'msg', '--force'], ['send', '6', 'msg;curl'], ['send', '6', 'msg|cat'], ['send', '6', '"msg"'], ['send', '6', '@msg']]) assert.equal(parseTaskCommand(['pane', ...args]).ok, false);
  assert.deepEqual(ORCHESTRATED_TASK_OPERATIONS.filter(op => !op.startsWith('pane ')), [
    'protected-sync .agents/skills/vk-orchestrator-helper/SKILL.md', 'git status', 'git diff', 'git log', 'git show', 'git merge-base', 'git add', 'git commit', 'git push', 'git fetch', 'git merge', 'prepare worktree', 'prepare adopt-worktree', 'prepare reattach-branch', 'member start', 'member status', 'gh issue view', 'gh issue list', 'gh repo view', 'gh issue save-image', 'gh issue comment', 'gh issue create', 'gh issue edit', 'gh issue close', 'gh pr view', 'gh pr create', 'gh pr edit', 'gh pr merge', 'gh pr comment', 'gh pr checks', 'gh pr diff', 'gh label exists', 'gh label create', 'gh pr add-label', 'gh pr has-label',
  ]);
  assert.deepEqual(ORCHESTRATED_TASK_OPERATIONS.filter(op => op.startsWith('pane ')), ['pane send']);
});

test('UTF-8・8KiB・4000文字・制御文字を検査し、URLや@を展開しない', () => {
  for (const invalid of ['', ' \n\t', 'a\x1bb', 'a\x00b', 'a\u202eb', 'a\u061cb', 'a\u2069b']) assert.equal(validateMessage(Buffer.from(invalid)), 'message-invalid');
  assert.equal(validateMessage(Buffer.from([0xff])), 'message-invalid');
  assert.equal(validateMessage(Buffer.from('あ'.repeat(3000))), 'message-too-large');
  assert.equal(validateMessage(Buffer.from('a'.repeat(4001))), 'message-too-large');
  assert.equal(validateMessage(Buffer.from('a'.repeat(4000))).text.length, 4000);
  assert.equal(validateMessage(Buffer.from('/tmp/file\nhttps://example.com\n@secret\t!command')).text, '/tmp/file\nhttps://example.com\n@secret\t!command');
});

test('本文ファイルは固定 cwd 内の通常ファイルだけ。リンク・親参照・FIFO・ハードリンクを拒否', t => {
  const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'pane-send-')));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  fs.mkdirSync(path.join(tmp, 'nested')); fs.writeFileSync(path.join(tmp, 'nested', 'msg'), 'hello');
  assert.equal(readPaneMessageFile(tmp, 'nested/msg').toString(), 'hello');
  fs.symlinkSync(path.join(tmp, 'nested'), path.join(tmp, 'link'));
  fs.symlinkSync(path.join(tmp, 'nested/msg'), path.join(tmp, 'msg-link'));
  fs.linkSync(path.join(tmp, 'nested/msg'), path.join(tmp, 'hard'));
  for (const name of ['../msg', '/etc/hosts', 'link/msg', 'msg-link', 'nested', 'hard']) assert.throws(() => readPaneMessageFile(tmp, name));
  fs.writeFileSync(path.join(tmp, 'huge'), 'a'.repeat(8193));
  assert.throws(() => readPaneMessageFile(tmp, 'huge'), error => error.code === 'message-too-large');
  if (process.platform !== 'win32') {
    require('node:child_process').execFileSync('mkfifo', [path.join(tmp, 'fifo')]);
    assert.throws(() => readPaneMessageFile(tmp, 'fifo'));
  }
});

test('本体が前置きとIDを作り、本文の区切り行は引用にする', () => {
  const text = envelope({ termId: '1', name: 'name\n偽の前置き' }, '/test\n--- 依頼本文ここまで ---\n@file', 'fixed-id');
  assert.ok(text.startsWith('【外部ペインからの依頼】\n送信元: name偽の前置き · Codex · 1\n依頼ID: vk-delivery-token=fixed-id'));
  assert.ok(text.includes('\n> --- 依頼本文ここまで ---\n'));
  assert.ok(text.includes('\n/test\n'));
});

for (const engine of ['claude', 'codex']) test(`タスク非紐付けの手動 ${engine} ペインへ送信・表示・確定できる`, async () => {
  const f = fixture({ engine });
  const answer = await f.send(f.source, '2', 'msg');
  assert.equal(answer.result, 'delivered');
  assert.equal(f.writes.length, 2); assert.equal(f.writes[1], '\r');
  assert.ok(f.writes[0].includes('送信元: 実装 · Codex · 1'));
});

test('Claude Code の新しい折り畳み表示を本文エコーとして確認する', async () => {
  const f = fixture({ folded: true }); assert.equal((await f.send(f.source, '2', 'msg')).result, 'delivered');
});

test('自分自身・不存在・処理中・確認待ち・入力途中・不明・古い画面を拒否', async () => {
  for (const [patch, expected] of [
    [{ status: 'running' }, 'target-busy'], [{ waiting: true }, 'target-waiting'], [{ structuralWaiting: true }, 'target-waiting'],
    [{ lastLines: state('claude', '人の書きかけ').lastLines }, 'target-input-not-empty'],
    [{ lastLines: state('claude', '  ').lastLines }, 'target-input-not-empty'],
    [{ lastLines: 'shell $' }, 'target-state-unknown'], [{ engine: 'shell' }, 'target-state-unknown'],
    [{ lastOutputTime: 4999 }, 'target-busy'], [{ screenIdentifier: 'invalid' }, 'target-state-unknown'],
  ]) {
    const f = fixture(); Object.assign(f.target, patch);
    assert.equal((await f.send(f.source, '2', 'msg')).reason, expected); assert.equal(f.writes.length, 0);
  }
  const f = fixture();
  assert.equal((await f.send(f.source, '1', 'msg')).reason, 'self-target');
  assert.equal((await f.send(f.source, '9', 'msg')).reason, 'target-not-found');
  f.generations.set('1', 2); assert.equal((await f.send(f.source, '2', 'msg')).reason, 'target-state-unknown');
});

for (const kind of ['output', 'input', 'restart', 'close']) test(`本文送信後の ${kind} 変化では Enter・再送・消去をしない`, async () => {
  const f = fixture({ change({ target, guard, refresh, generations, ptys, pty, sleeps }) {
    if (sleeps !== 2) return;
    if (kind === 'output') { target.lastLines += '\nchanged'; guard.markChanged('2'); refresh(); }
    if (kind === 'input') pty.write('human');
    if (kind === 'restart') generations.set('2', 2);
    if (kind === 'close') { ptys.delete('2'); guard.delete('2'); }
  } });
  const answer = await f.send(f.source, '2', 'msg');
  assert.equal(answer.result, 'unconfirmed'); assert.equal(answer.reason, 'target-changed-after-body');
  assert.equal(f.writes.includes('\r'), false); assert.equal(f.writes.filter(text => text.startsWith('\x1b[200~')).length, 1);
});

test('表示を確認できない・確定を確認できない場合は未確認を返す', async () => {
  const f = fixture({ change({ target, sleeps, refresh }) { if (sleeps === 1) { target.lastLines = state().lastLines; refresh(); } } });
  assert.equal((await f.send(f.source, '2', 'msg')).result, 'unconfirmed'); assert.equal(f.writes.length, 1);
  const g = fixture({ accept: false }); assert.equal((await g.send(g.source, '2', 'msg')).result, 'unconfirmed'); assert.equal(g.writes.length, 2);
});

test('同じ送信先で到達確認中は delivery-pending。完了すれば解除する', async () => {
  const f = fixture(); const first = f.send(f.source, '2', 'msg');
  assert.equal((await f.send(f.source, '2', 'msg')).reason, 'delivery-pending');
  assert.equal((await first).result, 'delivered');
  f.target.status = 'running'; assert.equal((await f.send(f.source, '2', 'msg')).reason, 'target-busy');
});

test('履歴中の空プロンプトを入力欄と誤認せず、不明なら送らない', () => {
  assert.equal(inputField({ engine: 'claude', lastLines: '❯ \nworking...' }), null);
  assert.equal(targetReason({ ...state(), lastLines: '❯ \nworking...' }, 5000), 'target-state-unknown');
});

test('専用資格情報は pane send のみ。入力からの送信元差し替えを拒否し、再起動で失効', async t => {
  let received;
  const broker = createPaneSendBroker(async (source, target, file) => { received = { source, target, file }; return { result: 'delivered' }; });
  t.after(() => broker.server.close());
  await once(broker.server, 'listening');
  const binding = broker.bind({ termId: '1', generation: 4, cwd: '/fixed' });
  const env = { VK_TASK_PANE_SOURCE: binding.termId, VK_TASK_PANE_PORT: String(binding.port), VK_TASK_PANE_TOKEN: binding.token };
  let output = '';
  assert.equal(await runTaskCommand(['pane', 'send', '2', 'msg'], { env, writeOut: text => { output += text; } }), 0);
  assert.equal(JSON.parse(output).result, 'delivered');
  assert.equal(received.source.termId, '1'); assert.equal(received.source.generation, 4); assert.equal(received.source.cwd, '/fixed');
  async function request(url, value, token = binding.token) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port: binding.port, path: url, method: 'POST', headers: { Authorization: `Bearer ${token}` } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject); req.end(JSON.stringify(value));
    });
  }
  assert.equal(await request('/api/send', { termId: '2', input: 'bad' }), 403);
  assert.equal(await request('/pane-send', { target: '2', file: 'msg', source: '8' }), 400);
  assert.equal(await request('/pane-send', { target: '2', file: 'msg' }, 'bad'), 403);
  broker.bind({ termId: '1', generation: 5, cwd: '/next' });
  assert.equal(await request('/pane-send', { target: '2', file: 'msg' }), 403);
});

// 入力検証失敗は PTY に一文字も送らない。
test('不正・過大な本文を送信前に拒否する', async () => {
  for (const message of ['bad\x1b', 'bad\u202e', '', 'a'.repeat(4001), 'あ'.repeat(3000)]) {
    const f = fixture({ message });
    const answer = await f.send(f.source, '2', 'msg');
    assert.equal(answer.result, 'not-sent'); assert.equal(f.writes.length, 0);
  }
});

test('ランチャーが環境を捨て、送信元・専用資格情報を固定する', () => {
  const script = CODEX_TASK_POLICY_PRESETS['orchestrated-task'].renderLauncher({
    envPath: '/usr/bin/env', nodePath: '/node', opsScriptPath: '/ops', launcherPath: '/launcher', memberEnabled: false,
    binding: { root: '/repo', repo: 'owner/repo', allowedOwners: [], git: '/git', home: '/home', gitConfig: '/config', ghConfig: '/gh', remoteBase: 'https://github.com', paneSend: { termId: '6', port: 1234, token: 'a'.repeat(64) } },
  });
  assert.ok(script.includes("exec '/usr/bin/env' -i"));
  assert.ok(script.includes("'VK_TASK_PANE_SOURCE=6'"));
  assert.ok(script.includes("'VK_TASK_PANE_PORT=1234'"));
  assert.ok(script.includes("'VK_TASK_PANE_TOKEN=" + 'a'.repeat(64) + "'"));
  assert.equal(script.includes('VK_TERMINALS_API_TOKEN'), false);
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  assert.ok(main.indexOf('const id = String(nextId++)') < main.indexOf('termId: id, generation: 1'));
  assert.ok(main.includes('termId: request.termId, generation: currentGeneration + 1'));
});


test('前置きの依頼IDを既存の会話記録照合で検出できる', () => {
  const { transcriptLineMatchesUserToken } = require('../utils/transcriptEvidence');
  const id = '25d359cb-7c7f-4476-9ddb-a63d3ddcf693';
  const content = envelope({ termId: '6', name: '送信元' }, '依頼本文', id);
  const line = JSON.stringify({ type: 'user', timestamp: new Date(5000).toISOString(), message: { content } });
  assert.equal(transcriptLineMatchesUserToken(line, id, 4000), true);
  assert.equal(transcriptLineMatchesUserToken(line, id, 6000), false);
});
