'use strict';
// Codex 使用量の集計対象に、タスク専用 CODEX_HOME の sessions を含める処理（issue #638）を検証する。
// 一時ディレクトリに個人の CODEX_HOME と VK Terminals のデータフォルダを作って完結させ、
// 利用者の ~/.codex・~/.vk-terminals には触れない。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  listTaskCodexSessionDirs,
  listCodexSessionDirs,
  createCodexSessionDirsResolver,
} = require('../utils/codexSessionDirs');
const {
  loadCodexUsageSnapshot,
  createCodexUsageProvider,
  selectLatestRateLimits,
  findLastTokenCountRecord,
} = require('../codexUsage');
const { createCodexUsageTracker, dedupeSessionSummaries, fileIdentityKey } = require('../codexUsageTracker');

const NOW = Date.parse('2026-07-06T03:00:00.000Z');
const PRESET = 'orchestrated-task';
const SECRET_TEXT = 'conversation body must not leak';

// 起動名は codexTaskPolicy.js と同じ 24 桁の 16 進数。
function launchName(n) {
  return String(n).padStart(24, '0');
}

function tokenCountLine({ timestamp, sessionPercent = 10, weeklyPercent = 20, totalTokens = 100, sessionResetAt, weeklyResetAt }) {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: totalTokens } },
      rate_limits: {
        primary: { used_percent: sessionPercent, window_minutes: 300, resets_at: sessionResetAt ?? Math.floor((NOW + 3600000) / 1000) },
        secondary: { used_percent: weeklyPercent, window_minutes: 10080, resets_at: weeklyResetAt ?? Math.floor((NOW + 86400000) / 1000) },
      },
    },
  });
}

// 会話本文のレコードも混ぜ、返す値に入らないことを確かめる。
function messageLine(timestamp) {
  return JSON.stringify({ timestamp, type: 'response_item', payload: { type: 'message', content: [{ type: 'output_text', text: SECRET_TEXT }] } });
}

