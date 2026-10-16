// 自動処理用 Codex に適用する「タスク用ポリシー」の実体（専用の CODEX_HOME）を用意する（issue #428）。
//
// 設計の要点（崩さないこと）:
//   - 利用者個人の ~/.codex/config.toml・rules・hooks・AGENTS.md は一切読み書きしない。
//     タスク用ポリシーは固定内容の専用 CODEX_HOME に生成し、その Codex 起動だけ CODEX_HOME をそこへ向ける。
//     個人設定の「上書き」ではなく「そもそも読み込まない」ため、個人設定側の広いネットワーク許可・
//     追加の書き込み先・profile が混ざる余地が無い。信頼済みプロジェクトの記録も引き継がない。
//   - 専用 CODEX_HOME は起動のたびに新規に作る（~/.vk-terminals/codex-task-policy/<preset>/<ランダム名>/）。
//     使い回さないので、事前に置かれた AGENTS.md・hooks.json・未知の設定ファイルを Codex が読む余地が無い。
//     作った直後に中身が許可した生成物だけであることを検証し、違えば Codex を起動させない。
//   - 拘束するリポジトリは config.toml に trust_level = "untrusted" で記録する。Codex は信頼済みのプロジェクトの
//     .codex（config.toml・rules・hooks）だけを実効設定へ重ねるので、リポジトリ側から network_access や
//     writable_roots を広げられない。記録が無いと信頼確認で「信頼して続行」を選べてしまうため、必ず記録する。
//   - 生成するのは preset ごとの固定テンプレートだけ。API の入力値は preset 名の選択以外、
//     ファイルの内容にも起動コマンドにも一切入らない（拘束するリポジトリは cwd から本アプリが実在確認して決める）。
//   - 承認なしで動かせる Git / GitHub 操作は、信頼済みランチャー（vk-task-ops）→ 検証付きの固定入口
//     （utils/codexTaskOps.js の複製）だけ。rules の prefix_rule は後続の引数を制限できないので、rules には
//     ランチャーの実行だけを許可し、引数・パス・リポジトリの検証は入口側で行う。
//   - ランチャーは Node を起動する前に `env -i` で環境を空にし、起動時に所有者・権限を検証した絶対パスの
//     Node / git / gh と、拘束したリポジトリ（実ルート・GitHub の owner/repo）だけを渡す。PATH は使わない。
//   - 信頼境界（データ・引き継ぎ先・ホーム・認証元・実行ファイル）は、元の絶対パスを根から 1 階層ずつ辿り、
//     リンクは向き先まで 1 段ずつ解決して、通る全ての階層の所有者・他人の書き込み不可を検証する（resolveTrustedPath）。
//     無いフォルダは検証済みの親の下に 1 段ずつ作る（検証前の再帰作成はしない）。返す直前に同一性を再確認する。
//   - gh は個人の ~/.config/gh を読まない。専用フォルダ（gh/）に固定内容の config.yml と、個人の hosts.yml から
//     許可した項目（github.com のユーザー名とトークン）だけを再生成した hosts.yml を置く。通信設定などは引き継がない。
//   - ディレクトリは実体（非シンボリックリンク）・自分の所有・0700、ファイルは通常ファイル・所定の権限を毎回検証する。
//     ファイルは排他的作成（既存なら失敗）・リンク非追跡で作る。
//   - 生成・検証のどこかで失敗したら ok: false を返し、途中まで作った専用フォルダは自分が作ったものだけ片付ける。
//     呼び出し側は Codex を起動せず、理由を返す。起動に使われなかった専用フォルダは discard() で回収する。
//   - 起動に使った専用フォルダは自動では消さない（使用中かどうかを複数のアプリプロセスをまたいで確実に判定できないため）。
//     削除は利用者の責務で、Codex が動いていないときに codex-task-policy フォルダを消してよい（docs/codex-task-policy.md）。
//
// fs / パス / 所有者 / ランダム名 / プロセス実行は引数で注入できるので、テストでは一時ディレクトリだけで検証できる。
const nodeFs = require('fs');
const childProcess = require('child_process');
const crypto = require('crypto');
const path = require('path');
const {
  FIXED_GIT_PREFIX,
  TrustError,
  assertChainUnchanged,
  buildChildEnvironment,
  inspectRepository,
  resolveTrustedExecutableDetailed,
  resolveTrustedPath,
} = require('./codexTaskOps');

