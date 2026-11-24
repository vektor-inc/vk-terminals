// 起動試行（attemptId）の帳簿と受領判定（utils/launchAttempts.js。issue #657）の検証。
// 仕様は docs/specification-launch-attempts.md を正とする。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const la = require('../utils/launchAttempts');
const { scheduleLaunchCommand } = require('../utils/delayedLaunch');

const PROMPT = 'Codex への初期指示\n"double" \'single\' $HOME `bt` !! \ttab \\backslash';

function tmpBase(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-launch-attempts-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return path.join(root, 'launch-attempts');
}

function validCwd(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-launch-attempts-cwd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const deps = {
  validateCodexLaunchOptions: (_engine, options) => {
    if (options.codexPolicy !== undefined && (typeof options.codexPolicy !== 'object' || options.codexPolicy.preset !== 'orchestrated-task')) {
      return { ok: false, error: 'invalid codexPolicy preset' };
    }
    return { ok: true, codexPolicy: options.codexPolicy, approvalPolicy: options.approvalPolicy, sandboxMode: options.sandboxMode };
  },
  isValidModelForEngine: (_engine, model) => typeof model === 'string' && /^[a-z0-9.-]+$/.test(model),
  isDirectory: (dir) => { try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; } },
};

function makeRequest(t, overrides = {}) {
  const body = { attemptId: crypto.randomUUID(), agent: 'codex', cwd: validCwd(t), prompt: PROMPT, codexPolicy: { preset: 'orchestrated-task' }, ...overrides };
  const result = la.validateLaunchAttemptRequest(body, deps);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.request;
}

function clock(start = 1_700_000_000_000) {
  let current = start;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

// 偽の専用 CODEX_HOME に rollout を書く。
function writeRollout(home, lines, { name = 'rollout-a.jsonl', trailingNewline = true } = {}) {
  const dir = path.join(home, 'sessions', '2026', '11', '24');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n') + (trailingNewline ? '\n' : ''));
}
const meta = (id = 'session-1') => ({ type: 'session_meta', payload: { id, cwd: '/x', cli_version: '0.171.0' } });
const newUserItem = (text) => ({ type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text }] } } });
const responseUser = (text) => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const oldUserMessage = (text) => ({ type: 'event_msg', payload: { type: 'user_message', message: text } });

// 受け付け → ペイン作成 → 書く直前の意図 → 書いた、までを進める。
function launch(ledger, request, { termId = '7', codexHome } = {}) {
  assert.equal(ledger.accept(request).status, 'accepted');
  const claim = ledger.claimPane(request.attemptId);
  ledger.bindPane(claim, { termId, paneGeneration: 1, codexHome });
  assert.equal(ledger.noteLaunchIntent(claim), true);
  ledger.markLaunchWritten(claim);
  return claim;
}
const alive = () => 'alive';

