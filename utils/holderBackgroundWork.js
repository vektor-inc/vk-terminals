'use strict';

// 保持役（tmux）のペインに持たせるバックグラウンド作業の接続情報（issue #587）。
// 合言葉（epoch）はペインごとの 0700 フォルダの 0600 ファイルにだけ置き、
// tmux のユーザー定義の値にはフォルダ名と世代番号（秘密でない値）だけを置く。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isSameProcessStart } = require('./agentLifecycle');

const {
  resolveUid, isPrivateDirectory, isPrivateFile, readPrivateJson, createPrivateJson, writePrivateJson,
} = require('./privateFile');

const DIRECTORY_NAME = /^background-work-[A-Za-z0-9]+$/;
const EPOCH = /^[0-9a-f]{48}$/;
const MAX_AGENT_IDENTITIES = 64;
const SAFE_SEGMENT = /^[a-zA-Z0-9_.-]{1,160}$/;
const SAFE_ID = /^[a-zA-Z0-9_-]{1,160}$/;

function createEpoch() {
  return crypto.randomBytes(24).toString('hex');
}

function inspectPrivateEntry(directory, names, uid = resolveUid()) {
  return isPrivateDirectory(directory, uid) && names.every(name => isPrivateFile(path.join(directory, name), uid));
}

// 合言葉を失効させる。シンボリックリンクはリンク先をたどらずリンクだけを消す。
function revokeDirectory(directory) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch (_) { return; }
  if (stat.isDirectory() && !stat.isSymbolicLink()) fs.rmSync(directory, { recursive: true, force: true });
  else fs.unlinkSync(directory);
}

function processStartTime(pid) {
  return execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
    encoding: 'utf8', timeout: 2000, killSignal: 'SIGKILL', env: { ...process.env, LC_ALL: 'C' },
  }).trim();
}

function sanitizeAgentIdentities(value) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_AGENT_IDENTITIES).filter(item => Array.isArray(item) && item.length === 2 &&
    Number.isSafeInteger(item[0]) && item[0] > 0 && typeof item[1] === 'string' && Number.isFinite(Date.parse(item[1])))
    .map(([pid, lstart]) => [pid, lstart]);
}

// 保持役のペインを持ち主とする owner.json の中身を検証して取り出す。
function parseHolderOwner(owner) {
  if (!owner || typeof owner !== 'object' || owner.holder !== 'tmux') return null;
  if (!/^\d+$/.test(String(owner.termId)) || !Number.isSafeInteger(owner.generation) || owner.generation < 1) return null;
  if (typeof owner.tmuxPaneId !== 'string' || !/^%\d+$/.test(owner.tmuxPaneId)) return null;
  if (!Number.isSafeInteger(owner.panePid) || owner.panePid <= 0 || typeof owner.paneLstart !== 'string' || !Number.isFinite(Date.parse(owner.paneLstart))) return null;
  const parsed = {
    holder: 'tmux', termId: String(owner.termId), generation: owner.generation,
    tmuxPaneId: owner.tmuxPaneId, panePid: owner.panePid, paneLstart: owner.paneLstart,
    agents: sanitizeAgentIdentities(owner.agents),
  };
  if (typeof owner.session === 'string' && SAFE_ID.test(owner.session) && typeof owner.project === 'string' && SAFE_SEGMENT.test(owner.project) && owner.project !== '..') {
    parsed.session = owner.session;
    parsed.project = owner.project;
  }
  return parsed;
}

function buildHolderOwner({ termId, generation, tmuxPaneId, panePid, paneLstart }) {
  return { holder: 'tmux', termId: String(termId), generation, tmuxPaneId, panePid, paneLstart, agents: [] };
}

// 新しく作ったフォルダの owner.json を、アプリのプロセスから保持役のペインへ付け替える。
function bindToHolderPane(directory, pane, uid = resolveUid()) {
  const owner = buildHolderOwner(pane);
  if (!parseHolderOwner(owner)) throw new Error('invalid holder pane identity');
  writePrivateJson(directory, 'owner.json', owner, uid);
  return owner;
}

// 失効させた同じ場所へ、新しい合言葉の接続情報を作り直す。ペインの Claude Code は
// 起動時に渡された同じパスの connection.json を読むため、作り直した合言葉で通知が届く。
function recreateConnection(directory, owner, config, uid) {
  const epoch = createEpoch();
  revokeDirectory(directory);
  fs.mkdirSync(directory, { mode: 0o700 });
  try {
    // 作ったフォルダと各ファイルの fd を検査しながら書く（作成直後の差し替えも検出する）。
    createPrivateJson(directory, 'owner.json', owner, uid);
    createPrivateJson(directory, 'connection.json', { ...config, epoch }, uid);
    if (!inspectPrivateEntry(directory, ['owner.json', 'connection.json'], uid)) throw new Error('unsafe background work file');
  } catch (error) {
    revokeDirectory(directory);
    throw error;
  }
  return epoch;
}

