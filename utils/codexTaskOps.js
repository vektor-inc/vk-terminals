// 自動処理用 Codex に「承認なし」で許す Git / GitHub 操作の固定入口（issue #428）。
//
// このファイルは 2 つの使われ方をする（どちらも同じ検証を通す）。
//   1. テストと main 側からの require（parseTaskCommand・信頼検証・リポジトリ拘束など）
//   2. 専用 CODEX_HOME へ複製され、信頼済みランチャー（vk-task-ops。Codex の rules が完全一致で許可する唯一の実行物）
//      から、環境を空にした絶対パスの Node で実行される
//
// 複製して単体で動かすため、node 標準モジュール以外を require しないこと（崩すと複製先で動かない）。
//
// 設計の要点:
//   - rules の prefix_rule は後続の引数を制限できない。そのため rules には「この入口の実行」だけを許可し、
//     引数の検証はこのファイルで行う。許可する操作・フラグ・位置引数はすべて下の許可リストにあるものだけで、
//     未知のフラグ・パス・リポジトリ指定（--repo など）・ファイル出力系（--output / --body-file など）は拒否する。
//   - git / gh へ渡す argv は検証済みの値だけで組み立て直す（呼び出し側の文字列をそのまま連結しない）。
//   - 実行環境は信頼済みランチャーが固定する。git / gh / Node は起動時に所有者・権限を検証した絶対パスだけを使い、
//     子プロセスの環境変数は許可リストで一から組み立てる（PATH・NODE_OPTIONS・LD_PRELOAD・GIT_*・GH_* は引き継がない）。
//   - Git の system / global 設定は使わず、リポジトリ内の設定に外部コマンドを起動しうる項目があれば実行しない。
//   - 操作の対象は起動時に確定したリポジトリ（実ルートと GitHub の owner/repo）に拘束する。実行のたびに一致を検証し、
//     gh には検証済みの --repo を必ず付ける。
const nodeFs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const REVISION_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/@^~{}-]*$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const JSON_FIELDS_PATTERN = /^[A-Za-z]+(,[A-Za-z]+)*$/;
const DIGITS_PATTERN = /^[0-9]{1,9}$/;

const NO_VALUE_FLAGS = Object.freeze({
  'git status': ['-s', '--short', '-b', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2'],
  'git diff': ['--stat', '--cached', '--staged', '--name-only', '--name-status', '--numstat', '--shortstat', '--check', '--no-color', '--no-renames'],
  'git log': ['--oneline', '--stat', '--name-only', '--name-status', '--no-color', '--graph', '--decorate'],
  'git show': ['--stat', '--name-only', '--name-status', '--no-color', '--oneline', '--no-patch', '-s'],
  'git add': ['-A', '--all', '-u', '--update'],
  'git commit': ['-a', '--all'],
});

// 外部コマンドを起動しうる設定を、コマンドライン指定（リポジトリ内の設定より優先）で無効にする。
// フックは無効化する（リポジトリ内のフックは承認なしの経路では実行しない）。
const GIT_SAFETY_CONFIG = Object.freeze([
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'diff.ignoreSubmodules=all',
]);
const FIXED_GIT_PREFIX = Object.freeze(['--no-pager', ...GIT_SAFETY_CONFIG.flatMap((setting) => ['-c', setting])]);

// diff / show / log はユーザー指定の外部コマンド（diff.external・textconv）を呼べるため常に無効化する。
const DIFF_SAFETY_FLAGS = Object.freeze(['--no-ext-diff', '--no-textconv']);

function fail(error) {
  return { ok: false, error: `task command rejected: ${error}` };
}

function hasUnsafeCharacter(value) {
  return typeof value !== 'string' || /[\x00]/.test(value);
}

// リポジトリ内の相対パスだけを許す（絶対パス・親へのさかのぼり・pathspec の特殊記法・オプション風の値は拒否）。
function isSafeRelativePath(value) {
  if (hasUnsafeCharacter(value) || value === '') return false;
  if (value.startsWith('-') || value.startsWith(':') || value.startsWith('/') || value.startsWith('~')) return false;
  if (/^[A-Za-z]:/.test(value) || value.includes('\\')) return false;
  const segments = value.split('/');
  if (segments.includes('..')) return false;
  return !segments.some((segment) => segment === '.git');
}

function isSafeBranchName(value) {
  if (hasUnsafeCharacter(value) || !BRANCH_PATTERN.test(value)) return false;
  if (value.includes('..') || value.includes('//') || value.endsWith('/') || value.endsWith('.') || value.endsWith('.lock')) return false;
  return !value.split('/').some((segment) => segment.startsWith('.') || segment.endsWith('.lock'));
}

function isSafeRevision(value) {
  return !hasUnsafeCharacter(value) && REVISION_PATTERN.test(value);
}

// 数字だけのオプション（-n 5 / -5 / --max-count=5 / -U3 など）を正規化して返す。該当しなければ null。
function parseNumericFlag(token, allowedPrefixes) {
  for (const prefix of allowedPrefixes) {
    if (token.startsWith(prefix) && DIGITS_PATTERN.test(token.slice(prefix.length))) return [token];
  }
  return null;
}

// 「フラグ → 位置引数（リビジョン） → -- → パス」の形を、許可リストだけで解釈する。
function parseGitReadCommand(subcommand, tokens, { numericPrefixes = [], allowRevisions = true, allowPaths = true }) {
  const flagList = NO_VALUE_FLAGS[`git ${subcommand}`];
  const flags = [];
  const revisions = [];
  const paths = [];
  let seenSeparator = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    if (seenSeparator) {
      if (!allowPaths || !isSafeRelativePath(token)) return fail(`unsafe path: ${JSON.stringify(token)}`);
      paths.push(token);
    } else if (token === '--') {
      seenSeparator = true;
    } else if (token.startsWith('-')) {
      const numeric = parseNumericFlag(token, numericPrefixes);
      if (flagList.includes(token)) flags.push(token);
      else if (numeric) flags.push(...numeric);
      else if (token === '-n' && numericPrefixes.includes('-n') && DIGITS_PATTERN.test(tokens[i + 1] || '')) {
        flags.push(token, tokens[i + 1]);
        i += 1;
      } else return fail(`flag not allowed: ${JSON.stringify(token)}`);
    } else {
      if (!allowRevisions || !isSafeRevision(token)) return fail(`unsafe revision: ${JSON.stringify(token)}`);
      revisions.push(token);
    }
  }
  return { ok: true, flags, revisions, paths, seenSeparator };
}