test('要求の検証: 未知の項目・不正な attemptId・未対応のエージェント・codexPolicy 無しを固定コードで拒否する', (t) => {
  const cwd = validCwd(t);
  const base = { attemptId: crypto.randomUUID(), agent: 'codex', cwd, prompt: 'x', codexPolicy: { preset: 'orchestrated-task' } };
  const codeOf = (body) => la.validateLaunchAttemptRequest(body, deps).error?.code;
  assert.equal(codeOf({ ...base, noClaude: false }), 'UNKNOWN_FIELD');
  assert.equal(codeOf({ ...base, engine: 'codex' }), 'UNKNOWN_FIELD');
  assert.equal(codeOf({ ...base, attemptId: 'not-a-uuid' }), 'INVALID_ATTEMPT_ID');
  assert.equal(codeOf({ ...base, attemptId: base.attemptId.toUpperCase() }), 'INVALID_ATTEMPT_ID');
  assert.equal(codeOf({ ...base, agent: 'claude' }), 'UNSUPPORTED_AGENT');
  assert.equal(codeOf({ ...base, cwd: 'relative/dir' }), 'INVALID_CWD');
  assert.equal(codeOf({ ...base, cwd: path.join(cwd, 'missing') }), 'INVALID_CWD');
  assert.equal(codeOf({ ...base, prompt: '  \n ' }), 'INVALID_PROMPT');
  assert.equal(codeOf({ ...base, prompt: 'a\0b' }), 'INVALID_PROMPT');
  assert.equal(codeOf({ ...base, prompt: 'あ'.repeat(Math.floor(la.MAX_PROMPT_BYTES / 3) + 1) }), 'PROMPT_TOO_LARGE');
  assert.equal(codeOf({ ...base, codexPolicy: undefined }), 'CODEX_POLICY_REQUIRED');
  assert.equal(codeOf({ ...base, codexPolicy: { preset: 'full-access' } }), 'INVALID_LAUNCH_OPTIONS');
  assert.equal(codeOf({ ...base, model: 'bad model' }), 'INVALID_LAUNCH_OPTIONS');
  assert.equal(codeOf({ ...base, stashed: 'yes' }), 'INVALID_LAUNCH_OPTIONS');
  assert.equal(codeOf([]), 'INVALID_JSON');
  // 拒否の retry は、送り直しても通らない not-useful。
  assert.equal(la.validateLaunchAttemptRequest({ ...base, extra: 1 }, deps).error.retry, 'not-useful');
  // 上限ちょうど（UTF-8 で 64KiB）は受け付ける。
  assert.equal(la.validateLaunchAttemptRequest({ ...base, prompt: 'a'.repeat(la.MAX_PROMPT_BYTES) }, deps).ok, true);
});

test('要約値: 改行を LF にそろえ前後の空白を除いた本文の UTF-8 SHA-256 で、本文を含まない', (t) => {
  const request = makeRequest(t, { prompt: `\r\n  ${PROMPT}\r\n\n` });
  const expected = `sha256:${crypto.createHash('sha256').update(Buffer.from(PROMPT, 'utf8')).digest('hex')}`;
  assert.equal(request.prompt, PROMPT);
  assert.equal(request.promptDigest, expected);
  assert.equal(la.computePromptDigest(PROMPT), expected);
  assert.equal(la.normalizePrompt('a\r\nb\rc'), 'a\nb\nc');
});

test('起動引数の断片: `--` の後ろで本文ファイルを読み、引用符や制御文字を含むパスは使わない', () => {
  assert.equal(la.buildPromptArgument('/home/u/.vk-terminals/launch-attempts/x/prompt.txt'), `-- "$(cat '/home/u/.vk-terminals/launch-attempts/x/prompt.txt')"`);
  assert.throws(() => la.buildPromptArgument("/home/o'neil/prompt.txt"));
  assert.throws(() => la.buildPromptArgument('/home/u/a\nb'));
  assert.throws(() => la.buildPromptArgument('relative/prompt.txt'));
  assert.equal(la.isSupportedLaunchShell('/bin/zsh', 'darwin'), true);
  assert.equal(la.isSupportedLaunchShell('/bin/bash', 'linux'), true);
  assert.equal(la.isSupportedLaunchShell('/bin/sh', 'linux'), true);
  assert.equal(la.isSupportedLaunchShell('/usr/bin/fish', 'linux'), false);
  assert.equal(la.isSupportedLaunchShell('C:\\Windows\\System32\\cmd.exe', 'win32'), false);
});

