'use strict';

// GET /api/transcript-evidence の照合ロジック（utils/transcriptEvidence.js）のテスト（issue #417）。
// 実ファイル（mkdtemp）で照合規則を、差し替えた fsApi でエラー系を検証する。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  checkTranscriptEvidence,
  buildTranscriptEvidenceResponse,
  parseTranscriptEvidenceQuery,
  resolveClaudeProjectTranscriptDir,
  encodeClaudeProjectDirName,
} = require('../utils/transcriptEvidence');

const TOKEN = '3f2b8c1e-5a4d-4e7f-9b6a-0c1d2e3f4a5b';
const OTHER_TOKEN = '11111111-2222-4333-8444-555555555555';
const SINCE = Date.parse('2026-10-02T00:00:00.000Z');
const AFTER = SINCE + 60_000;
const CWD = '/work/my project';

function userLine(token, iso, extra = {}) {
  return JSON.stringify({
    type: 'user',
    timestamp: iso,
    message: { role: 'user', content: `session-rotation-run-id=${token}` },
    ...extra,
  }) + '\n';
}

function assistantLine(iso, size) {
  return JSON.stringify({ type: 'assistant', timestamp: iso, message: { content: 'x'.repeat(size) } }) + '\n';
}

// 実ファイルを置いた fake home を作る。files: { 名前: { text, mtimeMs } }
function setup(files, cwd = CWD) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-transcript-'));
  const dir = resolveClaudeProjectTranscriptDir(cwd, { homeDir: home, env: {} });
  if (files) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, { text, mtimeMs }] of Object.entries(files)) {
      const p = path.join(dir, name);
      fs.writeFileSync(p, text);
      const d = new Date(mtimeMs);
      fs.utimesSync(p, d, d);
    }
  }
  return {
    home,
    dir,
    run: (overrides = {}) => checkTranscriptEvidence({
      cwd,
      token: TOKEN,
      sinceTimeMs: SINCE,
      engine: 'claude',
      homeDir: home,
      env: {},
      fsApi: { realpath: async (p) => p },
      ...overrides,
    }),
    cleanup: () => fs.rmSync(home, { recursive: true, force: true }),
  };
}

test('encodeClaudeProjectDirName は英数字以外をハイフンにする', () => {
  assert.equal(encodeClaudeProjectDirName('/Users/x/my proj.v2'), '-Users-x-my-proj-v2');
});

test('CLAUDE_CONFIG_DIR があればその配下の projects を見る', () => {
  const dir = resolveClaudeProjectTranscriptDir('/a/b', { homeDir: '/home/u', env: { CLAUDE_CONFIG_DIR: '/conf' } });
  assert.equal(dir, path.join('/conf', 'projects', '-a-b'));
});

test('届いた: since 以降のユーザー発話に token がある', async (t) => {
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, new Date(AFTER).toISOString()), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { result: 'delivered' });
});

test('since より前の行は数えない（mtime だけ新しくても pending）', async (t) => {
  const old = new Date(SINCE - 3_600_000).toISOString();
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, old), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { result: 'pending' });
});

test('since の猶予（5 秒）以内の行は数える', async (t) => {
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, new Date(SINCE - 3000).toISOString()), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { result: 'delivered' });
});

test('mtime が古いファイルは見ない', async (t) => {
  const line = userLine(TOKEN, new Date(AFTER).toISOString());
  const s = setup({ 'a.jsonl': { text: line, mtimeMs: SINCE - 3_600_000 } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { result: 'pending' });
});

test('ツール結果の行・assistant の行は数えない', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const text = userLine(TOKEN, iso, { toolUseResult: { stdout: 'x' } })
    + JSON.stringify({
      type: 'user',
      timestamp: iso,
      message: { role: 'user', content: [{ type: 'tool_result', content: TOKEN }] },
    }) + '\n'
    + JSON.stringify({ type: 'assistant', timestamp: iso, message: { content: TOKEN } }) + '\n';
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { result: 'pending' });
});

