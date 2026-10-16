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
//   - 通信する Git 操作（git push / prepare worktree の fetch）は origin の設定値を使わない。拘束した owner/repo から
//     入口が組み立てた固定 URL と固定 refspec だけに送り、資格情報は検証済み gh の `auth git-credential` だけを使う（issue #440）。
const nodeFs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const REVISION_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/@^~{}-]*$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const JSON_FIELDS_PATTERN = /^[A-Za-z]+(,[A-Za-z]+)*$/;
const DIGITS_PATTERN = /^[0-9]{1,9}$/;
// issue 作成の担当者は GitHub のアカウント名だけ（@me は通さない。utils/codexTaskPolicy.js の GH_USER_PATTERN と同じ形）。
const ASSIGNEE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const MAX_LABEL_LENGTH = 50;

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
// commit の後に走る自動保守（maintenance run --auto → gc --auto）は gc.recentObjectsHook などで外部コマンドを起動できるため、
// 自動保守そのものを止める（2 つの指定は経路が別。片方だけにしない）。
const GIT_SAFETY_CONFIG = Object.freeze([
  'core.fsmonitor=false',
  'core.hooksPath=/dev/null',
  'maintenance.auto=false',
  'gc.auto=0',
  'commit.gpgsign=false',
  'tag.gpgsign=false',
  'diff.ignoreSubmodules=all',
]);
const FIXED_GIT_PREFIX = Object.freeze(['--no-pager', ...GIT_SAFETY_CONFIG.flatMap((setting) => ['-c', setting])]);

// diff / show / log はユーザー指定の外部コマンド（diff.external・textconv）を呼べるため常に無効化する。
const DIFF_SAFETY_FLAGS = Object.freeze(['--no-ext-diff', '--no-textconv']);

// push 先・fetch 元の基点。ランチャーが固定する（本番は常に GitHub。テストだけが一時フォルダの bare リポジトリを指す）。
const DEFAULT_REMOTE_BASE = 'https://github.com';
// main / master への push・worktree 準備は作業ブランチとして使えない名前。
const PROTECTED_BRANCH_NAMES = Object.freeze(['main', 'master', 'HEAD']);
const WORKTREE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/;

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
  return { ok: true, bin: 'git', args: [...FIXED_GIT_PREFIX, 'commit', ...flags, ...messages.flatMap((message) => ['-m', message])], needsGitHub: false, guardsDefaultBranch: true };
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

// ラベル名は日本語・空白・`:` を含みうるので文字種は絞らず、危険なものだけを拒否する。
// 制御文字・改行・カンマとダブルクォート（gh の --label は CSV として解析されるため、判定と実際の解釈を一致させる）・先頭 `-`・前後の空白・空文字・過度な長さ（GitHub の上限 50 文字）。
function isSafeLabelName(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return false;
  if (/[\x00-\x1f\x7f]/.test(value) || value.includes(',') || value.includes('"') || value.startsWith('-')) return false;
  return [...value].length <= MAX_LABEL_LENGTH;
}

// issue 作成は --title / --body を必須にし、--assignee / --label（複数可）だけを任意で受ける。
// --repo・--body-file・--web・--editor・--template・--project・--milestone などは許可リストに無いので拒否される。
function parseGhIssueCreate(tokens) {
  let title;
  let body;
  const assignees = [];
  const labels = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    const [name, inlineValue] = token.startsWith('--') && token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    const readValue = () => {
      if (inlineValue !== undefined) return inlineValue;
      const value = tokens[i + 1];
      if (typeof value !== 'string') return undefined;
      i += 1;
      return value;
    };
    if ((name === '--title' || name === '-t') && title === undefined) title = readValue();
    else if ((name === '--body' || name === '-b') && body === undefined) body = readValue();
    else if (name === '--assignee' || name === '-a') {
      const value = readValue();
      if (typeof value !== 'string' || !ASSIGNEE_PATTERN.test(value)) return fail('invalid --assignee');
      assignees.push(value);
    } else if (name === '--label' || name === '-l') {
      const value = readValue();
      if (!isSafeLabelName(value)) return fail('invalid --label');
      labels.push(value);
    } else return fail(`argument not allowed: ${JSON.stringify(token)}`);
    if ((name === '--title' || name === '-t') && hasUnsafeCharacter(title)) return fail('invalid argument');
    if ((name === '--body' || name === '-b') && hasUnsafeCharacter(body)) return fail('invalid argument');
  }
  if (title === undefined || body === undefined || title.trim() === '' || body.trim() === '') return fail('--title and --body are required');
  const args = ['--title', title, '--body', body];
  for (const assignee of assignees) args.push('--assignee', assignee);
  for (const label of labels) args.push('--label', label);
  return { ok: true, args };
}