function buildGit(subcommand, flags, revisions, paths, { safety = false } = {}) {
  const args = [...FIXED_GIT_PREFIX, subcommand, ...(safety ? DIFF_SAFETY_FLAGS : []), ...flags, ...revisions];
  if (paths.length > 0) args.push('--', ...paths);
  return { ok: true, bin: 'git', args, needsGitHub: false };
}

function parseGitAdd(tokens) {
  const flagList = NO_VALUE_FLAGS['git add'];
  const flags = [];
  const paths = [];
  let seenSeparator = false;
  for (const token of tokens) {
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    if (!seenSeparator && token === '--') seenSeparator = true;
    else if (!seenSeparator && token.startsWith('-')) {
      if (!flagList.includes(token)) return fail(`flag not allowed: ${JSON.stringify(token)}`);
      flags.push(token);
    } else if (token === '.' || isSafeRelativePath(token)) paths.push(token);
    else return fail(`unsafe path: ${JSON.stringify(token)}`);
  }
  if (paths.length === 0 && !flags.some((flag) => ['-A', '--all', '-u', '--update'].includes(flag))) return fail('git add needs a path');
  return buildGit('add', flags, [], paths);
}

function parseGitCommit(tokens) {
  const flags = [];
  const messages = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    if (NO_VALUE_FLAGS['git commit'].includes(token)) flags.push(token);
    else if (token === '-m' || token === '--message') {
      const message = tokens[i + 1];
      if (hasUnsafeCharacter(message) || message.trim() === '') return fail('commit message required');
      messages.push(message);
      i += 1;
    } else if (token.startsWith('--message=') && token.slice('--message='.length).trim() !== '') {
      messages.push(token.slice('--message='.length));
    } else return fail(`flag not allowed: ${JSON.stringify(token)}`);
  }
  if (messages.length === 0) return fail('commit message required');
  return { ok: true, bin: 'git', args: [...FIXED_GIT_PREFIX, 'commit', ...flags, ...messages.flatMap((message) => ['-m', message])], needsGitHub: false };
}

// `--json a,b` / `--json=a,b` の読み取りと、値を取らない許可フラグだけを受ける（gh の閲覧系）。
function parseGhView(tokens, { allowedBooleanFlags, numberRequired }) {
  const args = [];
  let number;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    if (allowedBooleanFlags.includes(token)) args.push(token);
    else if (token === '--json' && JSON_FIELDS_PATTERN.test(tokens[i + 1] || '')) {
      args.push('--json', tokens[i + 1]);
      i += 1;
    } else if (token.startsWith('--json=') && JSON_FIELDS_PATTERN.test(token.slice('--json='.length))) args.push(token);
    else if (!token.startsWith('-') && number === undefined && DIGITS_PATTERN.test(token)) number = token;
    else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (numberRequired && number === undefined) return fail('number required');
  return { ok: true, number, args };
}