/**
 * 保持役のペインに残っている接続情報から、合言葉を復元する。
 * 検査を一つでも通らなければ読まずに失効させ、同じ場所へ新しい合言葉で作り直す。
 * @param {object} options
 * @param {string} options.dataDir 接続情報フォルダの親（~/.vk-terminals）。
 * @param {string} options.name tmux の @vk_bg_dir に置いたフォルダ名。
 * @param {{paneId: string, pid: number}} options.identity tmux から得た生存ペイン。
 * @param {string} options.termId アプリでのペイン番号。
 * @param {number} options.generation 復元する世代番号。
 * @param {{url: string, token: string}} options.config 今の受け口の接続先とトークン。
 * @param {Map} options.processes ps の表（ペインのシェルの起動時刻の照合に使う）。
 * @returns {{epoch: string, restored: boolean, directory: string|null, owner: object|null}}
 */
function restoreHolderConnection({ dataDir, name, identity, termId, generation, config, processes, uid = resolveUid() }) {
  if (typeof name !== 'string' || !DIRECTORY_NAME.test(name) || !isOwnedParent(dataDir, uid)) {
    return { epoch: createEpoch(), restored: false, directory: null, owner: null };
  }
  // ps の表が取れないときはシェルの生死を判断できないため、使用中かもしれない接続情報に触れない。
  if (!processes) return { epoch: createEpoch(), restored: false, directory: null, owner: null };
  const directory = path.join(dataDir, name);
  const shell = processes.get(identity.pid);
  const nextConfig = { termId: String(termId), token: config.token, url: config.url };
  // 検査を通ったものだけを読み、ペイン・世代・シェルの起動時刻まで一致する場合だけ復元する。
  let owner = null;
  let connection = null;
  if (inspectPrivateEntry(directory, ['owner.json', 'connection.json'], uid)) {
    try {
      owner = parseHolderOwner(readPrivateJson(directory, 'owner.json', uid));
      connection = readPrivateJson(directory, 'connection.json', uid);
    } catch (_) { owner = null; connection = null; }
  }
  const valid = owner && connection && typeof connection.epoch === 'string' && EPOCH.test(connection.epoch) &&
    owner.tmuxPaneId === identity.paneId && owner.panePid === identity.pid && owner.generation === generation &&
    shell && isSameProcessStart(shell.lstart, owner.paneLstart);
  if (valid) {
    try {
      // 合言葉は保存したものを使い続け、接続先とトークンだけ今の値へ合わせる。
      writePrivateJson(directory, 'connection.json', { ...nextConfig, epoch: connection.epoch }, uid);
      if (owner.termId !== String(termId)) {
        owner = { ...owner, termId: String(termId) };
        writePrivateJson(directory, 'owner.json', owner, uid);
      }
      return { epoch: connection.epoch, restored: true, directory, owner };
    } catch (_) {}
  }
  // ペインのシェルが確認できない場合は持ち主を作れないため、失効だけ行う。
  if (!shell) {
    try { revokeDirectory(directory); } catch (_) {}
    return { epoch: createEpoch(), restored: false, directory: null, owner: null };
  }
  const freshOwner = buildHolderOwner({ termId, generation, tmuxPaneId: identity.paneId, panePid: identity.pid, paneLstart: shell.lstart });
  try {
    const epoch = recreateConnection(directory, freshOwner, nextConfig, uid);
    return { epoch, restored: false, directory, owner: freshOwner };
  } catch (_) {
    return { epoch: createEpoch(), restored: false, directory: null, owner: null };
  }
}

// ~/.vk-terminals は 0700 とは限らないため、本人所有で他人が書き込めないことだけを求める。
function isOwnedParent(directory, uid = resolveUid()) {
  try {
    const stat = fs.lstatSync(directory);
    return !stat.isSymbolicLink() && stat.isDirectory() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o022) === 0;
  } catch (_) { return false; }
}

/**
 * 生存ペインの、世代番号が今より古い接続情報だけを失効させる。
 * ペインの @vk_bg_dir が指すフォルダは、復元の成否にかかわらず残す。
 * @param {string} dataDir 接続情報フォルダの親。
 * @param {Set<string>} protectedNames 生存ペインの @vk_bg_dir と、復元に使ったフォルダ名。
 * @param {Map<number, {paneId: string, generation: number}>} livePanes シェルの PID ごとの生存ペインと今の世代番号。
 */
function revokeStaleHolderDirectories(dataDir, protectedNames, livePanes, uid = resolveUid()) {
  let names;
  try { names = fs.readdirSync(dataDir); } catch (_) { return; }
  for (const name of names) {
    if (!DIRECTORY_NAME.test(name) || protectedNames.has(name)) continue;
    const directory = path.join(dataDir, name);
    try {
      if (!inspectPrivateEntry(directory, ['owner.json'], uid)) continue;
      const owner = parseHolderOwner(readPrivateJson(directory, 'owner.json', uid));
      const pane = owner && livePanes.get(owner.panePid);
      if (pane && pane.paneId === owner.tmuxPaneId && Number.isSafeInteger(pane.generation) && owner.generation < pane.generation) revokeDirectory(directory);
    } catch (_) {}
  }
}

module.exports = {
  DIRECTORY_NAME,
  inspectPrivateEntry,
  revokeDirectory,
  processStartTime,
  parseHolderOwner,
  bindToHolderPane,
  restoreHolderConnection,
  revokeStaleHolderDirectories,
};
