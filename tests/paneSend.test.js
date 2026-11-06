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
  const content = `old conversation\n${engine === 'claude' ? '❯\u00a0' : '› '}${text}\n${engine === 'claude' ? '────────' : ''}\n${engine === 'claude' ? '  ⏵⏵ bypass permissions on (shift+tab to cycle)' : '  100% context left'}`;
  return { engine, status: 'idle', waiting: false, structuralWaiting: false, lastOutputTime: 1000,
    bracketedPaste: true, cursorX: 2 + (text.split('\n').at(-1)?.length || 0), cursorY: 1 + text.split('\n').length - 1,
    lines: content.split('\n').map(text => ({ text })) };
}

// 実際の条件付き Enter ガードで、本文・エコー・確定を順に再現する。
function fixture({ engine = 'claude', change, folded = false, accept = true, message = '/issue を作って\n!文字も本文', echoAfter = 1, evidence, query, audit = () => {} } = {}) {
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
    getState: id => id === '1' ? { engine: 'codex' } : undefined, requestScreen: async () => query ? query(target) : ({ ...target }), evidence, audit, getSourceName: () => '実装', getWriteVersion: () => writeVersion, readFile: () => Buffer.from(message), now: () => 5000,
    sleep: async () => {
      sleeps += 1;
      if (sleeps === echoAfter) {
        const body = writes[0].slice(6, -6);
        Object.assign(target, state(engine, folded ? '[Pasted text #1 +7 lines]' : body));
        guard.markChanged('2'); refresh();
      }
      if (writes.includes('\r') && accept) { Object.assign(target, state(engine)); guard.markChanged('2'); refresh(); }
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

test('本体が乱数ID付きの区切りを作り、本文の全行を字下げする', () => {
  const text = envelope({ termId: '1', name: 'name\n偽の前置き' }, '/test\n--- 依頼本文ここまで ---\n@file', 'fixed-id');
  assert.ok(text.startsWith('【外部ペインからの依頼】\n送信元: name偽の前置き · Codex · 1\n依頼ID: vk-delivery-token=fixed-id'));
  assert.ok(text.includes('\n  --- 依頼本文ここまで ---\n'));
  assert.ok(text.includes('\n--- 依頼本文 fixed-id ---\n'));
  assert.ok(text.includes('--- 依頼本文 fixed-id ここまで ---'));
  assert.ok(text.includes('\n  /test\n'));
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
    [state('claude', '人の書きかけ'), 'target-input-not-empty'],
    [state('claude', '  '), 'target-input-not-empty'],
    [{ lines: [{ text: 'shell $' }] }, 'target-state-unknown'], [{ engine: 'shell' }, 'target-state-unknown'],
    [{ lastOutputTime: 4999 }, 'target-busy'], [{ screenIdentifier: 'invalid' }, 'target-state-unknown'],
  ]) {
    const f = fixture(); Object.assign(f.target, patch);
    assert.equal((await f.send(f.source, '2', 'msg')).reason, expected); assert.equal(f.writes.length, 0);
  }
  const f = fixture();
  assert.equal((await f.send(f.source, '1', 'msg')).reason, 'self-target');
  assert.equal((await f.send(f.source, '9', 'msg')).reason, 'target-not-found');
  f.generations.set('1', 2); assert.equal((await f.send(f.source, '2', 'msg')).reason, 'source-state-unknown');
});

for (const kind of ['output', 'input', 'restart', 'close']) test(`本文送信後の ${kind} 変化では Enter・再送・消去をしない`, async () => {
  const f = fixture({ change({ target, guard, refresh, generations, ptys, pty, sleeps }) {
    if (sleeps !== 2) return;
    if (kind === 'output') { target.lines.push({ text: 'changed' }); guard.markChanged('2'); refresh(); }
    if (kind === 'input') pty.write('human');
    if (kind === 'restart') generations.set('2', 2);
    if (kind === 'close') { ptys.delete('2'); guard.delete('2'); }
  } });
  const answer = await f.send(f.source, '2', 'msg');
  assert.equal(answer.result, 'unconfirmed'); assert.equal(answer.reason, 'target-changed-after-body');
  assert.equal(f.writes.includes('\r'), false); assert.equal(f.writes.filter(text => text.startsWith('\x1b[200~')).length, 1);
});