test('token が一致しなければ pending', async (t) => {
  const s = setup({ 'a.jsonl': { text: userLine(OTHER_TOKEN, new Date(AFTER).toISOString()), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { result: 'pending' });
});

test('timestamp が無い行・壊れた行は数えない', async (t) => {
  const text = JSON.stringify({ type: 'user', message: { content: TOKEN } }) + '\n' + `{"type":"user" ${TOKEN}\n`;
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { result: 'pending' });
});

test('末尾に改行の無い最終行も判定する', async (t) => {
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, new Date(AFTER).toISOString()).trimEnd(), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { result: 'delivered' });
});

test('読み取りチャンクの境界をまたぐ行も取りこぼさない', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const s = setup({ 'a.jsonl': { text: assistantLine(iso, 300).repeat(5) + userLine(TOKEN, iso), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run({ readChunkBytes: 64 }), { result: 'delivered' });
});

test('.jsonl 以外・symlink の .jsonl は読まない', async (t) => {
  const line = userLine(TOKEN, new Date(AFTER).toISOString());
  const s = setup({ 'a.txt': { text: line, mtimeMs: AFTER }, 'real-target': { text: line, mtimeMs: AFTER } });
  t.after(s.cleanup);
  fs.symlinkSync(path.join(s.dir, 'real-target'), path.join(s.dir, 'link.jsonl'));
  assert.deepEqual(await s.run(), { result: 'pending' });
});

test('Codex ペインは判定できない（engine-codex）', async (t) => {
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, new Date(AFTER).toISOString()), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run({ engine: 'codex' }), { result: 'unknown', reason: 'engine-codex' });
});

test('作業ディレクトリ不明は判定できない（cwd-unknown）', async (t) => {
  const s = setup(null);
  t.after(s.cleanup);
  assert.deepEqual(await s.run({ cwd: undefined }), { result: 'unknown', reason: 'cwd-unknown' });
  assert.deepEqual(await s.run({ cwd: '  ' }), { result: 'unknown', reason: 'cwd-unknown' });
});

test('会話記録ディレクトリが無ければ pending（まだ書かれていない）', async (t) => {
  const s = setup(null);
  t.after(s.cleanup);
  assert.deepEqual(await s.run(), { result: 'pending' });
});

test('会話記録ディレクトリが読めなければ unknown（transcript-unreadable）で、エラー文言を返さない', async () => {
  const eacces = Object.assign(new Error('EACCES: /secret/path'), { code: 'EACCES' });
  const out = await checkTranscriptEvidence({
    cwd: CWD,
    token: TOKEN,
    sinceTimeMs: SINCE,
    engine: 'claude',
    homeDir: '/nonexistent-home',
    env: {},
    fsApi: { realpath: async (p) => p, readdir: async () => { throw eacces; } },
  });
  assert.deepEqual(out, { result: 'unknown', reason: 'transcript-unreadable' });
  assert.ok(!JSON.stringify(out).includes('secret'));
});

test('ファイルが開けない（EACCES）場合も unknown（transcript-unreadable）', async (t) => {
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, new Date(AFTER).toISOString()), mtimeMs: AFTER } });
  t.after(s.cleanup);
  const eacces = Object.assign(new Error('x'), { code: 'EACCES' });
  const out = await s.run({ fsApi: { realpath: async (p) => p, open: async () => { throw eacces; } } });
  assert.deepEqual(out, { result: 'unknown', reason: 'transcript-unreadable' });
});

test('走査するファイル数の上限（maxFiles）を超えた古い側は見ない', async (t) => {
  const line = userLine(TOKEN, new Date(AFTER).toISOString());
  const s = setup({
    'new.jsonl': { text: 'noise\n', mtimeMs: AFTER + 2000 },
    'old.jsonl': { text: line, mtimeMs: AFTER },
  });
  t.after(s.cleanup);
  assert.deepEqual(await s.run({ maxFiles: 1 }), { result: 'pending' });
  assert.deepEqual(await s.run({ maxFiles: 2 }), { result: 'delivered' });
});

