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
const NOW = SINCE + 120_000; // クエリ検証・応答テストで使う「現在時刻」
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

test('読み取りバイト数の上限（maxReadBytes）を超えるファイルは末尾の上限バイト分だけを読む（先頭側の token は数えない）', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, iso) + assistantLine(iso, 500).repeat(4), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run({ maxReadBytes: 1024 }), { result: 'pending' });
});

// ─── 追加の照合テスト（issue #417 安藤レビュー LOW-2 / LOW-3）────────────────────

test('cwd がシンボリックリンクを含む場合、realpath で解決したディレクトリで照合する', async (t) => {
  const real = '/real/work/dir';
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, new Date(AFTER).toISOString()), mtimeMs: AFTER } }, real);
  t.after(s.cleanup);
  const link = '/link/to/work';
  const seen = [];
  const run = (fsApi) => checkTranscriptEvidence({
    cwd: link, token: TOKEN, sinceTimeMs: SINCE, engine: 'claude', homeDir: s.home, env: {}, fsApi,
  });
  // 解決しなければ link 側のディレクトリ（存在しない）を見て pending になる
  assert.deepEqual(await run({ realpath: async (p) => { seen.push(p); throw new Error('x'); } }), { result: 'pending' });
  // realpath で real へ解決できれば delivered
  assert.deepEqual(await run({ realpath: async (p) => { seen.push(p); return real; } }), { result: 'delivered' });
  assert.deepEqual(seen, [link, link]);
});

test('open が ELOOP を投げたファイルは飛ばして続行する', async (t) => {
  const line = userLine(TOKEN, new Date(AFTER).toISOString());
  const s = setup({
    'swapped.jsonl': { text: 'noise\n', mtimeMs: AFTER + 2000 },
    'ok.jsonl': { text: line, mtimeMs: AFTER },
  });
  t.after(s.cleanup);
  const realOpen = (p) => fs.promises.open(p, 'r');
  const out = await s.run({
    fsApi: {
      realpath: async (p) => p,
      open: async (p) => {
        if (p.endsWith('swapped.jsonl')) throw Object.assign(new Error('ELOOP'), { code: 'ELOOP' });
        return realOpen(p);
      },
    },
  });
  assert.deepEqual(out, { result: 'delivered' });
});

test('改行の無い長い行（チャンク多数）を連結しても、後続の行を判定できる', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const longLine = JSON.stringify({ type: 'assistant', timestamp: iso, message: { content: 'y'.repeat(20000) } }) + '\n';
  const s = setup({ 'a.jsonl': { text: longLine + userLine(TOKEN, iso), mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run({ readChunkBytes: 128 }), { result: 'delivered' });
});

test('上限で切れた断片は捨てる（長い行の途中で止まった場合に誤一致しない）', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const text = userLine(TOKEN, iso);
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  // 行の途中（改行の手前）で上限に達する。完全な行ではないので判定しない
  assert.deepEqual(await s.run({ maxReadBytes: text.length - 5 }), { result: 'pending' });
});

// ─── 上限を超える長い会話の末尾読み（issue #417 レビュー HIGH）────────────────

test('上限を超えるファイルの末尾にある token は delivered になる', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const text = assistantLine(iso, 500).repeat(4) + userLine(TOKEN, iso);
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.ok(Buffer.byteLength(text) > 1024);
  assert.deepEqual(await s.run({ maxReadBytes: 1024 }), { result: 'delivered' });
  // チャンクが小さくても（境界をまたいでも）同じ
  assert.deepEqual(await s.run({ maxReadBytes: 1024, readChunkBytes: 100 }), { result: 'delivered' });
});

test('上限以下のファイルは今までどおり先頭から全部読む', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const text = userLine(TOKEN, iso) + assistantLine(iso, 100);
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.deepEqual(await s.run({ maxReadBytes: Buffer.byteLength(text) }), { result: 'delivered' });
});

test('読み始め位置で途中から切れた 1 行に token が入っていても数えない', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const target = userLine(TOKEN, iso);
  const tail = assistantLine(iso, 200);
  const text = target + tail;
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  // 読み始め位置を token 行の途中（token の手前。残る断片は token を含むが、先頭が欠けた JSON になる）に置く。
  // token を含み、かつ途中から JSON として解釈できてしまう形にならないことを確認する。
  const maxReadBytes = Buffer.byteLength(tail) + 45;
  assert.ok(Buffer.byteLength(text) - maxReadBytes > 0);
  assert.deepEqual(await s.run({ maxReadBytes }), { result: 'pending' });
  // 読み始め位置が token 行の中にあり、その行に token が残っている（捨てた行に token がある前提）
  const dropped = Buffer.from(text).subarray(Buffer.byteLength(text) - maxReadBytes).toString().split('\n')[0];
  assert.ok(dropped.includes(TOKEN));
});