test('rollout の新しい形式（item_completed / response_item）と古い形式（user_message）で受領を判定する', () => {
  const digest = la.computePromptDigest(PROMPT);
  const text = (lines, tail = '\n') => lines.map((line) => JSON.stringify(line)).join('\n') + tail;
  // 先頭に AGENTS.md などの文脈が入っても、一致する発言があれば受領とみなす。
  assert.deepEqual(la.findPromptReceiptInRollout(text([meta('s-new'), responseUser('# AGENTS.md ...'), newUserItem(PROMPT)]), digest), { status: 'matched', sessionId: 's-new' });
  assert.deepEqual(la.findPromptReceiptInRollout(text([meta('s-resp'), responseUser(PROMPT)]), digest), { status: 'matched', sessionId: 's-resp' });
  assert.deepEqual(la.findPromptReceiptInRollout(text([meta('s-old'), oldUserMessage(PROMPT)]), digest), { status: 'matched', sessionId: 's-old' });
  // 一致しない・まだ書かれていない。
  assert.deepEqual(la.findPromptReceiptInRollout(text([meta(), newUserItem(`${PROMPT} `)]), digest), { status: 'pending' });
  assert.deepEqual(la.findPromptReceiptInRollout('', digest), { status: 'pending' });
  // 書きかけの最後の行は無視する。
  assert.deepEqual(la.findPromptReceiptInRollout(`${JSON.stringify(meta())}\n{"type":"event_msg","pay`, digest), { status: 'pending' });
  // 知らない形式（先頭が session_meta でない・途中の行が壊れている）。
  assert.deepEqual(la.findPromptReceiptInRollout(text([{ id: 'x', instructions: '' }, oldUserMessage(PROMPT)]), digest), { status: 'unrecognized' });
  assert.deepEqual(la.findPromptReceiptInRollout(`${JSON.stringify(meta())}\nnot json\n${JSON.stringify(newUserItem(PROMPT))}\n`, digest), { status: 'unrecognized' });
});

test('状態の移り変わり: 受け付け → 書いた → 受領で received になり、本文ファイルを消して要約値を残す', (t) => {
  const base = tmpBase(t);
  const c = clock();
  const ledger = la.createLaunchAttemptLedger({ baseDir: base, now: c.now });
  const request = makeRequest(t);
  const home = path.join(path.dirname(base), 'codex-home');
  assert.equal(ledger.accept(request).status, 'accepted');
  const promptFile = path.join(base, request.attemptId, 'prompt.txt');
  assert.equal(fs.readFileSync(promptFile, 'utf8'), PROMPT);
  assert.equal(fs.statSync(promptFile).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.join(base, request.attemptId)).mode & 0o777, 0o700);
  let response = ledger.toResponse(ledger.refresh(request.attemptId, { paneState: alive }));
  assert.equal(response.phase, 'awaiting-receipt');
  assert.equal(response.milestones.launchWritten, null);
  assert.equal(response.ledgerId, ledger.ledgerId);

  const claim = ledger.claimPane(request.attemptId);
  ledger.bindPane(claim, { termId: '7', paneGeneration: 1, codexHome: home });
  assert.equal(ledger.noteLaunchIntent(claim), true);
  ledger.markLaunchWritten(claim);
  response = ledger.toResponse(ledger.refresh(request.attemptId, { paneState: alive }));
  assert.equal(response.phase, 'awaiting-receipt');
  assert.ok(response.milestones.launchWritten);

  writeRollout(home, [meta('sess-1'), responseUser('ctx'), newUserItem(PROMPT)]);
  c.advance(1000);
  response = ledger.toResponse(ledger.refresh(request.attemptId, { paneState: alive }));
  assert.equal(response.phase, 'received');
  assert.equal(response.binding.sessionId, 'sess-1');
  assert.equal(response.binding.termId, '7');
  assert.equal(response.binding.paneGeneration, 1);
  assert.equal(response.binding.promptDigest, request.promptDigest);
  assert.equal(response.receipt.method, 'codex-rollout-v1');
  assert.ok(response.milestones.receiptConfirmed);
  assert.equal(response.error, undefined);
  assert.equal(fs.existsSync(promptFile), false);
  // 応答に本文・パスを含めない。
  assert.equal(JSON.stringify(response).includes('Codex への初期指示'), false);
  assert.equal(JSON.stringify(response).includes(base), false);
  // 受領の後にペインを閉じても received のまま。
  assert.equal(ledger.refresh(request.attemptId, { paneState: () => 'closed' }).phase, 'received');
});

