// Codex 版 issue 対応手順（vektor-inc/vk-agents の codex/vk-kore/）が要求する操作と、固定入口（utils/codexTaskOps.js）の許可操作の照合（issue #523）。
// 手順が要求する操作の一覧は tests/fixtures/codexProcedureOperations.js に写してあり、CI（vk-agents が無い環境）でもこの一覧だけで完結する。
// 照合は parseTaskCommand（固定入口の引数検証）に一覧の引数を渡して受理されるかを見るだけで、gh / git は呼ばない。
// vk-agents がある環境では、手順側に一覧に無い操作が増えていないかを補助的に確かめる（無い環境ではスキップ）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTaskCommand } = require('../utils/codexTaskOps');
const { SNAPSHOT_VK_AGENTS_COMMIT, requiredOperations, knownGaps, notApplicable } = require('./fixtures/codexProcedureOperations');

const SOURCE_PATTERN = /^codex\/vk-kore\/[A-Za-z0-9._-]+\.md:[1-9][0-9]*$/;
const OWNER_REPO = 'vektor-inc/vk-terminals';

const describeEntry = (entry) => `${entry.procedureOperation} (${entry.source}) ${JSON.stringify(entry.argv)}`;

// ─── 一覧そのものの形 ────────────────────────────────────────────────────

test('一覧: すべての項目に出典と引数があり、出典は codex/vk-kore/ 配下のファイルと行番号の形になっている', () => {
  assert.match(SNAPSHOT_VK_AGENTS_COMMIT, /^[0-9a-f]{7,40}$/);
  for (const entry of [...requiredOperations, ...knownGaps, ...notApplicable]) {
    assert.ok(entry.procedureOperation && typeof entry.procedureOperation === 'string', `procedureOperation がありません: ${JSON.stringify(entry)}`);
    assert.match(entry.source, SOURCE_PATTERN, `出典の形が不正です: ${entry.procedureOperation}`);
  }
  for (const entry of [...requiredOperations, ...knownGaps]) {
    assert.ok(Array.isArray(entry.argv) && entry.argv.length > 0 && entry.argv.every((token) => typeof token === 'string'), `argv が不正です: ${describeEntry(entry)}`);
  }
  for (const entry of [...knownGaps, ...notApplicable]) {
    assert.ok(typeof entry.reason === 'string' && entry.reason.length > 0, `除外には理由が必要です: ${entry.procedureOperation}`);
  }
});