function parseGhComment(tokens) {
  let number;
  let body;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    if ((token === '--body' || token === '-b') && body === undefined) {
      body = tokens[i + 1];
      if (hasUnsafeCharacter(body) || body.trim() === '') return fail('comment body required');
      i += 1;
    } else if (token.startsWith('--body=') && body === undefined && token.slice('--body='.length).trim() !== '') {
      body = token.slice('--body='.length);
    } else if (!token.startsWith('-') && number === undefined && DIGITS_PATTERN.test(token)) number = token;
    else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (number === undefined || body === undefined) return fail('number and body required');
  return { ok: true, number, args: ['--body', body] };
}

// PR 作成は head を必ず明示させる（省略すると gh が現在のブランチを push しようとするため）。
function parseGhPrCreate(tokens) {
  let head;
  let base;
  let title;
  let body;
  let draft = false;
  const takeValue = (i) => {
    const value = tokens[i + 1];
    return hasUnsafeCharacter(value) || value.trim() === '' ? undefined : value;
  };
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    const [name, inlineValue] = token.startsWith('--') && token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const value = takeValue(i);
      if (value !== undefined) i += 1;
      return value;
    };
    if ((name === '--head' || name === '-H') && head === undefined) head = readValue();
    else if ((name === '--base' || name === '-B') && base === undefined) base = readValue();
    else if ((name === '--title' || name === '-t') && title === undefined) title = readValue();
    else if ((name === '--body' || name === '-b') && body === undefined) body = readValue();
    else if ((token === '--draft' || token === '-d') && !draft) draft = true;
    else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (head === undefined || !isSafeBranchName(head)) return fail('--head with a plain branch name is required');
  if (base !== undefined && !isSafeBranchName(base)) return fail('invalid --base');
  if (title === undefined || body === undefined || title.trim() === '' || body.trim() === '') return fail('--title and --body are required');
  const args = ['--head', head, '--title', title, '--body', body];
  if (base !== undefined) args.push('--base', base);
  if (draft) args.push('--draft');
  return { ok: true, args };
}

function ghCommand(parts, args) {
  return { ok: true, bin: 'gh', args: [...parts, ...args], needsGitHub: true };
}

/**
 * 入口に渡された argv（`git status` など）を検証し、実行する git / gh の argv に組み立て直す。
 * 許可リストに無いものはすべて ok: false（理由つき）。
 * @param {ReadonlyArray<string>} argv 先頭が操作名（git / gh）の引数列
 * @returns {{ok: true, bin: 'git'|'gh', args: string[], needsGitHub: boolean} | {ok: false, error: string}}
 */
function parseTaskCommand(argv) {
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== 'string')) return fail('invalid argument list');
  const [tool, ...rest] = argv;
  if (tool === 'git') {
    const [subcommand, ...tokens] = rest;
    switch (subcommand) {
      case 'status': {
        const parsed = parseGitReadCommand('status', tokens, { allowRevisions: false, allowPaths: false });
        return parsed.ok ? buildGit('status', parsed.flags, [], []) : parsed;
      }
      case 'diff': {
        const parsed = parseGitReadCommand('diff', tokens, { numericPrefixes: ['-U', '--unified='] });
        return parsed.ok ? buildGit('diff', parsed.flags, parsed.revisions, parsed.paths, { safety: true }) : parsed;
      }
      case 'log': {
        const parsed = parseGitReadCommand('log', tokens, { numericPrefixes: ['-n', '-', '--max-count='] });
        return parsed.ok ? buildGit('log', parsed.flags, parsed.revisions, parsed.paths, { safety: true }) : parsed;
      }
      case 'show': {
        const parsed = parseGitReadCommand('show', tokens, {});
        return parsed.ok ? buildGit('show', parsed.flags, parsed.revisions, parsed.paths, { safety: true }) : parsed;
      }
      case 'add': return parseGitAdd(tokens);
      case 'commit': return parseGitCommit(tokens);
      default: return fail(`git ${subcommand === undefined ? '' : JSON.stringify(subcommand)} is not allowed`);
    }
  }
  if (tool === 'gh') {
    const [group, action, ...tokens] = rest;
    if (group === 'issue' && action === 'view') {
      const parsed = parseGhView(tokens, { allowedBooleanFlags: ['--comments'], numberRequired: true });
      return parsed.ok ? ghCommand(['issue', 'view', parsed.number], parsed.args) : parsed;
    }
    if (group === 'issue' && action === 'comment') {
      const parsed = parseGhComment(tokens);
      return parsed.ok ? ghCommand(['issue', 'comment', parsed.number], parsed.args) : parsed;
    }
    if (group === 'pr' && action === 'view') {
      const parsed = parseGhView(tokens, { allowedBooleanFlags: ['--comments'], numberRequired: true });
      return parsed.ok ? ghCommand(['pr', 'view', parsed.number], parsed.args) : parsed;
    }
    if (group === 'pr' && action === 'checks') {
      const parsed = parseGhView(tokens, { allowedBooleanFlags: [], numberRequired: true });
      return parsed.ok ? ghCommand(['pr', 'checks', parsed.number], parsed.args) : parsed;
    }
    if (group === 'pr' && action === 'comment') {
      const parsed = parseGhComment(tokens);
      return parsed.ok ? ghCommand(['pr', 'comment', parsed.number], parsed.args) : parsed;
    }
    if (group === 'pr' && action === 'create') {
      const parsed = parseGhPrCreate(tokens);
      return parsed.ok ? ghCommand(['pr', 'create'], parsed.args) : parsed;
    }
    return fail(`gh ${[group, action].filter((part) => part !== undefined).map((part) => JSON.stringify(part)).join(' ')} is not allowed`);
  }
  return fail('only git and gh are allowed');
}

