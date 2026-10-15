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
//   - 生成するのは preset ごとの固定テンプレートだけ。API の入力値は preset 名の選択以外、
//     ファイルの内容にも起動コマンドにも一切入らない。
//   - 承認なしで動かせる Git / GitHub 操作は、検証付きの固定入口（utils/codexTaskOps.js の複製）だけ。
//     rules の prefix_rule は後続の引数を制限できないので、rules には入口の実行だけを許可し、
//     引数・パス・リポジトリの検証は入口側で行う。
//   - ディレクトリは実体（非シンボリックリンク）・自分の所有・0700、ファイルは通常ファイル・0600 を毎回検証する。
//     ファイルは排他的作成（既存なら失敗）・リンク非追跡で作る。
//   - 生成・検証のどこかで失敗したら ok: false を返す。呼び出し側は Codex を起動せず、理由を返す。
//
// fs / パス / 所有者 / ランダム名は引数で注入できるので、テストでは一時ディレクトリだけで検証できる。
const nodeFs = require('fs');
const crypto = require('crypto');
const path = require('path');

const POLICY_DIR_NAME = 'codex-task-policy';
const OPS_SCRIPT_NAME = 'vk-task-ops.js';
const RULES_FILE_NAME = 'vk-terminals-task.rules';
const OPS_SOURCE_PATH = path.join(__dirname, 'codexTaskOps.js');
const LAUNCH_HOME_NAME_PATTERN = /^[0-9a-f]{24}$/;
// 使われなくなった起動ごとの専用フォルダを掃除する目安（長く動いているセッションを巻き込まない長さにする）。
const STALE_LAUNCH_HOME_MS = 30 * 24 * 60 * 60 * 1000;

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
 * rules ファイルの本文を組み立てる。許可するのは検証付きの固定入口の実行だけ。
 * @param {string} opsScriptPath 専用 CODEX_HOME 内の固定入口の絶対パス
 * @returns {string}
 */
function renderRules(opsScriptPath) {
  return [
    '# VK Terminals が生成。起動のたびに作り直される。',
    `prefix_rule(pattern=${JSON.stringify(['node', opsScriptPath])}, decision="allow")`,
    '',
  ].join('\n');
}

/**
 * AGENTS.md の本文を組み立てる（Codex が使う入口の案内）。
 * @param {string} opsScriptPath 専用 CODEX_HOME 内の固定入口の絶対パス
 * @returns {string}
 */
function renderAgentsGuide(opsScriptPath) {
  return [
    '# VK Terminals 自動処理用の操作入口',
    '',
    'Git / GitHub の次の操作は、承認なしで動く固定の入口 1 つだけを通して実行する。',
    `入口: \`node '${opsScriptPath}' <git|gh> <操作> ...\``,
    '',
    ...ORCHESTRATED_TASK_OPERATIONS.map((operation) => `- \`${operation}\``),
    '',
    '- 入口は許可した操作・オプションだけを通す。許可外（push・reset・gh api・--repo・--body-file・--output など）は拒否される。',
    '- `gh pr create` は `--head <ブランチ名> --title <題> --body <本文>` が必須。push は行われない。',
    '- 入口を通さない git / gh は sandbox の制限内（ネットワーク無し）で動く。',
    '',
  ].join('\n');
}

/**
 * config.toml の本文を組み立てる。
 * @param {string} handoffDir 会話整理の引き継ぎ先（唯一の追加書き込み先）
 * @returns {string}
 */
function renderConfigToml(handoffDir) {
  return [
    '# VK Terminals が生成。起動のたびに作り直される。',
    'approval_policy = "on-request"',
    'sandbox_mode = "workspace-write"',
    'web_search = "disabled"',
    '',
    '[sandbox_workspace_write]',
    'network_access = false',
    `writable_roots = [${JSON.stringify(handoffDir)}]`,
    '',
  ].join('\n');
}

