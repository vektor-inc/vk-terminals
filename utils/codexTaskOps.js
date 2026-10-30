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
//   - Git 操作は起動時に確定したリポジトリへ拘束する。gh は従来の拘束先に加え、明示した owner/repo の owner が
//     起動時の許可リストと一致するときだけ、ローカル Git に依存せず実行できる。gh には検証済みの --repo を必ず付ける。
//   - 通信する Git 操作（git push / prepare worktree の fetch）は origin の設定値を使わない。拘束した owner/repo から
//     入口が組み立てた固定 URL と固定 refspec だけに送り、資格情報は検証済み gh の `auth git-credential` だけを使う（issue #440）。
//   - メンバー起動（member start / member status。issue #441）は、子の Codex を親と同じ範囲の sandbox（-s workspace-write か read-only、
//     -a never）で起動する。囲いを外す指定は受け付けず、子には専用の CODEX_HOME（member 操作を持たない入口）を渡して入れ子の起動を防ぐ。
//     入出力ファイルは起動ごとの専用フォルダ直下の名前だけで、子の実行は数十分かかりうるためバックグラウンドで行う。
const nodeFs = require('fs');
const crypto = require('crypto');
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
// メンバー起動の入出力ファイル名（専用フォルダ直下の名前だけ。パス区切り・先頭 `.` は通らない）、モデル名、実行 ID。
const MEMBER_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MEMBER_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
const MEMBER_RUN_ID_PATTERN = /^[0-9a-f]{24}$/;
const MEMBER_SUPPORTED_ENGINES = Object.freeze(['codex']);
const MEMBER_PARENT_SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
const MEMBER_MAX_RESULT_BYTES = 16 * 1024 * 1024;
// 実行の監督プロセス（member start が起動する、子の Codex の終了を見届ける常駐プロセス）へ設定を渡す環境変数。
// ランチャーは環境を空にして入口を起動するため、Codex（親）からこの変数を差し込む経路は無い。
const MEMBER_SUPERVISE_ENV = 'VK_TASK_MEMBER_SUPERVISE';
const MEMBER_MAX_PROMPT_BYTES = 1024 * 1024;
const MEMBER_MAX_SCHEMA_BYTES = 256 * 1024;
const MEMBER_LOG_TAIL_BYTES = 4096;

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