// ─── 信頼境界の検証（所有者・権限・リンク） ─────────────────────────────

// グループ書き込みを許す信頼済みグループ（root 系の wheel と、macOS の admin。Homebrew の bin は admin が書ける）。
const TRUSTED_GROUP_IDS = Object.freeze([0, 80]);

function currentUid(deps = {}) {
  if (deps.uid !== undefined) return deps.uid;
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function isTrustedOwner(stat, uid) {
  return stat.uid === 0 || (uid !== undefined && stat.uid === uid);
}

// 他人が書き込める（差し替えられる）権限かを判定する。
// 他者書き込みは常に不可（ただし sticky の root/自分所有フォルダは、他人の作ったエントリを置換できないので祖先に限り許す）。
// グループ書き込みは、管理者グループ（root 系の wheel と macOS の admin。Homebrew の bin は admin が書ける）だけを信頼する。
// 利用者の既定グループ（macOS の staff など）は他のアカウントと共有されうるため信頼しない。
function hasUntrustedWrite(stat, { isAncestor }) {
  if (stat.mode & 0o002) return !(isAncestor && stat.isDirectory() && (stat.mode & 0o1000) && stat.uid === 0);
  if (stat.mode & 0o020) return !TRUSTED_GROUP_IDS.includes(stat.gid);
  return false;
}

/**
 * 検証結果（resolveTrustedPath が返す chain）と、現在の同じパスが同一であることを再確認する。
 * リンクの階層は向き先の文字列と識別子、それ以外はリンクでないことと識別子（dev/ino）を照合する。
 */
function assertChainUnchanged(fsImpl, snapshot) {
  for (const entry of snapshot) {
    const stat = fsImpl.lstatSync(entry.path);
    const changed = stat.dev !== entry.dev || stat.ino !== entry.ino
      || (entry.link === undefined ? stat.isSymbolicLink() : !stat.isSymbolicLink() || fsImpl.readlinkSync(entry.path) !== entry.link);
    if (changed) throw new TrustError(`path changed after it was verified: ${entry.path}`);
  }
}

class TrustError extends Error {}

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const MAX_LINK_HOPS = 16;

/**
 * 絶対パスを根から 1 階層ずつ辿り、通る全ての階層（フォルダ・リンク・末端）を検証して実パスを返す。
 * リンクは「自分か root の所有であること」を確認して向き先を 1 段ずつ解決し、向き先の階層も同じ検証に通す。
 * リンクを置く親フォルダは他人が書き込めないこと（リンクを差し替えられないこと）を、通常のフォルダと同じ規則で確認する。
 * 検証を通らない階層が 1 つでもあれば TrustError。実行・読み込みに使うパスの途中に、未検証のリンクは残らない。
 * rejectFinalLink なら、末端そのものがリンクのときは拒否する（フォルダの実体を求める用途。祖先のリンクは検証のうえ許す）。
 * createMissing なら、存在しない階層を親の検証後に 1 段ずつ 0700 で作る（再帰作成はしない）。
 * @param {object} fsImpl fs 互換
 * @param {string} inputPath 絶対パス（リンクを含んでよい）
 * @param {{uid?: number, finalKind?: 'directory'|'file'|'any', createMissing?: boolean, rejectFinalLink?: boolean}} [options]
 * @returns {{realPath: string, chain: Array<{path: string, dev: number, ino: number, link?: string}>}}
 */
function resolveTrustedPath(fsImpl, inputPath, options = {}) {
  const { finalKind = 'directory', createMissing = false, rejectFinalLink = false } = options;
  const uid = currentUid(options);
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) throw new TrustError('path is not absolute');
  const root = path.parse(inputPath).root;
  const snapshot = [];
  const checkDirectory = (dirPath, stat, isAncestor) => {
    if (!stat.isDirectory()) throw new TrustError(`path is not a directory: ${dirPath}`);
    if (!isTrustedOwner(stat, uid)) throw new TrustError(`path is not owned by the current user or root: ${dirPath}`);
    if (hasUntrustedWrite(stat, { isAncestor })) throw new TrustError(`path is writable by other users: ${dirPath}`);
  };
  const rootStat = fsImpl.lstatSync(root);
  checkDirectory(root, rootStat, true);
  snapshot.push({ path: root, dev: rootStat.dev, ino: rootStat.ino });

  let current = root;
  let pending = inputPath.slice(root.length).split(path.sep).filter(Boolean);
  let hops = 0;
  while (pending.length > 0) {
    const name = pending.shift();
    if (name === '.') continue;
    // current は検証済みの実フォルダだけなので、'..' は検証済みの親へ戻るだけになる。
    if (name === '..') {
      current = path.dirname(current);
      continue;
    }
    const next = path.join(current, name);
    let stat;
    try {
      stat = fsImpl.lstatSync(next);
    } catch (error) {
      if (!createMissing || !error || error.code !== 'ENOENT') throw error;
      fsImpl.mkdirSync(next, { mode: 0o700 });
      stat = fsImpl.lstatSync(next);
    }
    if (stat.isSymbolicLink()) {
      if (rejectFinalLink && pending.length === 0) throw new TrustError(`path is a symbolic link: ${next}`);
      hops += 1;
      if (hops > MAX_LINK_HOPS) throw new TrustError(`too many symbolic links: ${next}`);
      if (!isTrustedOwner(stat, uid)) throw new TrustError(`symbolic link is not owned by the current user or root: ${next}`);
      const target = fsImpl.readlinkSync(next);
      if (typeof target !== 'string' || target === '' || /[\x00]/.test(target)) throw new TrustError(`symbolic link target is invalid: ${next}`);
      snapshot.push({ path: next, dev: stat.dev, ino: stat.ino, link: target });
      if (path.isAbsolute(target)) current = root;
      pending = [...target.split(path.sep).filter(Boolean), ...pending];
      continue;
    }
    const isFinal = pending.length === 0;
    if (!isFinal || finalKind === 'directory') {
      checkDirectory(next, stat, !isFinal);
    } else {
      if (finalKind === 'file' && !stat.isFile()) throw new TrustError(`path is not a regular file: ${next}`);
      if (!isTrustedOwner(stat, uid)) throw new TrustError(`path is not owned by the current user or root: ${next}`);
      if (hasUntrustedWrite(stat, { isAncestor: false })) throw new TrustError(`path is writable by other users: ${next}`);
    }
    snapshot.push({ path: next, dev: stat.dev, ino: stat.ino });
    current = next;
  }
  return { realPath: current, chain: snapshot };
}

