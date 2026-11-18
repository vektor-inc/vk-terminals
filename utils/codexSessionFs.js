'use strict';
// Codex 使用量の集計で、sessions フォルダの中を読むときの読み取り層（issue #638）。
//
// 設計の要点（崩さないこと）:
//   - 列挙（utils/codexSessionDirs.js）で確かめた後にフォルダやファイルがリンクへ差し替えられても、
//     管理対象の外を読まないようにする。sessions フォルダは実パス（リンクを含まないパス）で受け取り、
//     読む直前に「そのパスの実パスがパス自身と一致する」＝途中にリンクが無いことを毎回確かめる。
//     下の階層は Dirent の名前を join して作るので、確かめたパスは sessions フォルダの内側に限られる。
//   - ファイルは O_NOFOLLOW で開き（最後の要素がリンクなら開かない）、開いた後に fd の dev / ino と、
//     実パスの確認を通ったパスの lstat の dev / ino が一致することを確かめてから読む。
//   - 残るリスク: Node には openat が無く、途中の階層を fd 基準で辿れない。実パスの確認と open の間に
//     途中の階層を差し替えて、確認の直後に元へ戻す、という競合は理論上は残る。差し替えには ~/.vk-terminals（0700・本人所有）
//     などへの書き込み権限が要り、読めるのも rollout-*.jsonl / *.jsonl の名前のファイルの token_count の数値だけで、
//     会話本文・パスは返す値に含めないため、影響は使用量表示の数値の誤りまでに留まる。

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { clampReadStart, MAX_READ_BYTES } = require('../usageTracker');

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
// sessions/YYYY/MM/DD/rollout-*.jsonl の深さ。想定より深い階層は辿らない。
const MAX_WALK_DEPTH = 3;

/**
 * p の実パスが p 自身と一致する（途中にシンボリックリンクが無い）か。
 * @param {string} p 絶対パス
 * @returns {Promise<boolean>}
 */
async function isCanonicalPath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false;
  try {
    return (await fsp.realpath(p)) === p;
  } catch (_e) {
    return false;
  }
}

/**
 * 途中にリンクの無いフォルダだけを readdir する。確認に失敗したら空配列。
 * @param {string} dir
 * @returns {Promise<fs.Dirent[]>}
 */
async function readdirCanonical(dir) {
  if (!(await isCanonicalPath(dir))) return [];
  try {
    return await fsp.readdir(dir, { withFileTypes: true });
  } catch (_e) {
    return [];
  }
}

/**
 * 途中にリンクの無い通常ファイルの lstat を返す。条件を満たさなければ null。
 * @param {string} filePath
 * @returns {Promise<fs.Stats|null>}
 */
async function lstatCanonicalFile(filePath) {
  try {
    const st = await fsp.lstat(filePath);
    if (!st.isFile()) return null;
    return (await isCanonicalPath(filePath)) ? st : null;
  } catch (_e) {
    return null;
  }
}

/**
 * ファイルをリンク非追跡で開き、開いた実体がパスの指す実体（途中にリンク無し）と一致することを確かめて返す。
 * 一致しなければ閉じて null を返す。呼び出し側は返した fh を必ず close する。
 * @param {string} filePath
 * @returns {Promise<null | { fh: fs.promises.FileHandle, stat: fs.Stats }>}
 */
async function openCanonicalFile(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, OPEN_FLAGS);
  } catch (_e) {
    return null;
  }
  try {
    const st = await fh.stat();
    const pathStat = await lstatCanonicalFile(filePath);
    if (st.isFile() && pathStat && pathStat.dev === st.dev && pathStat.ino === st.ino) return { fh, stat: st };
  } catch (_e) {
    // 確認できないものは読まない
  }
  await fh.close().catch(() => {});
  return null;
}

/**
 * ファイルの [start, end) を読み、最後の改行までの完全な行だけを返す（usageTracker.readSliceComplete と同じ約束）。
 * 開けない・実体が確かめられない場合は例外を投げる（呼び出し側で次回再試行にする）。
 * @returns {Promise<{ text: string, consumed: number }>}
 */
