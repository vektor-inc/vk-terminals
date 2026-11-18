'use strict';
// Codex 使用量の集計対象にする sessions フォルダを列挙する（issue #638）。
//
// 設計の要点（崩さないこと）:
//   - 対象は 2 種類だけ。利用者個人の CODEX_HOME（CODEX_HOME 環境変数、無ければ ~/.codex）の sessions と、
//     VK Terminals が作るタスク専用 CODEX_HOME（<dataDir>/codex-task-policy/<preset>/<名前>/ とその中の member/）の sessions。
//     タスク側は固定ルートの決まった深さだけを見て、preset は既知の名前、<名前> は起動時に付ける形式のものに限る。
//     任意のフォルダ・利用者入力由来のパスは探索しない。
//   - 列挙は固定ルートの走査で行う（起動時に作ったパスをメモリに記録する方式は使わない）。
//     アプリの再起動前に起動したタスクや、別のアプリプロセスが起動したタスクの Codex も集計に含めるため。
//   - タスク側はシンボリックリンクを辿らない。<preset>/<名前>/member/sessions の各段を lstat で確かめ、実体のフォルダだけを返す。
//     返すパスはすべて実パスにそろえる。ただし実パスへの置き換えは個人側だけに許し、タスク側は重複除外の段でも
//     「実パスがパス自身と一致する」ものだけを残す（列挙の後にリンクへ差し替えられても、外の実パスを探索対象にしない）。
//     読む直前の再確認は読み取り層 utils/codexSessionFs.js が行う。
//   - 専用フォルダは自動では消されず溜まり続けるため、更新時刻の新しい MAX_TASK_CODEX_HOMES 件だけを対象にする。
//   - 同じ実体のフォルダが複数の経路で見える場合（CODEX_HOME がタスク専用フォルダを指すなど）は dev / ino で 1 つにする。
//   - 削除済み・権限エラーのフォルダは黙って除外し、全体を失敗させない。
//   - 返すパスは main プロセス内の集計にだけ使い、renderer やモバイル API の返却値には載せない。

const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const path = require('path');
const {
  CODEX_TASK_POLICY_PRESETS,
  POLICY_DIR_NAME,
  MEMBER_HOME_NAME,
  LAUNCH_HOME_NAME_PATTERN,
} = require('./codexTaskPolicy');
const { isCanonicalPath } = require('./codexSessionFs');

const SESSIONS_DIR_NAME = 'sessions';
// 古いタスク専用フォルダが大量に溜まっても重くならないよう、走査する起動フォルダの数を絞る。
const MAX_TASK_CODEX_HOMES = 50;
// 1 つの preset フォルダで lstat する項目数の上限（想定外に大量のフォルダがあるときの打ち切り）。
const MAX_PRESET_ENTRIES = 5000;
// codexUsage（60 秒）と codexUsageTracker（10 秒）の両方から呼ばれるため、列挙結果を短時間だけ使い回す。
const SESSION_DIRS_TTL_MS = 15 * 1000;

/**
 * 利用者個人の CODEX_HOME を返す。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
function resolvePersonalCodexHome(env = process.env) {
  return env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

/**
 * path が実体のフォルダ（シンボリックリンクではない）なら lstat の結果を、そうでなければ null を返す。
 * @param {string} p
 * @returns {Promise<fs.Stats|null>}
 */
async function lstatRealDirectory(p) {
  try {
    const st = await fsp.lstat(p);
    return st.isDirectory() && !st.isSymbolicLink() ? st : null;
  } catch (_e) {
    return null;
  }
}

/**
 * タスク専用 CODEX_HOME の sessions フォルダを、起動フォルダの更新時刻が新しい順に返す。
 * 対象は <dataDir>/codex-task-policy/<既知の preset>/<起動名>/sessions と、同じ起動フォルダ内の member/sessions。
 * @param {string} dataDir VK Terminals のデータフォルダ（~/.vk-terminals）
 * @param {{ maxHomes?: number }} [opts]
 * @returns {Promise<string[]>}
 */