/**
 * 固定の探索先から、所有者・権限を検証済みの実行ファイルを 1 つ決める。環境変数 PATH は使わない。
 * 候補ごとに、候補のパスを根から 1 階層ずつ（リンクは向き先まで 1 段ずつ）検証する（resolveTrustedPath）。
 * 通らない候補は飛ばす。ツールが argv[0] で挙動を変えうるため返すのは候補のパスだが、
 * そのパスの途中にある全てのリンク・フォルダが検証済みで、検証結果（chain）は後から同一性を再確認できる。
 * @returns {{path: string, chain: Array<object>}|null} 見つからなければ null
 */
function resolveTrustedExecutableDetailed(fsImpl, name, searchDirs, options = {}) {
  if (!TOOL_NAME_PATTERN.test(name)) return null;
  for (const dir of searchDirs) {
    const candidate = path.join(dir, name);
    try {
      const { realPath, chain } = resolveTrustedPath(fsImpl, candidate, { ...options, finalKind: 'file' });
      if ((fsImpl.statSync(realPath).mode & 0o111) === 0) continue;
      return { path: candidate, chain };
    } catch (_error) {
      // 候補が無い・信頼できない場合は次へ。
    }
  }
  return null;
}

/** resolveTrustedExecutableDetailed のパスだけ版。見つからなければ null。 */
function resolveTrustedExecutable(fsImpl, name, searchDirs, options = {}) {
  const resolved = resolveTrustedExecutableDetailed(fsImpl, name, searchDirs, options);
  return resolved === null ? null : resolved.path;
}