async function readSliceCanonical(filePath, start, end, maxBytes = MAX_READ_BYTES) {
  const opened = await openCanonicalFile(filePath);
  if (!opened) throw new Error('codex session file is not readable');
  const { fh } = opened;
  try {
    const effStart = clampReadStart(start, end, maxBytes);
    const len = end - effStart;
    if (len <= 0) return { text: '', consumed: end };
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, effStart);
    const chunk = buf.subarray(0, bytesRead);
    const lastNl = chunk.lastIndexOf(0x0a);
    if (lastNl === -1) return { text: '', consumed: effStart };
    const consumedBytes = lastNl + 1;
    return { text: chunk.subarray(0, consumedBytes).toString('utf8'), consumed: effStart + consumedBytes };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * ファイル末尾 maxBytes を読み、先頭の途中行を捨てたテキストを返す。読めなければ ''。
 * @returns {Promise<string>}
 */
async function readTailCanonical(filePath, maxBytes) {
  const opened = await openCanonicalFile(filePath);
  if (!opened) return '';
  const { fh, stat } = opened;
  try {
    const start = Math.max(0, stat.size - maxBytes);
    const len = stat.size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, start);
    let text = buf.subarray(0, bytesRead).toString('utf8');
    if (start > 0) {
      const firstNl = text.indexOf('\n');
      text = firstNl >= 0 ? text.slice(firstNl + 1) : '';
    }
    return text;
  } catch (_e) {
    return '';
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * ファイル先頭の 1 行目を読む。
 *   - settled: true  … 1 行目が書き終わっている（maxBytes 以内に改行がある）。line はその行。
 *                      maxBytes まで読んでも改行が無い場合も、この先読める見込みが無いため line: null で settled にする。
 *   - settled: false … 空・書き込み途中（改行がまだ無い）・開けない・実体が確かめられない。後で読み直す余地がある。
 * @returns {Promise<{ line: string|null, settled: boolean }>}
 */
async function readFirstLineCanonical(filePath, maxBytes) {
  const pending = { line: null, settled: false };
  const opened = await openCanonicalFile(filePath);
  if (!opened) return pending;
  const { fh, stat } = opened;
  try {
    const len = Math.min(stat.size, maxBytes);
    if (len <= 0) return pending;
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, 0);
    const chunk = buf.subarray(0, bytesRead);
    const nl = chunk.indexOf(0x0a);
    if (nl >= 0) return { line: chunk.subarray(0, nl).toString('utf8'), settled: true };
    return bytesRead >= maxBytes ? { line: null, settled: true } : pending;
  } catch (_e) {
    return pending;
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * sessions フォルダ群から、更新時刻が nowMs - windowMs 以降の *.jsonl を列挙する（リンクは辿らない）。
 * usageTracker.listRecentFiles と同じ形に dev / ino を加えて返す。
 * @param {string[]} dirs 実パスの sessions フォルダ
 * @returns {Promise<Array<{ path: string, size: number, mtimeMs: number, dev: number, ino: number }>>}
 */
async function listRecentJsonlFiles(dirs, nowMs, windowMs) {
  const threshold = nowMs - windowMs;
  const results = [];
  async function walk(dir, depth) {
    if (depth > MAX_WALK_DEPTH) return;
    for (const ent of await readdirCanonical(dir)) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        await walk(full, depth + 1);
      } else if (ent.isFile() && ent.name.endsWith('.jsonl')) {
        const st = await lstatCanonicalFile(full);
        if (st && st.mtimeMs >= threshold) {
          results.push({ path: full, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino });
        }
      }
    }
  }
  for (const dir of Array.isArray(dirs) ? dirs : []) {
    await walk(dir, 0);
  }
  return results;
}

module.exports = {
  isCanonicalPath,
  readdirCanonical,
  lstatCanonicalFile,
  openCanonicalFile,
  readSliceCanonical,
  readTailCanonical,
  readFirstLineCanonical,
  listRecentJsonlFiles,
};