test('同じ要求の送り直しは同じ記録を返し、本文や起動オプションが違えば衝突にする', (t) => {
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t) });
  const request = makeRequest(t);
  assert.equal(ledger.accept(request).status, 'accepted');
  const again = la.validateLaunchAttemptRequest({ attemptId: request.attemptId, agent: 'codex', cwd: request.options.cwd, prompt: `${PROMPT}\n`, codexPolicy: { preset: 'orchestrated-task' } }, deps).request;
  assert.equal(ledger.accept(again).status, 'existing');
  const otherPrompt = { ...again, prompt: 'other', promptDigest: la.computePromptDigest('other') };
  assert.equal(ledger.accept(otherPrompt).status, 'conflict');
  const otherOptions = la.validateLaunchAttemptRequest({ attemptId: request.attemptId, agent: 'codex', cwd: request.options.cwd, prompt: PROMPT, codexPolicy: { preset: 'orchestrated-task' }, stashed: true }, deps).request;
  assert.equal(ledger.accept(otherOptions).status, 'conflict');
});

test('同時に届いた 2 つの要求でも、ペインの作成（claimPane）は 1 回だけ通る', async (t) => {
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t) });
  const request = makeRequest(t);
  const results = await Promise.all([0, 1].map(() => Promise.resolve().then(() => ledger.accept(request).status)));
  assert.deepEqual(results.sort(), ['accepted', 'existing']);
  const claims = [0, 1, 2].map(() => { try { return ledger.claimPane(request.attemptId); } catch (_) { return null; } });
  assert.equal(claims.filter(Boolean).length, 1);
  // 別インスタンスの帳簿が同じフォルダを使っても、記録フォルダの排他作成で 2 本目は受け付けない。
  const fresh = makeRequest(t);
  const other = la.createLaunchAttemptLedger({ baseDir: ledger.baseDir });
  assert.equal(ledger.accept(fresh).status, 'accepted');
  assert.equal(other.accept(fresh).status, 'unavailable');
});

test('時間切れの後に遅れて届いたペインの作成は弾き、rejected（Codex 未起動）にする', (t) => {
  const c = clock();
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t), now: c.now });
  const request = makeRequest(t);
  ledger.accept(request);
  c.advance(la.PANE_CREATION_TIMEOUT_MS);
  assert.throws(() => ledger.claimPane(request.attemptId), /not pending/);
  const response = ledger.toResponse(ledger.get(request.attemptId));
  assert.equal(response.phase, 'rejected');
  assert.deepEqual([response.error.code, response.error.retry], ['PANE_CREATION_TIMEOUT', 'not-useful']);
});

test('保存に失敗したら受け付けを取り消し、同じ attemptId で送り直せる', (t) => {
  let fail = true;
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t), hooks: { failPersist: () => fail } });
  const request = makeRequest(t);
  assert.equal(ledger.accept(request).status, 'unavailable');
  assert.equal(ledger.get(request.attemptId), null);
  assert.equal(fs.existsSync(path.join(ledger.baseDir, request.attemptId)), false);
  fail = false;
  assert.equal(ledger.accept(request).status, 'accepted');
});

test('書く直前の意図を保存できなければ書かず、rejected（Codex 未起動）にする', (t) => {
  let fail = false;
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t), hooks: { failPersist: () => fail } });
  const request = makeRequest(t);
  ledger.accept(request);
  const claim = ledger.claimPane(request.attemptId);
  fail = true;
  assert.equal(ledger.noteLaunchIntent(claim), false);
  const record = ledger.get(request.attemptId);
  assert.equal(record.phase, 'rejected');
  assert.equal(record.error.code, 'LEDGER_WRITE_FAILED');
});