// ─── リポジトリの拘束 ───────────────────────────────────────────────────────

const GITHUB_REMOTE_PATTERN = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/;
const GITHUB_REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

// 外部コマンドの起動・設定の取り込みにつながる、リポジトリ内の設定項目（git config --list の小文字化したキー）。
const UNSAFE_GIT_CONFIG_PATTERNS = Object.freeze([
  /^include\./,
  /^includeif\./,
  /^filter\..*\.(clean|smudge|process)$/,
  /^diff\.external$/,
  /^diff\..*\.(textconv|command)$/,
  /^merge\..*\.driver$/,
  /^(difftool|mergetool)\..*\.(cmd|path)$/,
  /^gpg\..*program$/,
  /^gpg\.program$/,
  /^gpg\.ssh\.defaultkeycommand$/,
  /^core\.(sshcommand|askpass|editor|pager|gitproxy)$/,
  /^credential\..*helper$/,
  /^credential\.helper$/,
  /^sequence\.editor$/,
  /^trailer\..*\.cmd$/,
  // 部分クローン（不足オブジェクトを参照すると自動で通信する）と、外部のリモートヘルパーの起動につながる項目。
  /^extensions\.partialclone$/,
  /^remote\..*\.(promisor|partialclonefilter|vcs)$/,
]);

// GIT_NO_LAZY_FETCH（不足オブジェクトの自動取得の無効化）が使える最小の Git バージョン。
const MIN_GIT_VERSION = Object.freeze([2, 46]);

/**
 * `git version` の出力が、遅延取得を環境変数で無効化できるバージョンか判定する。読み取れない場合も非対応とみなす。
 * @param {string} output
 * @returns {boolean}
 */
function isSupportedGitVersion(output) {
  const match = /^git version (\d+)\.(\d+)/.exec(String(output).trim());
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > MIN_GIT_VERSION[0] || (major === MIN_GIT_VERSION[0] && minor >= MIN_GIT_VERSION[1]);
}

/**
 * `git config --list --null` の出力から、外部コマンドを起動しうる設定項目を探す。
 * @param {string} output
 * @returns {{unsafeKey: string|null, originUrl: string|null}} 見つかった危険なキー（無ければ null）と、origin の生の URL
 */
function inspectGitConfigListing(output) {
  let unsafeKey = null;
  let originUrl = null;
  for (const record of String(output).split('\0')) {
    if (record === '') continue;
    const newline = record.indexOf('\n');
    const rawKey = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? '' : record.slice(newline + 1);
    const parts = rawKey.split('.');
    const key = parts.length > 2
      ? `${parts[0].toLowerCase()}.${parts.slice(1, -1).join('.')}.${parts[parts.length - 1].toLowerCase()}`
      : rawKey.toLowerCase();
    if (unsafeKey === null && UNSAFE_GIT_CONFIG_PATTERNS.some((pattern) => pattern.test(key.toLowerCase()))) unsafeKey = rawKey;
    if (key === 'remote.origin.url') originUrl = value;
  }
  return { unsafeKey, originUrl };
}

/**
 * origin の URL から GitHub の owner/repo を取り出す。github.com 以外・解釈できない形は null。
 * @param {string|null} url
 * @returns {string|null}
 */
function parseGitHubRepo(url) {
  const match = GITHUB_REMOTE_PATTERN.exec(String(url || '').trim());
  if (!match) return null;
  const repo = `${match[1]}/${match[2]}`;
  return GITHUB_REPO_PATTERN.test(repo) ? repo : null;
}

/**
 * 作業フォルダの Git リポジトリを調べ、拘束に使う実ルートと GitHub の owner/repo を返す。
 * 起動時の確定と、実行のたびの一致検証の両方が同じ関数を通る。
 * Git 管理下でない・ホームや / そのもの・外部コマンドを起動しうる設定がある場合は失敗する。
 * @param {{cwd: string, run: Function, homeDir: string, fsImpl: object}} params run(args, cwd) は信頼済みの git を固定環境で実行する
 * @returns {{ok: true, root: string, repo: string|null} | {ok: false, error: string}}
 */