// preset 名 → 生成物。キーが API で選べる preset の正（claudeModel.js の許可リストと一致させる。
// 一致はテストで検証している）。
const CODEX_TASK_POLICY_PRESETS = Object.freeze({
  'orchestrated-task': Object.freeze({
    renderConfigToml,
    renderRules,
    renderAgentsGuide,
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
 * 新規ファイルを 0600・排他的作成・リンク非追跡で作って書く。既にある（リンクを含む）なら失敗する。
 */
function writeNewFile(fsImpl, filePath, content) {
  const fd = fsImpl.openSync(filePath, openFlags(fsImpl, ['O_WRONLY', 'O_CREAT', 'O_EXCL', 'O_NOFOLLOW']), 0o600);
  try {
    fsImpl.fchmodSync(fd, 0o600);
    fsImpl.writeFileSync(fd, content);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// 通常ファイル・0600・自分の所有・リンクでない・中身が期待どおり、であることを検証する。
function verifyFile(fsImpl, filePath, expectedContent, uid) {
  const stat = fsImpl.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) throw new PolicyError('policy file is not a plain file');
  if ((stat.mode & 0o777) !== 0o600) throw new PolicyError('policy file permissions are not 0600');
  if (uid !== undefined && stat.uid !== uid) throw new PolicyError('policy file is not owned by the current user');
  if (fsImpl.readFileSync(filePath, 'utf8') !== expectedContent) throw new PolicyError('policy files could not be verified');
}

/**
 * 個人の auth.json（ログイン状態の共有元）を解決する。無ければ null（共有しない）。
 * 通常ファイル・自分の所有でなければ拒否する。リンクの場合は最終的な実体のパスを返す。
 */
function resolveAuthSource(fsImpl, personalCodexHome, uid) {
  const sourcePath = path.join(personalCodexHome, 'auth.json');
  try {
    fsImpl.lstatSync(sourcePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
  let realPath;
  try {
    realPath = fsImpl.realpathSync(sourcePath);
  } catch (_error) {
    throw new PolicyError('personal auth.json is a broken link');
  }
  const stat = fsImpl.statSync(realPath);
  if (!stat.isFile()) throw new PolicyError('personal auth.json is not a regular file');
  if (uid !== undefined && stat.uid !== uid) throw new PolicyError('personal auth.json is not owned by the current user');
  if (hasControlCharacter(realPath)) throw new PolicyError('personal auth.json path is unsafe');
  return realPath;
}

// 専用フォルダの中身が、許可した生成物だけであることを検証する（余計なファイルがあれば拒否）。
function verifyPolicyHome(fsImpl, home, expected, uid) {
  const names = fsImpl.readdirSync(home).sort();
  const expectedNames = [...Object.keys(expected.files), 'rules', ...(expected.authTarget ? ['auth.json'] : [])].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new PolicyError('policy home contains unexpected entries');
  verifyDirectory(fsImpl, path.join(home, 'rules'), { uid, enforceOwnerOnly: true });
  if (JSON.stringify(fsImpl.readdirSync(path.join(home, 'rules'))) !== JSON.stringify([RULES_FILE_NAME])) {
    throw new PolicyError('policy home contains unexpected entries');
  }
  verifyFile(fsImpl, path.join(home, 'rules', RULES_FILE_NAME), expected.rulesBody, uid);
  for (const [name, content] of Object.entries(expected.files)) verifyFile(fsImpl, path.join(home, name), content, uid);
  if (expected.authTarget) {
    const authPath = path.join(home, 'auth.json');
    if (!fsImpl.lstatSync(authPath).isSymbolicLink() || fsImpl.readlinkSync(authPath) !== expected.authTarget) {
      throw new PolicyError('policy auth link could not be verified');
    }
  }
}

// 古い起動ごとの専用フォルダを掃除する。名前・種別・所有者・更新時刻が全て条件に合うものだけを消し、失敗しても無視する。
function pruneStaleLaunchHomes(fsImpl, presetDir, keepName, uid, nowMs) {
  let entries;
  try { entries = fsImpl.readdirSync(presetDir); } catch (_error) { return; }
  for (const entry of entries) {
    if (entry === keepName || !LAUNCH_HOME_NAME_PATTERN.test(entry)) continue;
    try {
      const entryPath = path.join(presetDir, entry);
      const stat = fsImpl.lstatSync(entryPath);
      if (stat.isSymbolicLink() || !stat.isDirectory() || (uid !== undefined && stat.uid !== uid)) continue;
      if (nowMs - stat.mtimeMs > STALE_LAUNCH_HOME_MS) fsImpl.rmSync(entryPath, { recursive: true, force: true });
    } catch (_error) {
      // 掃除は best-effort。起動の成否には影響させない。
    }
  }
}

/**
 * タスク用ポリシーの専用 CODEX_HOME を起動ごとに新規生成・検証して返す。
 * 失敗時は ok: false と理由を返す。この場合、呼び出し側は Codex を起動してはならない。
 * dryRun: true なら親フォルダの検証までで止め、専用 CODEX_HOME は作らない（HTTP 受け口の事前確認用）。
 * @param {object} params
 * @param {string} params.preset 許可リストにある preset 名
 * @param {string} params.dataDir VK Terminals のデータディレクトリ（~/.vk-terminals）
 * @param {string} params.handoffDir 会話整理の引き継ぎ先
 * @param {string} params.personalCodexHome 利用者個人の CODEX_HOME（認証情報の共有元。設定は読まない）
 * @param {boolean} [params.dryRun] 専用 CODEX_HOME を作らず事前確認だけ行う
 * @param {object} [params.fs] テスト用の fs 差し替え
 * @param {number} [params.uid] テスト用の所有者 ID 差し替え
 * @param {() => string} [params.randomId] テスト用の起動ごとの名前の差し替え
 * @param {() => number} [params.now] テスト用の現在時刻（ミリ秒）差し替え
 * @returns {{ok: true, home: string|null} | {ok: false, error: string}}
 */
function prepareCodexTaskPolicyHome(params) {
  const { preset, dataDir, handoffDir, personalCodexHome, dryRun = false, fs: fsImpl = nodeFs } = params;
  if (typeof preset !== 'string' || !Object.prototype.hasOwnProperty.call(CODEX_TASK_POLICY_PRESETS, preset)) {
    return { ok: false, error: 'codex task policy unavailable: unknown preset' };
  }
  if (!isSafeAbsolutePath(dataDir) || !isSafeAbsolutePath(handoffDir) || !isSafeAbsolutePath(personalCodexHome)) {
    return { ok: false, error: 'codex task policy unavailable: unsafe directory path' };
  }
  const template = CODEX_TASK_POLICY_PRESETS[preset];
  const uid = currentUid(params);
  try {
    // 引き継ぎ先は書き込み許可の対象になるため、リンクや他人の所有物に差し替えられていないことを確認する。
    fsImpl.mkdirSync(handoffDir, { recursive: true });
    verifyDirectory(fsImpl, handoffDir, { uid, enforceOwnerOnly: false });

    // 親フォルダは 1 段ずつ作り、実体・所有者・0700 を毎回確認する（リンク経由で別の場所へ書かせない）。
    fsImpl.mkdirSync(dataDir, { recursive: true });
    verifyDirectory(fsImpl, dataDir, { uid, enforceOwnerOnly: false });
    const baseDir = path.join(dataDir, POLICY_DIR_NAME);
    const presetDir = path.join(baseDir, preset);
    for (const dir of [baseDir, presetDir]) {
      ensureDirectory(fsImpl, dir);
      verifyDirectory(fsImpl, dir, { uid, enforceOwnerOnly: true });
    }
    if (dryRun) return { ok: true, home: null };

    // 起動ごとに新規のフォルダを作る。既にある名前（リンクや事前配置を含む）は使わず失敗させる。
    const launchName = (params.randomId || (() => crypto.randomBytes(12).toString('hex')))();
    if (!LAUNCH_HOME_NAME_PATTERN.test(launchName)) throw new PolicyError('invalid launch directory name');
    const home = path.join(presetDir, launchName);
    fsImpl.mkdirSync(home, { mode: 0o700 });
    verifyDirectory(fsImpl, home, { uid, enforceOwnerOnly: true });
    fsImpl.mkdirSync(path.join(home, 'rules'), { mode: 0o700 });
    verifyDirectory(fsImpl, path.join(home, 'rules'), { uid, enforceOwnerOnly: true });

    const opsScriptPath = path.join(home, OPS_SCRIPT_NAME);
    const expected = {
      files: {
        'config.toml': template.renderConfigToml(handoffDir),
        'AGENTS.md': template.renderAgentsGuide(opsScriptPath),
        [OPS_SCRIPT_NAME]: fsImpl.readFileSync(OPS_SOURCE_PATH, 'utf8'),
      },
      rulesBody: template.renderRules(opsScriptPath),
      authTarget: resolveAuthSource(fsImpl, personalCodexHome, uid),
    };
    for (const [name, content] of Object.entries(expected.files)) writeNewFile(fsImpl, path.join(home, name), content);
    writeNewFile(fsImpl, path.join(home, 'rules', RULES_FILE_NAME), expected.rulesBody);
    // ログイン状態だけは個人の auth.json の実体へのリンクで共有する（個人の設定ファイルは共有しない）。
    if (expected.authTarget) fsImpl.symlinkSync(expected.authTarget, path.join(home, 'auth.json'));

    // 書き込み後に読み戻し、中身が許可した生成物だけであることを確認してから返す。
    verifyPolicyHome(fsImpl, home, expected, uid);
    pruneStaleLaunchHomes(fsImpl, presetDir, launchName, uid, (params.now || Date.now)());
    return { ok: true, home };
  } catch (error) {
    const reason = error instanceof PolicyError ? error.message : (error && error.code ? error.code : 'filesystem error');
    return { ok: false, error: `codex task policy unavailable: ${reason}` };
  }
}

/**
 * 起動オプションを検証し、タスク用ポリシーが含まれていれば専用 CODEX_HOME を用意して、
 * 起動コマンド組み立て用の内部オプションへ変換する。新規ペイン作成（IPC）と再起動（HTTP）の
 * 両方がこの関数を通るので、同じ入力からは同じ実効ポリシーになる。
 * 呼び出し元から来た codexPolicyHome など未知の項目は信用せず、検証済みの項目だけ引き継ぐ。
 * Codex 以外のエンジンにはポリシーを適用せず、Codex 用の項目を取り除く。
 * @param {string} engine 解決済みのエンジン名
 * @param {object} options approvalPolicy / sandboxMode / codexPolicy を含みうる起動オプション
 * @param {object} deps validateCodexLaunchOptions と、prepareCodexTaskPolicyHome へ渡す dataDir / handoffDir / personalCodexHome / fs
 * @returns {{ok: true, options: object} | {ok: false, error: string}}
 */
function resolveCodexTaskPolicyLaunchOptions(engine, options, deps) {
  if (engine !== 'codex') return { ok: true, options: {} };
  const { validateCodexLaunchOptions, ...prepareDeps } = deps;
  const validated = validateCodexLaunchOptions('codex', options || {});
  if (!validated.ok) return validated;
  const launchOptions = { approvalPolicy: validated.approvalPolicy, sandboxMode: validated.sandboxMode };
  if (validated.codexPolicy === undefined) return { ok: true, options: launchOptions };
  const prepared = prepareCodexTaskPolicyHome({ preset: validated.codexPolicy.preset, ...prepareDeps });
  if (!prepared.ok) return prepared;
  // dryRun（事前確認）では専用 CODEX_HOME が無い。起動には使えない値なので options へ載せない。
  const policyOptions = { ...launchOptions, codexPolicy: validated.codexPolicy };
  if (prepared.home !== null) policyOptions.codexPolicyHome = prepared.home;
  return { ok: true, options: policyOptions };
}

module.exports = {
  CODEX_TASK_POLICY_PRESETS,
  ORCHESTRATED_TASK_OPERATIONS,
  prepareCodexTaskPolicyHome,
  verifyPolicyHome,
  resolveCodexTaskPolicyLaunchOptions,
};
