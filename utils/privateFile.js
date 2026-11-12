'use strict';

// 合言葉（epoch）など秘密の値を含む JSON ファイルを、本人だけのフォルダで安全に読み書きする（issue #587）。
// フックからも単独で読み込むため、node の標準モジュール以外に依存しない。
//
// Node には openat 相当（開いたフォルダの fd を起点にファイルを開く手段）が無いため、
// フォルダの差し替えは次の組み合わせで検出する。
// - 開く前と後（書き込みは rename の前と後）に、フォルダの dev/ino が検査時と同じかを lstat で比べる
// - 開いたファイルは fd の fstat で所有者・通常ファイル・ちょうど 0600・nlink 1・サイズを確かめる
// - 書き込みでは、作った fd と置き換え後のパスが同じ実体（dev/ino）かを確かめる
// 親フォルダ（~/.vk-terminals）は本人所有で他人が書き込めないことを呼び出し側で確かめる。
// 本人のプロセスがフォルダを差し替える競合までは防げない（同じ権限のため、他の手段でも読める）。
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_FILE_BYTES = 65536;

function resolveUid(uid) {
  return uid === undefined && typeof process.getuid === 'function' ? process.getuid() : uid;
}

function isPrivateDirectoryStat(stat, uid) {
  return !stat.isSymbolicLink() && stat.isDirectory() && (uid === undefined || stat.uid === uid) && (stat.mode & 0o777) === 0o700;
}

function isPrivateFileStat(stat, uid) {
  return !stat.isSymbolicLink() && stat.isFile() && (uid === undefined || stat.uid === uid) &&
    (stat.mode & 0o777) === 0o600 && stat.nlink === 1 && stat.size <= MAX_FILE_BYTES;
}

const sameEntity = (a, b) => a.dev === b.dev && a.ino === b.ino;

// フォルダが本人所有・実フォルダ・ちょうど 0700 であるかを lstat で確かめる。
function isPrivateDirectory(directory, uid = resolveUid()) {
  try { return isPrivateDirectoryStat(fs.lstatSync(directory), uid); } catch (_) { return false; }
}

// ファイルが本人所有・通常ファイル・ちょうど 0600・他の名前から参照されていないかを lstat で確かめる。
function isPrivateFile(filename, uid = resolveUid()) {
  try { return isPrivateFileStat(fs.lstatSync(filename), uid); } catch (_) { return false; }
}

// 検査したフォルダの実体を返す。検査を通らなければ例外にする。
function inspectDirectory(directory, uid) {
  const stat = fs.lstatSync(directory);
  if (!isPrivateDirectoryStat(stat, uid)) throw new Error('unsafe private directory');
  return stat;
}

// フォルダが検査時と同じ実体で、まだ本人だけのものかを確かめる。
function assertSameDirectory(directory, expected, uid) {
  let stat;
  try { stat = fs.lstatSync(directory); } catch (_) { throw new Error('private directory changed'); }
  if (!sameEntity(stat, expected) || !isPrivateDirectoryStat(stat, uid)) throw new Error('private directory changed');
}

/**
 * 検査を通った JSON ファイルだけを読む。開いた fd に対しても同じ検査をやり直す。
 * @param {string} filename 読むファイルの絶対パス。
 * @param {number} [uid] 期待する所有者（省略時は実行中のユーザー）。
 * @returns {any} 読み取った JSON。
 */
function readPrivateJsonFile(filename, uid = resolveUid()) {
  const directory = path.dirname(filename);
  const directoryStat = inspectDirectory(directory, uid);
  const before = fs.lstatSync(filename);
  if (!isPrivateFileStat(before, uid)) throw new Error('unsafe private file');
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!sameEntity(stat, before) || !isPrivateFileStat(stat, uid)) throw new Error('private file changed while reading');
    assertSameDirectory(directory, directoryStat, uid);
    const buffer = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < stat.size) {
      const read = fs.readSync(fd, buffer, offset, stat.size - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return JSON.parse(buffer.subarray(0, offset).toString('utf8'));
  } finally { fs.closeSync(fd); }
}

function readPrivateJson(directory, name, uid = resolveUid()) {
  return readPrivateJsonFile(path.join(directory, name), uid);
}

// 作成時から 0600 のファイルを作り、開いた fd とフォルダを検査してから中身を書く。
function createPrivateFile(directory, name, content, uid, directoryStat) {
  const filename = path.join(directory, name);
  const fd = fs.openSync(filename, 'wx', 0o600);
  let stat;
  try {
    stat = fs.fstatSync(fd);
    if (!isPrivateFileStat(stat, uid)) throw new Error('private file changed while writing');
    assertSameDirectory(directory, directoryStat, uid);
    fs.writeSync(fd, content);
    stat = fs.fstatSync(fd);
    if ((stat.mode & 0o777) !== 0o600 || stat.nlink !== 1) throw new Error('private file changed while writing');
  } catch (error) {
    fs.closeSync(fd);
    try { fs.unlinkSync(filename); } catch (_) {}
    throw error;
  }
  fs.closeSync(fd);
  return stat;
}

/**
 * 新しいファイルとして JSON を書く（既にあれば失敗する）。
 * @param {string} directory 本人だけのフォルダ（0700）。
 * @param {string} name ファイル名。
 * @param {any} data 書く値。
 */
function createPrivateJson(directory, name, data, uid = resolveUid()) {
  const directoryStat = inspectDirectory(directory, uid);
  createPrivateFile(directory, name, JSON.stringify(data), uid, directoryStat);
}

/**
 * 書く前にフォルダと既存のファイルを検査し、0600 の一時ファイルを置き換える。
 * rename の前後でフォルダと置き換えたファイルの実体を確かめ、差し替えを検出したら例外にする。
 */
function writePrivateJson(directory, name, data, uid = resolveUid()) {
  let directoryStat;
  try { directoryStat = inspectDirectory(directory, uid); } catch (_) { throw new Error('unsafe background work directory'); }
  const target = path.join(directory, name);
  let exists = true;
  try { fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; exists = false; }
  if (exists && !isPrivateFile(target, uid)) throw new Error('unsafe background work file');
  const temporaryName = `.${name}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  const temporary = path.join(directory, temporaryName);
  try {
    const written = createPrivateFile(directory, temporaryName, JSON.stringify(data), uid, directoryStat);
    assertSameDirectory(directory, directoryStat, uid);
    if (!sameEntity(fs.lstatSync(temporary), written)) throw new Error('private file changed while writing');
    fs.renameSync(temporary, target);
    assertSameDirectory(directory, directoryStat, uid);
    const placed = fs.lstatSync(target);
    if (!sameEntity(placed, written) || !isPrivateFileStat(placed, uid)) throw new Error('private file changed while writing');
  } finally {
    try { fs.unlinkSync(temporary); } catch (_) {}
  }
}

module.exports = {
  MAX_FILE_BYTES,
  resolveUid,
  isPrivateDirectory,
  isPrivateFile,
  readPrivateJsonFile,
  readPrivateJson,
  createPrivateJson,
  writePrivateJson,
};