function inspectRepository({ cwd, run, homeDir, fsImpl }) {
  // 不足オブジェクトの自動取得を無効化できない Git では、通信・外部コマンド起動を防げないため使わない。
  const version = run(['version'], cwd);
  if (version.status !== 0 || !isSupportedGitVersion(version.stdout)) return fail(`git ${MIN_GIT_VERSION.join('.')} or later is required`);
  const toplevel = run(['rev-parse', '--show-toplevel'], cwd);
  if (toplevel.status !== 0) return fail('not inside a git repository');
  let root;
  try {
    root = fsImpl.realpathSync(String(toplevel.stdout).trim());
  } catch (_error) {
    return fail('repository path could not be resolved');
  }
  const forbidden = new Set([path.parse(root).root]);
  try { forbidden.add(fsImpl.realpathSync(homeDir)); } catch (_error) { /* ホームが無ければ比較対象にしない */ }
  if (forbidden.has(root)) return fail('repository root is not a project directory');
  const listing = run(['config', '--list', '--null'], cwd);
  if (listing.status !== 0) return fail('repository configuration could not be read');
  const { unsafeKey, originUrl } = inspectGitConfigListing(listing.stdout);
  if (unsafeKey !== null) return fail(`repository configuration can run external commands: ${JSON.stringify(unsafeKey)}`);
  return { ok: true, root, repo: parseGitHubRepo(originUrl) };
}

// ─── 子プロセスの環境 ───────────────────────────────────────────────────────

const SAFE_VALUE_PATTERN = /^[^\x00-\x1f\x7f']+$/;

function isSafeBindingPath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && SAFE_VALUE_PATTERN.test(value);
}

/**
 * ランチャーが固定した値（環境変数 VK_TASK_*）を読み、拘束の設定として検証する。1 つでも不正なら null。
 * @param {Record<string, string|undefined>} env
 * @returns {{root: string, repo: string|null, git: string, gh: string|null, home: string, gitConfig: string, ghConfig: string|null}|null}
 */
function readBinding(env) {
  const root = env.VK_TASK_ROOT;
  const git = env.VK_TASK_GIT;
  const gh = env.VK_TASK_GH || null;
  const home = env.VK_TASK_HOME;
  const gitConfig = env.VK_TASK_GITCONFIG;
  const ghConfig = env.VK_TASK_GHCONFIG || null;
  const repo = env.VK_TASK_REPO || null;
  if (![root, git, home, gitConfig].every(isSafeBindingPath)) return null;
  if (gh !== null && !isSafeBindingPath(gh)) return null;
  // gh を使えるときは、ランチャーが生成した専用の設定フォルダが必須（個人の gh 設定は読まない）。
  if (gh !== null && !isSafeBindingPath(ghConfig)) return null;
  if (ghConfig !== null && !isSafeBindingPath(ghConfig)) return null;
  if (repo !== null && !GITHUB_REPO_PATTERN.test(repo)) return null;
  return { root, repo, git, gh, home, gitConfig, ghConfig };
}

/**
 * git / gh の子プロセスに渡す環境変数を、許可リストで一から組み立てる。親の環境は一切引き継がない。
 * HOME は信頼値に固定し、Git の system / global 設定は使わない
 * （global の代わりに、ランチャーが生成した author 情報だけの設定ファイルを指す）。
 * 不足オブジェクトの自動取得は GIT_NO_LAZY_FETCH で、通信は GIT_ALLOW_PROTOCOL（空 = 全プロトコル不許可）で止める。
 * gh の設定は、個人の ~/.config/gh ではなくランチャーが生成した専用フォルダ（通信設定を持たず、認証だけを引き継いだもの）を指す。
 * @param {{git: string, gh: string|null, home: string, gitConfig: string, ghConfig: string|null}} binding
 * @returns {Record<string, string>}
 */
function buildChildEnvironment(binding) {
  const toolDirs = [path.dirname(binding.git), ...(binding.gh ? [path.dirname(binding.gh)] : []), '/usr/bin', '/bin'];
  // gh の設定フォルダが無いとき（git だけの実行）も、個人の ~/.config を指さないよう XDG は専用の場所へ向ける。
  const ghConfigDir = binding.ghConfig || path.join(path.dirname(binding.gitConfig), 'gh');
  return {
    PATH: [...new Set(toolDirs)].join(':'),
    HOME: binding.home,
    XDG_CONFIG_HOME: path.dirname(ghConfigDir),
    GH_CONFIG_DIR: ghConfigDir,
    GIT_CONFIG_GLOBAL: binding.gitConfig,
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    // 部分クローンの不足オブジェクトを参照しても、通信（自動取得）と remote 設定由来の外部コマンド起動を行わない。
    GIT_NO_LAZY_FETCH: '1',
    GIT_ALLOW_PROTOCOL: '',
    GH_PROMPT_DISABLED: '1',
    GH_NO_UPDATE_NOTIFIER: '1',
    GH_PAGER: 'cat',
    NO_COLOR: '1',
    LC_ALL: 'C',
  };
}

