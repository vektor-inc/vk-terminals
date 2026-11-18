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
  dedupeExistingDirs,
  createCodexSessionDirsResolver,
} = require('../utils/codexSessionDirs');
const {
  loadCodexUsageSnapshot,
  createCodexUsageProvider,
  selectLatestRateLimits,
  collectLatestCategories,
} = require('../codexUsage');
const { createCodexUsageTracker, mergeSessionSummaries, fileIdentityKey } = require('../codexUsageTracker');
const { openCanonicalFile, readdirCanonical, lstatCanonicalFile } = require('../utils/codexSessionFs');

const NOW = Date.parse('2026-07-06T03:00:00.000Z');
const PRESET = 'orchestrated-task';
const SECRET_TEXT = 'conversation body must not leak';

// 起動名は codexTaskPolicy.js と同じ 24 桁の 16 進数。
function launchName(n) {
  return String(n).padStart(24, '0');
}

// kinds で session / weekly の片方だけを持つレコードも作れる。
function tokenCountLine({ timestamp, sessionPercent = 10, weeklyPercent = 20, totalTokens = 100, sessionResetAt, weeklyResetAt, kinds = ['session', 'weekly'] }) {
  const rateLimits = {};
  if (kinds.includes('session')) {
    rateLimits.primary = { used_percent: sessionPercent, window_minutes: 300, resets_at: sessionResetAt ?? Math.floor((NOW + 3600000) / 1000) };
  }
  if (kinds.includes('weekly')) {
    rateLimits.secondary = { used_percent: weeklyPercent, window_minutes: 10080, resets_at: weeklyResetAt ?? Math.floor((NOW + 86400000) / 1000) };
  }
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { total_tokens: totalTokens } },
      rate_limits: rateLimits,
    },
  });
}

// rollout の 1 行目に書かれるセッション情報（セッション ID を持つ）。
function sessionMetaLine(id, timestamp = '2026-07-06T00:00:00.000Z') {
  return JSON.stringify({ timestamp, type: 'session_meta', payload: { id, cwd: '/tmp/x', instructions: SECRET_TEXT } });
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

  // (3) 同じ一覧に同じフォルダが重複して渡されても、読むのは 1 回だけ。
  ({ tokens } = await loadBoth(async () => [taskSessions, taskSessions]));
  assert.equal(tokens.todayTokens, 300);
}));

test('同じセッションの複製は累積値を統合し、別のセッションは同じ時刻・同じ累積値でも合算する', withTmp(async ({ root, personalHome, dataDir }) => {
  // 同じセッション ID の複製で、片方だけ 300 → 400 へ進んだ場合は 400（700 にしない）。
  writeRollout(path.join(personalHome, 'sessions'), 'same-a', [
    sessionMetaLine('session-same'),
    tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', totalTokens: 300 }),
  ]);
  writeRollout(path.join(taskHome(dataDir, 1), 'sessions'), 'same-b', [
    sessionMetaLine('session-same'),
    tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', totalTokens: 300 }),
    tokenCountLine({ timestamp: '2026-07-06T02:20:00.000Z', totalTokens: 400 }),
  ]);
  let { tokens } = await loadBoth(resolverFor(personalHome, dataDir));
  assert.equal(tokens.todayTokens, 400);
  assert.ok(!JSON.stringify(tokens).includes('session-same'), 'セッション ID は返す値に含めない');

  // 別々のセッションが同じ時刻に同じ 300 を記録していても 600（300 にしない）。
  const otherPersonal = path.join(root, 'other-personal');
  const otherData = path.join(root, 'other-data');
  writeRollout(path.join(otherPersonal, 'sessions'), 'one', [
    sessionMetaLine('session-one'),
    tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', totalTokens: 300 }),
  ]);
  writeRollout(path.join(taskHome(otherData, 1), 'sessions'), 'two', [
    sessionMetaLine('session-two'),
    tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', totalTokens: 300 }),
  ]);
  ({ tokens } = await loadBoth(resolverFor(otherPersonal, otherData)));
  assert.equal(tokens.todayTokens, 600);

  // セッション ID の無い旧形式のファイルは、ファイルごとに別のセッションとして数える。
  assert.deepEqual(mergeSessionSummaries([
    { sessionId: null, fileKey: 'a', summary: { ts: 1, tokens: 300 } },
    { sessionId: null, fileKey: 'b', summary: { ts: 1, tokens: 300 } },
    { sessionId: 's', fileKey: 'c', summary: { ts: 1, tokens: 300 } },
    { sessionId: 's', fileKey: 'd', summary: { ts: 2, tokens: 400 } },
  ]), [{ ts: 1, tokens: 300 }, { ts: 1, tokens: 300 }, { ts: 2, tokens: 400 }]);
}));