test('受領の前にペインが閉じた・入れ替わった・起動直後に終了した・時間切れは unknown（forbidden）', (t) => {
  const c = clock();
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t), now: c.now });
  const home = path.join(path.dirname(ledger.baseDir), 'empty-home');
  const cases = [
    [(id) => ledger.refresh(id, { paneState: () => 'closed' }), 'PANE_CLOSED'],
    [(id) => ledger.refresh(id, { paneState: () => 'replaced' }), 'PANE_REPLACED'],
    [(id, claim) => { ledger.markEarlyExit(claim); return ledger.refresh(id, { paneState: alive }); }, 'AGENT_EXITED_EARLY'],
    [(id) => { c.advance(la.RECEIPT_TIMEOUT_MS); return ledger.refresh(id, { paneState: alive }); }, 'RECEIPT_TIMEOUT'],
  ];
  for (const [act, code] of cases) {
    const request = makeRequest(t);
    const claim = launch(ledger, request, { codexHome: home });
    const record = act(request.attemptId, claim);
    assert.equal(record.phase, 'unknown', code);
    assert.deepEqual([record.error.code, record.error.retry], [code, 'forbidden']);
    assert.equal(fs.existsSync(path.join(ledger.baseDir, request.attemptId, 'prompt.txt')), false);
  }
});

test('起動直後に終了しても、受領の記録があれば received にする', (t) => {
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t) });
  const home = path.join(path.dirname(ledger.baseDir), 'home-early');
  const request = makeRequest(t);
  const claim = launch(ledger, request, { codexHome: home });
  ledger.markEarlyExit(claim);
  writeRollout(home, [meta('s-early'), oldUserMessage(PROMPT)]);
  assert.equal(ledger.refresh(request.attemptId, { paneState: () => 'closed' }).phase, 'received');
});

test('rollout を読めない・形式を判別できない場合は unknown（forbidden）', (t) => {
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t) });
  const home = path.join(path.dirname(ledger.baseDir), 'home-bad');
  const request = makeRequest(t);
  launch(ledger, request, { codexHome: home });
  writeRollout(home, [{ legacy: true }, 'x']);
  const record = ledger.refresh(request.attemptId, { paneState: alive });
  assert.deepEqual([record.phase, record.error.code, record.error.retry], ['unknown', 'ROLLOUT_UNRECOGNIZED', 'forbidden']);

  const unreadableHome = path.join(path.dirname(ledger.baseDir), 'home-unreadable');
  fs.mkdirSync(path.join(unreadableHome, 'sessions'), { recursive: true });
  fs.chmodSync(path.join(unreadableHome, 'sessions'), 0o000);
  const second = makeRequest(t);
  launch(ledger, second, { codexHome: unreadableHome });
  const unreadable = ledger.refresh(second.attemptId, { paneState: alive });
  fs.chmodSync(path.join(unreadableHome, 'sessions'), 0o700);
  if (process.getuid && process.getuid() === 0) return; // root では権限で読み取りを止められない
  assert.deepEqual([unreadable.phase, unreadable.error.code], ['unknown', 'ROLLOUT_UNREADABLE']);
});

