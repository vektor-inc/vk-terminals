// 自動処理用 Codex に「承認なし」で許す Git / GitHub 操作の固定入口（issue #428）。
//
// このファイルは 2 つの使われ方をする（どちらも同じ検証を通す）。
//   1. テストと main 側からの require（parseTaskCommand など）
//   2. 専用 CODEX_HOME へ複製され、Codex の rules（`node <このファイル>` の完全一致）経由で実行される
//
// 複製して単体で動かすため、node 標準モジュール以外を require しないこと（崩すと複製先で動かない）。
//
// 設計の要点:
//   - rules の prefix_rule は後続の引数を制限できない。そのため rules には「この入口の実行」だけを許可し、
//     引数の検証はこのファイルで行う。許可する操作・フラグ・位置引数はすべて下の許可リストにあるものだけで、
//     未知のフラグ・パス・リポジトリ指定（--repo など）・ファイル出力系（--output / --body-file など）は拒否する。
//   - git / gh へ渡す argv は検証済みの値だけで組み立て直す（呼び出し側の文字列をそのまま連結しない）。
//   - 実行前に、作業フォルダが Git 管理下で、ホームや / そのものではないことを確認する。
//     gh を使う操作は origin が github.com であることも確認する。
const nodeFs = require('fs');
const os = require('os');
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

const FIXED_GIT_PREFIX = Object.freeze(['--no-pager', '-c', 'core.fsmonitor=false']);

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
      const parsed = parseGhView(tokens, { allowedBooleanFlags: ['--comments'], numberRequired: false });
      return parsed.ok ? ghCommand(['pr', 'view', ...(parsed.number ? [parsed.number] : [])], parsed.args) : parsed;
    }
    if (group === 'pr' && action === 'checks') {
      const parsed = parseGhView(tokens, { allowedBooleanFlags: [], numberRequired: false });
      return parsed.ok ? ghCommand(['pr', 'checks', ...(parsed.number ? [parsed.number] : [])], parsed.args) : parsed;
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

// 設定の差し替えで外部コマンド・出力先・対象リポジトリを変えられないよう、環境変数を整理する。
function sanitizeEnvironment(env) {
  const next = {};
  for (const [key, value] of Object.entries(env)) {
    if (/^GIT_(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE)$/.test(key)) next[key] = value;
    else if (/^(GIT_|GH_REPO$|GH_HOST$|GH_PAGER$|GH_EDITOR$|GH_BROWSER$|BROWSER$|PAGER$|EDITOR$|VISUAL$)/.test(key)) continue;
    else next[key] = value;
  }
  next.GIT_TERMINAL_PROMPT = '0';
  next.GH_PROMPT_DISABLED = '1';
  return next;
}

const GITHUB_REMOTE_PATTERN = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?(?:\.git)?\/?$/;

/**
 * 作業フォルダが実行してよいリポジトリかを確認する。
 * Git 管理下で、ホームや / そのものではないこと。gh を使う操作は origin が github.com であること。
 * @returns {{ok: true} | {ok: false, error: string}}
 */
function verifyRepository({ cwd, needsGitHub, run, homeDir, fsImpl }) {
  const toplevel = run('git', ['rev-parse', '--show-toplevel'], cwd);
  if (toplevel.status !== 0) return fail('not inside a git repository');
  let topPath;
  try {
    topPath = fsImpl.realpathSync(String(toplevel.stdout).trim());
  } catch (_error) {
    return fail('repository path could not be resolved');
  }
  const forbidden = new Set([path.parse(topPath).root]);
  try { forbidden.add(fsImpl.realpathSync(homeDir)); } catch (_error) { /* ホームが無ければ比較対象にしない */ }
  if (forbidden.has(topPath)) return fail('repository root is not a project directory');
  if (needsGitHub) {
    const remote = run('git', ['remote', 'get-url', 'origin'], cwd);
    if (remote.status !== 0 || !GITHUB_REMOTE_PATTERN.test(String(remote.stdout).trim())) return fail('origin is not a github.com repository');
  }
  return { ok: true };
}

/**
 * 検証を通った操作だけを実行し、終了コードを返す。
 * @param {ReadonlyArray<string>} argv 先頭が git / gh の引数列
 * @param {object} [deps] テスト用の差し替え（cwd / env / spawnSync / homeDir / fs / write）
 * @returns {number} プロセスの終了コード（拒否・検証失敗は 2）
 */
function runTaskCommand(argv, deps = {}) {
  const cwd = deps.cwd || process.cwd();
  const env = sanitizeEnvironment(deps.env || process.env);
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  const write = deps.write || ((message) => process.stderr.write(message));
  const run = (bin, args, runCwd, stdio) => spawnSync(bin, args, { cwd: runCwd, env, encoding: 'utf8', ...(stdio ? { stdio } : {}) });
  const parsed = parseTaskCommand(argv);
  if (!parsed.ok) {
    write(`${parsed.error}\n`);
    return 2;
  }
  const verified = verifyRepository({
    cwd, needsGitHub: parsed.needsGitHub, run, homeDir: deps.homeDir || os.homedir(), fsImpl: deps.fs || nodeFs,
  });
  if (!verified.ok) {
    write(`${verified.error}\n`);
    return 2;
  }
  const result = run(parsed.bin, parsed.args, cwd, 'inherit');
  if (result.error) {
    write(`task command failed to start: ${result.error.code || 'error'}\n`);
    return 2;
  }
  return typeof result.status === 'number' ? result.status : 2;
}

module.exports = { parseTaskCommand, runTaskCommand, sanitizeEnvironment, verifyRepository };

// 複製先（専用 CODEX_HOME）では node の直接実行になる。require された場合は何もしない。
if (require.main === module) {
  process.exitCode = runTaskCommand(process.argv.slice(2));
}