/**
 * 検証済みの gh の argv に、拘束したリポジトリを必ず付ける。
 * @param {string[]} args parseTaskCommand が組み立てた gh の argv
 * @param {string} repo 拘束した owner/repo
 * @returns {string[]}
 */
function withBoundRepository(args, repo) {
  return [...args, '--repo', repo];
}

/**
 * 検証を通った操作だけを実行し、終了コードを返す。
 * 実行環境・git / gh の絶対パス・対象リポジトリはランチャーが固定した VK_TASK_*（deps.env）から読み、
 * 呼び出し元の環境には依存しない。
 * @param {ReadonlyArray<string>} argv 先頭が git / gh の引数列
 * @param {object} [deps] テスト用の差し替え（cwd / env / spawnSync / fs / write / uid）
 * @returns {number} プロセスの終了コード（拒否・検証失敗は 2）
 */
function runTaskCommand(argv, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const fsImpl = deps.fs || nodeFs;
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  const write = deps.write || ((message) => process.stderr.write(message));
  const reject = (message) => {
    write(`${message}\n`);
    return 2;
  };

  const parsed = parseTaskCommand(argv);
  if (!parsed.ok) return reject(parsed.error);

  const binding = readBinding(deps.env || process.env);
  if (binding === null) return reject('task command rejected: launcher binding is missing or invalid');

  // git / gh の実行ファイルを毎回検証する（起動後に差し替えられていないこと）。
  const trustOptions = { uid: deps.uid };
  try {
    for (const tool of [binding.git, ...(parsed.bin === 'gh' ? [binding.gh] : [])]) {
      if (tool === null) return reject('task command rejected: gh is not available');
      resolveTrustedPath(fsImpl, tool, { ...trustOptions, finalKind: 'file' });
    }
    // gh の専用設定フォルダ（認証だけを引き継いだもの）も、実体・所有者・他人の書き込み不可を確認する。
    if (parsed.bin === 'gh') resolveTrustedPath(fsImpl, binding.ghConfig, { ...trustOptions, rejectFinalLink: true });
  } catch (error) {
    return reject(`task command rejected: ${error instanceof TrustError ? error.message : 'executable could not be verified'}`);
  }

  const env = buildChildEnvironment(binding);
  const runGit = (args, runCwd) => spawnSync(binding.git, [...FIXED_GIT_PREFIX, ...args], { cwd: runCwd, env, encoding: 'utf8' });

  // 作業フォルダが、起動時に拘束したリポジトリそのものであることを確認する。
  const inspected = inspectRepository({ cwd, run: runGit, homeDir: binding.home, fsImpl });
  if (!inspected.ok) return reject(inspected.error);
  if (inspected.root !== binding.root) return reject('task command rejected: working directory is not the bound repository');
  if (parsed.needsGitHub) {
    if (binding.repo === null || inspected.repo !== binding.repo) return reject('task command rejected: origin does not match the bound github.com repository');
  }

  const bin = parsed.bin === 'gh' ? binding.gh : binding.git;
  const args = parsed.bin === 'gh' ? withBoundRepository(parsed.args, binding.repo) : parsed.args;
  const result = spawnSync(bin, args, { cwd, env, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) return reject(`task command failed to start: ${result.error.code || 'error'}`);
  return typeof result.status === 'number' ? result.status : 2;
}

module.exports = {
  parseTaskCommand,
  runTaskCommand,
  readBinding,
  buildChildEnvironment,
  withBoundRepository,
  inspectRepository,
  inspectGitConfigListing,
  isSupportedGitVersion,
  parseGitHubRepo,
  assertChainUnchanged,
  resolveTrustedPath,
  resolveTrustedExecutable,
  resolveTrustedExecutableDetailed,
  TrustError,
  FIXED_GIT_PREFIX,
};

// 複製先（専用 CODEX_HOME）では、ランチャーからの Node 直接実行になる。require された場合は何もしない。
if (require.main === module) {
  process.exitCode = runTaskCommand(process.argv.slice(2));
}
