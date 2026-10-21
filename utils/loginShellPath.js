'use strict';

const childProcess = require('child_process');
const fs = require('fs');
const path = require('path');

// Finder やドックから起動した Electron は PATH が最小限で、Homebrew や `npm install -g` で入れた
// claude / gh / codex / git が見つからない。利用者のログインシェルから PATH だけを取り出して補う（issue #454）。
//
// シェルは `-l -i -c`（ログイン + 対話）で起動する。理由:
//   - `-l` だけだと .zprofile / .zshenv までで、.zshrc に書かれた PATH（nvm・npm の global bin・
//     Homebrew の shellenv を .zshrc で読む構成など）を拾えない。実際にそこへ書く人が多い。
//   - 対話シェルは .zshrc の中身次第で入力待ちや重い初期化に入ることがあるが、stdin は閉じ、
//     短いタイムアウトで必ず打ち切るため、固まっても最大でタイムアウト分に収まる。
//     失敗時は呼び出し側が今までの動作（元の PATH のまま）に戻る。
const DEFAULT_TIMEOUT_MS = 3000;
// 目印で囲まれた PATH 以外の出力（.zprofile の echo・メッセージ等）を切り捨てるための目印。
const MARKER_PREFIX = '__VKT_LOGIN_PATH_';
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_PATH_LENGTH = 32 * 1024;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

function newMarker() {
  return `${MARKER_PREFIX}${process.pid}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}__`;
}

// 使うシェルを決める。$SHELL が絶対パスで実在すればそれ、無効なら /bin/zsh（macOS）か /bin/bash。
function pickShell(env, shellExists, platform = process.platform) {
  const candidate = typeof env.SHELL === 'string' ? env.SHELL : '';
  if (path.isAbsolute(candidate) && !CONTROL_CHARACTER.test(candidate) && shellExists(candidate)) return candidate;
  return platform === 'darwin' ? '/bin/zsh' : '/bin/bash';
}

// 出力から、目印で囲まれた PATH だけを切り出す。目印が揃わなければ null。
// 目印より前（.zprofile の出力）も後（終了時の出力）も捨てる。
// 対話シェルが入力行をエコーして目印の文字列が先に現れても、本物の出力は後ろなので最後の開始目印を採る。
function extractMarkedPath(stdout, marker) {
  const text = String(stdout || '');
  const start = text.lastIndexOf(`${marker}S`);
  if (start === -1) return null;
  const bodyStart = start + marker.length + 1;
  const end = text.indexOf(`${marker}E`, bodyStart);
  if (end === -1) return null;
  return text.slice(bodyStart, end);
}

// PATH として使える値か検証して、絶対パスの要素だけに整える。不正なら null。
// 空・制御文字入り・長すぎる値は丸ごと弾く。相対パス（"." など）の要素は実行ファイルの
// すり替えに使われうるため落とす。
function sanitizePath(value) {
  if (typeof value !== 'string' || value === '' || value.length > MAX_PATH_LENGTH) return null;
  if (CONTROL_CHARACTER.test(value)) return null;
  const entries = value.split(path.delimiter).filter((entry) => entry !== '' && path.isAbsolute(entry));
  if (entries.length === 0) return null;
  return [...new Set(entries)].join(path.delimiter);
}

// 子プロセスの実行（既定実装）。stdin は ignore、タイムアウトでプロセスグループごと kill する。
// 成功時は stdout 文字列、失敗・タイムアウト時は reject。
function defaultRunShell(shell, args, { timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = childProcess.spawn(shell, args, { env, stdio: ['ignore', 'pipe', 'ignore'], detached: true });
    } catch (error) {
      reject(error);
      return;
    }
    let settled = false;
    const chunks = [];
    let size = 0;
    const killTree = () => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (_e) {
        try { child.kill('SIGKILL'); } catch (_e2) { /* 既に終了している */ }
      }
    };
    const timer = setTimeout(() => {
      killTree();
      finish(reject, new Error('login shell timed out'));
    }, timeoutMs);
    function finish(fn, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    }
    child.stdout.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_OUTPUT_BYTES) {
        killTree();
        finish(reject, new Error('login shell output too large'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', (error) => finish(reject, error));
    child.on('close', (code) => {
      if (code === 0) finish(resolve, Buffer.concat(chunks).toString('utf8'));
      else finish(reject, new Error(`login shell exited with ${code}`));
    });
  });
}

function defaultShellExists(shellPath) {
  try {
    return fs.statSync(shellPath).isFile();
  } catch (_e) {
    return false;
  }
}

/**
 * ログインシェルから PATH を取得する。失敗・不正値・Windows では null（呼び出し側は何も変えない）。
 * 例外は投げない。
 *
 * @param {object} [options]
 * @param {object} [options.env] 元の環境変数（既定 process.env）
 * @param {string} [options.platform] テスト用のプラットフォーム差し替え
 * @param {number} [options.timeoutMs] 打ち切りまでの時間
 * @param {Function} [options.runShell] テスト用の子プロセス実行差し替え (shell, args, {timeoutMs, env}) => Promise<string>
 * @param {Function} [options.shellExists] テスト用のシェル実在判定差し替え
 * @param {string} [options.marker] テスト用の目印差し替え
 * @returns {Promise<string|null>}
 */
async function fetchLoginShellPath(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  // Windows は PATH の区切り・変数名の大文字小文字が異なるため対象外（utils/ptyEnv.js と揃える）。
  if (platform === 'win32') return null;
  const runShell = typeof options.runShell === 'function' ? options.runShell : defaultRunShell;
  const shellExists = typeof options.shellExists === 'function' ? options.shellExists : defaultShellExists;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
  const marker = options.marker || newMarker();
  try {
    const shell = pickShell(env, shellExists, platform);
    const script = `printf '%s%s%s' '${marker}S' "$PATH" '${marker}E'`;
    const stdout = await runShell(shell, ['-l', '-i', '-c', script], { timeoutMs, env });
    return sanitizePath(extractMarkedPath(stdout, marker));
  } catch (_e) {
    return null;
  }
}

/**
 * ログインシェルの PATH を env.PATH へ反映する（env を直接書き換える）。
 * ログインシェルの要素を先頭に、元の PATH にしかない要素を後ろに残す。
 * 取得に失敗したら何もしない。
 *
 * @returns {Promise<boolean>} 反映したか
 */
async function applyLoginShellPath(options = {}) {
  const env = options.env || process.env;
  const fetched = await fetchLoginShellPath({ ...options, env });
  if (fetched === null) return false;
  const original = typeof env.PATH === 'string' ? env.PATH.split(path.delimiter).filter(Boolean) : [];
  const merged = fetched.split(path.delimiter);
  for (const entry of original) if (!merged.includes(entry)) merged.push(entry);
  env.PATH = merged.join(path.delimiter);
  return true;
}

module.exports = { fetchLoginShellPath, applyLoginShellPath, extractMarkedPath, sanitizePath, pickShell, defaultRunShell };