test('一覧: 同じ出典・同じ操作名・同じ引数の重複項目が無い', () => {
  const keys = [...requiredOperations, ...knownGaps].map((entry) => `${entry.procedureOperation}\n${entry.source}\n${JSON.stringify(entry.argv)}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('一覧: 必要な操作と既知の不足の両方に同じ引数が入っていない（片方に決める）', () => {
  const requiredArgv = new Set(requiredOperations.map((entry) => JSON.stringify(entry.argv)));
  for (const gap of knownGaps) {
    assert.ok(!requiredArgv.has(JSON.stringify(gap.argv)), `必要な操作にも入っています: ${describeEntry(gap)}`);
  }
});

// ─── 手順が要求する操作を、固定入口が許可リストどおりの形で受理する ─────────

test('照合: 手順が要求する操作を、固定入口が受理する（gh / git は呼ばない）', () => {
  assert.ok(requiredOperations.length > 0);
  const failures = [];
  for (const entry of requiredOperations) {
    const parsed = parseTaskCommand(entry.argv);
    if (!parsed.ok) {
      failures.push(`固定入口が拒否: ${describeEntry(entry)} → ${parsed.error}`);
      continue;
    }
    if (entry.expected.bin !== undefined && parsed.bin !== entry.expected.bin) failures.push(`bin が違う: ${describeEntry(entry)} → ${parsed.bin}`);
    if (entry.expected.operation !== undefined && parsed.operation !== entry.expected.operation) failures.push(`operation が違う: ${describeEntry(entry)} → ${parsed.operation}`);
    if (entry.expected.args !== undefined && JSON.stringify(parsed.args.slice(0, entry.expected.args.length)) !== JSON.stringify(entry.expected.args)) {
      failures.push(`args が違う: ${describeEntry(entry)} → ${JSON.stringify(parsed.args)}`);
    }
  }
  assert.deepEqual(failures, [], `手順が要求するのに固定入口が受理しない操作があります。固定入口を直すか、既知の不足として knownGaps へ理由つきで移してください。\n${failures.join('\n')}`);
});

test('照合: owner/repo の明示形式を許す操作は、明示先を targetRepo に載せて同じ結果で受理する', () => {
  const explicit = requiredOperations.filter((entry) => entry.explicitRepo);
  assert.ok(explicit.length > 0);
  for (const entry of explicit) {
    const bound = parseTaskCommand(entry.argv);
    const [tool, ...rest] = entry.argv;
    const parsed = parseTaskCommand([tool, OWNER_REPO, ...rest]);
    assert.equal(parsed.ok, true, `明示形式を拒否: ${describeEntry(entry)} → ${parsed.error}`);
    assert.equal(parsed.targetRepo, OWNER_REPO, describeEntry(entry));
    assert.equal(parsed.operation, bound.operation, describeEntry(entry));
    assert.deepEqual(parsed.args, bound.args, describeEntry(entry));
  }
});

// ─── 既知の不足（除外リスト）が、いまも不足のままである ──────────────────────

test('既知の不足: 手順が要求するが固定入口が受理しない操作は、理由つきの除外リストのとおり拒否される', () => {
  assert.ok(knownGaps.length > 0);
  const nowAccepted = [];
  for (const gap of knownGaps) {
    const parsed = parseTaskCommand(gap.argv);
    if (parsed.ok) nowAccepted.push(describeEntry(gap));
  }
  assert.deepEqual(nowAccepted, [], `固定入口が受理するようになった操作は、knownGaps から requiredOperations へ移してください。\n${nowAccepted.join('\n')}`);
});

// ─── 補助チェック: vk-agents の実ファイルと一覧のずれ ──────────────────────

const VK_AGENTS_DIR = process.env.VK_AGENTS_DIR || path.join(os.homedir(), 'Documents', 'git', 'vk-agents');
const PROCEDURE_DIR = path.join(VK_AGENTS_DIR, 'codex', 'vk-kore');
const procedureAvailable = fs.existsSync(PROCEDURE_DIR) && fs.statSync(PROCEDURE_DIR).isDirectory();
const skipReason = procedureAvailable ? false : `vk-agents の codex/vk-kore が見つかりません（${PROCEDURE_DIR}）。CI などでは一覧だけで照合します`;

// 手順の markdown 1 件ぶんから、使われている操作名（gh-read.sh / gh-write.sh / repo-prepare.sh / run-member-agent.sh / 素の git サブコマンド）を集める。
function collectProcedureOperations(text) {
  const found = new Set();
  // 入口スクリプトの呼び出し（`GH_BIN/gh-read.sh pr-view ...` / `gh-read.sh --unset-token pr-view` の形）。
  for (const match of text.matchAll(/(gh-read|gh-write|repo-prepare)\.sh\s+(?:--unset-token\s+)?([a-z][a-z-]*)/g)) found.add(`${match[1]}.sh ${match[2]}`);
  // 「読み取り:」「書き込み:」の箇条書き（入口の操作名の一覧。ここが操作名の正）。
  for (const line of text.split('\n')) {
    const listed = line.match(/^\s*- (読み取り|書き込み):(.*)$/);
    if (!listed) continue;
    const script = listed[1] === '読み取り' ? 'gh-read' : 'gh-write';
    for (const token of listed[2].matchAll(/`([a-z]+(?:-[a-z]+)*)`/g)) found.add(`${script}.sh ${token[1]}`);
  }
  // メンバー起動ランチャーのエンジン指定。
  for (const match of text.matchAll(/(?:run-member-agent\.sh|LAUNCH_BIN)\s+(--engine\s+(?:codex|claude)|--readonly|out-dir)/g)) found.add(`run-member-agent.sh ${match[1].replace(/\s+/g, ' ')}`);
  // 素の git（`git -C "<dir>" -c key=value <サブコマンド>` を含む）。
  for (const match of text.matchAll(/\bgit\s+(?:-C\s+"[^"]*"\s+)?(?:-c\s+\S+\s+)*([a-z][a-z-]*)/g)) found.add(`git ${match[1]}`);
  return found;
}

// 一覧が持っている操作名。`gh-read.sh issue-view` のような完全一致と、`git diff` のようなサブコマンドの先頭一致の両方で数える。
function listedOperationNames() {
  const names = new Set();
  for (const entry of [...requiredOperations, ...knownGaps, ...notApplicable]) {
    names.add(entry.procedureOperation);
    names.add(entry.procedureOperation.split(' (')[0]);
  }
  return names;
}

test('補助チェック: 手順（vk-agents の codex/vk-kore）が使う操作名は、すべて一覧に載っている', { skip: skipReason }, () => {
  const listed = listedOperationNames();
  const missing = [];
  for (const file of fs.readdirSync(PROCEDURE_DIR).filter((name) => name.endsWith('.md')).sort()) {
    for (const operation of collectProcedureOperations(fs.readFileSync(path.join(PROCEDURE_DIR, file), 'utf8'))) {
      if (!listed.has(operation)) missing.push(`${operation}（${file}）`);
    }
  }
  assert.deepEqual(missing, [], `手順に、一覧（tests/fixtures/codexProcedureOperations.js）に無い操作名があります。requiredOperations か knownGaps へ追加してください。\n${missing.join('\n')}`);
});

test('補助チェック: 一覧の出典は、vk-agents の実ファイルの存在する行を指している', { skip: skipReason }, () => {
  const broken = [];
  for (const entry of [...requiredOperations, ...knownGaps, ...notApplicable]) {
    const [relativePath, line] = entry.source.split(':');
    const file = path.join(VK_AGENTS_DIR, relativePath);
    if (!fs.existsSync(file)) {
      broken.push(`ファイルが無い: ${entry.source}`);
      continue;
    }
    if (fs.readFileSync(file, 'utf8').split('\n').length < Number(line)) broken.push(`行が無い: ${entry.source}`);
  }
  assert.deepEqual(broken, [], `一覧の出典が手順側とずれています（手順側のファイル・行の移動）。出典を更新してください。\n${broken.join('\n')}`);
});