function writeRollout(sessionsDir, name, lines, mtimeMs) {
  const dayDir = path.join(sessionsDir, '2026', '07', '06');
  fs.mkdirSync(dayDir, { recursive: true });
  const file = path.join(dayDir, `rollout-${name}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  if (Number.isFinite(mtimeMs)) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

function taskHome(dataDir, n) {
  return path.join(dataDir, 'codex-task-policy', PRESET, launchName(n));
}

function withTmp(fn) {
  return async () => {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-codex-dirs-')));
    const personalHome = path.join(root, 'personal-codex');
    const dataDir = path.join(root, 'vk-terminals-data');
    fs.mkdirSync(personalHome, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      await fn({ root, personalHome, dataDir });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function resolverFor(personalHome, dataDir, extra = {}) {
  return createCodexSessionDirsResolver({ getPersonalCodexHome: () => personalHome, dataDir, ttlMs: 0, ...extra });
}

async function loadBoth(getSessionDirs) {
  const limits = await loadCodexUsageSnapshot({ getSessionDirs });
  const tracker = createCodexUsageTracker({ getDirs: getSessionDirs, clock: () => NOW, skewMs: 0 });
  const tokens = await tracker.refresh();
  return { limits, tokens };
}

test('通常の CODEX_HOME だけにログがある場合: 従来どおり使用率とトークン数を返す', withTmp(async ({ personalHome, dataDir }) => {
  writeRollout(path.join(personalHome, 'sessions'), 'personal', [
    messageLine('2026-07-06T01:59:00.000Z'),
    tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', sessionPercent: 12, weeklyPercent: 34, totalTokens: 1000 }),
  ]);
  const { limits, tokens } = await loadBoth(resolverFor(personalHome, dataDir));
  assert.equal(limits.session.percent, 12);
  assert.equal(limits.weekly.percent, 34);
  assert.equal(tokens.todayTokens, 1000);
}));

test('タスク専用 CODEX_HOME だけにログがある場合: 親と member/ の sessions を集計に含める', withTmp(async ({ personalHome, dataDir }) => {
  const home = taskHome(dataDir, 1);
  writeRollout(path.join(home, 'sessions'), 'parent', [
    tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', sessionPercent: 40, weeklyPercent: 50, totalTokens: 300 }),
  ]);
  writeRollout(path.join(home, 'member', 'sessions'), 'member', [
    tokenCountLine({ timestamp: '2026-07-06T02:10:00.000Z', sessionPercent: 45, weeklyPercent: 55, totalTokens: 200 }),
  ]);
  const dirs = await listCodexSessionDirs({ personalCodexHome: personalHome, dataDir });
  assert.deepEqual(dirs, [path.join(home, 'sessions'), path.join(home, 'member', 'sessions')]);

  const { limits, tokens } = await loadBoth(resolverFor(personalHome, dataDir));
  assert.equal(limits.session.percent, 45, 'member の方が新しい記録');
  assert.equal(limits.weekly.percent, 55);
  assert.equal(tokens.todayTokens, 500);
}));

test('通常用とタスク専用の両方にログがある場合: レコードの timestamp が新しい使用率を選び、トークンは合算する', withTmp(async ({ personalHome, dataDir }) => {
  // ファイルの更新時刻は通常用の方を新しくしておき、記録の timestamp で選んでいることを確かめる。
  writeRollout(path.join(personalHome, 'sessions'), 'personal', [
    tokenCountLine({ timestamp: '2026-07-06T01:00:00.000Z', sessionPercent: 10, weeklyPercent: 20, totalTokens: 1000 }),
  ], NOW);
  writeRollout(path.join(taskHome(dataDir, 1), 'sessions'), 'task', [
    tokenCountLine({ timestamp: '2026-07-06T02:30:00.000Z', sessionPercent: 70, weeklyPercent: 80, totalTokens: 400 }),
  ], NOW - 3600000);
  const { limits, tokens } = await loadBoth(resolverFor(personalHome, dataDir));
  assert.equal(limits.session.percent, 70);
  assert.equal(limits.weekly.percent, 80);
  assert.equal(tokens.todayTokens, 1400);
  assert.equal(tokens.weeklyTokens, 1400);

  // 返す値には保存先のパスも会話本文も含めない。
  const serialized = JSON.stringify({ limits, tokens });
  assert.ok(!serialized.includes(personalHome));
  assert.ok(!serialized.includes(dataDir));
  assert.ok(!serialized.includes(SECRET_TEXT));
}));

test('複数のタスク専用 CODEX_HOME がある場合: 最新の記録を選び、更新時刻の新しい上限件数だけを対象にする', withTmp(async ({ personalHome, dataDir }) => {
  const stamps = ['2026-07-06T01:00:00.000Z', '2026-07-06T02:00:00.000Z', '2026-07-06T02:40:00.000Z'];
  stamps.forEach((timestamp, i) => {
    const home = taskHome(dataDir, i + 1);
    writeRollout(path.join(home, 'sessions'), `task${i}`, [
      tokenCountLine({ timestamp, sessionPercent: 10 * (i + 1), weeklyPercent: 30 + i, totalTokens: 100 * (i + 1) }),
    ]);
    // 起動フォルダの更新時刻は、起動した順に新しくする。
    const t = (NOW - (stamps.length - i) * 60000) / 1000;
    fs.utimesSync(home, t, t);
  });

  const all = await loadBoth(resolverFor(personalHome, dataDir));
  assert.equal(all.limits.session.percent, 30);
  assert.equal(all.limits.weekly.percent, 32);
  assert.equal(all.tokens.todayTokens, 600);

  // 上限 2 件なら、最も古い起動フォルダ（task0）は対象外になる。
  const limited = await listTaskCodexSessionDirs(dataDir, { maxHomes: 2 });
  assert.deepEqual(limited, [path.join(taskHome(dataDir, 3), 'sessions'), path.join(taskHome(dataDir, 2), 'sessions')]);
  const capped = await loadBoth(resolverFor(personalHome, dataDir, { maxHomes: 2 }));
  assert.equal(capped.tokens.todayTokens, 500);
}));

test('管理対象外のフォルダは探索しない: 未知の preset・起動名の形式外・シンボリックリンクを除外する', withTmp(async ({ root, personalHome, dataDir }) => {
  const outside = path.join(root, 'outside', 'sessions');
  writeRollout(outside, 'outside', [tokenCountLine({ timestamp: '2026-07-06T02:50:00.000Z', totalTokens: 9999 })]);
  const policy = path.join(dataDir, 'codex-task-policy');
  fs.mkdirSync(path.join(policy, 'unknown-preset', launchName(9)), { recursive: true });
  fs.symlinkSync(outside, path.join(policy, 'unknown-preset', launchName(9), 'sessions'));
  fs.mkdirSync(path.join(policy, PRESET, 'not-a-launch-name'), { recursive: true });
  fs.symlinkSync(outside, path.join(policy, PRESET, 'not-a-launch-name', 'sessions'));
  // 起動名の形式でも、起動フォルダ自体・sessions・member がリンクなら辿らない。
  fs.symlinkSync(path.dirname(outside), path.join(policy, PRESET, launchName(1)));
  fs.mkdirSync(path.join(policy, PRESET, launchName(2), 'member'), { recursive: true });
  fs.symlinkSync(outside, path.join(policy, PRESET, launchName(2), 'sessions'));
  fs.symlinkSync(outside, path.join(policy, PRESET, launchName(2), 'member', 'sessions'));
  fs.mkdirSync(path.join(policy, PRESET, launchName(4)), { recursive: true });
  fs.symlinkSync(path.dirname(outside), path.join(policy, PRESET, launchName(4), 'member'));

  assert.deepEqual(await listTaskCodexSessionDirs(dataDir), []);
  const { limits, tokens } = await loadBoth(resolverFor(personalHome, dataDir));
  assert.equal(limits, null);
  assert.equal(tokens, null);
}));

test('管理対象の保存先が削除済み・読めない場合: 残りの保存先だけで集計し、全体を失敗させない', withTmp(async ({ personalHome, dataDir }) => {
  writeRollout(path.join(personalHome, 'sessions'), 'personal', [
    tokenCountLine({ timestamp: '2026-07-06T01:00:00.000Z', sessionPercent: 11, weeklyPercent: 22, totalTokens: 100 }),
  ]);
  const goneHome = taskHome(dataDir, 1);
  writeRollout(path.join(goneHome, 'sessions'), 'gone', [
    tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', sessionPercent: 90, totalTokens: 500 }),
  ]);
  const lockedSessions = path.join(taskHome(dataDir, 2), 'sessions');
  writeRollout(lockedSessions, 'locked', [
    tokenCountLine({ timestamp: '2026-07-06T02:30:00.000Z', sessionPercent: 95, totalTokens: 700 }),
  ]);

  // 列挙した後に保存先が消えた場合（列挙結果のキャッシュ中に利用者が削除した場合）と、権限で読めない場合。
  const dirs = await listCodexSessionDirs({ personalCodexHome: personalHome, dataDir });
  assert.equal(dirs.length, 3);
  fs.rmSync(goneHome, { recursive: true, force: true });
  fs.chmodSync(lockedSessions, 0o000);
  try {
    const { limits, tokens } = await loadBoth(async () => dirs);
    if (process.getuid && process.getuid() === 0) return; // root は権限を無視して読めるため、以降の判定を行わない
    assert.equal(limits.session.percent, 11);
    assert.equal(tokens.todayTokens, 100);
  } finally {
    fs.chmodSync(lockedSessions, 0o700);
  }

  // データフォルダ自体が無い場合も、通常の CODEX_HOME だけで集計する。
  const missing = await listCodexSessionDirs({ personalCodexHome: personalHome, dataDir: path.join(dataDir, 'missing') });
  assert.deepEqual(missing, [path.join(personalHome, 'sessions')]);
}));

test('同じログ・同じレコードが複数経路から見える場合: 二重に数えない', withTmp(async ({ root, personalHome, dataDir }) => {
  const home = taskHome(dataDir, 1);
  const taskSessions = path.join(home, 'sessions');
  const file = writeRollout(taskSessions, 'shared', [
    tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', totalTokens: 300 }),
  ]);

  // (1) 個人の CODEX_HOME がタスク専用フォルダそのもの（同じ実体のフォルダ）を指す場合は 1 つにまとめる。
  const dirs = await listCodexSessionDirs({ personalCodexHome: home, dataDir });
  assert.deepEqual(dirs, [taskSessions]);
  let { tokens } = await loadBoth(resolverFor(home, dataDir));
  assert.equal(tokens.todayTokens, 300);

  // (2) 同じファイルのハードリンクが別の保存先にある場合は、実体（dev / ino）で 1 回だけ数える。
  const personalDay = path.join(personalHome, 'sessions', '2026', '07', '06');
  fs.mkdirSync(personalDay, { recursive: true });
  const hardlink = path.join(personalDay, 'rollout-hardlink.jsonl');
  fs.linkSync(file, hardlink);
  const keyOf = (p) => {
    const st = fs.statSync(p);
    return fileIdentityKey({ path: p, dev: st.dev, ino: st.ino });
  };
  assert.equal(keyOf(file), keyOf(hardlink), 'ハードリンクは同じファイルとして識別する');
  ({ tokens } = await loadBoth(resolverFor(personalHome, dataDir)));
  assert.equal(tokens.todayTokens, 300);

  // (3) 同じレコードを持つ複製ファイル（別の実体）も、記録の時刻と累積値が同じなら 1 回だけ数える。
  const copyDir = path.join(root, 'copy-personal');
  writeRollout(path.join(copyDir, 'sessions'), 'copy', [
    tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', totalTokens: 300 }),
  ]);
  ({ tokens } = await loadBoth(resolverFor(copyDir, dataDir)));
  assert.equal(tokens.todayTokens, 300);

  // (4) 同じ一覧に同じフォルダが重複して渡されても、読むのは 1 回だけ。
  ({ tokens } = await loadBoth(async () => [taskSessions, taskSessions]));
  assert.equal(tokens.todayTokens, 300);
  assert.deepEqual(dedupeSessionSummaries([{ ts: 1, tokens: 2 }, { ts: 1, tokens: 2 }, { ts: 1, tokens: 3 }]), [{ ts: 1, tokens: 2 }, { ts: 1, tokens: 3 }]);
}));

test('レート制限のリセット時刻を過ぎた場合: 新しい保存先の値で更新し、古い値には expired を付ける', withTmp(async ({ personalHome, dataDir }) => {
  const past = Math.floor((NOW - 60000) / 1000);
  writeRollout(path.join(personalHome, 'sessions'), 'personal', [
    tokenCountLine({ timestamp: '2026-07-06T01:00:00.000Z', sessionPercent: 99, sessionResetAt: past, totalTokens: 100 }),
  ]);
  const getSessionDirs = resolverFor(personalHome, dataDir);
  let clockMs = NOW;
  const provider = createCodexUsageProvider({ ttlMs: 60000, clock: () => clockMs, getSessionDirs });

  // 通常用の古い記録しか無い間は、リセット時刻を過ぎた session に expired が付く（表示側で「未確認」）。
  let r = await provider.get();
  assert.equal(r.session.percent, 99);
  assert.equal(r.session.expired, true);
  assert.equal(r.weekly.expired, undefined);

  // タスク専用 CODEX_HOME に新しい記録が出たら、TTL 内でも取り直して新しい値に置き換わる。
  writeRollout(path.join(taskHome(dataDir, 1), 'sessions'), 'task', [
    tokenCountLine({ timestamp: '2026-07-06T02:55:00.000Z', sessionPercent: 3, totalTokens: 50 }),
  ]);
  clockMs = NOW + 1000;
  r = await provider.get();
  assert.equal(r.session.percent, 3);
  assert.equal(r.session.expired, undefined);
}));

test('selectLatestRateLimits: 区分ごとに新しい値を選び、timestamp が無い候補は渡された新しさ（更新時刻）で比べる', () => {
  const sessionOnly = { session: { percent: 5, resetAtMs: null }, weekly: null, tokens: 10 };
  const both = { session: { percent: 50, resetAtMs: null }, weekly: { percent: 60, resetAtMs: null }, tokens: 20 };
  const r = selectLatestRateLimits([
    { snapshot: both, recordedAtMs: 1000 },
    { snapshot: sessionOnly, recordedAtMs: 2000 },
    { snapshot: { session: { percent: 1 }, weekly: { percent: 1 }, tokens: 1 }, recordedAtMs: null },
    null,
  ], NOW);
  assert.equal(r.session.percent, 5);
  assert.equal(r.weekly.percent, 60);
  assert.equal(r.tokens, 10);
  assert.equal(r.fetchedAtMs, NOW);
  assert.equal(selectLatestRateLimits([], NOW), null);

  const found = findLastTokenCountRecord([tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z' }), messageLine('2026-07-06T02:01:00.000Z')].join('\n'), NOW);
  assert.equal(found.recordedAtMs, Date.parse('2026-07-06T02:00:00.000Z'));
});
