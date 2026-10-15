// 自動処理用 Codex に適用する「タスク用ポリシー」の実体（専用の CODEX_HOME）を用意する（issue #428）。
//
// 設計の要点（崩さないこと）:
//   - 利用者個人の ~/.codex/config.toml・rules・hooks・AGENTS.md は一切読み書きしない。
//     タスク用ポリシーは固定内容の専用 CODEX_HOME（~/.vk-terminals/codex-task-policy/<preset>）に
//     生成し、その Codex 起動だけ CODEX_HOME をそこへ向ける。個人設定の「上書き」ではなく
//     「そもそも読み込まない」ため、個人設定側の広いネットワーク許可・追加の書き込み先・
//     profile が混ざる余地が無い。信頼済みプロジェクトの記録も引き継がないので、作業フォルダ内の
//     .codex/ 設定も既定では読まれない。
//   - 生成する内容は preset ごとの固定テンプレートだけ。API の入力値は preset 名の選択以外、
//     ファイルの内容にも起動コマンドにも一切入らない。
//   - 固定の Git / GitHub 操作入口は Codex の rules（prefix_rule の allow）で与える。
//     ネットワークと追加の書き込み先は閉じたまま、列挙したコマンドだけが承認なしで動く。
//   - 生成・検証のどこかで失敗したら ok: false を返す。呼び出し側は Codex を起動せず、理由を返す。
//
// fs / パスは引数で注入できるので、テストでは一時ディレクトリだけで検証できる。
const nodeFs = require('fs');
const path = require('path');

const POLICY_DIR_NAME = 'codex-task-policy';

// 承認なしで実行してよい固定の入口。argv の先頭一致（prefix_rule）で判定されるため、
// `git -c … commit` のように先頭がずれる呼び出しは一致しない。
// git push・git reset・gh api・gh pr merge など範囲の広い操作は意図して含めない。
const ORCHESTRATED_TASK_ALLOWED_COMMANDS = Object.freeze([
  ['git', 'status'],
  ['git', 'diff'],
  ['git', 'log'],
  ['git', 'show'],
  ['git', 'add'],
  ['git', 'commit'],
  ['gh', 'issue', 'view'],
  ['gh', 'issue', 'comment'],
  ['gh', 'pr', 'view'],
  ['gh', 'pr', 'create'],
  ['gh', 'pr', 'comment'],
  ['gh', 'pr', 'checks'],
]);

/**
 * rules ファイルの本文を組み立てる。
 * @param {ReadonlyArray<ReadonlyArray<string>>} commands 許可する argv の先頭一致リスト
 * @returns {string}
 */
function renderRules(commands) {
  const lines = ['# VK Terminals が生成。手で編集しても起動のたびに上書きされる。'];
  for (const argv of commands) {
    lines.push(`prefix_rule(pattern=${JSON.stringify(argv)}, decision="allow")`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * config.toml の本文を組み立てる。
 * @param {string} handoffDir 会話整理の引き継ぎ先（唯一の追加書き込み先）
 * @returns {string}
 */
function renderConfigToml(handoffDir) {
  return [
    '# VK Terminals が生成。手で編集しても起動のたびに上書きされる。',
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
    rulesBody: renderRules(ORCHESTRATED_TASK_ALLOWED_COMMANDS),
  }),
});

function hasControlCharacter(value) {
  return /[\x00-\x1f\x7f]/.test(value);
}

function isSafeAbsolutePath(value) {
  return typeof value === 'string' && path.isAbsolute(value) && !hasControlCharacter(value) && !value.includes("'");
}

// 同じ内容なら書き換えず、違えば一時ファイル経由で置き換える（途中状態を読まれない）。
function writeFileIfDifferent(fsImpl, filePath, content) {
  try {
    if (fsImpl.readFileSync(filePath, 'utf8') === content) return;
  } catch (_error) {
    // 無ければ新規に書く
  }
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tempPath, content, { mode: 0o600 });
  fsImpl.renameSync(tempPath, filePath);
}