test('再起動からの復帰: 書く前に止まったものは rejected、書いた後はペインが生きていれば確認を続ける', (t) => {
  const base = tmpBase(t);
  const first = la.createLaunchAttemptLedger({ baseDir: base });
  const home = path.join(path.dirname(base), 'home-restart');
  const beforeLaunch = makeRequest(t);
  first.accept(beforeLaunch);
  const afterLaunchAlive = makeRequest(t);
  launch(first, afterLaunchAlive, { termId: '3', codexHome: home });
  const afterLaunchGone = makeRequest(t);
  launch(first, afterLaunchGone, { termId: '4', codexHome: path.join(path.dirname(base), 'home-gone') });

  // アプリを再起動したのと同じく、同じフォルダから帳簿を読み直す。
  const second = la.createLaunchAttemptLedger({ baseDir: base });
  assert.equal(second.ledgerId, first.ledgerId);
  const rejected = second.get(beforeLaunch.attemptId);
  assert.deepEqual([rejected.phase, rejected.error.code, rejected.error.retry], ['rejected', 'APP_RESTARTED_BEFORE_LAUNCH', 'not-useful']);
  assert.equal(fs.existsSync(path.join(base, beforeLaunch.attemptId, 'prompt.txt')), false);
  // 再起動前の試行のペインは作り直さない。
  assert.throws(() => second.claimPane(afterLaunchAlive.attemptId));

  const paneState = (termId) => (termId === '3' ? 'alive' : 'closed');
  assert.equal(second.refresh(afterLaunchAlive.attemptId, { paneState }).phase, 'awaiting-receipt');
  writeRollout(home, [meta('s-restart'), newUserItem(PROMPT)]);
  assert.equal(second.refresh(afterLaunchAlive.attemptId, { paneState }).phase, 'received');
  const gone = second.refresh(afterLaunchGone.attemptId, { paneState });
  assert.deepEqual([gone.phase, gone.error.code, gone.error.retry], ['unknown', 'APP_RESTARTED', 'forbidden']);
});

test('帳簿に無い attemptId は attempt-not-found、帳簿を作り直すと ledgerId が変わる', (t) => {
  const base = tmpBase(t);
  const ledger = la.createLaunchAttemptLedger({ baseDir: base });
  const id = crypto.randomUUID();
  assert.equal(ledger.refresh(id, { paneState: alive }), null);
  assert.deepEqual(ledger.notFoundResponse(id), { attemptId: id, ledgerId: ledger.ledgerId, phase: 'unknown', reason: 'attempt-not-found', error: { code: 'ATTEMPT_NOT_FOUND', retry: 'forbidden', message: 'attempt not found in this ledger' } });
  fs.rmSync(base, { recursive: true, force: true });
  const rebuilt = la.createLaunchAttemptLedger({ baseDir: base });
  assert.notEqual(rebuilt.ledgerId, ledger.ledgerId);
  const capability = la.describeLaunchAttemptCapability(rebuilt);
  assert.deepEqual(capability, { available: true, contractVersion: 1, agents: ['codex'], maxPromptBytes: 65536, receiptMethods: ['codex-rollout-v1'], ledgerId: rebuilt.ledgerId });
  assert.equal(la.describeLaunchAttemptCapability(null).available, false);
});

test('保持期間: 7 日で要約値だけの記録にし、期限切れの attemptId が届いたら拒否する。30 日で消す', (t) => {
  const c = clock();
  const base = tmpBase(t);
  const ledger = la.createLaunchAttemptLedger({ baseDir: base, now: c.now });
  const request = makeRequest(t);
  ledger.accept(request);
  ledger.markNotLaunched(request.attemptId, 'PANE_CREATION_FAILED');
  c.advance(la.RECORD_RETENTION_MS);
  const other = makeRequest(t);
  assert.equal(ledger.accept(other).status, 'accepted'); // 受け付けのたびに整理する
  assert.equal(ledger.accept(request).status, 'expired');
  assert.equal(ledger.toResponse(ledger.get(request.attemptId)).reason, 'attempt-expired');
  const stored = JSON.parse(fs.readFileSync(path.join(base, request.attemptId, 'record.json'), 'utf8'));
  assert.deepEqual(Object.keys(stored).sort(), ['attemptId', 'expiresAt', 'promptDigest', 'tombstone', 'version']);
  c.advance(la.TOMBSTONE_RETENTION_MS);
  la.createLaunchAttemptLedger({ baseDir: base, now: c.now });
  assert.equal(fs.existsSync(path.join(base, request.attemptId)), false);
});