test('読み取りバイト数の上限（maxReadBytes）を超えた先は見ない', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const s = setup({ 'a.jsonl': { text: assistantLine(iso, 500).repeat(4) + userLine(TOKEN, iso), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run({ maxReadBytes: 1024 }), { result: 'pending' });
});

// ─── クエリ検証・応答の組み立て ─────────────────────────────────────────────

const q = (obj) => new URLSearchParams(obj);

test('クエリ検証: 正常な形式を受け付ける', () => {
  const r = parseTranscriptEvidenceQuery(q({ termId: '3', token: TOKEN, since: String(SINCE) }));
  assert.deepEqual(r, { ok: true, termId: '3', token: TOKEN, sinceTimeMs: SINCE });
});

test('クエリ検証: token が UUID でない・欠落は 400 相当', () => {
  for (const token of ['', 'abc', `${TOKEN}x`, '../../etc/passwd', undefined]) {
    const params = { termId: '1', since: String(SINCE) };
    if (token !== undefined) params.token = token;
    assert.equal(parseTranscriptEvidenceQuery(q(params)).ok, false, String(token));
  }
});

test('クエリ検証: termId / since の不正値は 400 相当', () => {
  for (const termId of ['', '0', '-1', '1.5', 'abc', '1 ', '12345678901']) {
    assert.equal(parseTranscriptEvidenceQuery(q({ termId, token: TOKEN, since: String(SINCE) })).ok, false, termId);
  }
  for (const since of ['', '-1', '1.5', 'abc', '1e3', '99999999999999999', '0x10']) {
    assert.equal(parseTranscriptEvidenceQuery(q({ termId: '1', token: TOKEN, since })).ok, false, since);
  }
  assert.equal(parseTranscriptEvidenceQuery(q({ token: TOKEN, since: '1' })).ok, false);
});

test('応答: 不正形式は 400、存在しない termId は 404', async () => {
  const deps = { paneExists: (id) => id === '1', getPaneState: () => ({ cwd: CWD, engine: 'claude' }) };
  const bad = await buildTranscriptEvidenceResponse({ searchParams: q({ termId: '1', token: 'x', since: '1' }), ...deps });
  assert.equal(bad.status, 400);
  const missing = await buildTranscriptEvidenceResponse({ searchParams: q({ termId: '9', token: TOKEN, since: '1' }), ...deps });
  assert.equal(missing.status, 404);
});

test('応答: 実際の cwd / engine を使って 200 で返し、中身・パスを含めない', async (t) => {
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, new Date(AFTER).toISOString()), mtimeMs: AFTER } });
  t.after(s.cleanup);
  const base = {
    paneExists: () => true,
    checkOptions: { homeDir: s.home, env: {}, fsApi: { realpath: async (p) => p } },
    searchParams: q({ termId: '1', token: TOKEN, since: String(SINCE) }),
  };
  const ok = await buildTranscriptEvidenceResponse({ ...base, getPaneState: () => ({ cwd: CWD, engine: 'claude' }) });
  assert.deepEqual(ok, { status: 200, body: { result: 'delivered' } });
  const codex = await buildTranscriptEvidenceResponse({ ...base, getPaneState: () => ({ cwd: CWD, engine: 'codex' }) });
  assert.deepEqual(codex, { status: 200, body: { result: 'unknown', reason: 'engine-codex' } });
  const noState = await buildTranscriptEvidenceResponse({ ...base, getPaneState: () => undefined });
  assert.deepEqual(noState, { status: 200, body: { result: 'unknown', reason: 'cwd-unknown' } });
  assert.ok(!JSON.stringify(ok).includes(s.home));
});