async function listTaskCodexSessionDirs(dataDir, opts = {}) {
  const maxHomes = Number.isInteger(opts.maxHomes) && opts.maxHomes >= 0 ? opts.maxHomes : MAX_TASK_CODEX_HOMES;
  if (typeof dataDir !== 'string' || !path.isAbsolute(dataDir) || maxHomes === 0) return [];

  // データフォルダ自体は専用 CODEX_HOME を作る側（codexTaskPolicy.js）と同じく実パスに解決し、その下はリンクを辿らない。
  let dataRoot;
  try {
    dataRoot = await fsp.realpath(dataDir);
  } catch (_e) {
    return [];
  }
  const policyRoot = path.join(dataRoot, POLICY_DIR_NAME);
  if (!(await lstatRealDirectory(policyRoot))) return [];

  // 起動フォルダの候補を集める（既知の preset ・起動名の形式・実体のフォルダだけ）。
  const homes = [];
  for (const preset of Object.keys(CODEX_TASK_POLICY_PRESETS)) {
    const presetDir = path.join(policyRoot, preset);
    if (!(await lstatRealDirectory(presetDir))) continue;
    let names;
    try {
      names = await fsp.readdir(presetDir);
    } catch (_e) {
      continue;
    }
    let scanned = 0;
    for (const name of names) {
      if (!LAUNCH_HOME_NAME_PATTERN.test(name)) continue;
      if (scanned >= MAX_PRESET_ENTRIES) break;
      scanned += 1;
      const home = path.join(presetDir, name);
      const st = await lstatRealDirectory(home);
      if (st) homes.push({ home, mtimeMs: st.mtimeMs });
    }
  }

  // 更新時刻の新しい起動フォルダだけを残し、親と member/ の sessions を実体のフォルダに限って返す。
  homes.sort((a, b) => (b.mtimeMs - a.mtimeMs) || (a.home < b.home ? -1 : 1));
  const out = [];
  for (const { home } of homes.slice(0, maxHomes)) {
    // 各段の lstat の後に途中の階層が差し替えられた場合に備え、返す直前に途中にリンクが無いことを確かめ直す。
    const parentSessions = path.join(home, SESSIONS_DIR_NAME);
    if (await lstatRealDirectory(parentSessions) && await isCanonicalPath(parentSessions)) out.push(parentSessions);
    const member = path.join(home, MEMBER_HOME_NAME);
    if (await lstatRealDirectory(member)) {
      const memberSessions = path.join(member, SESSIONS_DIR_NAME);
      if (await lstatRealDirectory(memberSessions) && await isCanonicalPath(memberSessions)) out.push(memberSessions);
    }
  }
  return out;
}

// 保存先の由来。個人側だけ実パスへの置き換えを許し、タスク側はパスが実パスと一致するものだけを残す。
const DIR_ORIGIN_PERSONAL = 'personal';
const DIR_ORIGIN_TASK = 'task';

/**
 * 保存先の一覧から、存在しないもの・フォルダでないもの・同じ実体（dev / ino が同じ）の重複を除く。
 * 読み取り層（utils/codexSessionFs.js）は実パスと一致するパスだけを読むため、返すパスは実パスにそろえる。
 *   - 個人側（origin: 'personal'）: 利用者が決める場所のため、リンクでも実パスに置き換えて使う。
 *   - タスク側（origin: 'task'。文字列だけ渡されたものもこちら）: 実パスがパス自身と一致しなければ除外する。
 *     列挙で確かめた後にリンクへ差し替えられた場合に、管理対象の外の実パスを正式な探索対象にしないため。
 * 順序は最初に現れた位置を保つ。
 * @param {Array<string|{ dir: string, origin?: string }>} entries
 * @returns {Promise<string[]>}
 */