test('途中から切れた行を捨てる処理: ちょうど { から読み始めても、完全な行の先頭ではないので数えない', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const text = 'GARBAGE' + userLine(TOKEN, iso) + assistantLine(iso, 50);
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  // 'GARBAGE' の直後の { から読み始める。この断片は有効な JSON 行で token も入っているので、
  // 捨てる処理が無ければ delivered になってしまう
  const maxReadBytes = Buffer.byteLength(text) - Buffer.byteLength('GARBAGE');
  assert.deepEqual(await s.run({ maxReadBytes }), { result: 'pending' });
});

test('読み始めがちょうど改行の直後なら、完全な行として判定する', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const tail = assistantLine(iso, 50);
  const text = assistantLine(iso, 50) + userLine(TOKEN, iso) + tail;
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  // user 行の先頭（直前が改行）から読み始める
  const maxReadBytes = Buffer.byteLength(text) - Buffer.byteLength(assistantLine(iso, 50));
  assert.deepEqual(await s.run({ maxReadBytes }), { result: 'delivered' });
});

test('末尾読みでも、改行で終わらない最終行の token は判定する', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const last = userLine(TOKEN, iso).trimEnd();
  const text = assistantLine(iso, 300) + last;
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  assert.ok(Buffer.byteLength(text) > Buffer.byteLength(last) + 50);
  assert.deepEqual(await s.run({ maxReadBytes: Buffer.byteLength(last) + 50 }), { result: 'delivered' });
});

test('末尾読みでも、途中から切れた行を捨てたあとの完全な行は判定する', async (t) => {
  const iso = new Date(AFTER).toISOString();
  const text = assistantLine(iso, 300) + userLine(TOKEN, iso);
  const s = setup({ 'a.jsonl': { text, mtimeMs: AFTER } });
  t.after(s.cleanup);
  // 先頭の assistant 行の途中から読み始める
  assert.deepEqual(await s.run({ maxReadBytes: Buffer.byteLength(userLine(TOKEN, iso)) + 50 }), { result: 'delivered' });
});

// ─── クエリ検証・応答の組み立て ─────────────────────────────────────────────

const q = (obj) => new URLSearchParams(obj);

test('クエリ検証: 正常な形式を受け付ける', () => {
  const r = parseTranscriptEvidenceQuery(q({ termId: '3', token: TOKEN, since: String(SINCE) }), NOW);
  assert.deepEqual(r, { ok: true, termId: '3', token: TOKEN, sinceTimeMs: SINCE });
});

test('クエリ検証: token が UUID でない・欠落は 400 相当', () => {
  for (const token of ['', 'abc', `${TOKEN}x`, '../../etc/passwd', undefined]) {
    const params = { termId: '1', since: String(SINCE) };
    if (token !== undefined) params.token = token;
    assert.equal(parseTranscriptEvidenceQuery(q(params), NOW).ok, false, String(token));
  }
});

test('クエリ検証: 大文字を含む UUID は 400 相当（小文字のみ受け付ける）', () => {
  assert.equal(parseTranscriptEvidenceQuery(q({ termId: '1', token: TOKEN.toUpperCase(), since: String(SINCE) }), NOW).ok, false);
  assert.equal(parseTranscriptEvidenceQuery(q({ termId: '1', token: '3F2b8c1e-5a4d-4e7f-9b6a-0c1d2e3f4a5b', since: String(SINCE) }), NOW).ok, false);
});

test('クエリ検証: termId / since の不正値は 400 相当', () => {
  for (const termId of ['', '0', '-1', '1.5', 'abc', '1 ', '12345678901']) {
    assert.equal(parseTranscriptEvidenceQuery(q({ termId, token: TOKEN, since: String(SINCE) }), NOW).ok, false, termId);
  }
  for (const since of ['', '-1', '1.5', 'abc', '1e3', '99999999999999999', '0x10']) {
    assert.equal(parseTranscriptEvidenceQuery(q({ termId: '1', token: TOKEN, since }), NOW).ok, false, since);
  }
  assert.equal(parseTranscriptEvidenceQuery(q({ token: TOKEN, since: '1' }), NOW).ok, false);
});

test('クエリ検証: since の下限（24 時間前）と未来（1 分超）は 400 相当、境界は受け付ける', () => {
  const day = 24 * 60 * 60 * 1000;
  const parse = (since) => parseTranscriptEvidenceQuery(q({ termId: '1', token: TOKEN, since: String(since) }), NOW).ok;
  assert.equal(parse(0), false);
  assert.equal(parse(NOW - day - 1), false);
  assert.equal(parse(NOW - day), true);
  assert.equal(parse(NOW + 60_000), true);
  assert.equal(parse(NOW + 60_001), false);
});