// push は `git push <ブランチ名>` だけ。フラグ・refspec・複数指定は受けない（送る内容は入口が refs/heads/<b>:refs/heads/<b> に固定する）。
function parseGitPush(tokens) {
  if (tokens.length !== 1) return fail('git push takes exactly one branch name');
  const [branch] = tokens;
  if (hasUnsafeCharacter(branch) || branch === '') return fail('invalid argument');
  if (branch.startsWith('-')) return fail(`flag not allowed: ${JSON.stringify(branch)}`);
  if (/[+:*?\[\\^~\s]/.test(branch)) return fail(`refspec not allowed: ${JSON.stringify(branch)}`);
  if (!isSafeBranchName(branch)) return fail(`unsafe branch name: ${JSON.stringify(branch)}`);
  if (PROTECTED_BRANCH_NAMES.includes(branch) || branch.startsWith('refs/')) return fail(`cannot push ${JSON.stringify(branch)}`);
  return { ok: true, bin: 'git', operation: 'push', branch, needsGitHub: true, needsGh: true };
}

// 作業フォルダ準備は `prepare worktree <base> <issue番号> <ブランチ> <worktree名>` だけ（owner/repo は拘束済みなので引数に取らない）。
function parsePrepareWorktree(tokens) {
  if (tokens.length !== 4) return fail('usage: prepare worktree <base> <issue number> <branch> <worktree name>');
  const [base, issue, branch, name] = tokens;
  if (tokens.some(hasUnsafeCharacter)) return fail('invalid argument');
  if (!isSafeBranchName(base) || base.startsWith('refs/')) return fail(`unsafe base: ${JSON.stringify(base)}`);
  if (!DIGITS_PATTERN.test(issue) || Number(issue) === 0) return fail('invalid issue number');
  if (!isSafeBranchName(branch) || branch.startsWith('refs/')) return fail(`unsafe branch name: ${JSON.stringify(branch)}`);
  if (branch === base || PROTECTED_BRANCH_NAMES.includes(branch)) return fail('working branch cannot be the base or a protected name');
  if (!branch.includes(`/${issue}-`)) return fail(`branch must look like <kind>/${issue}-...`);
  if (!WORKTREE_NAME_PATTERN.test(name)) return fail('worktree name must be letters, digits and hyphens only');
  return { ok: true, bin: 'git', operation: 'prepare-worktree', base, issue, branch, name, needsGitHub: true, needsGh: true };
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
      case 'push': return parseGitPush(tokens);
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
    if (group === 'issue' && action === 'create') {
      const parsed = parseGhIssueCreate(tokens);
      return parsed.ok ? ghCommand(['issue', 'create'], parsed.args) : parsed;
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
  if (tool === 'prepare') {
    const [target, ...tokens] = rest;
    if (target === 'worktree') return parsePrepareWorktree(tokens);
    return fail(`prepare ${target === undefined ? '' : JSON.stringify(target)} is not allowed`);
  }
  return fail('only git, gh and prepare are allowed');
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
  // 自動保守（gc・repack）や代替オブジェクト参照の途中で外部コマンドを起動する項目。
  /^gc\.recentobjectshook$/,
  /^core\.alternaterefscommand$/,
  /^uploadpack\.packobjectshook$/,
  // 部分クローン（不足オブジェクトを参照すると自動で通信する）と、外部のリモートヘルパーの起動につながる項目。
  /^extensions\.partialclone$/,
  /^remote\..*\.(promisor|partialclonefilter|vcs)$/,
]);

// 通信する操作（push・prepare worktree の fetch）だけが追加で拒否する項目。接続先の書き換え（url.*.insteadOf）や、
// 通信の経路・認証ヘッダー・証明書の検証を変える http.*（プロキシ・extraHeader・sslVerify など）は、資格情報の送り先をすり替えうる。
const NETWORK_UNSAFE_GIT_CONFIG_PATTERNS = Object.freeze([
  /^url\..*\.(insteadof|pushinsteadof)$/,
  /^http\./,
  /^remote\..*\.(proxy|receivepack|uploadpack|pushurl)$/,
  /^core\.(gitproxy|sshcommand)$/,
  /^push\.(gpgsign|recursesubmodules)$/,
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

// `git config --list --null` の 1 件ずつを、キーの正規化（セクション名と変数名だけ小文字化。サブセクションは大文字小文字を保つ）つきで返す。
function listConfigRecords(output) {
  const records = [];
  for (const record of String(output).split('\0')) {
    if (record === '') continue;
    const newline = record.indexOf('\n');
    const rawKey = newline === -1 ? record : record.slice(0, newline);
    const value = newline === -1 ? '' : record.slice(newline + 1);
    const parts = rawKey.split('.');
    const key = parts.length > 2
      ? `${parts[0].toLowerCase()}.${parts.slice(1, -1).join('.')}.${parts[parts.length - 1].toLowerCase()}`
      : rawKey.toLowerCase();
    records.push({ rawKey, key, value });
  }
  return records;
}

/**
 * 通信する操作の前に、接続先や経路を書き換えうる設定項目を探す。見つかった最初のキー（無ければ null）。
 * @param {string} output `git config --list --null` の出力
 * @returns {string|null}
 */
function findNetworkUnsafeKey(output) {
  for (const { rawKey, key } of listConfigRecords(output)) {
    if (NETWORK_UNSAFE_GIT_CONFIG_PATTERNS.some((pattern) => pattern.test(key.toLowerCase()))) return rawKey;
  }
  return null;
}

/**
 * `git config --list --null` の出力から、外部コマンドを起動しうる設定項目を探す。
 * @param {string} output
 * @returns {{unsafeKey: string|null, originUrl: string|null}} 見つかった危険なキー（無ければ null）と、origin の生の URL
 */
function inspectGitConfigListing(output) {
  let unsafeKey = null;
  let originUrl = null;
  for (const { rawKey, key, value } of listConfigRecords(output)) {
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
  return { ok: true, root, repo: parseGitHubRepo(originUrl), networkUnsafeKey: findNetworkUnsafeKey(listing.stdout) };
}

// ─── worktree の受け入れと既定ブランチの保護 ──────────────────────────────

/**
 * 指定フォルダの Git 管理領域（全 worktree が共有する .git）の実パスを返す。解決できなければ null。
 * 相対パスで返る場合に備え、そのフォルダ基準で解決してから realpath にする。
 * @param {{dir: string, run: Function, fsImpl: object}} params
 * @returns {string|null}
 */
function resolveGitCommonDir({ dir, run, fsImpl }) {
  const result = run(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir);
  if (result.status !== 0) return null;
  const output = String(result.stdout).trim();
  if (output === '') return null;
  try {
    return fsImpl.realpathSync(path.resolve(dir, output));
  } catch (_error) {
    return null;
  }
}

/**
 * 作業フォルダが、拘束したリポジトリに登録された worktree かを確認する。次をすべて満たすときだけ true。
 *   1. Git 管理領域（common-dir）の実パスが拘束先と同一（別リポジトリ・入れ子・同じ origin の別クローンを除く）
 *   2. 作業フォルダの実 gitdir が、拘束先の common-dir 直下の worktrees/ の 1 つ下である（.git ファイルが任意の場所を指す偽装を除く）
 *   3. その gitdir の `gitdir` ファイル（逆参照）が、検査対象ルートの .git ファイルを指している
 *      （登録済み worktree の gitdir を指す .git ファイルを別フォルダへ複製した場合を除く）。
 *      逆参照ファイルは通常ファイル・リンクでない・自分（または root）の所有のときだけ読む。
 * 拘束先側の値は起動時に固定せず、実行のたびに拘束先のフォルダから求め直す。
 * @param {{cwd: string, run: Function, bindingRoot: string, inspectedRoot: string, fsImpl: object, uid?: number}} params
 * @returns {boolean}
 */
function isBoundWorktree({ cwd, run, bindingRoot, inspectedRoot, fsImpl, uid }) {
  const own = resolveGitCommonDir({ dir: cwd, run, fsImpl });
  if (own === null) return false;
  const bound = resolveGitCommonDir({ dir: bindingRoot, run, fsImpl });
  if (bound === null || own !== bound) return false;

  const gitDirResult = run(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
  if (gitDirResult.status !== 0) return false;
  let gitDir;
  try {
    gitDir = fsImpl.realpathSync(path.resolve(cwd, String(gitDirResult.stdout).trim()));
  } catch (_error) {
    return false;
  }
  if (path.dirname(gitDir) !== path.join(bound, 'worktrees')) return false;

  try {
    // 検査対象ルートの .git は、リンクでない通常ファイル（worktree の目印）でなければならない。
    const dotGit = path.join(inspectedRoot, '.git');
    const dotGitStat = fsImpl.lstatSync(dotGit);
    if (dotGitStat.isSymbolicLink() || !dotGitStat.isFile()) return false;
    const backRef = path.join(gitDir, 'gitdir');
    const stat = fsImpl.lstatSync(backRef);
    if (stat.isSymbolicLink() || !stat.isFile()) return false;
    if (!(uid === undefined || stat.uid === uid || stat.uid === 0)) return false;
    const target = String(fsImpl.readFileSync(backRef, 'utf8')).trim();
    if (target === '' || !path.isAbsolute(target)) return false;
    return fsImpl.realpathSync(target) === dotGit;
  } catch (_error) {
    return false;
  }
}

/**
 * 既定ブランチの完全名の集合（main / master と、refs/remotes/origin/HEAD が指す先）。
 * @param {{cwd: string, run: Function}} params
 * @returns {Set<string>}
 */
function defaultBranchRefs({ cwd, run }) {
  const defaults = new Set(['refs/heads/main', 'refs/heads/master']);
  const remoteHead = run(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], cwd);
  if (remoteHead.status === 0) {
    const remoteRef = String(remoteHead.stdout).trim();
    const prefix = 'refs/remotes/origin/';
    if (remoteRef.startsWith(prefix) && remoteRef.length > prefix.length) defaults.add(`refs/heads/${remoteRef.slice(prefix.length)}`);
  }
  return defaults;
}

/**
 * git commit の前に、現在のブランチが既定ブランチ（main / master / origin/HEAD の指す先）か、
 * ブランチに属さない状態（detached HEAD）でないことを確認する。問題なければ null、拒否するならメッセージ。
 * 同名のタグがあると短縮名が `heads/main` のように変わり比較をすり抜けるため、symbolic-ref の完全名で比較する。
 * @param {{cwd: string, run: Function}} params
 * @returns {string|null}
 */
function checkCommitBranch({ cwd, run }) {
  const head = run(['symbolic-ref', '-q', 'HEAD'], cwd);
  const ref = head.status === 0 ? String(head.stdout).trim() : '';
  if (ref === '') return 'task command rejected: cannot commit on a detached HEAD; switch to a working branch first';
  if (!ref.startsWith('refs/heads/')) return 'task command rejected: HEAD does not point to a local branch; switch to a working branch first';
  const defaults = defaultBranchRefs({ cwd, run });
  if (defaults.has(ref)) return `task command rejected: cannot commit on the default branch ${JSON.stringify(ref.slice('refs/heads/'.length))}; switch to a working branch first`;
  return null;
}

// ─── 子プロセスの環境 ───────────────────────────────────────────────────────

const SAFE_VALUE_PATTERN = /^[^\x00-\x1f\x7f']+$/;

function isSafeBindingPath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && SAFE_VALUE_PATTERN.test(value);
}

/**
 * ランチャーが固定した値（環境変数 VK_TASK_*）を読み、拘束の設定として検証する。1 つでも不正なら null。
 * @param {Record<string, string|undefined>} env
 * @returns {{root: string, repo: string|null, git: string, gh: string|null, home: string, gitConfig: string, ghConfig: string|null, remoteBase: string}|null}
 */
function readBinding(env) {
  const root = env.VK_TASK_ROOT;
  const git = env.VK_TASK_GIT;
  const gh = env.VK_TASK_GH || null;
  const home = env.VK_TASK_HOME;
  const gitConfig = env.VK_TASK_GITCONFIG;
  const ghConfig = env.VK_TASK_GHCONFIG || null;
  const repo = env.VK_TASK_REPO || null;
  const remoteBase = env.VK_TASK_REMOTE_BASE || DEFAULT_REMOTE_BASE;
  if (![root, git, home, gitConfig].every(isSafeBindingPath)) return null;
  if (gh !== null && !isSafeBindingPath(gh)) return null;
  // gh を使えるときは、ランチャーが生成した専用の設定フォルダが必須（個人の gh 設定は読まない）。
  if (gh !== null && !isSafeBindingPath(ghConfig)) return null;
  if (ghConfig !== null && !isSafeBindingPath(ghConfig)) return null;
  if (repo !== null && !GITHUB_REPO_PATTERN.test(repo)) return null;
  // push 先・fetch 元の基点は GitHub の固定値。例外はテスト用に一時フォルダの絶対パスを渡すときだけで、
  // 値はランチャー（Codex から書き換えられない）が固定する。
  if (remoteBase !== DEFAULT_REMOTE_BASE && (!isSafeBindingPath(remoteBase) || remoteBase.split('/').includes('..'))) return null;
  return { root, repo, git, gh, home, gitConfig, ghConfig, remoteBase };
}

/**
 * git / gh の子プロセスに渡す環境変数を、許可リストで一から組み立てる。親の環境は一切引き継がない。
 * HOME は信頼値に固定し、Git の system / global 設定は使わない
 * （global の代わりに、ランチャーが生成した author 情報だけの設定ファイルを指す）。
 * 不足オブジェクトの自動取得は GIT_NO_LAZY_FETCH で、通信は GIT_ALLOW_PROTOCOL（空 = 全プロトコル不許可）で止める。
 * gh の設定は、個人の ~/.config/gh ではなくランチャーが生成した専用フォルダ（通信設定を持たず、認証だけを引き継いだもの）を指す。
 * 通信する操作（push・fetch）だけ、options.allowProtocol で許可するプロトコルを 1 つに限る（既定は空 = 全プロトコル不許可）。
 * @param {{git: string, gh: string|null, home: string, gitConfig: string, ghConfig: string|null}} binding
 * @param {{allowProtocol?: string}} [options]
 * @returns {Record<string, string>}
 */
function buildChildEnvironment(binding, options = {}) {
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
    GIT_ALLOW_PROTOCOL: options.allowProtocol || '',
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

// ─── 通信する操作（git push / prepare worktree） ─────────────────────────────

/** 拘束した owner/repo から、push 先・fetch 元の URL を組み立てる（origin の設定値は使わない）。 */
function boundRemoteUrl(binding) {
  return `${binding.remoteBase}/${binding.repo}.git`;
}

/** 通信する git に付ける指定。既存の credential helper を空にしたうえで、検証済みの gh の `auth git-credential` だけを使う。 */
function networkGitConfig(binding) {
  return [
    '-c', 'credential.helper=',
    '-c', 'credential.https://github.com.helper=',
    '-c', `credential.https://github.com.helper=!'${binding.gh}' auth git-credential`,
  ];
}

function networkEnvironment(binding) {
  return buildChildEnvironment(binding, { allowProtocol: binding.remoteBase.startsWith('https://') ? 'https' : 'file' });
}

// ─── 書き込み先を OS が制限して実行する（書き込み先の制限） ─────────────

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/**
 * コマンドを、書き込み先を allowWrite 配下に限る OS のファイルシステム制限（macOS の sandbox-exec）つきで実行する形に包む。
 * 制限は書き込みの時点で、リンクを解決した後の実パスに対して判定される。
 * 許可した場所の外には書けない。denyWrite は allowWrite の内側で、書き込みを禁じる場所（フックや設定ファイルなど）。
 * パスは -D の値として渡すので、プロファイルの文字列には入らない。
 * @param {{bin: string, args: string[], allowWrite: string[], denyWrite?: string[]}} params 許可・禁止のパスは実パス（絶対パス）
 * @returns {{bin: string, args: string[]}}
 */
function restrictWrites({ bin, args, allowWrite, denyWrite = [] }) {
  const params = [];
  const rules = (list, prefix) => list.map((target, index) => {
    params.push('-D', `${prefix}${index}=${target}`);
    return `(subpath (param "${prefix}${index}"))`;
  });
  const allowed = rules(allowWrite, 'ALLOW');
  const denied = rules(denyWrite, 'DENY');
  const profile = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${allowed.join(' ')} (literal "/dev/null"))`,
    ...(denied.length > 0 ? [`(deny file-write* ${denied.join(' ')})`] : []),
  ].join('\n');
  return { bin: SANDBOX_EXEC_PATH, args: [...params, '-p', profile, bin, ...args] };
}

function lstatOrNull(fsImpl, target) {
  try {
    return fsImpl.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/**
 * `git push <ブランチ>`。送る内容は refs/heads/<b>:refs/heads/<b> に固定し、強制上書き・削除・タグ・任意の refspec の経路を作らない。
 * 新規作成と早送りだけが通る（非早送りは + の無い refspec なので push 側が拒否する）。
 */
function executePush({ parsed, binding, cwd, runGit, spawnSync, networkEnv, reject, inspected }) {
  if (inspected.networkUnsafeKey) return reject(`task command rejected: repository configuration can redirect network access: ${JSON.stringify(inspected.networkUnsafeKey)}`);
  const head = runGit(['symbolic-ref', '-q', 'HEAD'], cwd);
  if (head.status !== 0 || String(head.stdout).trim() === '') return reject('task command rejected: cannot push on a detached HEAD; switch to a working branch first');
  const ref = `refs/heads/${parsed.branch}`;
  if (runGit(['show-ref', '--verify', '--quiet', ref], cwd).status !== 0) return reject(`task command rejected: local branch does not exist: ${JSON.stringify(parsed.branch)}`);
  if (defaultBranchRefs({ cwd, run: runGit }).has(ref)) return reject(`task command rejected: cannot push the default branch ${JSON.stringify(parsed.branch)}`);

  const url = boundRemoteUrl(binding);
  const networkArgs = [...FIXED_GIT_PREFIX, ...networkGitConfig(binding)];
  // origin/HEAD が無い clone でも既定ブランチを守る。リモートの既定ブランチを確定できないときは push しない。
  const remoteHead = spawnSync(binding.git, [...networkArgs, 'ls-remote', '--symref', url, 'HEAD'], { cwd, env: networkEnv, encoding: 'utf8' });
  const match = remoteHead.status === 0 ? /^ref: (refs\/heads\/\S+)\tHEAD$/m.exec(String(remoteHead.stdout)) : null;
  if (match === null) return reject('task command rejected: remote default branch could not be verified');
  if (match[1] === ref) return reject(`task command rejected: cannot push the remote default branch ${JSON.stringify(parsed.branch)}`);

  const args = [
    ...networkArgs, 'push', '--no-verify', '--no-follow-tags', '--no-recurse-submodules', '--no-signed',
    url, `${ref}:${ref}`,
  ];
  const result = spawnSync(binding.git, args, { cwd, env: networkEnv, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) return reject(`task command failed to start: ${result.error.code || 'error'}`);
  return typeof result.status === 'number' ? result.status : 2;
}

/**
 * `prepare worktree <base> <issue番号> <ブランチ> <worktree名>`。vk-agents の repo-prepare.sh issue-worktree と同じ処理を、
 * この入口の中で行う（対象が vk-agents 自身でも、Codex が書き換えられるスクリプトを囲いの外で動かさないため）。
 * 作るのは <拘束ルート>/.claude/worktrees/<名前> の worktree だけで、通常のクローンの切り替えや未コミット変更には触れない。
 */
function executePrepareWorktree({ parsed, binding, cwd, fsImpl, runGit, spawnSync, networkEnv, plainEnv, reject, inspected, write, writeOut, deps }) {
  if (inspected.networkUnsafeKey) return reject(`task command rejected: repository configuration can redirect network access: ${JSON.stringify(inspected.networkUnsafeKey)}`);
  if (inspected.root !== binding.root || fsImpl.realpathSync(cwd) !== binding.root) return reject('task command rejected: prepare worktree must run at the bound repository root');
  const root = binding.root;
  const claudeDir = path.join(root, '.claude');
  const worktreeRoot = path.join(claudeDir, 'worktrees');
  const worktreePath = path.join(worktreeRoot, parsed.name);
  const remoteRef = `refs/remotes/origin/${parsed.base}`;
  const branchRef = `refs/heads/${parsed.branch}`;

  // 事前の検証（取得より前に、作れないと分かるものを止める）。
  for (const dir of [claudeDir, worktreeRoot]) {
    const stat = lstatOrNull(fsImpl, dir);
    if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) return reject(`task command rejected: ${path.relative(root, dir)} is a symbolic link or not a directory`);
  }
  if (lstatOrNull(fsImpl, worktreePath) !== null) return reject(`task command rejected: worktree path already exists: ${worktreePath}`);
  if (runGit(['show-ref', '--verify', '--quiet', branchRef], cwd).status === 0) return reject(`task command rejected: working branch already exists: ${JSON.stringify(parsed.branch)}`);

  // 書き込みを伴う実行はすべて、書き込み先を OS が制限した形で行う。制限をかけられない環境（sandbox-exec が無い・信頼できない）では準備しない。
  const earlyCommonDir = resolveGitCommonDir({ dir: cwd, run: runGit, fsImpl });
  let ghConfigReal = null;
  try {
    resolveTrustedPath(fsImpl, SANDBOX_EXEC_PATH, { uid: deps.uid, finalKind: 'file' });
    if (earlyCommonDir === null) throw new TrustError('git directory could not be resolved');
    ghConfigReal = resolveTrustedPath(fsImpl, binding.ghConfig, { uid: deps.uid, rejectFinalLink: true }).realPath;
  } catch (_error) {
    return reject('task command rejected: write-restricted execution is not available');
  }
  // 各段階が書いてよい場所は、その段階が実際に書く場所だけに絞る（Git 管理領域全体は許さない）。
  // Git の制御ファイル（hooks・config・各 worktree の config.worktree・objects/info 配下の alternates など）は、どの段階でも書けない。
  const adminDir = path.join(earlyCommonDir, 'worktrees', parsed.name);
  const gitPath = (...parts) => path.join(earlyCommonDir, ...parts);
  const controlFiles = [
    gitPath('hooks'), gitPath('config'), gitPath('config.worktree'), gitPath('info', 'attributes'), gitPath('objects', 'info'),
    path.join(adminDir, 'config.worktree'), path.join(adminDir, 'hooks'),
    // 作成先と補助の書き込み先が重なっても、管理領域の中に作業フォルダ用の固定名のファイルを置けないようにする。
    gitPath('refs', 'heads', '.git'), gitPath('logs', 'refs', 'heads', '.git'), path.join(adminDir, '.git'),
  ];
  const restricted = (command, allowWrite) => restrictWrites({ ...command, allowWrite, denyWrite: controlFiles });
  const runRestricted = (command, options) => spawnSync(command.bin, command.args, { cwd, encoding: 'utf8', ...options });
  const infoDir = gitPath('info');
  const excludeFile = path.join(infoDir, 'exclude');
  const refsRemotes = gitPath('refs', 'remotes');
  const logsRemotes = gitPath('logs', 'refs', 'remotes');
  const refsHeads = gitPath('refs', 'heads');
  const logsHeads = gitPath('logs', 'refs', 'heads');

  // 事前検査: 管理領域側の置き場所がリンクや別種のファイルでないこと、同名の管理情報が無いこと。
  const infoStat = lstatOrNull(fsImpl, infoDir);
  if (infoStat !== null && (infoStat.isSymbolicLink() || !infoStat.isDirectory())) return reject('task command rejected: local exclude directory is a symbolic link or not a directory');
  const excludeStat = lstatOrNull(fsImpl, excludeFile);
  if (excludeStat !== null && (excludeStat.isSymbolicLink() || !excludeStat.isFile())) return reject('task command rejected: local exclude file is not a regular file');
  if (lstatOrNull(fsImpl, adminDir) !== null) return reject('task command rejected: worktree administrative entry already exists');

  // Git 管理領域側の置き場所（ref・ログ・worktree 管理情報の親）を先に作る。作るだけで、中身は書かない。
  const gitDirs = [refsRemotes, logsRemotes, refsHeads, logsHeads, gitPath('worktrees')];
  const dirsMade = runRestricted(restricted({ bin: '/bin/mkdir', args: ['-p', '--', ...gitDirs] }, [gitPath('refs'), gitPath('logs'), gitPath('worktrees')]), { env: plainEnv });
  if (dirsMade.error || dirsMade.status !== 0) return reject('task command rejected: could not prepare the git directories');

  // 取得（通信あり）。書き込み先は、取得したオブジェクトと origin の追跡 ref と gh の設定だけ。
  const fetchArgs = [
    ...FIXED_GIT_PREFIX, ...networkGitConfig(binding),
    'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', boundRemoteUrl(binding), `+refs/heads/${parsed.base}:${remoteRef}`,
  ];
  const fetched = runRestricted(restricted({ bin: binding.git, args: fetchArgs }, [gitPath('objects'), refsRemotes, logsRemotes, ghConfigReal]), { env: networkEnv, stdio: 'inherit' });
  if (fetched.error) return reject(`task command failed to start: ${fetched.error.code || 'error'}`);
  if (fetched.status !== 0) return typeof fetched.status === 'number' ? fetched.status : 2;
  if (runGit(['show-ref', '--verify', '--quiet', remoteRef], cwd).status !== 0) return reject(`task command rejected: could not fetch the base branch ${JSON.stringify(parsed.base)}`);

  // 通常のクローンの status に worktree が未追跡として現れないよう、このクローンだけの除外設定へ作成先を登録する（共有の .gitignore は変えない）。
  // 書き込みは Node ではなく、除外ファイルだけに書き込みを限った子プロセスで行う。
  const entry = `/.claude/worktrees/${parsed.name}/`;
  let existing = '';
  try {
    existing = excludeStat === null ? '' : String(fsImpl.readFileSync(excludeFile, 'utf8'));
  } catch (error) {
    write(`task command failed: ${error && error.code ? error.code : 'filesystem error'}\n`);
    return 2;
  }
  if (!existing.split('\n').includes(entry)) {
    const infoMade = runRestricted(restricted({ bin: '/bin/mkdir', args: ['-p', '--', infoDir] }, [infoDir]), { env: plainEnv });
    if (infoMade.error || infoMade.status !== 0) return reject('task command rejected: could not create the local exclude directory');
    const appended = runRestricted(restricted({ bin: '/bin/sh', args: ['-c', 'printf "\\n%s\\n" "$2" >> "$1"', 'sh', excludeFile, entry] }, [excludeFile]), { env: plainEnv });
    if (appended.error || appended.status !== 0) return reject('task command rejected: could not update the local exclude file');
  }

  // 作成先の親フォルダは、書き込みを .claude 配下の実パスに限った子プロセスで作る。
  const mkdirCommand = restricted({ bin: '/bin/mkdir', args: ['-p', '--', worktreeRoot] }, [claudeDir]);
  const made = runRestricted(mkdirCommand, { env: plainEnv });
  if (made.error || made.status !== 0) return reject('task command rejected: could not create the worktree parent directory');
  // 作成後の状態を確かめる（拒否の理由を分かりやすくするための検査。安全性は書き込み制限が担う）。
  try {
    for (const dir of [claudeDir, worktreeRoot]) {
      const stat = fsImpl.lstatSync(dir);
      if (stat.isSymbolicLink() || !stat.isDirectory() || fsImpl.realpathSync(dir) !== dir) return reject(`task command rejected: ${path.relative(root, dir)} is a symbolic link or not a directory`);
    }
  } catch (error) {
    write(`task command failed: ${error && error.code ? error.code : 'filesystem error'}\n`);
    return 2;
  }

  // 管理情報の作成（チェックアウトしない）。書けるのは新しいブランチの ref とログ、この worktree の管理情報、作成先の事前に計算した実パスだけ。
  const addCommand = restricted({
    bin: binding.git,
    args: [...FIXED_GIT_PREFIX, 'worktree', 'add', '--quiet', '--no-checkout', '--no-track', '-b', parsed.branch, worktreePath, remoteRef],
  }, [worktreePath, refsHeads, logsHeads, adminDir]);
  const added = runRestricted(addCommand, { env: plainEnv, stdio: 'inherit' });
  if (added.error) return reject(`task command failed to start: ${added.error.code || 'error'}`);
  if (added.status !== 0) return typeof added.status === 'number' ? added.status : 2;

  // 展開は 2 つの別プロセスに分ける。管理領域と作業フォルダは引数で明示する（作業フォルダの .git ファイルは信用しない）。
  // 1) index の作成（作業ファイルには触れない）: 書けるのはこの worktree の管理情報だけ。
  // 2) 作業ファイルの展開: 書けるのは作業フォルダの事前に計算した実パスだけ。展開プロセスには管理領域を一切許可しない。
  const explicit = [...FIXED_GIT_PREFIX, '-c', 'core.splitIndex=false', `--git-dir=${adminDir}`, `--work-tree=${worktreePath}`];
  const indexed = runRestricted(restricted({ bin: binding.git, args: [...explicit, 'read-tree', '--reset', 'HEAD'] }, [adminDir]), { env: plainEnv, stdio: 'inherit' });
  if (indexed.error) return reject(`task command failed to start: ${indexed.error.code || 'error'}`);
  if (indexed.status !== 0) return typeof indexed.status === 'number' ? indexed.status : 2;
  const checkedOut = runRestricted(restricted({ bin: binding.git, args: [...explicit, 'checkout-index', '--all', '--force'] }, [worktreePath]), { env: plainEnv, stdio: 'inherit' });
  if (checkedOut.error) return reject(`task command failed to start: ${checkedOut.error.code || 'error'}`);
  if (checkedOut.status !== 0) return typeof checkedOut.status === 'number' ? checkedOut.status : 2;
  const baseSha = runGit(['rev-parse', remoteRef], cwd);
  writeOut(`TARGET_REPO=${worktreePath}\nWORK_BRANCH=${parsed.branch}\nBASE_SHA=${String(baseSha.stdout).trim()}\n`);
  return 0;
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
  const writeOut = deps.writeOut || ((message) => process.stdout.write(message));
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
    const usesGh = parsed.bin === 'gh' || parsed.needsGh === true;
    for (const tool of [binding.git, ...(usesGh ? [binding.gh] : [])]) {
      if (tool === null) return reject('task command rejected: gh is not available');
      resolveTrustedPath(fsImpl, tool, { ...trustOptions, finalKind: 'file' });
    }
    // gh の専用設定フォルダ（認証だけを引き継いだもの）も、実体・所有者・他人の書き込み不可を確認する。
    if (usesGh) resolveTrustedPath(fsImpl, binding.ghConfig, { ...trustOptions, rejectFinalLink: true });
  } catch (error) {
    return reject(`task command rejected: ${error instanceof TrustError ? error.message : 'executable could not be verified'}`);
  }

  const env = buildChildEnvironment(binding);
  const runGit = (args, runCwd) => spawnSync(binding.git, [...FIXED_GIT_PREFIX, ...args], { cwd: runCwd, env, encoding: 'utf8' });

  // 作業フォルダが、起動時に拘束したリポジトリそのものであることを確認する。
  const inspected = inspectRepository({ cwd, run: runGit, homeDir: binding.home, fsImpl });
  if (!inspected.ok) return reject(inspected.error);
  if (inspected.root !== binding.root && !isBoundWorktree({ cwd, run: runGit, bindingRoot: binding.root, inspectedRoot: inspected.root, fsImpl, uid: currentUid(deps) })) {
    return reject('task command rejected: working directory is not the bound repository');
  }
  if (parsed.needsGitHub) {
    if (binding.repo === null || inspected.repo !== binding.repo) return reject('task command rejected: origin does not match the bound github.com repository');
  }

  if (parsed.guardsDefaultBranch) {
    const branchError = checkCommitBranch({ cwd, run: runGit });
    if (branchError !== null) return reject(branchError);
  }

  if (parsed.operation === 'push' || parsed.operation === 'prepare-worktree') {
    const networkEnv = networkEnvironment(binding);
    const context = { parsed, binding, cwd, fsImpl, runGit, spawnSync, networkEnv, plainEnv: env, reject, inspected, write, writeOut, deps };
    return parsed.operation === 'push' ? executePush(context) : executePrepareWorktree(context);
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
  isBoundWorktree,
  checkCommitBranch,
  inspectGitConfigListing,
  findNetworkUnsafeKey,
  isSupportedGitVersion,
  parseGitHubRepo,
  assertChainUnchanged,
  resolveTrustedPath,
  resolveTrustedExecutable,
  resolveTrustedExecutableDetailed,
  TrustError,
  FIXED_GIT_PREFIX,
  DEFAULT_REMOTE_BASE,
  restrictWrites,
};

// 複製先（専用 CODEX_HOME）では、ランチャーからの Node 直接実行になる。require された場合は何もしない。
if (require.main === module) {
  process.exitCode = runTaskCommand(process.argv.slice(2));
}