test('列挙の後にフォルダ・ファイルがリンクへ差し替えられても、管理対象の外は読まない', withTmp(async ({ root, personalHome, dataDir }) => {
  const outside = path.join(root, 'outside', 'sessions');
  writeRollout(outside, 'outside', [tokenCountLine({ timestamp: '2026-07-06T02:50:00.000Z', sessionPercent: 77, totalTokens: 9999 })]);
  const home = taskHome(dataDir, 1);
  const taskSessions = path.join(home, 'sessions');
  const taskFile = writeRollout(taskSessions, 'task', [tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', sessionPercent: 5, totalTokens: 100 })]);

  // 列挙結果を取ってから（キャッシュ中の想定）、sessions フォルダ自体を外へのリンクに差し替える。
  const dirs = await listCodexSessionDirs({ personalCodexHome: personalHome, dataDir });
  assert.deepEqual(dirs, [taskSessions]);
  fs.renameSync(taskSessions, path.join(home, 'sessions-moved'));
  fs.symlinkSync(outside, taskSessions);
  let { limits, tokens } = await loadBoth(async () => dirs);
  assert.equal(limits, null);
  assert.equal(tokens, null);

  // 途中の日フォルダを外へのリンクに差し替えた場合も読まない。
  fs.unlinkSync(taskSessions);
  fs.renameSync(path.join(home, 'sessions-moved'), taskSessions);
  const dayDir = path.dirname(taskFile);
  fs.rmSync(dayDir, { recursive: true, force: true });
  fs.symlinkSync(path.join(outside, '2026', '07', '06'), dayDir);
  ({ limits, tokens } = await loadBoth(async () => dirs));
  assert.equal(limits, null);
  assert.equal(tokens, null);
  assert.deepEqual(await readdirCanonical(dayDir), []);
  const viaLinkedDir = path.join(dayDir, 'rollout-outside.jsonl');
  assert.equal(await lstatCanonicalFile(viaLinkedDir), null);
  assert.equal(await openCanonicalFile(viaLinkedDir), null, '途中にリンクがあるパスのファイルは開かない');

  // ファイル自体を外へのリンクに差し替えた場合は、リンク非追跡で開けない。
  fs.unlinkSync(dayDir);
  fs.mkdirSync(dayDir);
  fs.symlinkSync(path.join(outside, '2026', '07', '06', 'rollout-outside.jsonl'), taskFile);
  assert.equal(await openCanonicalFile(taskFile), null);
  ({ limits, tokens } = await loadBoth(async () => dirs));
  assert.equal(limits, null);
  assert.equal(tokens, null);
}));

test('列挙で確かめた後にタスク側の sessions がリンクへ差し替えられても、重複除外で実パスに置き換えず除外する', withTmp(async ({ root, personalHome, dataDir }) => {
  const outsideHome = path.join(root, 'outside-home');
  const outside = path.join(outsideHome, 'sessions');
  writeRollout(outside, 'outside', [tokenCountLine({ timestamp: '2026-07-06T02:50:00.000Z', sessionPercent: 77, totalTokens: 9999 })]);
  // 個人側はリンクでも実パスに置き換えて使う（従来どおり）。
  const personalReal = path.join(root, 'personal-real', 'sessions');
  writeRollout(personalReal, 'personal', [tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', sessionPercent: 5, totalTokens: 100 })]);
  fs.symlinkSync(personalReal, path.join(personalHome, 'sessions'));

  // 親の sessions・member/sessions・member フォルダ自体の 3 経路を、それぞれ別の起動フォルダで差し替える。
  const parentSessions = path.join(taskHome(dataDir, 1), 'sessions');
  const memberSessions = path.join(taskHome(dataDir, 2), 'member', 'sessions');
  const memberDir = path.join(taskHome(dataDir, 3), 'member');
  for (const dir of [parentSessions, memberSessions, path.join(memberDir, 'sessions')]) {
    writeRollout(dir, 'task', [tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', totalTokens: 1 })]);
  }
  const swapToLink = (target, linkTo) => {
    fs.renameSync(target, `${target}-moved`);
    fs.symlinkSync(linkTo, target);
  };

  let enumerated = null;
  const dirs = await listCodexSessionDirs({
    personalCodexHome: personalHome,
    dataDir,
    listTaskDirs: async (d, o) => {
      enumerated = await listTaskCodexSessionDirs(d, o);
      // 列挙の確認を通った後（重複除外の前）に差し替える。
      swapToLink(parentSessions, outside);
      swapToLink(memberSessions, outside);
      swapToLink(memberDir, outsideHome);
      return enumerated;
    },
  });
  assert.deepEqual([...enumerated].sort(), [parentSessions, memberSessions, path.join(memberDir, 'sessions')].sort(),
    '差し替え前の列挙では 3 経路とも実体のフォルダとして確かめられている');
  assert.deepEqual(dirs, [personalReal], 'タスク側の差し替えられた経路は、外の実パスに置き換えず除外する');

  // 重複除外を直接呼んだ場合も、タスク側（由来の指定なしを含む）は実パスと一致しないものを除外する。
  assert.deepEqual(await dedupeExistingDirs([
    { dir: parentSessions, origin: 'task' },
    memberSessions,
    { dir: path.join(memberDir, 'sessions'), origin: 'task' },
  ]), []);
  assert.deepEqual(await dedupeExistingDirs([{ dir: parentSessions, origin: 'personal' }]), [outside]);

  // 列挙結果を使い回す resolver 経由でも、外のログは集計しない。
  const { limits, tokens } = await loadBoth(async () => dirs);
  assert.equal(limits.session.percent, 5);
  assert.equal(tokens.todayTokens, 100);
}));

test('session_meta を読めなかったファイルは、書き終わった後に読み直して同じセッションの複製とまとめる', withTmp(async ({ personalHome, dataDir }) => {
  // 複製元（別の実体）: 同じセッション ID で累積 300。
  writeRollout(path.join(taskHome(dataDir, 1), 'sessions'), 'copy', [
    sessionMetaLine('session-dup'),
    tokenCountLine({ timestamp: '2026-07-06T01:00:00.000Z', totalTokens: 300 }),
  ]);
  // 新しいファイルは空のまま初回の走査に当たる。
  const dayDir = path.join(personalHome, 'sessions', '2026', '07', '06');
  fs.mkdirSync(dayDir, { recursive: true });
  const growing = path.join(dayDir, 'rollout-growing.jsonl');
  fs.writeFileSync(growing, '', 'utf8');

  const tracker = createCodexUsageTracker({ getDirs: resolverFor(personalHome, dataDir), clock: () => NOW, skewMs: 0 });
  let tokens = await tracker.refresh();
  assert.equal(tokens.todayTokens, 300);

  // 先頭行が書き込み途中（改行がまだ無い）の走査を挟む。
  const meta = sessionMetaLine('session-dup');
  fs.appendFileSync(growing, meta.slice(0, 20), 'utf8');
  tokens = await tracker.refresh();
  assert.equal(tokens.todayTokens, 300);

  // session_meta を書き終え、累積 400 まで進んだら、複製（300）とまとめて 400 にする（700 にしない）。
  fs.appendFileSync(growing, `${meta.slice(20)}\n${tokenCountLine({ timestamp: '2026-07-06T02:00:00.000Z', totalTokens: 400 })}\n`, 'utf8');
  tokens = await tracker.refresh();
  assert.equal(tokens.todayTokens, 400);
  tokens = await tracker.refresh();
  assert.equal(tokens.todayTokens, 400);
}));

test('同じ sessions の中で、更新時刻と記録時刻の順序が逆の 2 ファイルは記録時刻で選ぶ', withTmp(async ({ personalHome, dataDir }) => {
  const sessions = path.join(personalHome, 'sessions');
  // 新しい token_count を持つファイル（更新時刻は古い）。
  writeRollout(sessions, 'newer-record', [
    tokenCountLine({ timestamp: '2026-07-06T02:40:00.000Z', sessionPercent: 60, weeklyPercent: 70 }),
  ], NOW - 3600000);
  // 古い token_count のあとに会話が追記されたファイル（更新時刻は新しい）。
  writeRollout(sessions, 'older-record', [
    tokenCountLine({ timestamp: '2026-07-06T01:00:00.000Z', sessionPercent: 10, weeklyPercent: 20 }),
    messageLine('2026-07-06T02:59:00.000Z'),
  ], NOW);
  const { limits } = await loadBoth(resolverFor(personalHome, dataDir));
  assert.equal(limits.session.percent, 60);
  assert.equal(limits.weekly.percent, 70);
}));

test('末尾のレコードが片方の区分だけの場合も、もう片方を直前のレコード・別の保存先から補う', withTmp(async ({ personalHome, dataDir }) => {
  // 同じログ: 末尾は session だけ、その直前に weekly がある。
  writeRollout(path.join(personalHome, 'sessions'), 'personal', [
    tokenCountLine({ timestamp: '2026-07-06T01:00:00.000Z', sessionPercent: 10, weeklyPercent: 20 }),
    tokenCountLine({ timestamp: '2026-07-06T01:30:00.000Z', sessionPercent: 15, kinds: ['session'] }),
  ]);
  let { limits } = await loadBoth(resolverFor(personalHome, dataDir));
  assert.equal(limits.session.percent, 15);
  assert.equal(limits.weekly.percent, 20);

  // 複数の保存先: タスク側の最新は weekly だけ。session は通常用の値のまま、weekly はタスク側の新しい値。
  writeRollout(path.join(taskHome(dataDir, 1), 'sessions'), 'task', [
    tokenCountLine({ timestamp: '2026-07-06T02:30:00.000Z', weeklyPercent: 33, kinds: ['weekly'] }),
  ]);
  ({ limits } = await loadBoth(resolverFor(personalHome, dataDir)));
  assert.equal(limits.session.percent, 15);
  assert.equal(limits.weekly.percent, 33);

  const text = [
    tokenCountLine({ timestamp: '2026-07-06T01:00:00.000Z', weeklyPercent: 40, kinds: ['weekly'] }),
    tokenCountLine({ timestamp: '2026-07-06T01:10:00.000Z', sessionPercent: 50, kinds: ['session'] }),
    messageLine('2026-07-06T01:20:00.000Z'),
  ].join('\n');
  const found = collectLatestCategories(text, NOW);
  assert.equal(found.session.value.percent, 50);
  assert.equal(found.session.recordedAtMs, Date.parse('2026-07-06T01:10:00.000Z'));
  assert.equal(found.weekly.value.percent, 40);
  assert.equal(found.weekly.recordedAtMs, Date.parse('2026-07-06T01:00:00.000Z'));
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

test('selectLatestRateLimits: 区分ごとに新しい値を選び、timestamp が無い候補は後回しにする', () => {
  const cat = (percent, recordedAtMs) => ({ value: { percent, resetAtMs: null }, recordedAtMs });
  const r = selectLatestRateLimits([
    { session: cat(50, 1000), weekly: cat(60, 1000), tokens: { value: 20, recordedAtMs: 1000 } },
    { session: cat(5, 2000), weekly: null, tokens: { value: 10, recordedAtMs: 2000 } },
    { session: cat(1, null), weekly: cat(1, null), tokens: { value: 1, recordedAtMs: null } },
    null,
  ], NOW);
  assert.equal(r.session.percent, 5);
  assert.equal(r.weekly.percent, 60);
  assert.equal(r.tokens, 10);
  assert.equal(r.fetchedAtMs, NOW);
  assert.equal(selectLatestRateLimits([], NOW), null);
});