const baseDeps = (overrides = {}) => ({
  paneExists: (id) => id === '1',
  getPaneState: () => ({ cwd: CWD, engine: 'claude' }),
  now: () => NOW,
  ...overrides,
});

test('応答: 不正形式は 400、存在しないペインは 404 ではなく 200 unknown / pane-not-found', async () => {
  const bad = await buildTranscriptEvidenceResponse({ searchParams: q({ termId: '1', token: 'x', since: String(SINCE) }), ...baseDeps() });
  assert.equal(bad.status, 400);
  const old = await buildTranscriptEvidenceResponse({ searchParams: q({ termId: '1', token: TOKEN, since: '0' }), ...baseDeps() });
  assert.equal(old.status, 400);
  const missing = await buildTranscriptEvidenceResponse({ searchParams: q({ termId: '9', token: TOKEN, since: String(SINCE) }), ...baseDeps() });
  assert.deepEqual(missing, { status: 200, body: { result: 'unknown', reason: 'pane-not-found' } });
});

test('応答: 実際の cwd / engine を使って 200 で返し、中身・パスを含めない', async (t) => {
  const s = setup({ 'a.jsonl': { text: userLine(TOKEN, new Date(AFTER).toISOString()), mtimeMs: AFTER } });
  t.after(s.cleanup);
  const base = baseDeps({
    paneExists: () => true,
    checkOptions: { homeDir: s.home, env: {}, fsApi: { realpath: async (p) => p } },
  });
  const searchParams = q({ termId: '1', token: TOKEN, since: String(SINCE) });
  const ok = await buildTranscriptEvidenceResponse({ ...base, searchParams, getPaneState: () => ({ cwd: CWD, engine: 'claude' }) });
  assert.deepEqual(ok, { status: 200, body: { result: 'delivered' } });
  const codex = await buildTranscriptEvidenceResponse({ ...base, searchParams, getPaneState: () => ({ cwd: CWD, engine: 'codex' }) });
  assert.deepEqual(codex, { status: 200, body: { result: 'unknown', reason: 'engine-codex' } });
  const noState = await buildTranscriptEvidenceResponse({ ...base, searchParams, getPaneState: () => undefined });
  assert.deepEqual(noState, { status: 200, body: { result: 'unknown', reason: 'cwd-unknown' } });
  assert.ok(!JSON.stringify(ok).includes(s.home));
});

test('応答: 照合の途中に同じペインへ来た要求は busy、別ペインは影響を受けない', async () => {
  const inFlight = new Set();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  // realpath を止めて「照合の途中」を作る
  const checkOptions = { homeDir: '/nonexistent-home', env: {}, fsApi: { realpath: async (p) => { await gate; return p; }, readdir: async () => [] } };
  const searchParams = q({ termId: '1', token: TOKEN, since: String(SINCE) });
  const deps = baseDeps({ paneExists: () => true, checkOptions, inFlight });

  const first = buildTranscriptEvidenceResponse({ searchParams, ...deps });
  const second = await buildTranscriptEvidenceResponse({ searchParams, ...deps });
  assert.deepEqual(second, { status: 200, body: { result: 'unknown', reason: 'busy' } });
  assert.equal(inFlight.has('1'), true);

  const other = buildTranscriptEvidenceResponse({ searchParams: q({ termId: '2', token: TOKEN, since: String(SINCE) }), ...deps });
  release();
  assert.deepEqual((await first).body, { result: 'pending' });
  assert.deepEqual((await other).body, { result: 'pending' });
  assert.equal(inFlight.size, 0);

  // 終わった後は再び受け付ける
  assert.deepEqual((await buildTranscriptEvidenceResponse({ searchParams, ...deps })).body, { result: 'pending' });
});

test('応答: 処理中に例外が出ても処理中の印は外れる', async () => {
  const inFlight = new Set();
  const searchParams = q({ termId: '1', token: TOKEN, since: String(SINCE) });
  const deps = baseDeps({
    paneExists: () => true,
    getPaneState: () => { throw new Error('boom'); },
    inFlight,
  });
  await assert.rejects(buildTranscriptEvidenceResponse({ searchParams, ...deps }), /boom/);
  assert.equal(inFlight.size, 0);
});

test('応答: ペインが無いときは処理中の印を付けない', async () => {
  const inFlight = new Set();
  await buildTranscriptEvidenceResponse({
    searchParams: q({ termId: '9', token: TOKEN, since: String(SINCE) }),
    ...baseDeps({ inFlight }),
  });
  assert.equal(inFlight.size, 0);
});