const POLICY_DIR_NAME = 'codex-task-policy';
const OPS_SCRIPT_NAME = 'vk-task-ops.js';
const LAUNCHER_NAME = 'vk-task-ops';
const GIT_CONFIG_NAME = 'gitconfig';
const GH_CONFIG_DIR_NAME = 'gh';
const GH_CONFIG_FILE_NAME = 'config.yml';
const GH_HOSTS_FILE_NAME = 'hosts.yml';
const GH_HOST = 'github.com';
const RULES_FILE_NAME = 'vk-terminals-task.rules';
const OPS_SOURCE_PATH = path.join(__dirname, 'codexTaskOps.js');
const LAUNCH_HOME_NAME_PATTERN = /^[0-9a-f]{24}$/;
const ENV_COMMAND_PATH = '/usr/bin/env';
const MAX_IDENTITY_LENGTH = 200;
const MAX_GH_HOSTS_BYTES = 64 * 1024;
const GH_USER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const GH_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,255}$/;
// 実行ファイル（node / git / gh）を探す固定の場所。環境変数 PATH は使わない。
const TRUSTED_TOOL_DIRS = Object.freeze(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin']);

// 承認なしで実行できる操作の一覧。実際の判定は utils/codexTaskOps.js（許可リスト）が行い、
// ここは AGENTS.md への案内文を作るための表示用。追加・削除は codexTaskOps.js の parseTaskCommand と必ずそろえる。
const ORCHESTRATED_TASK_OPERATIONS = Object.freeze([
  'git status',
  'git diff',
  'git log',
  'git show',
  'git add',
  'git commit',
  'gh issue view',
  'gh issue comment',
  'gh pr view',
  'gh pr create',
  'gh pr comment',
  'gh pr checks',
]);

/**
 * rules ファイルの本文を組み立てる。許可するのは信頼済みランチャーの実行だけ。
 * @param {string} launcherPath 専用 CODEX_HOME 内のランチャーの絶対パス
 * @returns {string}
 */
function renderRules(launcherPath) {
  return [
    '# VK Terminals が生成。起動のたびに作り直される。',
    `prefix_rule(pattern=${JSON.stringify([launcherPath])}, decision="allow")`,
    '',
  ].join('\n');
}

/**
 * AGENTS.md の本文を組み立てる（Codex が使う入口の案内）。
 * @param {string} launcherPath 専用 CODEX_HOME 内のランチャーの絶対パス
 * @returns {string}
 */
function renderAgentsGuide(launcherPath) {
  return [
    '# VK Terminals 自動処理用の操作入口',
    '',
    'Git / GitHub の次の操作は、承認なしで動く固定の入口 1 つだけを通して実行する。',
    `入口: \`'${launcherPath}' <git|gh> <操作> ...\``,
    '',
    ...ORCHESTRATED_TASK_OPERATIONS.map((operation) => `- \`${operation}\``),
    '',
    '- 入口は許可した操作・オプションだけを通す。許可外（push・reset・gh api・--repo・--body-file・--output など）は拒否される。',
    '- 入口はこのタスクのリポジトリ（起動時に確定したフォルダと GitHub のリポジトリ）と、その worktree（`git worktree add` で作った作業フォルダ）にだけ働く。別のリポジトリ・入れ子のリポジトリでは拒否される。gh には対象リポジトリが自動で付く。',
    '- `git commit` は作業ブランチ上でだけ通る。main / master・リモートの既定ブランチ・detached HEAD 上では拒否されるので、先に作業ブランチを作ってから commit する。',
    '- `gh pr view` / `gh pr checks` は PR 番号が必須。`gh pr create` は `--head <ブランチ名> --title <題> --body <本文>` が必須。push は行われない。',
    '- Git のフックは入口経由では実行されない。外部コマンドを起動する設定（clean filter・署名プログラムなど）があるリポジトリでは入口は拒否する。',
    '- 入口を通さない git / gh は sandbox の制限内（ネットワーク無し）で動く。',
    '',
  ].join('\n');
}

/**
 * config.toml の本文を組み立てる。
 * 外部コマンドの起動前読み込みにつながる環境変数は、Codex が起動するコマンドへ渡さない。
 * 拘束するリポジトリ（と作業フォルダ）は trust_level = "untrusted" で記録する。Codex は信頼済みのプロジェクトだけ
 * プロジェクト側の .codex（config.toml・rules・hooks）を実効設定へ重ねるため、network_access や writable_roots などを
 * リポジトリ側から広げられない。記録が無いと起動時に「信頼して続行」が選べ、Enter 1 回で信頼済みになってしまう。
 * @param {string} handoffDir 会話整理の引き継ぎ先（唯一の追加書き込み先）
 * @param {string[]} untrustedProjectPaths 信頼しないプロジェクトとして記録する実パス
 * @returns {string}
 */
function renderConfigToml(handoffDir, untrustedProjectPaths) {
  return [
    '# VK Terminals が生成。起動のたびに作り直される。',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    '',
    '[shell_environment_policy]',
    'inherit = "all"',
    'exclude = ["LD_*", "DYLD_*", "NODE_*", "BASH_ENV", "ENV", "GIT_*", "GH_*", "GITHUB_*"]',
    '',
    '[sandbox_workspace_write]',
    'network_access = false',
    `writable_roots = [${JSON.stringify(handoffDir)}]`,
    ...untrustedProjectPaths.flatMap((projectPath) => ['', `[projects.${JSON.stringify(projectPath)}]`, 'trust_level = "untrusted"']),
    '',
  ].join('\n');
}

// 値を TOML / gitconfig の二重引用符つき文字列として書く（検証済みの制御文字なしの値だけが来る）。
function quoteConfigValue(value) {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Git の global 設定の代わりになる設定ファイルの本文を組み立てる（author 情報だけ。外部コマンドを起動する設定は持たない）。
 * @param {{name: string|null, email: string|null}} identity
 * @returns {string}
 */
function renderGitConfig(identity) {
  const lines = ['# VK Terminals が生成。起動のたびに作り直される。'];
  if (identity.name !== null || identity.email !== null) {
    lines.push('[user]');
    if (identity.name !== null) lines.push(`\tname = ${quoteConfigValue(identity.name)}`);
    if (identity.email !== null) lines.push(`\temail = ${quoteConfigValue(identity.email)}`);
  }
  lines.push('');
  return lines.join('\n');
}

/**
 * 信頼済みランチャー（sh スクリプト）の本文を組み立てる。
 * Node を起動する前に `env -i` で環境を空にし、検証済みの絶対パスの Node と、拘束の設定だけを渡す。
 * @param {{envPath: string, nodePath: string, opsScriptPath: string, binding: object}} params
 * @returns {string}
 */
function renderLauncher({ envPath, nodePath, opsScriptPath, binding }) {
  const assignments = [
    'PATH=/usr/bin:/bin',
    `VK_TASK_ROOT=${binding.root}`,
    `VK_TASK_REPO=${binding.repo || ''}`,
    `VK_TASK_GIT=${binding.git}`,
    `VK_TASK_GH=${binding.gh || ''}`,
    `VK_TASK_HOME=${binding.home}`,
    `VK_TASK_GITCONFIG=${binding.gitConfig}`,
    `VK_TASK_GHCONFIG=${binding.ghConfig}`,
  ];
  return [
    '#!/bin/sh',
    '# VK Terminals が生成。起動のたびに作り直される。環境を空にして、検証済みの Node で固定の入口を実行する。',
    `exec '${envPath}' -i \\`,
    ...assignments.map((assignment) => `  '${assignment}' \\`),
    `  '${nodePath}' '${opsScriptPath}' "$@"`,
    '',
  ].join('\n');
}

/**
 * gh の専用設定（config.yml）の本文。通信設定（プロキシ・UNIX ソケット・ブラウザ・エディタなど）を持たない固定内容。
 * @returns {string}
 */
function renderGhConfig() {
  return [
    '# VK Terminals が生成。起動のたびに作り直される。',
    'version: "1"',
    'git_protocol: https',
    'prompt: disabled',
    'pager: cat',
    '',
  ].join('\n');
}

/**
 * 個人の gh の hosts.yml から、github.com の認証に必要な項目（ユーザー名・トークン）だけを取り出して
 * 専用の hosts.yml の本文を作り直す。それ以外の項目（通信設定など）と他のホストは引き継がない。
 * 読み取れる項目が無ければ null（認証を引き継がない）。
 * @param {string} source 個人の hosts.yml の本文
 * @returns {string|null}
 */
function renderGhHosts(source) {
  const unquote = (value) => value.trim().replace(/^(['"])(.*)\1$/, '$2');
  let inHost = false;
  let section = null;
  let accountName = null;
  let user = null;
  let hostToken = null;
  const accounts = new Map();
  for (const line of String(source).split(/\r?\n/)) {
    if (line.trim() === '' || line.trim().startsWith('#')) continue;
    const match = /^( *)([^\s:][^:]*):(?: (.*))?$/.exec(line);
    if (!match) continue;
    const [, indent, key, rawValue = ''] = match;
    const value = unquote(rawValue);
    if (indent.length === 0) {
      inHost = key === GH_HOST;
      section = null;
    } else if (inHost && indent.length === 4) {
      section = key;
      accountName = null;
      if (key === 'user' && GH_USER_PATTERN.test(value)) user = value;
      if (key === 'oauth_token' && GH_TOKEN_PATTERN.test(value)) hostToken = value;
    } else if (inHost && section === 'users' && indent.length === 8) {
      accountName = GH_USER_PATTERN.test(key) ? key : null;
      if (accountName !== null && !accounts.has(accountName)) accounts.set(accountName, null);
    } else if (inHost && section === 'users' && indent.length === 12 && accountName !== null) {
      if (key === 'oauth_token' && GH_TOKEN_PATTERN.test(value)) accounts.set(accountName, value);
    }
  }
  if (user === null && hostToken === null && accounts.size === 0) return null;
  const lines = [`${GH_HOST}:`, '    git_protocol: https'];
  if (accounts.size > 0) {
    lines.push('    users:');
    for (const [name, token] of accounts) {
      lines.push(`        ${name}:`);
      if (token !== null) lines.push(`            oauth_token: ${token}`);
    }
  }
  if (user !== null) lines.push(`    user: ${user}`);
  if (hostToken !== null) lines.push(`    oauth_token: ${hostToken}`);
  lines.push('');
  return lines.join('\n');
}

// preset 名 → 生成物。キーが API で選べる preset の正（claudeModel.js の許可リストと一致させる。
// 一致はテストで検証している）。
const CODEX_TASK_POLICY_PRESETS = Object.freeze({
  'orchestrated-task': Object.freeze({
    renderConfigToml,
    renderRules,
    renderAgentsGuide,
    renderGitConfig,
    renderLauncher,
  }),
});

class PolicyError extends Error {}

function hasControlCharacter(value) {
  return /[\x00-\x1f\x7f]/.test(value);
}

function isSafeAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !hasControlCharacter(value) && !value.includes("'");
}

function currentUid(deps) {
  if (deps.uid !== undefined) return deps.uid;
  return typeof process.getuid === 'function' ? process.getuid() : undefined;
}

function openFlags(fsImpl, extra) {
  const constants = fsImpl.constants || nodeFs.constants;
  return extra.reduce((flags, name) => flags | (constants[name] || 0), 0);
}

/**
 * ディレクトリが「実体・自分の所有」であることを検証する。enforceOwnerOnly なら 0700 も強制し、できなければ拒否する。
 * 権限の変更は開いたディレクトリ自体（fd）に対して行い、検証後にリンクへ差し替えられても別の場所を触らない。
 */
function verifyDirectory(fsImpl, dirPath, { uid, enforceOwnerOnly }) {
  const stat = fsImpl.lstatSync(dirPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new PolicyError('policy directory is not a plain directory');
  if (uid !== undefined && stat.uid !== uid) throw new PolicyError('policy directory is not owned by the current user');
  if (!enforceOwnerOnly) return;
  const fd = fsImpl.openSync(dirPath, openFlags(fsImpl, ['O_RDONLY', 'O_DIRECTORY', 'O_NOFOLLOW']));
  try {
    const opened = fsImpl.fstatSync(fd);
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isDirectory()) {
      throw new PolicyError('policy directory changed while it was being checked');
    }
    if ((opened.mode & 0o777) !== 0o700) fsImpl.fchmodSync(fd, 0o700);
    if ((fsImpl.fstatSync(fd).mode & 0o777) !== 0o700) throw new PolicyError('policy directory permissions could not be restricted');
  } finally {
    fsImpl.closeSync(fd);
  }
}

// 既にあればそのまま（検証は呼び出し側）、無ければ非再帰で 0700 の実体を作る。
function ensureDirectory(fsImpl, dirPath) {
  try {
    fsImpl.mkdirSync(dirPath, { mode: 0o700 });
  } catch (error) {
    if (!error || error.code !== 'EEXIST') throw error;
  }
}

/**
 * 信頼境界のフォルダを用意し、リンクを解決した実パスと検証結果を返す。
 * 元の絶対パスを根から 1 階層ずつ検証し（リンクは向き先まで）、create なら無い階層を 1 段ずつ作る。
 * @returns {{realPath: string, chain: Array<{path: string, dev: number, ino: number, link?: string}>}}
 */
function prepareTrustedDirectory(fsImpl, dirPath, uid, { create }) {
  const { realPath, chain } = resolveTrustedPath(fsImpl, dirPath, { uid, finalKind: 'directory', createMissing: create, rejectFinalLink: true });
  if (!isSafeAbsolutePath(realPath)) throw new PolicyError('unsafe directory path');
  return { realPath, chain };
}

/**
 * 新規ファイルを所定の権限・排他的作成・リンク非追跡で作って書く。既にある（リンクを含む）なら失敗する。
 */
function writeNewFile(fsImpl, filePath, content, mode = 0o600) {
  const fd = fsImpl.openSync(filePath, openFlags(fsImpl, ['O_WRONLY', 'O_CREAT', 'O_EXCL', 'O_NOFOLLOW']), mode);
  try {
    fsImpl.fchmodSync(fd, mode);
    fsImpl.writeFileSync(fd, content);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// 通常ファイル・所定の権限・自分の所有・リンクでない・中身が期待どおり、であることを検証する。
function verifyFile(fsImpl, filePath, expectedContent, uid, mode = 0o600) {
  const stat = fsImpl.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new PolicyError('policy file is not a plain file');
  if ((stat.mode & 0o777) !== mode) throw new PolicyError(`policy file permissions are not ${mode.toString(8).padStart(4, '0')}`);
  if (uid !== undefined && stat.uid !== uid) throw new PolicyError('policy file is not owned by the current user');
  if (fsImpl.readFileSync(filePath, 'utf8') !== expectedContent) throw new PolicyError('policy files could not be verified');
}

/**
 * 個人の認証ファイルを解決する。無ければ null（共有しない）。
 * 元のパスを根から 1 階層ずつ（リンクは向き先まで）検証し、実体は通常ファイル・自分の所有であることを求める。
 * @param {object} fsImpl fs 互換
 * @param {string} sourcePath 認証ファイルの絶対パス
 * @param {number|undefined} uid
 * @param {string} label エラーメッセージに使う名前
 * @returns {{target: string, chain: Array<object>}|null}
 */
function resolveAuthFile(fsImpl, sourcePath, uid, label) {
  try {
    fsImpl.lstatSync(sourcePath);
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    throw error;
  }
  let resolved;
  try {
    resolved = resolveTrustedPath(fsImpl, sourcePath, { uid, finalKind: 'file' });
  } catch (error) {
    if (error instanceof TrustError || (error && error.code === 'ENOENT')) {
      throw new PolicyError(`${label} could not be verified: ${error instanceof TrustError ? error.message : 'broken link'}`);
    }
    throw error;
  }
  if (uid !== undefined && fsImpl.statSync(resolved.realPath).uid !== uid) throw new PolicyError(`${label} is not owned by the current user`);
  if (hasControlCharacter(resolved.realPath)) throw new PolicyError(`${label} path is unsafe`);
  return { target: resolved.realPath, chain: resolved.chain };
}

/**
 * 個人の gh の hosts.yml から、専用の hosts.yml の本文を作る。元ファイルが無い・認証項目が無ければ null。
 * 元のパスの検証は resolveAuthFile と同じ。
 * @returns {{content: string, chain: Array<object>}|null}
 */
function resolveGhHostsSource(fsImpl, personalGhConfigDir, uid) {
  const source = resolveAuthFile(fsImpl, path.join(personalGhConfigDir, GH_HOSTS_FILE_NAME), uid, 'personal gh hosts.yml');
  if (source === null) return null;
  if (fsImpl.statSync(source.target).size > MAX_GH_HOSTS_BYTES) throw new PolicyError('personal gh hosts.yml is too large');
  const content = renderGhHosts(fsImpl.readFileSync(source.target, 'utf8'));
  return content === null ? null : { content, chain: source.chain };
}

// 専用フォルダの中身が、許可した生成物だけであることを検証する（余計なファイルがあれば拒否）。
function verifyPolicyHome(fsImpl, home, expected, uid) {
  const names = fsImpl.readdirSync(home).sort();
  const expectedNames = [...Object.keys(expected.files), 'rules', GH_CONFIG_DIR_NAME, ...(expected.authTarget ? ['auth.json'] : [])].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new PolicyError('policy home contains unexpected entries');
  verifyDirectory(fsImpl, path.join(home, 'rules'), { uid, enforceOwnerOnly: true });
  if (JSON.stringify(fsImpl.readdirSync(path.join(home, 'rules'))) !== JSON.stringify([RULES_FILE_NAME])) {
    throw new PolicyError('policy home contains unexpected entries');
  }
  verifyFile(fsImpl, path.join(home, 'rules', RULES_FILE_NAME), expected.rulesBody, uid);
  const ghDir = path.join(home, GH_CONFIG_DIR_NAME);
  verifyDirectory(fsImpl, ghDir, { uid, enforceOwnerOnly: true });
  if (JSON.stringify(fsImpl.readdirSync(ghDir).sort()) !== JSON.stringify(Object.keys(expected.ghFiles).sort())) {
    throw new PolicyError('policy home contains unexpected entries');
  }
  for (const [name, { content, mode }] of Object.entries(expected.ghFiles)) verifyFile(fsImpl, path.join(ghDir, name), content, uid, mode);
  for (const [name, { content, mode }] of Object.entries(expected.files)) verifyFile(fsImpl, path.join(home, name), content, uid, mode);
  if (expected.authTarget) {
    const authPath = path.join(home, 'auth.json');
    if (!fsImpl.lstatSync(authPath).isSymbolicLink() || fsImpl.readlinkSync(authPath) !== expected.authTarget) {
      throw new PolicyError('policy auth link could not be verified');
    }
  }
}

/**
 * 自分が作った起動ごとの専用フォルダを片付ける。作ったときの識別子（dev/ino）と一致する実体のフォルダだけを消す。
 * @returns {boolean} 消したかどうか
 */
function removeCreatedLaunchHome(fsImpl, home, identity, uid) {
  try {
    const stat = fsImpl.lstatSync(home);
    if (stat.isSymbolicLink() || !stat.isDirectory() || stat.dev !== identity.dev || stat.ino !== identity.ino) return false;
    if (uid !== undefined && stat.uid !== uid) return false;
    fsImpl.rmSync(home, { recursive: true, force: true });
    return true;
  } catch (_error) {
    return false;
  }
}

/**
 * 実行ファイルの探索先を決める。固定の場所を先に、次にアプリ自身の PATH の絶対パス（Volta など利用者がインストールした場所）。
 * ここで挙げるのは候補だけで、採用するかは resolveTrustedExecutableDetailed が所有者・権限で検証する。
 * Codex 実行時の PATH は使わない（決めた絶対パスをランチャーへ固定する）。
 */
function listToolSearchDirs(homeDir, pathEnv) {
  const fromPath = String(pathEnv || '').split(path.delimiter).filter((entry) => path.isAbsolute(entry));
  return [...new Set([...TRUSTED_TOOL_DIRS, path.join(homeDir, '.volta', 'bin'), ...fromPath])];
}

// Git の author 情報を、信頼済みの git で個人の global 設定から読む（読み取りのみ。実行を伴う設定は引き継がない）。
function readGitIdentity(spawnSync, gitPath, homeDir) {
  const env = { PATH: `${path.dirname(gitPath)}:/usr/bin:/bin`, HOME: homeDir, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '', LC_ALL: 'C' };
  const read = (key) => {
    const result = spawnSync(gitPath, ['config', '--global', '--get', key], { env, encoding: 'utf8' });
    const value = result.status === 0 ? String(result.stdout).replace(/\n$/, '') : '';
    return value !== '' && value.length <= MAX_IDENTITY_LENGTH && !hasControlCharacter(value) ? value : null;
  };
  return { name: read('user.name'), email: read('user.email') };
}

/**
 * タスク用ポリシーの専用 CODEX_HOME を起動ごとに新規生成・検証して返す。
 * 失敗時は ok: false と理由を返す。この場合、呼び出し側は Codex を起動してはならない（途中まで作ったフォルダは片付け済み）。
 * 成功して Codex の起動に使わなかった場合は、返された discard() で専用フォルダを回収する。
 * dryRun: true なら実行ファイル・リポジトリ・親フォルダの検証までで止め、専用 CODEX_HOME は作らない（事前確認用）。
 * @param {object} params
 * @param {string} params.preset 許可リストにある preset 名
 * @param {string} params.dataDir VK Terminals のデータディレクトリ（~/.vk-terminals）
 * @param {string} params.handoffDir 会話整理の引き継ぎ先
 * @param {string} params.personalCodexHome 利用者個人の CODEX_HOME（認証情報の共有元。設定は読まない）
 * @param {string} params.cwd タスクの作業フォルダ（拘束するリポジトリを決める）
 * @param {string} params.homeDir 利用者のホーム（実行環境の HOME に固定する。gh の認証情報の共有元もここから決める）
 * @param {boolean} [params.dryRun] 専用 CODEX_HOME を作らず事前確認だけ行う
 * @param {object} [params.fs] テスト用の fs 差し替え
 * @param {number} [params.uid] テスト用の所有者 ID 差し替え
 * @param {Function} [params.spawnSync] テスト用のプロセス実行差し替え
 * @param {string[]} [params.toolDirs] テスト用の実行ファイル探索先の差し替え
 * @param {string} [params.pathEnv] テスト用のアプリ自身の PATH の差し替え
 * @param {() => string} [params.randomId] テスト用の起動ごとの名前の差し替え
 * @returns {{ok: true, home: string|null, discard: () => boolean} | {ok: false, error: string}}
 */
function prepareCodexTaskPolicyHome(params) {
  const { preset, dataDir, handoffDir, personalCodexHome, cwd, homeDir, dryRun = false, fs: fsImpl = nodeFs } = params;
  const spawnSync = params.spawnSync || childProcess.spawnSync;
  if (typeof preset !== 'string' || !Object.prototype.hasOwnProperty.call(CODEX_TASK_POLICY_PRESETS, preset)) {
    return { ok: false, error: 'codex task policy unavailable: unknown preset' };
  }
  if (typeof cwd !== 'string' || cwd === '') {
    return { ok: false, error: 'codex task policy unavailable: working directory required' };
  }
  if (![dataDir, handoffDir, personalCodexHome, cwd, homeDir].every(isSafeAbsolutePath)) {
    return { ok: false, error: 'codex task policy unavailable: unsafe directory path' };
  }
  const template = CODEX_TASK_POLICY_PRESETS[preset];
  const uid = currentUid(params);
  let created = null;
  try {
    // 引き継ぎ先は書き込み許可の対象になるため、祖先を含めてリンクや他人の書き込みに差し替えられないことを確認する。
    const handoff = prepareTrustedDirectory(fsImpl, handoffDir, uid, { create: true });
    const data = prepareTrustedDirectory(fsImpl, dataDir, uid, { create: true });
    const home = prepareTrustedDirectory(fsImpl, homeDir, uid, { create: false });

    // 実行ファイルは固定の場所から、所有者・権限を検証したものだけを使う。
    const toolDirs = params.toolDirs || listToolSearchDirs(home.realPath, params.pathEnv === undefined ? process.env.PATH : params.pathEnv);
    const nodeTool = resolveTrustedExecutableDetailed(fsImpl, 'node', toolDirs, { uid });
    const gitTool = resolveTrustedExecutableDetailed(fsImpl, 'git', toolDirs, { uid });
    const ghTool = resolveTrustedExecutableDetailed(fsImpl, 'gh', toolDirs, { uid });
    const envTool = resolveTrustedExecutableDetailed(fsImpl, path.basename(ENV_COMMAND_PATH), [path.dirname(ENV_COMMAND_PATH)], { uid });
    if (nodeTool === null || gitTool === null || envTool === null) throw new PolicyError('trusted node/git/env executable not found');
    const tools = [nodeTool, gitTool, envTool, ...(ghTool ? [ghTool] : [])];
    if (!tools.every((tool) => isSafeAbsolutePath(tool.path))) throw new PolicyError('unsafe executable path');
    const nodePath = nodeTool.path;
    const gitPath = gitTool.path;
    const envPath = envTool.path;
    const ghPath = ghTool ? ghTool.path : null;
    const toolChains = tools.flatMap((tool) => tool.chain);

    // 作業フォルダの Git リポジトリ（実ルート・GitHub の owner/repo）をここで確定し、以後は変更できない設定として保持する。
    const trustedEnv = buildChildEnvironment({ git: gitPath, gh: ghPath, home: home.realPath, gitConfig: '/dev/null', ghConfig: null });
    const runGit = (args, runCwd) => spawnSync(gitPath, [...FIXED_GIT_PREFIX, ...args], { cwd: runCwd, env: trustedEnv, encoding: 'utf8' });
    const repository = inspectRepository({ cwd, run: runGit, homeDir: home.realPath, fsImpl });
    if (!repository.ok) throw new PolicyError(repository.error.replace(/^task command rejected: /, ''));
    if (!isSafeAbsolutePath(repository.root)) throw new PolicyError('unsafe repository path');
    // 信頼しないプロジェクトとして記録する場所。Codex が信頼を引く単位（Git ルート・作業フォルダ）の両方を実パスで固定する。
    const untrustedProjectPaths = [...new Set([repository.root, fsImpl.realpathSync(cwd)])];
    if (!untrustedProjectPaths.every(isSafeAbsolutePath)) throw new PolicyError('unsafe repository path');

    // 親フォルダは 1 段ずつ作り、実体・所有者・0700 を毎回確認する（リンク経由で別の場所へ書かせない）。
    const baseDir = path.join(data.realPath, POLICY_DIR_NAME);
    const presetDir = path.join(baseDir, preset);
    for (const dir of [baseDir, presetDir]) {
      ensureDirectory(fsImpl, dir);
      verifyDirectory(fsImpl, dir, { uid, enforceOwnerOnly: true });
    }
    if (dryRun) {
      assertChainUnchanged(fsImpl, [...handoff.chain, ...data.chain, ...home.chain, ...toolChains]);
      return { ok: true, home: null, discard: () => false };
    }

    const identity = readGitIdentity(spawnSync, gitPath, home.realPath);
    const auth = resolveAuthFile(fsImpl, path.join(personalCodexHome, 'auth.json'), uid, 'personal auth.json');
    const ghHosts = ghPath === null ? null : resolveGhHostsSource(fsImpl, path.join(homeDir, '.config', 'gh'), uid);

    // 起動ごとに新規のフォルダを作る。既にある名前（リンクや事前配置を含む）は使わず失敗させる。
    const launchName = (params.randomId || (() => crypto.randomBytes(12).toString('hex')))();
    if (!LAUNCH_HOME_NAME_PATTERN.test(launchName)) throw new PolicyError('invalid launch directory name');
    const launchHome = path.join(presetDir, launchName);
    fsImpl.mkdirSync(launchHome, { mode: 0o700 });
    const createdStat = fsImpl.lstatSync(launchHome);
    created = { home: launchHome, dev: createdStat.dev, ino: createdStat.ino };
    verifyDirectory(fsImpl, launchHome, { uid, enforceOwnerOnly: true });
    fsImpl.mkdirSync(path.join(launchHome, 'rules'), { mode: 0o700 });
    verifyDirectory(fsImpl, path.join(launchHome, 'rules'), { uid, enforceOwnerOnly: true });
    const ghConfigDir = path.join(launchHome, GH_CONFIG_DIR_NAME);
    fsImpl.mkdirSync(ghConfigDir, { mode: 0o700 });
    verifyDirectory(fsImpl, ghConfigDir, { uid, enforceOwnerOnly: true });

    const opsScriptPath = path.join(launchHome, OPS_SCRIPT_NAME);
    const launcherPath = path.join(launchHome, LAUNCHER_NAME);
    const gitConfigPath = path.join(launchHome, GIT_CONFIG_NAME);
    const binding = { root: repository.root, repo: repository.repo, git: gitPath, gh: ghPath, home: home.realPath, gitConfig: gitConfigPath, ghConfig: ghConfigDir };
    const expected = {
      files: {
        'config.toml': { content: template.renderConfigToml(handoff.realPath, untrustedProjectPaths), mode: 0o600 },
        'AGENTS.md': { content: template.renderAgentsGuide(launcherPath), mode: 0o600 },
        [GIT_CONFIG_NAME]: { content: template.renderGitConfig(identity), mode: 0o600 },
        [OPS_SCRIPT_NAME]: { content: fsImpl.readFileSync(OPS_SOURCE_PATH, 'utf8'), mode: 0o400 },
        [LAUNCHER_NAME]: { content: template.renderLauncher({ envPath, nodePath, opsScriptPath, binding }), mode: 0o500 },
      },
      ghFiles: {
        [GH_CONFIG_FILE_NAME]: { content: renderGhConfig(), mode: 0o600 },
        ...(ghHosts ? { [GH_HOSTS_FILE_NAME]: { content: ghHosts.content, mode: 0o600 } } : {}),
      },
      rulesBody: template.renderRules(launcherPath),
      authTarget: auth ? auth.target : null,
    };
    for (const [name, { content, mode }] of Object.entries(expected.files)) writeNewFile(fsImpl, path.join(launchHome, name), content, mode);
    writeNewFile(fsImpl, path.join(launchHome, 'rules', RULES_FILE_NAME), expected.rulesBody);
    for (const [name, { content, mode }] of Object.entries(expected.ghFiles)) writeNewFile(fsImpl, path.join(ghConfigDir, name), content, mode);
    // ログイン状態だけは個人の auth.json の実体へのリンクで共有する（個人の設定ファイルは共有しない）。
    if (expected.authTarget) fsImpl.symlinkSync(expected.authTarget, path.join(launchHome, 'auth.json'));

    // 書き込み後に読み戻し、中身が許可した生成物だけであること、検証した信頼境界が差し替えられていないことを確認してから返す。
    verifyPolicyHome(fsImpl, launchHome, expected, uid);
    assertChainUnchanged(fsImpl, [...handoff.chain, ...data.chain, ...home.chain, ...toolChains, ...(auth ? auth.chain : []), ...(ghHosts ? ghHosts.chain : [])]);
    const discardTarget = created;
    return { ok: true, home: launchHome, discard: () => removeCreatedLaunchHome(fsImpl, discardTarget.home, discardTarget, uid) };
  } catch (error) {
    if (created !== null) removeCreatedLaunchHome(fsImpl, created.home, created, uid);
    const reason = error instanceof PolicyError || error instanceof TrustError ? error.message : (error && error.code ? error.code : 'filesystem error');
    return { ok: false, error: `codex task policy unavailable: ${reason}` };
  }
}

const NOT_CREATED = () => false;

/**
 * 起動オプションを検証し、タスク用ポリシーが含まれていれば専用 CODEX_HOME を用意して、
 * 起動コマンド組み立て用の内部オプションへ変換する。新規ペイン作成（IPC）と再起動（HTTP）の
 * 両方がこの関数を通るので、同じ入力からは同じ実効ポリシーになる。
 * 呼び出し元から来た codexPolicyHome など未知の項目は信用せず、検証済みの項目だけ引き継ぐ。
 * Codex 以外のエンジンにはポリシーを適用せず、Codex 用の項目を取り除く。
 * 返された discard() は、専用 CODEX_HOME を作ったのに Codex の起動に使わなかったとき（停止失敗・PTY 作成失敗など）に呼ぶ。
 * @param {string} engine 解決済みのエンジン名
 * @param {object} options approvalPolicy / sandboxMode / codexPolicy を含みうる起動オプション
 * @param {object} deps validateCodexLaunchOptions と、prepareCodexTaskPolicyHome へ渡す dataDir / handoffDir / personalCodexHome / cwd / homeDir / fs
 * @returns {{ok: true, options: object, discard: () => boolean} | {ok: false, error: string}}
 */
function resolveCodexTaskPolicyLaunchOptions(engine, options, deps) {
  if (engine !== 'codex') return { ok: true, options: {}, discard: NOT_CREATED };
  const { validateCodexLaunchOptions, ...prepareDeps } = deps;
  const validated = validateCodexLaunchOptions('codex', options || {});
  if (!validated.ok) return validated;
  const launchOptions = { approvalPolicy: validated.approvalPolicy, sandboxMode: validated.sandboxMode };
  if (validated.codexPolicy === undefined) return { ok: true, options: launchOptions, discard: NOT_CREATED };
  const prepared = prepareCodexTaskPolicyHome({ preset: validated.codexPolicy.preset, ...prepareDeps });
  if (!prepared.ok) return prepared;
  // dryRun（事前確認）では専用 CODEX_HOME が無い。起動には使えない値なので options へ載せない。
  const policyOptions = { ...launchOptions, codexPolicy: validated.codexPolicy };
  if (prepared.home !== null) policyOptions.codexPolicyHome = prepared.home;
  return { ok: true, options: policyOptions, discard: prepared.discard };
}

module.exports = {
  CODEX_TASK_POLICY_PRESETS,
  ORCHESTRATED_TASK_OPERATIONS,
  prepareCodexTaskPolicyHome,
  verifyPolicyHome,
  resolveCodexTaskPolicyLaunchOptions,
};