async function dedupeExistingDirs(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of Array.isArray(entries) ? entries : []) {
    const dir = typeof entry === 'string' ? entry : (entry && entry.dir);
    const origin = entry && typeof entry === 'object' && entry.origin === DIR_ORIGIN_PERSONAL
      ? DIR_ORIGIN_PERSONAL
      : DIR_ORIGIN_TASK;
    if (typeof dir !== 'string' || dir === '') continue;
    let real;
    let st;
    try {
      real = await fsp.realpath(dir);
      if (origin === DIR_ORIGIN_TASK && real !== dir) continue;
      st = await fsp.lstat(real);
    } catch (_e) {
      continue;
    }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    const key = `${st.dev}:${st.ino}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(real);
  }
  return out;
}

/**
 * 個人の CODEX_HOME とタスク専用 CODEX_HOME の sessions フォルダを返す（存在するもの・重複なし）。
 * 個人側は利用者が自分で決める場所のため、シンボリックリンクでも実パスに解決して使う（従来の ~/.codex/sessions と同じ扱い）。
 * タスク側はリンクを辿らない（重複除外の処理まで由来を持ち回して、実パスへの置き換えをさせない）。
 * @param {{ personalCodexHome?: string, dataDir?: string, maxHomes?: number, listTaskDirs?: Function }} [opts]
 *   listTaskDirs はテスト用（列挙の直後に差し替える競合を再現するため）。省略時は listTaskCodexSessionDirs。
 * @returns {Promise<string[]>}
 */
async function listCodexSessionDirs(opts = {}) {
  const personalCodexHome = opts.personalCodexHome || resolvePersonalCodexHome();
  const dataDir = opts.dataDir || path.join(os.homedir(), '.vk-terminals');
  const listTaskDirs = typeof opts.listTaskDirs === 'function' ? opts.listTaskDirs : listTaskCodexSessionDirs;
  const personal = path.join(personalCodexHome, SESSIONS_DIR_NAME);
  let tasks = [];
  try {
    tasks = await listTaskDirs(dataDir, { maxHomes: opts.maxHomes });
  } catch (_e) {
    tasks = [];
  }
  return dedupeExistingDirs([
    { dir: personal, origin: DIR_ORIGIN_PERSONAL },
    ...(Array.isArray(tasks) ? tasks : []).map((dir) => ({ dir, origin: DIR_ORIGIN_TASK })),
  ]);
}

/**
 * listCodexSessionDirs の結果を ttlMs だけ使い回す列挙関数を返す。同時に呼ばれたときは 1 回の走査を共有する。
 * @param {{ getPersonalCodexHome?: () => string, dataDir?: string, maxHomes?: number, ttlMs?: number, clock?: () => number }} [options]
 * @returns {() => Promise<string[]>}
 */
function createCodexSessionDirsResolver(options = {}) {
  const getPersonalCodexHome = typeof options.getPersonalCodexHome === 'function'
    ? options.getPersonalCodexHome
    : () => resolvePersonalCodexHome();
  const ttlMs = options.ttlMs != null ? options.ttlMs : SESSION_DIRS_TTL_MS;
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  let cached = null;
  let cachedAt = -Infinity;
  let pending = null;
  return async function getSessionDirs() {
    if (cached && clock() - cachedAt < ttlMs) return cached;
    if (pending) return pending;
    pending = listCodexSessionDirs({
      personalCodexHome: getPersonalCodexHome(),
      dataDir: options.dataDir,
      maxHomes: options.maxHomes,
    })
      .catch(() => [])
      .then((dirs) => {
        cached = dirs;
        cachedAt = clock();
        return dirs;
      })
      .finally(() => { pending = null; });
    return pending;
  };
}

module.exports = {
  resolvePersonalCodexHome,
  listTaskCodexSessionDirs,
  dedupeExistingDirs,
  listCodexSessionDirs,
  createCodexSessionDirsResolver,
  MAX_TASK_CODEX_HOMES,
  MAX_PRESET_ENTRIES,
  SESSION_DIRS_TTL_MS,
};