// 個人の認証情報だけをシンボリックリンクで共有する（ログイン状態を引き継ぐため）。個人の設定ファイルは共有しない。
function linkAuthFile(fsImpl, personalCodexHome, home) {
  const personalAuth = path.join(personalCodexHome, 'auth.json');
  const linkPath = path.join(home, 'auth.json');
  if (!fsImpl.existsSync(personalAuth)) return;
  try {
    if (fsImpl.readlinkSync(linkPath) === personalAuth) return;
  } catch (_error) {
    // リンクでない・無い場合は作り直す
  }
  fsImpl.rmSync(linkPath, { force: true });
  fsImpl.symlinkSync(personalAuth, linkPath);
}

/**
 * タスク用ポリシーの CODEX_HOME を生成・検証して返す。
 * 失敗時は ok: false と理由を返す。この場合、呼び出し側は Codex を起動してはならない。
 * @param {object} params
 * @param {string} params.preset 許可リストにある preset 名
 * @param {string} params.dataDir VK Terminals のデータディレクトリ（~/.vk-terminals）
 * @param {string} params.handoffDir 会話整理の引き継ぎ先
 * @param {string} params.personalCodexHome 利用者個人の CODEX_HOME（認証情報の共有元。設定は読まない）
 * @param {object} [params.fs] テスト用の fs 差し替え
 * @returns {{ok: true, home: string} | {ok: false, error: string}}
 */
function prepareCodexTaskPolicyHome({ preset, dataDir, handoffDir, personalCodexHome, fs: fsImpl = nodeFs }) {
  if (typeof preset !== 'string' || !Object.prototype.hasOwnProperty.call(CODEX_TASK_POLICY_PRESETS, preset)) {
    return { ok: false, error: 'codex task policy unavailable: unknown preset' };
  }
  if (!isSafeAbsolutePath(dataDir) || !isSafeAbsolutePath(handoffDir) || !isSafeAbsolutePath(personalCodexHome)) {
    return { ok: false, error: 'codex task policy unavailable: unsafe directory path' };
  }
  const template = CODEX_TASK_POLICY_PRESETS[preset];
  const home = path.join(dataDir, POLICY_DIR_NAME, preset);
  const rulesDir = path.join(home, 'rules');
  const configPath = path.join(home, 'config.toml');
  const rulesPath = path.join(rulesDir, 'vk-terminals-task.rules');
  const configToml = template.renderConfigToml(handoffDir);
  try {
    fsImpl.mkdirSync(rulesDir, { recursive: true, mode: 0o700 });
    fsImpl.mkdirSync(handoffDir, { recursive: true });
    // 生成先がシンボリックリンクだと、別の場所へ書き込まれたり別の設定を読ませたりできてしまう。
    for (const dir of [home, rulesDir]) {
      if (fsImpl.lstatSync(dir).isSymbolicLink() || !fsImpl.lstatSync(dir).isDirectory()) {
        return { ok: false, error: 'codex task policy unavailable: policy directory is not a plain directory' };
      }
    }
    // 生成先の固定ファイル以外（個人設定の複製や追加の rules）が混ざらないよう、rules は 1 ファイルだけにする。
    for (const entry of fsImpl.readdirSync(rulesDir)) {
      if (entry !== path.basename(rulesPath)) fsImpl.rmSync(path.join(rulesDir, entry), { recursive: true, force: true });
    }
    writeFileIfDifferent(fsImpl, configPath, configToml);
    writeFileIfDifferent(fsImpl, rulesPath, template.rulesBody);
    linkAuthFile(fsImpl, personalCodexHome, home);
    // 書き込み後に読み戻し、実際に固定内容になっていることを確認してから返す。
    if (fsImpl.readFileSync(configPath, 'utf8') !== configToml
      || fsImpl.readFileSync(rulesPath, 'utf8') !== template.rulesBody) {
      return { ok: false, error: 'codex task policy unavailable: policy files could not be verified' };
    }
  } catch (error) {
    return { ok: false, error: `codex task policy unavailable: ${error && error.code ? error.code : 'filesystem error'}` };
  }
  return { ok: true, home };
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
  return {
    ok: true,
    options: { ...launchOptions, codexPolicy: validated.codexPolicy, codexPolicyHome: prepared.home },
  };
}

module.exports = {
  CODEX_TASK_POLICY_PRESETS,
  ORCHESTRATED_TASK_ALLOWED_COMMANDS,
  prepareCodexTaskPolicyHome,
  resolveCodexTaskPolicyLaunchOptions,
};
