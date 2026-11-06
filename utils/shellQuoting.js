'use strict';

// ペインへ入力するパスを、ペインのシェルに合わせて 1 つの引数へ変換する。
// 引数として正しく表せないパスは、変換せず対象外として返す。

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/;
const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ash', 'ksh', 'mksh']);
const POWERSHELL_SHELLS = new Set(['powershell', 'pwsh', 'pwsh-preview']);
const POSIX_SINGLE_QUOTE = /'/g;
const POWERSHELL_SINGLE_QUOTES = /['\u2018\u2019\u201a\u201b]/g;
const FISH_QUOTED_ESCAPES = /[\\']/g;

/**
 * シェルの実行ファイルから、引用の規則の種類を決める。OS ではなくシェル自体で判定する。
 *
 * @param {string} shellExecutable ペインで起動したシェルの実行ファイル。
 * @returns {'cmd'|'powershell'|'fish'|'posix'|'unknown'} 引用の規則の種類。
 */
function classifyShell(shellExecutable) {
  const name = String(shellExecutable).split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
  if (name === 'cmd') return 'cmd';
  if (POWERSHELL_SHELLS.has(name)) return 'powershell';
  if (name === 'fish') return 'fish';
  if (POSIX_SHELLS.has(name)) return 'posix';
  return 'unknown';
}

/**
 * パスをシェルの種類に合わせて 1 つの引数へ変換する。
 *
 * @param {string} value ファイルのパス。
 * @param {string} shellKind 引用の規則の種類。
 * @returns {string|null} 変換後の引数。正しく表せないパスは null。
 */
function quoteShellPath(value, shellKind) {
  if (typeof value !== 'string' || value.length === 0 || CONTROL_CHARACTER.test(value)) return null;
  if (shellKind === 'cmd') {
    // cmd.exe の二重引用符は % の展開を止められず、文字としての " も表せない。
    // % は行全体で対になるため、1 つのパスの中だけを見ても判定できない。
    if (value.includes('"') || value.includes('%')) return null;
    return `"${value}"`;
  }
  if (shellKind === 'powershell') return `'${value.replace(POWERSHELL_SINGLE_QUOTES, '$&$&')}'`;
  if (shellKind === 'fish') return `'${value.replace(FISH_QUOTED_ESCAPES, '\\$&')}'`;
  if (shellKind === 'posix') return `'${value.replace(POSIX_SINGLE_QUOTE, `'\\''`)}'`;
  return null;
}

/**
 * ドロップされたパスの一覧を、ペインの入力欄へ送る文字列へ変換する。
 *
 * @param {unknown} paths ドロップされたパスの一覧。
 * @param {unknown} shellExecutable ペインで起動したシェルの実行ファイル。
 * @returns {{text: string, rejectedCount: number}} 入力欄へ送る文字列と、対象外にした件数。
 */
function buildFileDropText(paths, shellExecutable) {
  const candidates = Array.isArray(paths) ? paths : [];
  if (typeof shellExecutable !== 'string' || shellExecutable.length === 0) {
    return { text: '', rejectedCount: candidates.length };
  }
  const shellKind = classifyShell(shellExecutable);
  const quoted = candidates.map((value) => quoteShellPath(value, shellKind));
  const accepted = quoted.filter((value) => value !== null);
  return { text: accepted.join(' '), rejectedCount: quoted.length - accepted.length };
}

/**
 * ペインのシェルで作業フォルダを移動するコマンドを組み立てる。
 *
 * @param {unknown} cwd 移動先のフォルダ。再起動は macOS と Linux だけが対象のため、絶対パスに限る。
 * @param {unknown} shellExecutable ペインで起動したシェルの実行ファイル。
 * @returns {string|null} 移動のコマンド。このシェルで正しく表せないときは null。
 */
function buildChangeDirectoryCommand(cwd, shellExecutable) {
  if (typeof shellExecutable !== 'string' || shellExecutable.length === 0) return null;
  if (typeof cwd !== 'string' || !cwd.startsWith('/')) return null;
  const shellKind = classifyShell(shellExecutable);
  const argument = quoteShellPath(cwd, shellKind);
  if (argument === null) return null;
  if (shellKind === 'powershell') {
    // PowerShell は macOS と Linux でも \ を区切りとして扱い、:: を Provider の指定として扱う。
    return /\\|::/.test(cwd) ? null : `Set-Location -LiteralPath ${argument}`;
  }
  if (shellKind === 'posix' || shellKind === 'fish') return `cd -- ${argument}`;
  return null;
}

module.exports = { buildChangeDirectoryCommand, buildFileDropText, classifyShell, quoteShellPath };