test('表示を確認できない・確定を確認できない場合は未確認を返す', async () => {
  const f = fixture({ change({ target, sleeps, refresh }) { if (sleeps === 1) { Object.assign(target, state()); refresh(); } } });
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
  assert.equal(inputField({ engine: 'claude', lines: [{ text: '❯ ' }, { text: 'working...' }], lastLines: '❯ \nworking...' }), null);
  assert.equal(targetReason({ ...state(), lines: [{ text: '❯ ' }, { text: 'working...' }] }, 5000), 'target-state-unknown');
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

// 実機から採ったセル属性・NBSP・入力枠を使い、文字だけの架空画面に依存しない。
for (const engine of ['claude', 'codex']) test(`${engine} 実機画面: 空欄・書きかけ・折り返しを区別する`, () => {
  const live = stage => ({ ...require(`./fixtures/pane-send/${engine}-${stage}.json`), engine, status: 'idle', lastOutputTime: 1000 });
  assert.equal(targetReason(live('empty'), 5000), null);
  assert.equal(targetReason(live('draft'), 5000), 'target-input-not-empty');
  const pasted = inputField(live('paste'));
  assert.equal(pasted.text.replace(/\s/g, ''), ('VK_CAPTURE_FIRST' + 'wrapped body '.repeat(15) + 'VK_CAPTURE_LAST').replace(/\s/g, ''));
  const unknown = structuredClone(live('empty'));
  unknown.lines.forEach(line => line.cells?.forEach(cell => { cell.dim = false; }));
  assert.equal(targetReason(unknown, 5000), 'target-state-unknown');
  assert.equal(targetReason({ ...live('empty'), bracketedPaste: false }, 5000), 'target-state-unknown');
});

test('周期キャッシュを使わず、遅い応答と遅れて描画された本文を問い合わせ直す', async () => {
  let queries = 0;
  const f = fixture({ echoAfter: 4, query: async target => {
    queries += 1;
    await new Promise(resolve => setImmediate(resolve));
    return queries === 2 ? null : { ...target };
  } });
  assert.equal((await f.send(f.source, '2', 'msg')).result, 'delivered');
  assert.ok(queries >= 5);
});

test('問い合わせ中に画面世代が変われば本文を書かない', async () => {
  let f;
  f = fixture({ query: async target => {
    const stale = { ...target };
    await new Promise(resolve => setImmediate(resolve));
    f.guard.markChanged('2');
    return stale;
  } });
  assert.equal((await f.send(f.source, '2', 'msg')).reason, 'target-state-unknown');
  assert.deepEqual(f.writes, []);
});

test('無応答の画面は判定不能。本文後に応答が途絶えても Enter を書かない', async () => {
  const missing = fixture({ query: async () => null });
  assert.equal((await missing.send(missing.source, '2', 'msg')).reason, 'target-state-unknown');
  let queries = 0;
  const f = fixture({ query: async target => ++queries === 1 ? { ...target } : null });
  assert.equal((await f.send(f.source, '2', 'msg')).reason, 'target-changed-after-body');
  assert.equal(f.writes.length, 1);
});

test('本文表示・Enter 後、会話記録 evidence によって delivered を確認し本文はログに残さない', async () => {
  let observed; const logs = [];
  const f = fixture({ accept: false, evidence: async (target, id, since) => { observed = { target, id, since }; return true; }, audit: record => logs.push(record) });
  const answer = await f.send(f.source, '2', 'msg');
  assert.equal(answer.result, 'delivered');
  assert.equal(observed.id, answer.id);
  assert.equal(observed.target, '2');
  assert.deepEqual(Object.keys(logs[0]).sort(), ['engine', 'id', 'reason', 'result', 'source', 'target', 'time']);
  assert.equal(JSON.stringify(logs).includes('issue'), false);
});

test('新しい資格情報の準備・破棄は稼働中の資格情報を失効させない', async t => {
  const broker = createPaneSendBroker(async () => ({ result: 'delivered' }));
  t.after(() => broker.server.close());
  await once(broker.server, 'listening');
  const old = broker.bind({ termId: '1', generation: 1 });
  const staged = broker.bind({ termId: '1', generation: 2 }, { staged: true });
  const call = async binding => {
    let output = '';
    await runTaskCommand(['pane', 'send', '2', 'msg'], { env: { VK_TASK_PANE_SOURCE: '1', VK_TASK_PANE_PORT: String(binding.port), VK_TASK_PANE_TOKEN: binding.token }, writeOut: text => { output += text; } });
    return JSON.parse(output);
  };
  staged.discard();
  assert.equal((await call(old)).result, 'delivered');
  assert.equal((await call(staged)).reason, 'credentials-expired');
  const next = broker.bind({ termId: '1', generation: 2 }, { staged: true });
  next.activate();
  assert.equal((await call(old)).reason, 'credentials-expired');
  assert.equal((await call(next)).result, 'delivered');
});

test('最新画面 IPC は対応する renderer の返答だけを採用し、無応答は期限で null にする', async () => {
  const vm = require('node:vm');
  const main = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');
  const code = main.slice(main.indexOf('const paneScreenRequests ='), main.indexOf('const paneSendBroker ='));
  let listener; let requested; const sender = { send: (...args) => { requested = args; } };
  const context = { require, Promise, Map, setTimeout: fn => setTimeout(fn, 15), clearTimeout,
    ipcMain: { on: (_channel, fn) => { listener = fn; } }, win: { isDestroyed: () => false, webContents: sender },
    conditionalTerminalInput: { capture: () => ({ screenIdentifier: 'paired', agentGeneration: 1 }) }, agentLifecycles: { get: () => 'running' }, agentGenerations: new Map([['2', 1]]) };
  vm.createContext(context); vm.runInContext(code, context);
  const pending = context.requestPaneScreen('2');
  assert.equal(requested[0], 'terminal:pane-screen-request');
  listener({ sender: {} }, requested[1], { wrong: true });
  listener({ sender }, requested[1], { paired: true });
  assert.deepEqual(await pending, { paired: true });
  assert.equal(await context.requestPaneScreen('2'), null);
  listener({ sender }, requested[1], { late: true });
  const stopped = context.requestPaneScreen('2');
  context.agentLifecycles.get = () => 'stopped';
  listener({ sender }, requested[1], { paired: true });
  assert.equal(await stopped, null);
  assert.equal(await context.requestPaneScreen('2'), null);
});

test('実機の両エンジンの折り畳みと Codex の縦スクロールを読み取れる', () => {
  const live = (engine, stage) => ({ ...require(`./fixtures/pane-send/${engine}-${stage}.json`), engine });
  assert.equal(inputField(live('claude', 'long-paste')).text, '[Pasted text #1 +24 lines]');
  assert.equal(inputField(live('codex', 'long-paste')).text, '[Pasted Content 2915 chars]');
  assert.ok(inputField(live('codex', 'envelope-paste')).text.endsWith('ここまで ---'));
  assert.equal(inputField(live('codex', 'envelope-long-paste')).text, '[Pasted Content 2225 chars]');
});

for (const engine of ['claude', 'codex']) test(`${engine} 実機の折り畳み形式で本文を照合し Enter を確定する`, async () => {
  let f;
  f = fixture({ engine, change({ target, sleeps, refresh }) {
    if (sleeps !== 1) return;
    const body = f.writes[0].slice(6, -6);
    const display = engine === 'codex' ? `[Pasted Content ${[...body].length} chars]` : '[Pasted text #1 +12 lines]';
    Object.assign(target, state(engine, display));
    if (engine === 'claude') target.lines.at(-1).text = '  paste again to expand';
    refresh();
  } });
  assert.equal((await f.send(f.source, '2', 'msg')).result, 'delivered');
});

test('Codex の縦スクロールは今回の乱数終了区切りを含む末尾全体だけを認める', async () => {
  for (const tamper of [false, true]) {
    let f;
    f = fixture({ engine: 'codex', message: 'test\n'.repeat(30), change({ target, sleeps, refresh }) {
      if (sleeps !== 1) return;
      const body = f.writes[0].slice(6, -6);
      const tail = body.split('\n').slice(-4).join('\n');
      Object.assign(target, state('codex', tail.replace('\n', '   ↑\n') + (tamper ? 'extra' : '')));
      refresh();
    } });
    assert.equal((await f.send(f.source, '2', 'msg')).result, tamper ? 'unconfirmed' : 'delivered');
    assert.equal(f.writes.includes('\r'), !tamper);
  }
});

test('接続前の失敗は not-sent、接続後の通信断は unconfirmed として再送しない', async () => {
  const { EventEmitter } = require('node:events');
  for (const connected of [false, true]) {
    let output = '';
    const httpStub = { request() {
      const request = new EventEmitter();
      request.end = () => setImmediate(() => {
        const socket = new EventEmitter(); socket.connecting = true;
        request.emit('socket', socket);
        if (connected) socket.emit('connect');
        request.emit('error', Object.assign(new Error('connection failure'), { code: 'EACCES' }));
      });
      return request;
    } };
    assert.equal(await runTaskCommand(['pane', 'send', '2', 'msg'], { http: httpStub,
      env: { VK_TASK_PANE_SOURCE: '1', VK_TASK_PANE_PORT: '1234', VK_TASK_PANE_TOKEN: 'a'.repeat(64) }, writeOut: text => { output += text; } }), 2);
    assert.equal(JSON.parse(output).result, connected ? 'unconfirmed' : 'not-sent');
    assert.equal(JSON.parse(output).reason, connected ? 'send-failed' : 'sender-unavailable');
    if (!connected) assert.match(JSON.parse(output).message, /VK Terminals に接続できません/);
  }
});

test('pane の案内は資格情報を持つ入口だけに表示する', () => {
  const template = CODEX_TASK_POLICY_PRESETS['orchestrated-task'];
  const enabled = template.renderAgentsGuide('/entry', '/io', true);
  const child = template.renderAgentsGuide('/entry', null, false);
  assert.ok(enabled.includes('<git|gh|prepare|protected-sync|pane|member>'));
  for (const outcome of ['delivered', 'not-sent', 'unconfirmed']) assert.ok(enabled.includes(`${outcome}:`));
  assert.equal(child.includes('pane send'), false);
  assert.equal(child.includes('|pane'), false);
});

for (const engine of ['claude', 'codex']) test(`${engine} 複数行の書きかけ中の矢印を空プロンプトと誤認しない`, () => {
  const draft = state(engine, `人の書きかけ\n  ${engine === 'claude' ? '❯\u00a0' : '› '}`);
  assert.equal(targetReason(draft, 5000), 'target-input-not-empty');
  assert.equal(targetReason({ ...state(engine), cursorY: 3 }, 5000), 'target-state-unknown');
});

// カーソルより後ろも読み、空白だけの複数行入力も保護する。
test('Codex のカーソル下の残文・空行上のカーソルを保護する', async () => {
  for (const text of ['\n  残文', '\n  ', '\n']) {
    const draft = state('codex', text);
    draft.cursorY = text === '\n  残文' ? 1 : 2; draft.cursorX = 2;
    assert.equal(targetReason(draft, 5000), 'target-input-not-empty');
  }
  for (const suffix of ['extra', '\n  extra']) {
    const f = fixture({ engine: 'codex', change({ target, sleeps, refresh }) {
      if (sleeps !== 1) return;
      target.lines.splice(target.cursorY + 1, 0, { text: suffix }); refresh();
    } });
    assert.equal((await f.send(f.source, '2', 'msg')).result, 'unconfirmed');
    assert.equal(f.writes.includes('\r'), false);
  }
});

test('本文表示後の古い識別値では Enter を送らない', async () => {
  let queries = 0; let f;
  f = fixture({ query: target => {
    const screen = { ...target };
    if (++queries > 1) f.guard.markChanged('2');
    return screen;
  } });
  assert.equal((await f.send(f.source, '2', 'msg')).result, 'unconfirmed');
  assert.equal(f.writes.includes('\r'), false);
});

test('既存の Claude Code 折り畳み番号とフッター変更を拒否する', async () => {
  for (const kind of ['number', 'footer']) {
    const f = fixture({ folded: kind === 'number', change({ target, sleeps, refresh }) {
      if (sleeps !== 1) return;
      if (kind === 'footer') target.lines.at(-1).text = '  ? for shortcuts';
      refresh();
    } });
    if (kind === 'number') f.target.lines[0].text = '[Pasted text #1 +7 lines]';
    assert.equal((await f.send(f.source, '2', 'msg')).result, 'unconfirmed');
    assert.equal(f.writes.includes('\r'), false);
  }
});

test('renderer は描画キュー通過後に識別値を再照合する', () => {
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const code = source.slice(source.indexOf("VKIpc.on('terminal:pane-screen-request'"), source.indexOf("VKIpc.on('terminal:data'"));
  let handler; let flush; const replies = [];
  const terminal = { termId: '2', screenIdentifier: 'screen', screenIdentifierGeneration: 1,
    term: { write(text, callback) { assert.equal(text, ''); flush = callback; } } };
  vm.runInNewContext(code, { terminals: { pane: terminal }, VKIpc: { on: (_, fn) => { handler = fn; }, send: (...args) => replies.push(args) },
    window: { VKPaneSnapshot: { capturePaneScreen: () => ({ rendered: true }) } } });
  const expected = { screenIdentifier: 'screen', agentGeneration: 1 };
  for (const change of [null, 'screenIdentifier', 'screenIdentifierGeneration']) {
    terminal.screenIdentifier = 'screen'; terminal.screenIdentifierGeneration = 1;
    const before = replies.length;
    handler('request', '2', expected);
    assert.equal(replies.length, before);
    if (change) terminal[change] = 'changed';
    flush();
    if (change) assert.equal(replies.at(-1)[2], null);
    else assert.equal(replies.at(-1)[2].rendered, true);
  }
});

test('capturePaneScreen は viewport と dim をセルごとに採取する', () => {
  const { capturePaneScreen } = require('../renderer/paneSnapshot');
  const term = { rows: 2, cols: 2, modes: { bracketedPasteMode: true }, buffer: { active: {
    baseY: 10, cursorX: 1, cursorY: 0, getLine(y) { return {
      translateToString: trim => { assert.equal(trim, true); return `line${y}`; },
      getCell: x => ({ getChars: () => `${y}:${x}`, isDim: () => y === 10 && x === 1 }),
    }; },
  } } };
  const snapshot = capturePaneScreen(term);
  assert.deepEqual(snapshot.lines, [10, 11].map(y => ({ text: `line${y}`, cells: [0, 1].map(x => ({ chars: `${y}:${x}`, dim: y === 10 && x === 1 })) })));
  assert.equal(snapshot.bracketedPaste, true);
});

test('本文表示の最新判定が拒否した画面は後段のガードへ渡さない', async () => {
  const f = fixture();
  const current = f.guard.isCurrent;
  let checks = 0;
  // 最初の送信前画面だけを許可し、本文表示の照合を独立して拒否する。
  f.guard.isCurrent = (...args) => ++checks === 1 && current(...args);
  assert.equal((await f.send(f.source, '2', 'msg')).result, 'unconfirmed');
  assert.equal(f.writes.includes('\r'), false);
});

test('Codex の下部2行のモデル表示を本文へ含めない', () => {
  const live = structuredClone(require('./fixtures/pane-send/codex-empty.json'));
  live.lines.at(-2).text = '  GPT-5.6-Sol low · /temporary/example';
  assert.equal(targetReason({ ...live, engine: 'codex', status: 'idle', lastOutputTime: 1000 }, 5000), null);
});

test('未設定と接続前エラーでは利用者への案内を分ける', async () => {
  let output = '';
  await runTaskCommand(['pane', 'send', '2', 'msg'], { env: {}, writeOut: text => { output += text; } });
  assert.match(JSON.parse(output).message, /設定されていません/);
});

for (const footer of ['⏵⏵ accept edits on (shift+tab to cycle)', '⏸ plan mode on (shift+tab to cycle)', '⏵⏵ auto mode on (shift+tab to cycle)', '⏸ manual mode on']) test(`Claude Code の実機フッター: ${footer}`, () => {
  const screen = structuredClone(require('./fixtures/pane-send/claude-empty.json'));
  screen.lines.at(-1).text = `  ${footer} · ← 2 agents`;
  assert.equal(targetReason({ ...screen, engine: 'claude', status: 'idle', lastOutputTime: 1000 }, 5000), null);
});

for (const phrase of ['for shortcuts', 'context left']) test(`Codex 本文の ${phrase} を終端にしない`, async () => {
  const draft = state('codex', `\n  ${phrase}`); draft.cursorY = 1; draft.cursorX = 2;
  assert.equal(targetReason(draft, 5000), 'target-input-not-empty');
  const f = fixture({ engine: 'codex', message: phrase });
  assert.equal((await f.send(f.source, '2', 'msg')).result, 'delivered');
});

// 各安全条件を単独で外したときに、別の条件へ隠れない反例を作る。
for (const kind of ['plain-footer', 'fold-footer', 'fold-format', 'extra-footer', 'no-arrow', 'no-end', 'wrong-top', 'tail-only']) test(`本文照合の反例: ${kind}`, async () => {
  const codex = ['no-arrow', 'no-end', 'wrong-top', 'tail-only'].includes(kind);
  let f;
  f = fixture({ engine: codex ? 'codex' : 'claude', change({ target, sleeps, refresh }) {
    if (sleeps !== 1) return;
    const body = f.writes[0].slice(6, -6);
    let text = body;
    if (kind === 'fold-footer' || kind === 'extra-footer') text = '[Pasted text #1 +12 lines]';
    if (kind === 'fold-format') text = '[Pasted text #1 +12 lines]junk';
    if (codex) {
      text = body.split('\n').slice(-3).join('\n');
      if (kind !== 'no-arrow') text = text.replace('\n', ' ↑\n');
      if (kind === 'no-end') text = ' ↑\n';
      if (kind === 'wrong-top') text = 'WRONG' + text;
      if (kind === 'tail-only') text += 'extra';
    }
    Object.assign(target, state(codex ? 'codex' : 'claude', text));
    if (!codex) target.lines.at(-1).text = kind === 'fold-footer' ? '? for shortcuts' : kind === 'extra-footer' ? 'paste again to expand\n? for shortcuts' : 'paste again to expand';
    // フッターを実際の別行へ分割する。
    target.lines = target.lines.flatMap(line => line.text.split('\n').map(text => ({ text })));
    refresh();
  } });
  assert.equal((await f.send(f.source, '2', 'msg')).result, 'unconfirmed');
  assert.equal(f.writes.includes('\r'), false);
});

for (const kind of ['body-remains', 'stale-empty']) test(`Enter 後の到達確認: ${kind}`, async () => {
  let f;
  f = fixture({ accept: false, change({ target, guard, refresh }) {
    if (!f.writes.includes('\r')) return;
    if (kind === 'stale-empty') { Object.assign(target, state()); refresh(); guard.markChanged('2'); }
    else { refresh(); }
  } });
  assert.equal((await f.send(f.source, '2', 'msg')).result, 'unconfirmed');
  assert.equal(f.writes.includes('\r'), true);
});

test('送信結果3分類を本文なしで0600保存し、1世代でローテーションする', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { createPaneSendLog } = require('../utils/paneSendLog');
  const audit = createPaneSendLog(dir);
  for (const kind of ['delivered', 'not-sent', 'unconfirmed']) {
    const f = fixture({ audit, accept: kind !== 'unconfirmed' });
    if (kind === 'not-sent') f.target.status = 'running';
    assert.equal((await f.send(f.source, '2', 'msg')).result, kind);
  }
  const file = path.join(dir, 'pane-send-log.jsonl');
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(rows.map(row => row.result), ['delivered', 'not-sent', 'unconfirmed']);
  assert.equal(JSON.stringify(rows).includes('issue'), false);
  assert.ok(rows.every(row => row.time && row.id && row.engine));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  createPaneSendLog(dir, { maxBytes: 1 })(rows[0]);
  assert.equal(fs.existsSync(file + '.1'), true);
  assert.equal(fs.statSync(file + '.1').mode & 0o777, 0o600);
});

test('ログ書き込み失敗でも送信を完了する', async t => {
  const warnings = []; t.mock.method(console, 'warn', (...args) => warnings.push(args));
  const { createPaneSendLog } = require('../utils/paneSendLog');
  const f = fixture({ audit: createPaneSendLog('/unused', { fsImpl: { mkdirSync() { throw new Error('disk failure'); } } }) });
  assert.equal((await f.send(f.source, '2', 'msg')).result, 'delivered');
  assert.equal(warnings.length, 1);
});

// 危険なログの実体を別プロセスで検査し、停止もタイムアウトで検出する。
for (const kind of ['symlink', 'fifo']) test(`ログの${kind}を拒否して停止しない`, { skip: process.platform === 'win32' }, t => {
  const { spawnSync } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-log-special-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'pane-send-log.jsonl');
  const destination = path.join(dir, 'destination');
  fs.writeFileSync(destination, 'unchanged', { mode: 0o644 });
  if (kind === 'symlink') fs.symlinkSync(destination, file);
  else assert.equal(spawnSync('mkfifo', [file]).status, 0);
  const run = spawnSync(process.execPath, ['-e', `require(${JSON.stringify(require.resolve('../utils/paneSendLog'))}).createPaneSendLog(${JSON.stringify(dir)})({result:'not-sent'})`], { timeout: 3000, encoding: 'utf8' });
  assert.equal(run.error, undefined);
  assert.equal(run.status, 0);
  assert.match(run.stderr, /pane-send log failed/);
  assert.equal(fs.readFileSync(destination, 'utf8'), 'unchanged');
  assert.equal(fs.statSync(destination).mode & 0o777, 0o644);
});

test('ログは許可した項目だけを保存する', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pane-log-fields-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const record = { time: 'now', id: 'id', source: '1', target: '2', engine: 'codex', result: 'delivered', reason: 'delivered' };
  require('../utils/paneSendLog').createPaneSendLog(dir)({ ...record, body: 'private', file: '/private', token: 'secret', unexpected: 'extra' });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'pane-send-log.jsonl'), 'utf8')), record);
});