test('帳簿の件数の上限を超えたら full で拒否する', (t) => {
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t) });
  const cwd = validCwd(t);
  for (let index = 0; index < la.MAX_LIVE_RECORDS; index++) {
    const request = la.validateLaunchAttemptRequest({ attemptId: crypto.randomUUID(), agent: 'codex', cwd, prompt: `p${index}`, codexPolicy: { preset: 'orchestrated-task' } }, deps).request;
    assert.equal(ledger.accept(request).status, 'accepted');
  }
  assert.equal(ledger.accept(makeRequest(t)).status, 'full');
});

test('帳簿のフォルダが他人にも開いていたら作らない（LEDGER_UNAVAILABLE の元）', (t) => {
  const base = tmpBase(t);
  fs.mkdirSync(base, { mode: 0o755 });
  fs.chmodSync(base, 0o755);
  assert.throws(() => la.createLaunchAttemptLedger({ baseDir: base }), /private/);
});

test('waitForLaunchOutcome は書いた・最終状態で解け、時間切れなら false を返す', async (t) => {
  const ledger = la.createLaunchAttemptLedger({ baseDir: tmpBase(t) });
  const request = makeRequest(t);
  ledger.accept(request);
  const waiting = ledger.waitForLaunchOutcome(request.attemptId, 5000);
  const claim = ledger.claimPane(request.attemptId);
  ledger.noteLaunchIntent(claim);
  ledger.markLaunchWritten(claim);
  assert.equal(await waiting, true);
  const second = makeRequest(t);
  ledger.accept(second);
  assert.equal(await ledger.waitForLaunchOutcome(second.attemptId, 10), false);
});

// 遅延起動（utils/delayedLaunch.js）に足した起動試行向けの口。
function createTimers() {
  const pending = [];
  return { setTimer: (callback) => { pending.push(callback); return pending.length; }, fire: () => pending.shift()(), pending };
}

test('遅延起動: beforeLaunchWrite が false なら書かずに回収し、true なら書いてから通知する', async () => {
  for (const allowed of [false, true]) {
    const timers = createTimers();
    const written = [];
    const events = [];
    const ptyProcess = { write: (data) => written.push(data) };
    scheduleLaunchCommand({
      ptys: new Map([['1', ptyProcess]]), id: '1', ptyProcess, command: 'codex', delayMs: 0, setTimer: timers.setTimer,
      discard: () => events.push('discard'),
      beforeLaunchWrite: () => { events.push('intent'); return allowed; },
      onWriteSuccess: () => events.push('written'),
    });
    timers.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(written, allowed ? ['codex\r'] : []);
    assert.deepEqual(events, allowed ? ['intent', 'written'] : ['intent', 'discard']);
  }
});

test('遅延起動: onEarlyExit を渡すと、起動直後に終了しても起動し直さず通知だけする', async () => {
  const timers = createTimers();
  const written = [];
  let earlyExits = 0;
  const ptyProcess = { write: (data) => written.push(data) };
  scheduleLaunchCommand({
    ptys: new Map([['1', ptyProcess]]), id: '1', ptyProcess, command: 'codex', delayMs: 0, setTimer: timers.setTimer,
    discard: () => {}, waitForEarlyExit: async () => true, onEarlyExit: () => { earlyExits += 1; },
  });
  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(earlyExits, 1);
  assert.equal(timers.pending.length, 0);
  assert.deepEqual(written, ['codex\r']);
});

test('遅延起動: 起動コマンドの書き込みが例外になったら onLaunchWriteFailed を呼ぶ', async () => {
  const timers = createTimers();
  const events = [];
  const ptyProcess = { write: () => { throw new Error('EIO'); } };
  scheduleLaunchCommand({
    ptys: new Map([['1', ptyProcess]]), id: '1', ptyProcess, command: 'codex', delayMs: 0, setTimer: timers.setTimer,
    discard: () => events.push('discard'), onLaunchWriteFailed: () => events.push('write-failed'),
  });
  timers.fire();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['write-failed', 'discard']);
});