// 作成済み issue への担当者・既存ラベルの追加は `gh issue edit <番号> --add-assignee <名前> --add-label <ラベル>` の形だけ（どちらも複数可、少なくとも 1 つ必須）。
// 題名・本文・削除系・--repo などは許可リストに無いので拒否される。実行は入口が「ラベルの存在確認 → 更新 → 読み戻し」の順で行う。
function parseGhIssueEdit(tokens) {
  let number;
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
    if (name === '--add-assignee') {
      const value = readValue();
      if (typeof value !== 'string' || !ASSIGNEE_PATTERN.test(value)) return fail('invalid --add-assignee');
      assignees.push(value);
    } else if (name === '--add-label') {
      const value = readValue();
      if (!isSafeLabelName(value)) return fail('invalid --add-label');
      labels.push(value);
    } else if (!token.startsWith('-') && number === undefined && DIGITS_PATTERN.test(token)) number = token;
    else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (number === undefined) return fail('number required');
  if (assignees.length === 0 && labels.length === 0) return fail('--add-assignee or --add-label is required');
  return { ok: true, bin: 'gh', operation: 'issue-edit', number, assignees, labels, needsGitHub: true };
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

function isSafeMemberFileName(value) {
  return !hasUnsafeCharacter(value) && MEMBER_FILE_NAME_PATTERN.test(value) && !value.includes('..') && !value.endsWith('.');
}

// メンバー起動は `member start --engine codex --prompt <名前> --schema <名前> --out <名前> [--model <名前>] [--readonly]` と
// `member status <ID>` だけ。--repo・絶対パス・囲いを外す指定は許可リストに無いので、未知のオプションとして拒否される。
function parseMemberStart(tokens) {
  const values = {};
  let readonly = false;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    const [name, inlineValue] = token.startsWith('--') && token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    if (name === '--readonly' && inlineValue === undefined && !readonly) {
      readonly = true;
    } else if (['--engine', '--prompt', '--schema', '--out', '--model'].includes(name) && values[name] === undefined) {
      const value = inlineValue !== undefined ? inlineValue : tokens[i + 1];
      if (hasUnsafeCharacter(value)) return fail(`${name} needs a value`);
      if (inlineValue === undefined) i += 1;
      values[name] = value;
    } else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (values['--engine'] === undefined) return fail('--engine is required');
  if (!MEMBER_SUPPORTED_ENGINES.includes(values['--engine'])) return fail(`engine not supported: ${JSON.stringify(values['--engine'])}`);
  for (const option of ['--prompt', '--schema', '--out']) {
    if (values[option] === undefined) return fail(`${option} is required`);
    if (!isSafeMemberFileName(values[option])) return fail(`${option} must be a plain file name in the member input/output folder`);
  }
  if (new Set([values['--prompt'], values['--schema'], values['--out']]).size !== 3) return fail('--prompt, --schema and --out must be different files');
  if (values['--model'] !== undefined && !MEMBER_MODEL_PATTERN.test(values['--model'])) return fail('invalid --model');
  return {
    ok: true, bin: 'codex', operation: 'member-start', engine: values['--engine'], prompt: values['--prompt'], schema: values['--schema'], out: values['--out'],
    model: values['--model'] === undefined ? null : values['--model'], readonly, needsGitHub: false,
  };
}

function parseMember(tokens) {
  const [action, ...rest] = tokens;
  if (action === 'start') return parseMemberStart(rest);
  if (action === 'status') {
    if (rest.length !== 1 || hasUnsafeCharacter(rest[0]) || !MEMBER_RUN_ID_PATTERN.test(rest[0])) return fail('usage: member status <run id>');
    return { ok: true, bin: 'codex', operation: 'member-status', id: rest[0], needsGitHub: false };
  }
  return fail(`member ${action === undefined ? '' : JSON.stringify(action)} is not allowed`);
}

function ghCommand(parts, args) {
  return { ok: true, bin: 'gh', args: [...parts, ...args], needsGitHub: true };
}

function isSafeGitHubRepo(value) {
  if (typeof value !== 'string' || !GITHUB_REPO_PATTERN.test(value)) return false;
  const [owner, repo] = value.split('/');
  return !['.', '..'].includes(owner) && !owner.startsWith('-') && !['.', '..'].includes(repo) && !repo.startsWith('-');
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
    let ghTokens = rest;
    let targetRepo;
    if (rest[0]?.includes('/')) {
      if (!isSafeGitHubRepo(rest[0])) return fail(`invalid github repository: ${JSON.stringify(rest[0])}`);
      [targetRepo, ...ghTokens] = rest;
    }
    const [group, action, ...tokens] = ghTokens;
    const command = (parts, args) => ({ ...ghCommand(parts, args), ...(targetRepo === undefined ? {} : { targetRepo }) });
    if (group === 'issue' && action === 'view') {
      const parsed = parseGhView(tokens, { allowedBooleanFlags: ['--comments'], numberRequired: true });
      return parsed.ok ? command(['issue', 'view', parsed.number], parsed.args) : parsed;
    }
    if (group === 'issue' && action === 'comment') {
      const parsed = parseGhComment(tokens);
      return parsed.ok ? command(['issue', 'comment', parsed.number], parsed.args) : parsed;
    }
    if (group === 'issue' && action === 'create') {
      const parsed = parseGhIssueCreate(tokens);
      return parsed.ok ? command(['issue', 'create'], parsed.args) : parsed;
    }
    if (group === 'issue' && action === 'edit') {
      // 操作対象は起動時に固定したリポジトリだけ。別リポジトリの明示は受けない。
      if (targetRepo !== undefined) return fail('gh issue edit cannot target another repository');
      return parseGhIssueEdit(tokens);
    }
    if (group === 'pr' && action === 'view') {
      const parsed = parseGhView(tokens, { allowedBooleanFlags: ['--comments'], numberRequired: true });
      return parsed.ok ? command(['pr', 'view', parsed.number], parsed.args) : parsed;
    }
    if (group === 'pr' && action === 'checks') {
      const parsed = parseGhView(tokens, { allowedBooleanFlags: [], numberRequired: true });
      return parsed.ok ? command(['pr', 'checks', parsed.number], parsed.args) : parsed;
    }
    if (group === 'pr' && action === 'comment') {
      const parsed = parseGhComment(tokens);
      return parsed.ok ? command(['pr', 'comment', parsed.number], parsed.args) : parsed;
    }
    if (group === 'pr' && action === 'create') {
      const parsed = parseGhPrCreate(tokens);
      return parsed.ok ? command(['pr', 'create'], parsed.args) : parsed;
    }
    return fail(`gh ${[group, action].filter((part) => part !== undefined).map((part) => JSON.stringify(part)).join(' ')} is not allowed`);
  }
  if (tool === 'prepare') {
    const [target, ...tokens] = rest;
    if (target === 'worktree') return parsePrepareWorktree(tokens);
    return fail(`prepare ${target === undefined ? '' : JSON.stringify(target)} is not allowed`);
  }
  if (tool === 'member') return parseMember(rest);
  return fail('only git, gh, prepare and member are allowed');
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
 * @returns {{root: string, repo: string|null, git: string, gh: string|null, home: string, gitConfig: string, ghConfig: string|null, remoteBase: string, member: {codex: string, home: string, io: string, runs: string, parentCwd: string, parentSandbox: string}|null}|null}
 */
function readBinding(env) {
  const root = env.VK_TASK_ROOT;
  const git = env.VK_TASK_GIT;
  const gh = env.VK_TASK_GH || null;
  const home = env.VK_TASK_HOME;
  const gitConfig = env.VK_TASK_GITCONFIG;
  const ghConfig = env.VK_TASK_GHCONFIG || null;
  const repo = env.VK_TASK_REPO || null;
  const allowedOwnersValue = env.VK_TASK_ALLOWED_OWNERS || (repo === null ? '' : repo.split('/')[0]);
  const remoteBase = env.VK_TASK_REMOTE_BASE || DEFAULT_REMOTE_BASE;
  if (![root, git, home, gitConfig].every(isSafeBindingPath)) return null;
  if (gh !== null && !isSafeBindingPath(gh)) return null;
  // gh を使えるときは、ランチャーが生成した専用の設定フォルダが必須（個人の gh 設定は読まない）。
  if (gh !== null && !isSafeBindingPath(ghConfig)) return null;
  if (ghConfig !== null && !isSafeBindingPath(ghConfig)) return null;
  if (repo !== null && !GITHUB_REPO_PATTERN.test(repo)) return null;
  const allowedOwners = allowedOwnersValue === '' ? [] : allowedOwnersValue.split(',');
  if (allowedOwners.some((owner) => !isSafeGitHubRepo(`${owner}/repository`))) return null;
  // push 先・fetch 元の基点は GitHub の固定値。例外はテスト用に一時フォルダの絶対パスを渡すときだけで、
  // 値はランチャー（Codex から書き換えられない）が固定する。
  if (remoteBase !== DEFAULT_REMOTE_BASE && (!isSafeBindingPath(remoteBase) || remoteBase.split('/').includes('..'))) return null;
  // メンバー起動の設定は 4 つがそろったときだけ有効。すべて空（子用ランチャー・Codex が見つからない場合）なら member 操作は拒否する。
  // 一部だけ設定されている状態は不正として、束縛全体を無効にする。
  // parentCwd / parentSandbox は、親の Codex を起動したときの作業フォルダと sandbox。子はこの範囲を超えない。
  const memberValues = [env.VK_TASK_CODEX, env.VK_TASK_MEMBER_HOME, env.VK_TASK_MEMBER_IO, env.VK_TASK_MEMBER_RUNS, env.VK_TASK_PARENT_CWD, env.VK_TASK_PARENT_SANDBOX];
  let member = null;
  if (memberValues.some((value) => value)) {
    if (!memberValues.slice(0, 5).every(isSafeBindingPath)) return null;
    if (!MEMBER_PARENT_SANDBOXES.includes(memberValues[5])) return null;
    member = { codex: memberValues[0], home: memberValues[1], io: memberValues[2], runs: memberValues[3], parentCwd: memberValues[4], parentSandbox: memberValues[5] };
  }
  return { root, repo, allowedOwners, git, gh, home, gitConfig, ghConfig, remoteBase, member };
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
 * `gh issue edit <番号> --add-assignee … --add-label …`。固定したリポジトリの issue にだけ、担当者と既存ラベルを足す。
 * 1. 指定ラベルが対象リポジトリに完全一致で存在することを確かめる（無い名前で新しいラベルが作られないように、更新の前に止める。一覧はページ送りで全件取る）。
 * 2. gh issue edit を実行する。
 * 3. issue を読み戻し、依頼した担当者とラベルがすべて付いていることを確かめる。gh issue edit は権限不足でも終了コード 0 で何もしないことがあるため、成功の判定は 3 だけで行う。
 * 担当者の照合は GitHub のアカウント名が大文字小文字を区別しないため小文字にそろえ、ラベルは完全一致で見る。
 */
function executeIssueEdit({ parsed, binding, cwd, env, spawnSync, reject, writeOut }) {
  const runGh = (args) => spawnSync(binding.gh, args, { cwd, env, encoding: 'utf8' });
  const failed = (result) => Boolean(result.error) || result.status !== 0;
  const detail = (result) => String(result.stderr || '').trim().split('\n')[0] || (result.error && result.error.code) || `exit ${result.status}`;

  if (parsed.labels.length > 0) {
    const listed = runGh(['api', '--paginate', `repos/${binding.repo}/labels?per_page=100`, '--jq', '.[].name']);
    if (failed(listed)) return reject(`task command failed: could not list labels: ${detail(listed)}`);
    const existing = new Set(String(listed.stdout).split('\n'));
    const missing = parsed.labels.find((label) => !existing.has(label));
    if (missing !== undefined) return reject(`task command rejected: label does not exist: ${JSON.stringify(missing)}`);
  }

  const editArgs = ['issue', 'edit', parsed.number];
  for (const assignee of parsed.assignees) editArgs.push('--add-assignee', assignee);
  for (const label of parsed.labels) editArgs.push('--add-label', label);
  const edited = runGh(withBoundRepository(editArgs, binding.repo));
  if (failed(edited)) return reject(`task command failed: gh issue edit failed: ${detail(edited)}`);

  const viewed = runGh(withBoundRepository(['issue', 'view', parsed.number, '--json', 'assignees,labels'], binding.repo));
  if (failed(viewed)) return reject(`task command failed: could not verify the update: ${detail(viewed)}`);
  let issue;
  try {
    issue = JSON.parse(String(viewed.stdout));
  } catch (error) {
    return reject('task command failed: could not verify the update: unreadable response');
  }
  const currentAssignees = new Set((Array.isArray(issue && issue.assignees) ? issue.assignees : []).map((item) => String(item && item.login).toLowerCase()));
  const currentLabels = new Set((Array.isArray(issue && issue.labels) ? issue.labels : []).map((item) => item && item.name));
  const missingAssignee = parsed.assignees.find((assignee) => !currentAssignees.has(assignee.toLowerCase()));
  const missingLabel = parsed.labels.find((label) => !currentLabels.has(label));
  if (missingAssignee !== undefined || missingLabel !== undefined) {
    return reject(`task command failed: the update was not applied: ${JSON.stringify(missingAssignee !== undefined ? missingAssignee : missingLabel)} is not on issue #${parsed.number}`);
  }
  writeOut(`updated issue #${parsed.number}: assignees=${JSON.stringify(parsed.assignees)} labels=${JSON.stringify(parsed.labels)}\n`);
  return 0;
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
    path.join(adminDir, '.git'),
  ];
  const restricted = (command, allowWrite) => restrictWrites({ ...command, allowWrite, denyWrite: controlFiles });
  const runRestricted = (command, options) => spawnSync(command.bin, command.args, { cwd, encoding: 'utf8', ...options });
  const infoDir = gitPath('info');
  const excludeFile = path.join(infoDir, 'exclude');
  // ref とログは「その 1 本のファイルとロックファイル」だけに書き込みを許す（refs/heads などの階層全体は許さない）。
  const refFile = (...parts) => gitPath('refs', ...parts);
  const logFile = (...parts) => gitPath('logs', 'refs', ...parts);
  const remoteParts = ['remotes', 'origin', ...parsed.base.split('/')];
  const branchParts = ['heads', ...parsed.branch.split('/')];
  const writableRef = (parts) => [refFile(...parts), `${refFile(...parts)}.lock`, logFile(...parts), `${logFile(...parts)}.lock`];
  // 作る必要がある親フォルダ（mkdir は作るだけで、既存の中身には触れない）。
  const parentDirs = (parts) => {
    const dirs = [];
    for (let i = 1; i < parts.length; i += 1) dirs.push(refFile(...parts.slice(0, i)), logFile(...parts.slice(0, i)));
    return dirs;
  };

  // 事前検査: 管理領域側の置き場所がリンクや別種のファイルでないこと、同名の管理情報が無いこと。
  const infoStat = lstatOrNull(fsImpl, infoDir);
  if (infoStat !== null && (infoStat.isSymbolicLink() || !infoStat.isDirectory())) return reject('task command rejected: local exclude directory is a symbolic link or not a directory');
  const excludeStat = lstatOrNull(fsImpl, excludeFile);
  if (excludeStat !== null && (excludeStat.isSymbolicLink() || !excludeStat.isFile())) return reject('task command rejected: local exclude file is not a regular file');
  if (lstatOrNull(fsImpl, adminDir) !== null) return reject('task command rejected: worktree administrative entry already exists');

  // Git 管理領域側の置き場所（ref・ログ・worktree 管理情報の親）を先に作る。作るだけで、中身は書かない。
  const gitDirs = [...new Set([...parentDirs(remoteParts), ...parentDirs(branchParts), gitPath('worktrees')])];
  // 書き込みを許すのは「まだ存在しないフォルダ」だけ（既存のフォルダの中身には書き込み権を与えない）。
  const makeDirs = (dirs) => {
    const missing = dirs.filter((dir) => lstatOrNull(fsImpl, dir) === null);
    if (missing.length === 0) return true;
    const made = runRestricted(restricted({ bin: '/bin/mkdir', args: ['-p', '--', ...missing] }, missing), { env: plainEnv });
    return !made.error && made.status === 0;
  };
  if (!makeDirs([gitPath('refs'), gitPath('logs'), gitPath('logs', 'refs'), ...gitDirs])) return reject('task command rejected: could not prepare the git directories');

  // 取得（通信あり）。書き込み先は、取得したオブジェクトと origin の追跡 ref と gh の設定だけ。
  const fetchArgs = [
    ...FIXED_GIT_PREFIX, ...networkGitConfig(binding),
    'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', boundRemoteUrl(binding), `+refs/heads/${parsed.base}:${remoteRef}`,
  ];
  const fetched = runRestricted(restricted({ bin: binding.git, args: fetchArgs }, [gitPath('objects'), ...writableRef(remoteParts), ghConfigReal]), { env: networkEnv, stdio: 'inherit' });
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
    if (!makeDirs([infoDir])) return reject('task command rejected: could not create the local exclude directory');
    const appended = runRestricted(restricted({ bin: '/bin/sh', args: ['-c', 'printf "\\n%s\\n" "$2" >> "$1"', 'sh', excludeFile, entry] }, [excludeFile]), { env: plainEnv });
    if (appended.error || appended.status !== 0) return reject('task command rejected: could not update the local exclude file');
  }

  // 作成先の親フォルダは、書き込みを .claude 配下の実パスに限った子プロセスで作る。
  if (!makeDirs([claudeDir, worktreeRoot])) return reject('task command rejected: could not create the worktree parent directory');
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

  // 作業ブランチの作成は、worktree の追加とは別のプロセスで行う。書けるのはそのブランチの ref・ログとそれぞれのロックファイルだけ。
  const branchMade = runRestricted(restricted({
    bin: binding.git, args: [...FIXED_GIT_PREFIX, 'branch', '--quiet', '--no-track', parsed.branch, remoteRef],
  }, writableRef(branchParts)), { env: plainEnv, stdio: 'inherit' });
  if (branchMade.error) return reject(`task command failed to start: ${branchMade.error.code || 'error'}`);
  if (branchMade.status !== 0) return typeof branchMade.status === 'number' ? branchMade.status : 2;

  // 管理情報の作成（チェックアウトしない・既存のブランチを指定する）。書けるのはこの worktree の管理情報と、作成先の事前に計算した実パスだけで、ref やログの階層には書けない。
  const addCommand = restricted({
    bin: binding.git,
    args: [...FIXED_GIT_PREFIX, 'worktree', 'add', '--quiet', '--no-checkout', worktreePath, parsed.branch],
  }, [worktreePath, adminDir]);
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

// ─── メンバー起動（member start / member status） ──────────────────────────

/**
 * target が base そのもの、または base の配下（どちらも実パス）かを判定する。
 * 親の書き込み範囲は、親を起動した作業フォルダ（Codex の workspace-write はその配下全体）なので、
 * 後から `prepare worktree` で作った worktree（拘束ルート配下の `.claude/worktrees/`）は、親をルートで起動していれば範囲に入る。
 * 親をサブフォルダで起動した場合や、範囲の外に登録された worktree は入らない。
 * @param {string} target
 * @param {string} base
 * @returns {boolean}
 */
function isWithinDirectory(target, base) {
  const relative = path.relative(base, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

/**
 * 子の Codex の起動引数を組み立てる（codex の後ろに続く部分）。
 * 親と同じ範囲の sandbox（workspace-write。--readonly なら read-only）と `-a never` を必ず付け、
 * 囲いを外す指定（--dangerously-bypass-approvals-and-sandbox など）はここからも入らない。
 * read-only の子は、入口の許可ルールを読み込ませず（--ignore-rules）、書き込みを伴う入口操作も使わせない。
 * @param {{root: string, schemaPath: string, outPath: string, model: string|null, readonly: boolean}} params
 * @returns {string[]}
 */
function buildMemberCodexArgs({ root, schemaPath, outPath, model, readonly }) {
  return [
    '-a', 'never', 'exec', '-C', root,
    '-s', readonly ? 'read-only' : 'workspace-write',
    ...(readonly ? ['--ignore-rules'] : []),
    '--color', 'never',
    '--output-schema', schemaPath, '-o', outPath,
    ...(model === null ? [] : ['--model', model]),
    '-',
  ];
}

/**
 * 子の Codex の環境変数を一から組み立てる。親の環境は引き継がず、CODEX_HOME は子用の専用フォルダに固定する。
 * @param {{git: string, gh: string|null, home: string, member: {codex: string, home: string}}} binding
 * @returns {Record<string, string>}
 */
function buildMemberEnvironment(binding) {
  const dirs = [path.dirname(binding.member.codex), path.dirname(binding.git), ...(binding.gh ? [path.dirname(binding.gh)] : []), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
  return {
    PATH: [...new Set(dirs)].join(':'),
    HOME: binding.home,
    CODEX_HOME: binding.member.home,
    NO_COLOR: '1',
  };
}

// 起動のたびの専用フォルダ直下にある入力ファイルを、リンクをたどらず・通常ファイル・自分の所有・サイズ上限内で読む。
function readMemberInput(fsImpl, dir, name, maxBytes, uid) {
  const constants = fsImpl.constants || nodeFs.constants;
  let fd;
  try {
    fd = fsImpl.openSync(path.join(dir, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? 'does not exist' : 'is not a plain file';
    throw new TrustError(`${name} ${reason}`);
  }
  try {
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new TrustError(`${name} is not a plain file`);
    if (uid !== undefined && stat.uid !== uid) throw new TrustError(`${name} is not owned by the current user`);
    if (stat.size === 0 || stat.size > maxBytes) throw new TrustError(`${name} is empty or too large`);
    return fsImpl.readFileSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// 新規ファイルを、既にある（リンクを含む）なら失敗する形で作って書く。
function createExclusiveFile(fsImpl, filePath, content, mode = 0o600) {
  const constants = fsImpl.constants || nodeFs.constants;
  const fd = fsImpl.openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
  try {
    if (content.length > 0) fsImpl.writeFileSync(fd, content);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// 実行の記録フォルダに、member start 自身または監督プロセスが作りうるファイル名（失敗した起動の後始末で消す）。
const MEMBER_RUN_FILES = ['prompt.txt', 'schema.json', 'meta.json', 'meta.tmp', 'log.txt', 'result.txt', 'result-state.tmp', 'result-state', 'exit.tmp', 'exit'];
const MEMBER_STOP_POLL_MS = 100;
const MEMBER_STOP_POLLS = 30;

// 同期的に待つ（member start は同期処理のため）。
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// プロセスグループに実行中（ゾンビ以外）のプロセスが残っているかを ps で調べる。取得できなければ null（確認できない）。
function hasLiveProcessInGroup(pgid, deps) {
  if (deps.listProcessStates) return deps.listProcessStates(pgid);
  const result = childProcess.spawnSync('ps', ['-A', '-o', 'pgid=,stat='], { encoding: 'utf8' });
  if (result.error || result.status !== 0) return null;
  return String(result.stdout).split('\n').some((line) => {
    const match = line.trim().match(/^(\d+)\s+(\S+)/);
    return match !== null && Number(match[1]) === pgid && !match[2].startsWith('Z');
  });
}

// 監督プロセスのグループ（監督プロセスと、その子）が全て消えた、または終了済みで回収待ち（ゾンビ）だけなら true。
// 確認できないとき（kill が ESRCH 以外で失敗、ps の失敗）は false を返す。
function isSupervisorGroupGone(pid, deps) {
  try {
    (deps.kill || process.kill)(-pid, 0);
  } catch (error) {
    return Boolean(error && error.code === 'ESRCH');
  }
  if (deps.kill && !deps.listProcessStates) return false;
  return hasLiveProcessInGroup(pid, deps) === false;
}

/**
 * 起動に失敗した監督プロセス（とその子）を止め、終了を待つ。最初は SIGTERM、待っても残れば SIGKILL。
 * @returns {boolean} 終了を確かめられたら true（待ち切れなければ false。呼び出し側は競合を避けて記録フォルダを消さない）
 */
function stopSupervisor(pid, deps) {
  const kill = deps.kill || process.kill;
  const sleep = deps.sleep || sleepSync;
  for (let poll = 0; poll <= MEMBER_STOP_POLLS; poll += 1) {
    if (poll === 0 || poll === MEMBER_STOP_POLLS / 2) {
      try {
        kill(-pid, poll === 0 ? 'SIGTERM' : 'SIGKILL');
      } catch (_error) {
        // 既に終わっていれば何もしない。
      }
    }
    if (isSupervisorGroupGone(pid, deps)) return true;
    if (poll < MEMBER_STOP_POLLS) sleep(MEMBER_STOP_POLL_MS);
  }
  return false;
}

// 失敗した起動の後始末用。消せなくても（元から無い等）他の後始末を止めない。
function removeQuietly(fsImpl, targetPath, method) {
  try {
    fsImpl[method](targetPath);
  } catch (_error) {
    // 後始末は最善努力。
  }
}

// 実行の監督プロセスに渡された設定が、想定した形かを確かめる（異常なら起動しない）。
function readSupervisePayload(raw) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (_error) {
    return null;
  }
  const isPath = (value) => typeof value === 'string' && path.isAbsolute(value) && !/[\x00]/.test(value);
  const valid = payload && isPath(payload.codex) && isPath(payload.cwd) && isPath(payload.runDir)
    && Array.isArray(payload.args) && payload.args.every((arg) => typeof arg === 'string' && !/[\x00]/.test(arg))
    && payload.env && typeof payload.env === 'object' && Object.values(payload.env).every((value) => typeof value === 'string');
  return valid ? payload : null;
}

/**
 * 子の Codex を起動して終了を見届ける、`member start` が切り離して起動する監督プロセスの本体。
 * 入口（member start）は子の終了を待たずに返るため、終了コードの記録と結果の公開はここで行う。
 *   - 子の標準入力・出力は、実行の記録フォルダ内のファイル（プロンプトの写し・ログ）に直接つなぐ。
 *   - 子の結果（codex の `-o`）は、子から書き換えられない実行の記録フォルダ内に書かれる。
 *   - 入出力フォルダへの公開は、member start が先に排他的作成して渡した記述子（outFd）へ書くだけにする。
 *     入出力フォルダのパスは開き直さないので、作成後にその名前がリンクに差し替えられても、別のファイルは書き換わらない。
 *   - 公開が済んでから終了コードを書く（`exit` が在る = 結果の公開も終わっている）。
 * @param {{codex: string, args: string[], cwd: string, env: Record<string, string>, runDir: string}} payload
 * @param {{fs?: object, spawn?: Function, outFd?: number}} [deps] テスト用の差し替え（outFd は結果の公開先の記述子。既定は 3）
 * @returns {Promise<number>} 記録した終了コード
 */
function superviseMemberRun(payload, deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const spawnChild = deps.spawn || childProcess.spawn;
  const outFd = deps.outFd === undefined ? 3 : deps.outFd;
  const constants = fsImpl.constants || nodeFs.constants;
  const inRunDir = (name) => path.join(payload.runDir, name);
  return new Promise((resolve) => {
    let promptFd;
    let logFd;
    let finished = false;
    const closeQuietly = (fd) => {
      if (fd === undefined) return;
      try { fsImpl.closeSync(fd); } catch (_error) { /* 既に閉じている */ }
    };
    // 子の結果を、保持している記述子へコピーする。成否と理由（固定の語）を返す。公開できなかった場合は何も書かない（途中までの書き込みは起こさない）。
    const publishResult = () => {
      let resultFd;
      try {
        try {
          resultFd = fsImpl.openSync(inRunDir('result.txt'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        } catch (error) {
          // リンク（O_NOFOLLOW で ELOOP）など、開けたが通常ファイルでないものは別の理由にする。
          return { ok: false, reason: error && error.code === 'ENOENT' ? 'result-missing' : 'result-not-a-regular-file' };
        }
        const stat = fsImpl.fstatSync(resultFd);
        if (!stat.isFile()) return { ok: false, reason: 'result-not-a-regular-file' };
        if (stat.size > MEMBER_MAX_RESULT_BYTES) return { ok: false, reason: 'result-too-large' };
        fsImpl.writeFileSync(outFd, fsImpl.readFileSync(resultFd));
        return { ok: true, reason: null };
      } catch (_error) {
        return { ok: false, reason: 'result-write-failed' };
      } finally {
        closeQuietly(resultFd);
      }
    };
    const finish = (code) => {
      if (finished) return;
      finished = true;
      closeQuietly(promptFd);
      closeQuietly(logFd);
      const published = publishResult();
      closeQuietly(outFd);
      // 結果の公開の成否は、終了コードより先に保護された実行の記録フォルダへ書く（exit が在る = 成否の記録も済んでいる）。
      try {
        createExclusiveFile(fsImpl, inRunDir('result-state.tmp'), Buffer.from(published.ok ? 'published\n' : `failed ${published.reason}\n`));
        fsImpl.renameSync(inRunDir('result-state.tmp'), inRunDir('result-state'));
      } catch (_error) {
        // 記録できなければ、状態確認は failed（result-state-unrecorded）になる。
      }
      try {
        createExclusiveFile(fsImpl, inRunDir('exit.tmp'), Buffer.from(`${code}\n`));
        fsImpl.renameSync(inRunDir('exit.tmp'), inRunDir('exit'));
      } catch (_error) {
        // 記録できなければ、状態確認は lost になる。
      }
      resolve(code);
    };
    let child;
    try {
      promptFd = fsImpl.openSync(inRunDir('prompt.txt'), constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      logFd = fsImpl.openSync(inRunDir('log.txt'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      child = spawnChild(payload.codex, payload.args, { cwd: payload.cwd, env: payload.env, stdio: [promptFd, logFd, logFd] });
    } catch (_error) {
      finish(127);
      return;
    }
    child.on('error', () => finish(127));
    child.on('close', (code) => finish(Number.isInteger(code) && code >= 0 && code <= 255 ? code : 128));
  });
}

/**
 * `member start`。子の Codex をバックグラウンドで起動し、実行 ID を返す。子の実行は数十分かかりうるため、完了は待たない。
 * 子は親と同じ範囲を超えない場合にだけ起動する。
 *   - sandbox: 親が read-only なら、`--readonly` の有無にかかわらず read-only（`--ignore-rules` 付き）にする。
 *   - 作業フォルダ: 常に親を起動した作業フォルダ（VK_TASK_PARENT_CWD の実パス）。呼び出し位置がその配下のときだけ起動し、配下の worktree・サブフォルダから呼んでも読み替える。
 * 入出力は専用フォルダ直下の名前だけを受ける。
 */
function executeMemberStart({ parsed, binding, cwd, fsImpl, inspected, reject, writeOut, deps }) {
  const member = binding.member;
  if (member === null) return reject('task command rejected: member is not available from this launcher');
  // 子の作業フォルダ（-C）と監督プロセスの cwd は、呼び出し位置にかかわらず、親の起動 cwd（ランチャーが実パスで固定した値）そのものにする。
  // 呼び出し位置（配下の worktree・サブフォルダ）は検査にしか使わず、起動には使わない。検査のあとに配下のフォルダがリンクに置き換えられても、範囲外は子に渡らない。
  // 呼び出し位置が親の起動 cwd の配下でなければ拒否する。どの worktree で作業させるかは prompt で伝える。
  if (!isWithinDirectory(fsImpl.realpathSync(cwd), member.parentCwd)) return reject('task command rejected: member start must run inside the parent working directory');
  if (fsImpl.realpathSync(member.parentCwd) !== member.parentCwd) return reject('task command rejected: parent working directory is not a real directory');
  const memberRoot = member.parentCwd;
  const readonly = parsed.readonly || member.parentSandbox === 'read-only';
  const uid = currentUid(deps);
  let promptBody;
  let schemaBody;
  try {
    resolveTrustedPath(fsImpl, member.codex, { uid, finalKind: 'file' });
    resolveTrustedPath(fsImpl, member.home, { uid, rejectFinalLink: true });
    // 専用フォルダはランチャーが実パスで固定している。リンクを通る場合は拒否する。
    for (const dir of [member.io, member.runs]) {
      if (resolveTrustedPath(fsImpl, dir, { uid, rejectFinalLink: true }).realPath !== dir) throw new TrustError(`path is not a real directory: ${dir}`);
    }
    promptBody = readMemberInput(fsImpl, member.io, parsed.prompt, MEMBER_MAX_PROMPT_BYTES, uid);
    schemaBody = readMemberInput(fsImpl, member.io, parsed.schema, MEMBER_MAX_SCHEMA_BYTES, uid);
    JSON.parse(schemaBody.toString('utf8'));
  } catch (error) {
    return reject(`task command rejected: ${error instanceof TrustError ? error.message : 'member input could not be verified'}`);
  }

  const constants = fsImpl.constants || nodeFs.constants;
  const outPath = path.join(member.io, parsed.out);
  const runId = (deps.randomId || (() => crypto.randomBytes(12).toString('hex')))();
  const runDir = path.join(member.runs, runId);
  const paths = { prompt: path.join(runDir, 'prompt.txt'), schema: path.join(runDir, 'schema.json'), result: path.join(runDir, 'result.txt'), log: path.join(runDir, 'log.txt'), meta: path.join(runDir, 'meta.json') };
  let outFd;
  let outCreated = false;
  let runDirCreated = false;
  let supervisorPid = null;
  let started = false;
  try {
    // 出力先は先に新規作成して記述子を保持する（事前に置かれたリンクや既存ファイルへ書かない）。以後このパスは開き直さない。
    try {
      outFd = fsImpl.openSync(outPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      outCreated = true;
    } catch (error) {
      return reject(`task command rejected: ${parsed.out} ${error && error.code === 'EEXIST' ? 'already exists' : 'could not be created'}`);
    }
    // 入力は実行用の専用フォルダへ写し取る。子から書き換えられる場所（入出力フォルダ）を、検証後に再び開かない。
    fsImpl.mkdirSync(runDir, { mode: 0o700 });
    runDirCreated = true;
    createExclusiveFile(fsImpl, paths.prompt, promptBody);
    createExclusiveFile(fsImpl, paths.schema, schemaBody);
    // 状態確認が起動直後から読めるよう、記録は監督プロセスの起動より先に書く。pid は起動後にしか分からないので、起動前は null（status では STATE=starting）。
    const meta = { pid: null, startedAt: new Date().toISOString(), readonly, out: outPath };
    createExclusiveFile(fsImpl, paths.meta, Buffer.from(`${JSON.stringify(meta)}\n`));

    // 子の結果（-o）は、子から書き換えられない実行の記録フォルダ内に書かせる。入出力フォルダへの公開は監督プロセスが行う。
    const codexArgs = buildMemberCodexArgs({ root: memberRoot, schemaPath: paths.schema, outPath: paths.result, model: parsed.model, readonly });
    const payload = { codex: member.codex, args: codexArgs, cwd: memberRoot, env: buildMemberEnvironment(binding), runDir };
    const spawnDetached = deps.spawn || childProcess.spawn;
    let supervisor;
    try {
      supervisor = spawnDetached(process.execPath, [__filename], {
        cwd: memberRoot, env: { [MEMBER_SUPERVISE_ENV]: JSON.stringify(payload) }, detached: true, stdio: ['ignore', 'ignore', 'ignore', outFd],
      });
    } catch (error) {
      return reject(`task command failed to start: ${error && error.code ? error.code : 'error'}`);
    }
    if (!supervisor || typeof supervisor.pid !== 'number') return reject('task command failed to start: error');
    supervisorPid = supervisor.pid;
    if (typeof supervisor.unref === 'function') supervisor.unref();
    // pid を記録する。置き換えで書くので、status が書きかけの記録を読むことはない。
    createExclusiveFile(fsImpl, path.join(runDir, 'meta.tmp'), Buffer.from(`${JSON.stringify({ ...meta, pid: supervisorPid })}\n`));
    fsImpl.renameSync(path.join(runDir, 'meta.tmp'), paths.meta);
    started = true;
  } catch (error) {
    return reject(`task command failed: ${error && error.code ? error.code : 'filesystem error'}`);
  } finally {
    if (!started) {
      // 失敗した起動の後始末。この起動で作ったものだけを、リンクをたどらない unlink / rmdir で消す（パスを開き直さない）。
      // 監督プロセスを起動済みなら、止まったことを確かめてから消す（動いたままだと、消している最中に結果や終了コードを書かれる）。
      const supervisorStopped = supervisorPid === null || stopSupervisor(supervisorPid, deps);
      // 止まったと確かめられないときは、書き込みが競合しないよう実行の記録フォルダには触れない（--out は記述子で書かれるだけなので消してよい）。
      if (runDirCreated && supervisorStopped) {
        for (const name of MEMBER_RUN_FILES) removeQuietly(fsImpl, path.join(runDir, name), 'unlinkSync');
        removeQuietly(fsImpl, runDir, 'rmdirSync');
      }
      if (outCreated) removeQuietly(fsImpl, outPath, 'unlinkSync');
    }
    if (outFd !== undefined) fsImpl.closeSync(outFd);
  }
  writeOut(`MEMBER_ID=${runId}\nOUT=${outPath}\nLOG=${paths.log}\n`);
  return 0;
}


// 通常ファイルの末尾を、リンクをたどらずに最大 MEMBER_LOG_TAIL_BYTES だけ読む。読めなければ null。
function readFileTail(fsImpl, filePath) {
  const constants = fsImpl.constants || nodeFs.constants;
  let fd;
  try {
    fd = fsImpl.openSync(filePath, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  } catch (_error) {
    return null;
  }
  try {
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile()) return null;
    const length = Math.min(stat.size, MEMBER_LOG_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    if (length > 0) fsImpl.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } catch (_error) {
    return null;
  } finally {
    fsImpl.closeSync(fd);
  }
}

/**
 * `member status <ID>`。子の状態（running / exited / lost）、終了コード、結果ファイル・ログの場所と、ログの末尾を返す。
 * 終了コードは子の終了時に包みの shell が書いたファイルから読む。それが無く、プロセスも見つからなければ lost（異常終了）。
 */
function executeMemberStatus({ parsed, binding, fsImpl, reject, writeOut, deps }) {
  const member = binding.member;
  if (member === null) return reject('task command rejected: member is not available from this launcher');
  const uid = currentUid(deps);
  const runDir = path.join(member.runs, parsed.id);
  let meta;
  let exitCode = null;
  let resultState = null;
  try {
    if (resolveTrustedPath(fsImpl, member.runs, { uid, rejectFinalLink: true }).realPath !== member.runs) throw new TrustError(`path is not a real directory: ${member.runs}`);
    const stat = lstatOrNull(fsImpl, runDir);
    if (stat === null) return reject(`task command rejected: unknown member run: ${parsed.id}`);
    if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) throw new TrustError('member run folder is not a plain directory');
    meta = JSON.parse(String(readMemberInput(fsImpl, runDir, 'meta.json', 64 * 1024, uid)));
    if (lstatOrNull(fsImpl, path.join(runDir, 'exit')) !== null) {
      const raw = String(readMemberInput(fsImpl, runDir, 'exit', 16, uid)).trim();
      if (!/^[0-9]{1,3}$/.test(raw)) throw new TrustError('member exit file is invalid');
      exitCode = Number(raw);
      // 結果の公開の成否。exit より先に書かれるので、exit が在って成否が無いのは記録の失敗（成功とは扱わない）。
      if (lstatOrNull(fsImpl, path.join(runDir, 'result-state')) === null) {
        resultState = 'failed result-state-unrecorded';
      } else {
        const rawState = String(readMemberInput(fsImpl, runDir, 'result-state', 128, uid)).trim();
        resultState = /^(published|failed [a-z-]{1,64})$/.test(rawState) ? rawState : 'failed result-state-invalid';
      }
    }
  } catch (error) {
    return reject(`task command rejected: ${error instanceof TrustError ? error.message : 'member run could not be read'}`);
  }
  let alive = false;
  if (exitCode === null && Number.isInteger(meta.pid) && meta.pid > 0) {
    try {
      (deps.kill || process.kill)(meta.pid, 0);
      alive = true;
    } catch (error) {
      alive = Boolean(error && error.code === 'EPERM');
    }
  }
  // pid が null の間は、member start が監督プロセスを起動している途中（記録は起動の前に書かれる）。
  const state = exitCode !== null ? 'exited' : alive ? 'running' : meta.pid === null ? 'starting' : 'lost';
  const tail = readFileTail(fsImpl, path.join(runDir, 'log.txt'));
  writeOut([
    `MEMBER_ID=${parsed.id}`,
    `STATE=${state}`,
    ...(exitCode === null ? [] : [`EXIT_CODE=${exitCode}`]),
    ...(resultState === null ? [] : resultState === 'published' ? ['RESULT_STATE=published'] : ['RESULT_STATE=failed', `RESULT_FAILURE=${resultState.slice('failed '.length)}`]),
    `OUT=${String(meta.out)}`,
    `LOG=${path.join(runDir, 'log.txt')}`,
    ...(tail === null || tail === '' ? [] : ['--- log tail ---', tail.replace(/\n$/, '')]),
    '',
  ].join('\n'));
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

  // 明示先の gh はローカル Git を使わない。owner を起動時の束縛と照合し、それ以外は従来どおりリポジトリを検査する。
  const explicitGitHubTarget = parsed.bin === 'gh' ? parsed.targetRepo : undefined;
  let inspected;
  if (explicitGitHubTarget !== undefined) {
    const owner = explicitGitHubTarget.split('/')[0].toLowerCase();
    if (!binding.allowedOwners.some((allowedOwner) => allowedOwner.toLowerCase() === owner)) {
      return reject(`task command rejected: owner ${JSON.stringify(explicitGitHubTarget.split('/')[0])} is not allowed`);
    }
  } else {
    inspected = inspectRepository({ cwd, run: runGit, homeDir: binding.home, fsImpl });
    if (!inspected.ok) return reject(inspected.error);
    if (inspected.root !== binding.root && !isBoundWorktree({ cwd, run: runGit, bindingRoot: binding.root, inspectedRoot: inspected.root, fsImpl, uid: currentUid(deps) })) {
      return reject('task command rejected: working directory is not the bound repository');
    }
    if (parsed.needsGitHub && (binding.repo === null || inspected.repo !== binding.repo)) {
      return reject('task command rejected: origin does not match the bound github.com repository');
    }
  }

  if (parsed.guardsDefaultBranch) {
    const branchError = checkCommitBranch({ cwd, run: runGit });
    if (branchError !== null) return reject(branchError);
  }

  if (parsed.operation === 'member-start' || parsed.operation === 'member-status') {
    const context = { parsed, binding, cwd, fsImpl, inspected, reject, writeOut, deps };
    return parsed.operation === 'member-start' ? executeMemberStart(context) : executeMemberStatus(context);
  }

  if (parsed.operation === 'push' || parsed.operation === 'prepare-worktree') {
    const networkEnv = networkEnvironment(binding);
    const context = { parsed, binding, cwd, fsImpl, runGit, spawnSync, networkEnv, plainEnv: env, reject, inspected, write, writeOut, deps };
    return parsed.operation === 'push' ? executePush(context) : executePrepareWorktree(context);
  }

  if (parsed.operation === 'issue-edit') return executeIssueEdit({ parsed, binding, cwd, env, spawnSync, reject, writeOut });

  const bin = parsed.bin === 'gh' ? binding.gh : binding.git;
  const args = parsed.bin === 'gh' ? withBoundRepository(parsed.args, explicitGitHubTarget || binding.repo) : parsed.args;
  // 明示先の gh は呼び出し元 cwd の Git 設定にも依存させず、固定した HOME から実行する。
  const executionCwd = explicitGitHubTarget === undefined ? cwd : binding.home;
  const result = spawnSync(bin, args, { cwd: executionCwd, env, encoding: 'utf8', stdio: 'inherit' });
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
  buildMemberCodexArgs,
  buildMemberEnvironment,
  isWithinDirectory,
  superviseMemberRun,
  resolveGitCommonDir,
  MEMBER_SUPERVISE_ENV,
};

// 複製先（専用 CODEX_HOME）では、ランチャーからの Node 直接実行になる。require された場合は何もしない。
// 環境変数 VK_TASK_MEMBER_SUPERVISE があるときは、`member start` が切り離して起動した監督プロセス（ランチャーは環境を空にするため、
// 親の Codex からこの変数は渡せない）。
if (require.main === module) {
  if (process.env[MEMBER_SUPERVISE_ENV] !== undefined) {
    const payload = readSupervisePayload(process.env[MEMBER_SUPERVISE_ENV]);
    if (payload === null) process.exitCode = 2;
    else superviseMemberRun(payload).then((code) => { process.exitCode = code; });
  } else {
    process.exitCode = runTaskCommand(process.argv.slice(2));
  }
}
