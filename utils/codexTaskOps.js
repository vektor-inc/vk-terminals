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
//   - protected-sync は固定対応表のバイトコピーだけを、配布先の親だけ書ける OS 制限内で実行する。
//   - rules の prefix_rule は後続の引数を制限できない。そのため rules には「この入口の実行」だけを許可し、
//     引数の検証はこのファイルで行う。許可する操作・フラグ・位置引数はすべて下の許可リストにあるものだけで、
//     未知のフラグ・パス・リポジトリ指定（--repo など）・ファイル出力系（--output など）は拒否する。PR のタイトル・本文だけは入出力フォルダ直下のファイル名で受ける（下記）。
//   - git / gh へ渡す argv は検証済みの値だけで組み立て直す（呼び出し側の文字列をそのまま連結しない）。
//   - 実行環境は信頼済みランチャーが固定する。git / gh / Node は起動時に所有者・権限を検証した絶対パスだけを使い、
//     子プロセスの環境変数は許可リストで一から組み立てる（PATH・NODE_OPTIONS・LD_PRELOAD・GIT_*・GH_* は引き継がない）。
//   - Git の system / global 設定は使わず、リポジトリ内の設定に外部コマンドを起動しうる項目があれば実行しない。
//   - Git 操作は起動時に確定したリポジトリへ拘束する。gh は従来の拘束先に加え、明示した owner/repo の owner が
//     起動時の許可リストと一致するときだけ、ローカル Git に依存せず実行できる。gh には検証済みの --repo を必ず付ける。
//   - 通信する Git 操作（git push / prepare worktree の fetch）は origin の設定値を使わない。拘束した owner/repo から
//     入口が組み立てた固定 URL と固定 refspec だけに送り、資格情報は検証済み gh の `auth git-credential` だけを使う（issue #440）。
//   - デフォルトブランチの取り込みは引数なしの `git fetch` / `git merge` だけ（issue #479）。取得元は拘束した owner/repo の固定 URL、対象は
//     gh で GitHub から読んだデフォルトブランチ 1 本、保存先は refs/remotes/origin/<デフォルトブランチ> に固定する。merge は必ず merge commit を作り、
//     競合したときは状態を戻さず、Codex がファイルを直したあと既存の `git add` / `git commit -m` で完成させる。
//   - メンバー起動（member start / member status。issue #441）は、子の Codex を親と同じ範囲の sandbox（-s workspace-write か read-only、
//     -a never）で起動する。囲いを外す指定は受け付けず、子には専用の CODEX_HOME（member 操作を持たない入口）を渡して入れ子の起動を防ぐ。
//     入出力ファイルは起動ごとの専用フォルダ直下の名前だけで、子の実行は数十分かかりうるためバックグラウンドで行う。
//   - 空白・改行を含む PR のタイトル・本文は、引用符なしの単独コマンドでは引数として渡せない（引用符を付けるとサンドボックス内の実行とみなされて止まる）。
//     そのため `gh pr create` / `gh pr edit` は `--title-file <名前>` / `--body-file <名前>` で、同じ入出力フォルダ直下のファイルから読む（issue #477）。
//     parse 段階はファイル名の形だけを検査し、読み込みと内容の検査（UTF-8・制御文字・サイズ）は実行段階で gh を起動する前に行う。読んだ値はシェルを通さず argv で渡す。
//     同じ形を `gh issue comment` / `gh pr comment`（--body-file）と `gh issue create`（--title-file / --body-file）にも広げた（issue #519。読み込みと検査は同じ処理）。
//   - 起票前の確認用に、読み取り専用の `gh issue list`（重複確認）と `gh repo view`（公開範囲・デフォルトブランチの確認）を持つ（issue #520）。
//     フラグは状態・検索語・件数・ラベル・許可リストの JSON 項目だけで、--web・--jq・--template・--repo は受けない。
//     `gh repo view` は `--repo` を持たないため、拘束したリポジトリ（または許可 owner の明示先）を位置引数として入口が付ける。
//   - 分析・レビュー用の読み取りとして、`gh pr diff <番号> [--name-only | --patch]`、`git merge-base <リビジョン> <リビジョン>`、
//     issue の添付画像を入出力フォルダ直下へ保存する `gh issue save-image <URL> --out <名前>` を持つ（issue #521）。
//     画像の取得は GitHub の添付画像のホスト（完全一致の許可リスト）だけで、リダイレクトは各ホップでホストを再検査し、認証トークンは github.com にしか送らない。
//     保存名・サイズ・画像形式（中身のマジックバイト）は入口が検査し、既存ファイルは上書きしない。
//   - issue の本文更新（`gh issue edit <番号> --body-file <名前>`）・close（`gh issue close <番号> [--reason completed|"not planned"]`）・
//     ラベル削除（`gh issue edit <番号> --remove-label <ラベル>`）を持つ（issue #522）。本文ファイルの読み込みと検査は --body-file の既存処理を再利用する。
//     担当者・ラベルの追加（--add-*）、本文更新、ラベル削除は 1 回の gh issue edit に併用させず、それぞれ別の操作として実行する（読み戻しの照合を操作ごとに独立させるため）。
//     成功の判定はどれも読み戻し（本文の一致・state が CLOSED・ラベルが外れたこと）で行い、gh の終了コードだけでは成功としない。
const nodeFs = require('fs');
const crypto = require('crypto');
const path = require('path');
const childProcess = require('child_process');
const https = require('https');

const REVISION_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/@^~{}-]*$/;
const BRANCH_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const JSON_FIELDS_PATTERN = /^[A-Za-z]+(,[A-Za-z]+)*$/;
const DIGITS_PATTERN = /^[0-9]{1,9}$/;
// issue 作成の担当者は GitHub のアカウント名だけ（@me は通さない。utils/codexTaskPolicy.js の GH_USER_PATTERN と同じ形）。
const ASSIGNEE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const MAX_LABEL_LENGTH = 50;
// レビュー合格ラベル（vk-agents の vk-kore 9-3 が使う完了マーカー）。ラベル操作はこの名前だけを通し、色・説明も入口側で固定する。
const REVIEW_PASSED_LABEL = 'agent-review-passed';
const REVIEW_PASSED_LABEL_COLOR = '0e8a16';
const REVIEW_PASSED_LABEL_DESCRIPTION = 'エージェントのレビュー完了マーカー（最終レビュー・e2e ゲート通過）';
// gh issue list / gh repo view（issue #520）で許す --json の項目。任意式の評価（--jq / --template）は受けず、項目名もここにあるものだけ。
const ISSUE_LIST_JSON_FIELDS = Object.freeze(['number', 'title', 'state', 'stateReason', 'url', 'labels', 'assignees', 'author', 'body', 'createdAt', 'updatedAt', 'closedAt', 'milestone']);
const REPO_VIEW_JSON_FIELDS = Object.freeze(['name', 'nameWithOwner', 'owner', 'url', 'description', 'visibility', 'isPrivate', 'isArchived', 'isFork', 'defaultBranchRef', 'hasIssuesEnabled', 'viewerPermission']);
const ISSUE_LIST_STATES = Object.freeze(['open', 'closed', 'all']);
const ISSUE_LIST_MAX_LIMIT = 100;
const ISSUE_LIST_MAX_LABELS = 10;
const ISSUE_LIST_MAX_SEARCH_CHARS = 256;
// gh は --search と --label を 1 本の検索式に組み立てる。検索先（repo: など）や括弧・論理演算子で拘束先の外へ広げられないよう、許可した文法だけを通す。
const SEARCH_TERM_PATTERN = /^(?:-?label:)?[\p{L}\p{N}_.-]+$/u;
const SEARCH_OPERATOR_PATTERN = /^(?:AND|OR|NOT)$/i;
const LIST_LABEL_PATTERN = /^[\p{L}\p{N}_.:-]+(?: [\p{L}\p{N}_.:-]+)*$/u;

// issue 添付画像の保存（issue #521）。取得してよいのは GitHub の添付画像のホストだけ（完全一致）。
// 利用者が渡せる URL のホスト（ATTACHMENT_START_HOSTS）と、リダイレクト先として許すホスト（ATTACHMENT_REDIRECT_HOSTS）は分ける。
// 認証トークンを送るのは github.com だけ（署名付き URL を持つ他のホストには送らない）。
const ATTACHMENT_START_HOSTS = Object.freeze(['github.com', 'user-images.githubusercontent.com', 'private-user-images.githubusercontent.com']);
const ATTACHMENT_REDIRECT_HOSTS = Object.freeze([...ATTACHMENT_START_HOSTS, 'objects.githubusercontent.com', 'github-production-user-asset-6210df.s3.amazonaws.com']);
const ATTACHMENT_TOKEN_HOSTS = Object.freeze(['github.com']);
const ATTACHMENT_URL_PRINTABLE_PATTERN = /^[\x21-\x7e]{1,2048}$/;
const ATTACHMENT_ASSET_PATH_PATTERN = /^\/user-attachments\/assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ATTACHMENT_STATIC_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+$/;
const ATTACHMENT_JWT_QUERY_PATTERN = /^\?jwt=[A-Za-z0-9._-]+$/;
const ATTACHMENT_FILE_NAME_PATTERN = /\.(png|jpg|jpeg|gif|webp)$/;
const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_MAX_REDIRECTS = 5;
const ATTACHMENT_TIMEOUT_MS = 30000;
const ATTACHMENT_REDIRECT_STATUSES = Object.freeze([301, 302, 303, 307, 308]);
const ATTACHMENT_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,512}$/;
// 画像形式（中身のマジックバイトで判定した値）と、許す拡張子の対応。拡張子と中身が食い違うものは保存しない。
const IMAGE_TYPE_EXTENSIONS = Object.freeze({ png: ['png'], jpeg: ['jpg', 'jpeg'], gif: ['gif'], webp: ['webp'] });

// PR 番号は 1 以上の数字だけ（0・先頭ゼロは不可）。
const POSITIVE_NUMBER_PATTERN = /^[1-9][0-9]{0,8}$/;
// ラベル操作の対応表（parse 側）と、runTaskCommand の振り分け（REVIEW_LABEL_OPERATIONS）の元を 1 か所にそろえる。値は [操作名, PR 番号を取るか]。
const REVIEW_LABEL_COMMANDS = Object.freeze({
  'label exists': ['label-exists', false],
  'label create': ['label-create', false],
  'pr add-label': ['pr-add-label', true],
  'pr has-label': ['pr-has-label', true],
});
const REVIEW_LABEL_OPERATIONS = new Set(Object.values(REVIEW_LABEL_COMMANDS).map(([operation]) => operation));

// 操作の受理集合と実際の振り分けを同じ対応表から決める。
const GH_OPERATION_HANDLERS = Object.freeze({
  'gh issue view': (tokens, targetRepo, command) => {
    const parsed = parseGhView(tokens, { allowedBooleanFlags: ['--comments'], numberRequired: true });
    return parsed.ok ? command(['issue', 'view', parsed.number], parsed.args) : parsed;
  },
  'gh issue list': (tokens, targetRepo, command) => {
    const parsed = parseGhIssueList(tokens);
    return parsed.ok ? command(['issue', 'list'], parsed.args) : parsed;
  },
  'gh repo view': parseGhRepoView,
  'gh issue save-image': (tokens, targetRepo) => {
    const parsed = parseGhIssueSaveImage(tokens);
    return parsed.ok && targetRepo !== undefined ? { ...parsed, targetRepo } : parsed;
  },
  'gh pr diff': (tokens, targetRepo, command) => {
    const parsed = parseGhPrDiff(tokens);
    return parsed.ok ? command(['pr', 'diff', parsed.number], parsed.args) : parsed;
  },
  'gh issue comment': (tokens, targetRepo, command) => {
    return withTextFiles(parseGhComment(tokens), (parsed) => command(['issue', 'comment', parsed.number], parsed.args));
  },
  'gh issue create': (tokens, targetRepo, command) => {
    return withTextFiles(parseGhIssueCreate(tokens), (parsed) => command(['issue', 'create'], parsed.args));
  },
  'gh issue edit': parseGhIssueEdit,
  'gh issue close': parseGhIssueClose,
  'gh pr view': (tokens, targetRepo, command) => {
    const parsed = parseGhView(tokens, { allowedBooleanFlags: ['--comments'], numberRequired: true });
    return parsed.ok ? command(['pr', 'view', parsed.number], parsed.args) : parsed;
  },
  'gh pr checks': (tokens, targetRepo, command) => {
    const parsed = parseGhView(tokens, { allowedBooleanFlags: [], numberRequired: true });
    return parsed.ok ? command(['pr', 'checks', parsed.number], parsed.args) : parsed;
  },
  'gh pr comment': (tokens, targetRepo, command) => {
    return withTextFiles(parseGhComment(tokens), (parsed) => command(['pr', 'comment', parsed.number], parsed.args));
  },
  'gh pr create': (tokens, targetRepo, command) => {
    return withTextFiles(parseGhPrCreate(tokens), (parsed) => command(['pr', 'create'], parsed.args));
  },
  'gh pr edit': parseGhPrEdit,
  'gh pr merge': parseGhPrMerge,
  ...Object.fromEntries(Object.entries(REVIEW_LABEL_COMMANDS).map(([name, [operation, withNumber]]) => [
    `gh ${name}`,
    (tokens, targetRepo) => {
      const parsed = parseReviewLabelCommand(operation, tokens, { withNumber });
      return parsed.ok ? { ...parsed, ...(targetRepo === undefined ? {} : { targetRepo }) } : parsed;
    },
  ])),
});
const ACCEPTED_GH_OPERATIONS = Object.freeze(Object.keys(GH_OPERATION_HANDLERS));

const NO_VALUE_FLAGS = Object.freeze({
  'git status': ['-s', '--short', '-b', '--branch', '--porcelain', '--porcelain=v1', '--porcelain=v2'],
  'git diff': ['--stat', '--cached', '--staged', '--name-only', '--name-status', '--numstat', '--shortstat', '--check', '--no-color', '--no-renames'],
  'git log': ['--oneline', '--stat', '--name-only', '--name-status', '--no-color', '--graph', '--decorate'],
  'git show': ['--stat', '--name-only', '--name-status', '--no-color', '--oneline', '--no-patch', '-s'],
  'git add': ['-A', '--all', '-u', '--update'],
  'git commit': ['-a', '--all'],
  'git merge-base': [],
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
const CODEX_WORKTREE_PARENT = Object.freeze(['.codex', 'worktrees']);
// 移行中の起動済みタスクを引き受けるため、旧 Claude 配下も候補に残す。外す時期は vektor-inc/vk-orchestrator#748 の決定に合わせる。
const ADOPT_WORKTREE_PARENTS = Object.freeze([CODEX_WORKTREE_PARENT, Object.freeze(['.claude', 'worktrees'])]);
// メンバー起動の入出力ファイル名（専用フォルダ直下の名前だけ。パス区切り・先頭 `.` は通らない）、モデル名、実行 ID。
const MEMBER_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MEMBER_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._[\]-]{0,63}$/;
const MEMBER_RUN_ID_PATTERN = /^[0-9a-f]{24}$/;
const MEMBER_SUPPORTED_ENGINES = Object.freeze(['codex']);
const MEMBER_PARENT_SANDBOXES = Object.freeze(['read-only', 'workspace-write']);
const MEMBER_MAX_RESULT_BYTES = 16 * 1024 * 1024;
const WORKTREE_GIT_TIMEOUT_MS = 1500;
const WORKTREE_MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
// 実行の監督プロセス（member start が起動する、子の Codex の終了を見届ける常駐プロセス）へ設定を渡す環境変数。
// ランチャーは環境を空にして入口を起動するため、Codex（親）からこの変数を差し込む経路は無い。
const MEMBER_SUPERVISE_ENV = 'VK_TASK_MEMBER_SUPERVISE';
const MEMBER_MAX_PROMPT_BYTES = 1024 * 1024;
// PR のタイトル・本文のファイル上限。タイトルは GitHub の上限 256 文字（日本語でも 3 バイト × 256 = 768 バイト）に余裕を足した 1 KiB。
// 本文は GitHub の上限 65536 文字（最大 4 バイト × 65536 = 256 KiB）に合わせた 256 KiB で、バイト数のあとに文字数でも検査する。
// 禁止する文字: C0/C1 制御文字・DEL、ゼロ幅スペースと向きの印（U+200B・U+200E・U+200F）、行/段落区切り（U+2028/2029）、双方向制御（U+202A-202E・U+2066-2069）、BOM（U+FEFF）。
// 本文はこれらのうち、タブ・LF・CR だけ許す。
const PR_TITLE_FORBIDDEN_PATTERN = /[\x00-\x1f\x7f-\x9f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
const PR_BODY_FORBIDDEN_PATTERN = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;
const PR_TITLE_MAX_BYTES = 1024;
const PR_TITLE_MAX_CHARS = 256;
const PROTECTED_SYNC_MAX_SOURCE_BYTES = 256 * 1024;
const PR_BODY_MAX_BYTES = 256 * 1024;
const PR_BODY_MAX_CHARS = 65536;
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

// `--json a,b` / `--json=a,b` を読み、項目がすべて許可リストにあるときだけ値を返す（無ければ null）。
function readAllowedJsonFields(value, allowedFields) {
  if (typeof value !== 'string' || !JSON_FIELDS_PATTERN.test(value)) return null;
  const fields = value.split(',');
  return fields.every((field) => allowedFields.includes(field)) ? value : null;
}

// `--name value` / `--name=value` のどちらでも値を取り出す共通処理（gh の読み取り系で使う）。
function splitFlag(tokens, index) {
  const token = tokens[index];
  if (token.startsWith('--') && token.includes('=')) {
    return { name: token.slice(0, token.indexOf('=')), value: token.slice(token.indexOf('=') + 1), consumed: 0 };
  }
  return { name: token, value: tokens[index + 1], consumed: 1 };
}

// 検索語は、空白区切りの各語が「文字・数字・_ . -」だけ（`label:` / `-label:` の接頭辞のみ可）のときだけ通す。
// 括弧・引用符・ほかの修飾子・論理演算子を含む語は拒否する。
function isSafeSearchQuery(value) {
  if (value.trim() === '' || [...value].length > ISSUE_LIST_MAX_SEARCH_CHARS) return false;
  return value.trim().split(/ +/).every((term) => SEARCH_TERM_PATTERN.test(term) && !SEARCH_OPERATOR_PATTERN.test(term));
}

// `gh issue list` は読み取り専用。--state / --search / --limit / --label / --json だけを受ける（issue #520）。
// --web（ブラウザを開く）・--jq / --template（任意式の評価）・--repo / -R・短縮形・位置引数は拒否する。
// 検索語は `--search=<値>` の 1 引数に組み立て直し、先頭が `-` の検索構文でも別フラグとして読まれないようにする。
function parseGhIssueList(tokens) {
  const args = [];
  const seen = new Set();
  const labels = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token) || PR_TITLE_FORBIDDEN_PATTERN.test(token)) return fail('invalid argument');
    const { name, value, consumed } = splitFlag(tokens, i);
    if (!['--state', '--search', '--limit', '--label', '--json'].includes(name)) return fail(`argument not allowed: ${JSON.stringify(token)}`);
    if (typeof value !== 'string' || PR_TITLE_FORBIDDEN_PATTERN.test(value)) return fail(`invalid value for ${name}`);
    if (name === '--label') {
      if (!isSafeLabelName(value) || !LIST_LABEL_PATTERN.test(value) || labels.length >= ISSUE_LIST_MAX_LABELS) return fail('invalid --label');
      labels.push(value);
    } else {
      if (seen.has(name)) return fail(`${name} specified more than once`);
      seen.add(name);
      if (name === '--state') {
        if (!ISSUE_LIST_STATES.includes(value)) return fail('invalid --state');
        args.push('--state', value);
      } else if (name === '--search') {
        if (!isSafeSearchQuery(value)) return fail('invalid --search');
        args.push(`--search=${value}`);
      } else if (name === '--limit') {
        if (!DIGITS_PATTERN.test(value) || Number(value) < 1 || Number(value) > ISSUE_LIST_MAX_LIMIT) return fail(`--limit must be between 1 and ${ISSUE_LIST_MAX_LIMIT}`);
        args.push('--limit', String(Number(value)));
      } else {
        const fields = readAllowedJsonFields(value, ISSUE_LIST_JSON_FIELDS);
        if (fields === null) return fail('--json field not allowed');
        args.push('--json', fields);
      }
    }
    i += consumed;
  }
  for (const label of labels) args.push('--label', label);
  return { ok: true, args };
}

// `gh repo view` は読み取り専用。`--json <項目,...>` が必須で、位置引数は owner/repo（拘束先の明示）だけ（issue #520）。
// gh repo view は --repo を持たないため、対象は実行段階で入口が位置引数として付ける。
function parseGhRepoView(tokens, targetRepo) {
  let json;
  let positional;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token) || PR_TITLE_FORBIDDEN_PATTERN.test(token)) return fail('invalid argument');
    if (token === '--json' || token.startsWith('--json=')) {
      const { value, consumed } = splitFlag(tokens, i);
      const fields = readAllowedJsonFields(value, REPO_VIEW_JSON_FIELDS);
      if (json !== undefined || fields === null) return fail('--json field not allowed');
      json = fields;
      i += consumed;
    } else if (!token.startsWith('-') && token.includes('/') && positional === undefined) {
      if (!isSafeGitHubRepo(token)) return fail(`invalid github repository: ${JSON.stringify(token)}`);
      positional = token;
    } else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (json === undefined) return fail('--json required');
  if (positional !== undefined && targetRepo !== undefined) return fail('repository specified more than once');
  const target = targetRepo === undefined ? positional : targetRepo;
  return { ok: true, bin: 'gh', args: ['repo', 'view', '--json', json], needsGitHub: true, repoPositional: true, ...(target === undefined ? {} : { targetRepo: target }) };
}

// `gh pr diff <番号>` は読み取り専用。表示形式は `--name-only`（ファイル名のみ）か `--patch`（パッチ形式）のどちらか 1 つだけ（issue #521）。
// `--color` などの値つきフラグ・`--web`・`--exclude`・`--repo` / `-R`・短縮形は受けない。
function parseGhPrDiff(tokens) {
  let number;
  let format;
  for (const token of tokens) {
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    if (token === '--name-only' || token === '--patch') {
      if (format !== undefined) return fail('only one of --name-only and --patch can be used once');
      format = token;
    } else if (!token.startsWith('-') && number === undefined && POSITIVE_NUMBER_PATTERN.test(token)) number = token;
    else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (number === undefined) return fail('number required');
  return { ok: true, number, args: format === undefined ? [] : [format] };
}

// `git merge-base <リビジョン> <リビジョン>` は読み取り専用で、リビジョンちょうど 2 つだけを受ける（issue #521）。
// フラグ（--fork-point / --octopus / --is-ancestor など）・`--`・パスは受けない。リビジョンは他の git 閲覧系と同じ形（先頭が `-` のものは不可）。
function parseGitMergeBase(tokens) {
  const parsed = parseGitReadCommand('merge-base', tokens, { allowPaths: false });
  if (!parsed.ok) return parsed;
  if (parsed.seenSeparator) return fail('-- is not allowed');
  if (parsed.revisions.length !== 2) return fail('git merge-base needs exactly two revisions');
  return buildGit('merge-base', [], parsed.revisions, []);
}

// 添付画像の URL を検証し、URL オブジェクトを返す（許可外は null）。ホストは完全一致の許可リスト、https のみ、認証情報・ポート・フラグメントは不可。
// 利用者が渡す URL（redirect: false）は正規形そのものであることと、ホストごとの経路・クエリの形も確かめる。
// リダイレクト先（redirect: true）は署名付き URL を持つため経路とクエリは緩めるが、ホストは許可リストで再検査する。
function parseAttachmentUrl(value, { redirect = false } = {}) {
  if (typeof value !== 'string' || !ATTACHMENT_URL_PRINTABLE_PATTERN.test(value) || !value.startsWith('https://') || value.includes('\\') || value.includes('#')) return null;
  let url;
  try {
    url = new URL(value);
  } catch (_error) {
    return null;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') return null;
  if (!(redirect ? ATTACHMENT_REDIRECT_HOSTS : ATTACHMENT_START_HOSTS).includes(url.hostname)) return null;
  if (redirect) return url;
  if (url.href !== value || url.pathname.split('/').some((segment) => segment === '.' || segment === '..')) return null;
  if (url.hostname === 'github.com') return ATTACHMENT_ASSET_PATH_PATTERN.test(url.pathname) && url.search === '' && !value.includes('?') ? url : null;
  if (!ATTACHMENT_STATIC_PATH_PATTERN.test(url.pathname) || url.pathname.includes('//')) return null;
  if (url.hostname === 'private-user-images.githubusercontent.com') return url.search === '' || ATTACHMENT_JWT_QUERY_PATTERN.test(url.search) ? url : null;
  return url.search === '' && !value.includes('?') ? url : null;
}

// `gh issue save-image <URL> --out <名前>`（issue #521）。保存先は入出力フォルダ直下の名前だけ（拡張子は png / jpg / jpeg / gif / webp）。
// parse 段階は URL と名前の形だけを検査する。取得・形式の確認・保存は実行段階で行う。
function parseGhIssueSaveImage(tokens) {
  let urlValue;
  let name;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    const { name: flag, value, consumed } = splitFlag(tokens, i);
    if (flag === '--out' && name === undefined) {
      if (typeof value !== 'string') return fail('--out needs a value');
      name = value;
      i += consumed;
    } else if (!token.startsWith('-') && urlValue === undefined) urlValue = token;
    else return fail(`argument not allowed: ${JSON.stringify(token.slice(0, 64))}`);
  }
  if (urlValue === undefined || name === undefined) return fail('usage: gh issue save-image <url> --out <file name>');
  if (!isSafeMemberFileName(name) || !ATTACHMENT_FILE_NAME_PATTERN.test(name)) return fail('--out must be a plain file name ending in .png, .jpg, .jpeg, .gif or .webp');
  if (parseAttachmentUrl(urlValue) === null) return fail('url is not a GitHub attachment image url');
  return { ok: true, bin: 'gh', operation: 'issue-image-save', url: urlValue, out: name, needsGitHub: true };
}

// `gh issue comment` / `gh pr comment <番号>` は `--body <値>` か `--body-file <名前>`（入出力フォルダ直下のファイル名）のどちらか 1 つ（issue #519）。
function parseGhComment(tokens) {
  let number;
  let body;
  let bodyFile;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    if ((token === '--body' || token === '-b') && body === undefined) {
      body = tokens[i + 1];
      if (hasUnsafeCharacter(body) || body.trim() === '') return fail('comment body required');
      i += 1;
    } else if (token.startsWith('--body=') && body === undefined && token.slice('--body='.length).trim() !== '') {
      body = token.slice('--body='.length);
    } else if ((token === '--body-file' || token.startsWith('--body-file=')) && bodyFile === undefined) {
      const value = token === '--body-file' ? tokens[i + 1] : token.slice('--body-file='.length);
      if (token === '--body-file') i += 1;
      if (!isSafeMemberFileName(value)) return fail('--body-file must be a plain file name in the member input/output folder');
      bodyFile = value;
    } else if (!token.startsWith('-') && number === undefined && DIGITS_PATTERN.test(token)) number = token;
    else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (body !== undefined && bodyFile !== undefined) return fail('--body and --body-file cannot be used together');
  if (number === undefined || (body === undefined && bodyFile === undefined)) return fail('number and body (or --body-file) required');
  return { ok: true, number, args: body === undefined ? [] : ['--body', body], textFiles: { body: bodyFile } };
}

// PR 作成は head を必ず明示させる（省略すると gh が現在のブランチを push しようとするため）。
function parseGhPrCreate(tokens) {
  const parsed = parsePrTextFlags(tokens, { head: true });
  if (!parsed.ok) return parsed;
  const { head, base, draft, title, body, titleFile, bodyFile } = parsed;
  if (head === undefined || !isSafeBranchName(head)) return fail('--head with a plain branch name is required');
  if (base !== undefined && !isSafeBranchName(base)) return fail('invalid --base');
  if ((title === undefined && titleFile === undefined) || (body === undefined && bodyFile === undefined)) return fail('--title (or --title-file) and --body (or --body-file) are required');
  const args = ['--head', head];
  if (title !== undefined) args.push('--title', title);
  if (body !== undefined) args.push('--body', body);
  if (base !== undefined) args.push('--base', base);
  if (draft) args.push('--draft');
  return { ok: true, args, textFiles: { title: titleFile, body: bodyFile } };
}

// gh pr create / gh pr edit 共通の引数解析。--title / --body の直接指定と --title-file / --body-file（入出力フォルダ直下のファイル名）を受ける。
// 同じ項目で直接指定とファイル指定は併用できない。ファイル名は形だけを検査し、中身は実行段階で読む。
// head: true なら --head / --base / --draft も受ける（pr create）。false なら受けない（pr edit は他のフラグを許可しない）。
function parsePrTextFlags(tokens, { head: allowCreateFlags, positional = null }) {
  let head;
  let base;
  let title;
  let body;
  let titleFile;
  let bodyFile;
  let draft = false;
  let number;
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
    const readFileName = (option) => {
      const value = readValue();
      return isSafeMemberFileName(value) ? value : fail(`${option} must be a plain file name in the member input/output folder`);
    };
    if (allowCreateFlags && (name === '--head' || name === '-H') && head === undefined) head = readValue();
    else if (allowCreateFlags && (name === '--base' || name === '-B') && base === undefined) base = readValue();
    else if ((name === '--title' || name === '-t') && title === undefined) title = readValue();
    else if ((name === '--body' || name === '-b') && body === undefined) body = readValue();
    else if (name === '--title-file' && titleFile === undefined) {
      titleFile = readFileName('--title-file');
      if (titleFile.ok === false) return titleFile;
    } else if (name === '--body-file' && bodyFile === undefined) {
      bodyFile = readFileName('--body-file');
      if (bodyFile.ok === false) return bodyFile;
    } else if (allowCreateFlags && (token === '--draft' || token === '-d') && !draft) draft = true;
    else if (positional === 'number' && !token.startsWith('-') && number === undefined && DIGITS_PATTERN.test(token)) number = token;
    else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (title !== undefined && titleFile !== undefined) return fail('--title and --title-file cannot be used together');
  if (body !== undefined && bodyFile !== undefined) return fail('--body and --body-file cannot be used together');
  // `--title=` / `--body= ` のように `=` 付きで渡された空・空白だけの値も、別引数の値と同じく拒否する。
  if ((title !== undefined && title.trim() === '') || (body !== undefined && body.trim() === '')) return fail('--title and --body must not be blank');
  return { ok: true, head, base, draft, title, body, titleFile, bodyFile, number };
}

// 作成済み PR のタイトル・本文の更新は `gh pr edit <番号> [--title <値>|--title-file <名前>] [--body <値>|--body-file <名前>]` の形だけ（少なくとも 1 つ必須）。
// 他のフラグ（--add-* / --remove-* / --base / --repo など）は許可リストに無いので拒否される。
// 実行は入口が「ファイル読み込み → 更新 → 読み戻し」の順で行う。
function parseGhPrEdit(tokens, targetRepo) {
  // 更新操作は起動時に固定したリポジトリだけを対象にする。
  if (targetRepo !== undefined) return fail('gh pr edit cannot target another repository');
  const parsed = parsePrTextFlags(tokens, { head: false, positional: 'number' });
  if (!parsed.ok) return parsed;
  const { number, title, body, titleFile, bodyFile } = parsed;
  if (number === undefined) return fail('number required');
  if (title === undefined && titleFile === undefined && body === undefined && bodyFile === undefined) return fail('--title or --body (or --title-file / --body-file) is required');
  if ((title !== undefined && title.trim() === '') || (body !== undefined && body.trim() === '')) return fail('--title and --body must not be blank');
  return { ok: true, bin: 'gh', operation: 'pr-edit', number, title, body, textFiles: { title: titleFile, body: bodyFile }, needsGitHub: true };
}

// PR のマージは番号 1 つだけを受ける。方式・head 固定・リポジトリは入口側で組み立てるため、利用者指定のフラグはすべて拒否する。
function parseGhPrMerge(tokens, targetRepo) {
  // 更新操作は起動時に固定したリポジトリだけを対象にする。
  if (targetRepo !== undefined) return fail('gh pr merge cannot target another repository');
  if (tokens.length !== 1 || hasUnsafeCharacter(tokens[0]) || !POSITIVE_NUMBER_PATTERN.test(tokens[0])) {
    return fail('gh pr merge needs one valid PR number and no flags');
  }
  return { ok: true, bin: 'gh', operation: 'pr-merge', number: tokens[0], needsGitHub: true };
}

// ラベル名は日本語・空白・`:` を含みうるので文字種は絞らず、危険なものだけを拒否する。
// 制御文字・改行・カンマとダブルクォート（gh の --label は CSV として解析されるため、判定と実際の解釈を一致させる）・先頭 `-`・前後の空白・空文字・過度な長さ（GitHub の上限 50 文字）。
function isSafeLabelName(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()) return false;
  if (/[\x00-\x1f\x7f-\x9f]/.test(value) || value.includes(',') || value.includes('"') || value.startsWith('-')) return false;
  return [...value].length <= MAX_LABEL_LENGTH;
}

// issue 作成は --title / --body を必須にし、--assignee / --label（複数可）だけを任意で受ける。
// --title-file / --body-file は入出力フォルダ直下のファイル名（issue #519）。--title と --title-file、--body と --body-file は併用できない。
// --repo・--web・--editor・--template・--project・--milestone などは許可リストに無いので拒否される。
function parseGhIssueCreate(tokens) {
  let title;
  let body;
  let titleFile;
  let bodyFile;
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
    if (name === '--title-file' && titleFile === undefined) {
      const value = readValue();
      if (!isSafeMemberFileName(value)) return fail('--title-file must be a plain file name in the member input/output folder');
      titleFile = value;
    } else if (name === '--body-file' && bodyFile === undefined) {
      const value = readValue();
      if (!isSafeMemberFileName(value)) return fail('--body-file must be a plain file name in the member input/output folder');
      bodyFile = value;
    } else if ((name === '--title' || name === '-t') && title === undefined) title = readValue();
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
  if (title !== undefined && titleFile !== undefined) return fail('--title and --title-file cannot be used together');
  if (body !== undefined && bodyFile !== undefined) return fail('--body and --body-file cannot be used together');
  if ((title === undefined && titleFile === undefined) || (body === undefined && bodyFile === undefined)) return fail('--title (or --title-file) and --body (or --body-file) are required');
  if ((title !== undefined && title.trim() === '') || (body !== undefined && body.trim() === '')) return fail('--title and --body are required');
  const args = [];
  if (title !== undefined) args.push('--title', title);
  if (body !== undefined) args.push('--body', body);
  for (const assignee of assignees) args.push('--assignee', assignee);
  for (const label of labels) args.push('--label', label);
  return { ok: true, args, textFiles: { title: titleFile, body: bodyFile } };
}

// ラベル操作は `gh label exists|create agent-review-passed` と `gh pr add-label|has-label <PR番号> agent-review-passed` の形だけ。
// 他のオプション・ラベル名・PR 番号の形は受けない。実行は gh api の固定エンドポイントで入口が行う（executeReviewLabel）。
function parseReviewLabelCommand(operation, tokens, { withNumber }) {
  const expected = withNumber ? 2 : 1;
  if (tokens.length !== expected) return fail(withNumber ? 'expected <PR number> and the label name' : 'expected the label name only');
  if (tokens.some((token) => hasUnsafeCharacter(token))) return fail('invalid argument');
  const label = tokens[expected - 1];
  if (label !== REVIEW_PASSED_LABEL) return fail(`label not allowed: ${JSON.stringify(label)}`);
  if (!withNumber) return { ok: true, bin: 'gh', args: [], needsGitHub: true, operation, label };
  if (!POSITIVE_NUMBER_PATTERN.test(tokens[0])) return fail('invalid PR number');
  return { ok: true, bin: 'gh', args: [], needsGitHub: true, operation, label, number: tokens[0] };
}

// 作成済み issue の更新は次の 3 通りの形だけ（issue #472 / #522）。互いに併用はできず、混ぜると拒否する（読み戻しの照合を操作ごとに独立させるため）。
//   1. `gh issue edit <番号> --add-assignee <名前> --add-label <ラベル>`（どちらも複数可、少なくとも 1 つ必須）→ operation: issue-edit
//   2. `gh issue edit <番号> --body-file <名前>`（本文の更新。入出力フォルダ直下のファイル名 1 つ）→ operation: issue-edit-body
//   3. `gh issue edit <番号> --remove-label <ラベル>`（複数可）→ operation: issue-remove-label
// 題名・--body・--milestone・--repo などは許可リストに無いので拒否される。実行は入口が「更新 → 読み戻し」の順で行う（1 はラベルの存在確認も先に行う）。
function parseGhIssueEdit(tokens, targetRepo) {
  // 更新操作は起動時に固定したリポジトリだけを対象にする。
  if (targetRepo !== undefined) return fail('gh issue edit cannot target another repository');
  let number;
  let bodyFile;
  const assignees = [];
  const labels = [];
  const removeLabels = [];
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
    } else if (name === '--remove-label') {
      const value = readValue();
      if (!isSafeLabelName(value)) return fail('invalid --remove-label');
      removeLabels.push(value);
    } else if (name === '--body-file' && bodyFile === undefined) {
      const value = readValue();
      if (!isSafeMemberFileName(value)) return fail('--body-file must be a plain file name in the member input/output folder');
      bodyFile = value;
    } else if (!token.startsWith('-') && number === undefined && DIGITS_PATTERN.test(token)) number = token;
    else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (number === undefined) return fail('number required');
  const kinds = [assignees.length > 0 || labels.length > 0, bodyFile !== undefined, removeLabels.length > 0].filter(Boolean).length;
  if (kinds === 0) return fail('--add-assignee, --add-label, --body-file or --remove-label is required');
  if (kinds > 1) return fail('--add-assignee / --add-label, --body-file and --remove-label cannot be combined');
  if (bodyFile !== undefined) return { ok: true, bin: 'gh', operation: 'issue-edit-body', number, textFiles: { body: bodyFile }, needsGitHub: true };
  if (removeLabels.length > 0) return { ok: true, bin: 'gh', operation: 'issue-remove-label', number, removeLabels, needsGitHub: true };
  return { ok: true, bin: 'gh', operation: 'issue-edit', number, assignees, labels, needsGitHub: true };
}

// issue の close は `gh issue close <番号> [--reason completed|"not planned"]` だけ（issue #522）。
// --comment・--duplicate-of・--reason duplicate・--repo などは受けない。引用符なしの単独コマンドでは空白を含む引数を渡せないため、`not_planned` も `not planned` と同じ意味で受ける。
const CLOSE_REASONS = Object.freeze({ completed: 'completed', 'not planned': 'not planned', not_planned: 'not planned' });
function parseGhIssueClose(tokens, targetRepo) {
  // 更新操作は起動時に固定したリポジトリだけを対象にする。
  if (targetRepo !== undefined) return fail('gh issue close cannot target another repository');
  let number;
  let reason;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (hasUnsafeCharacter(token)) return fail('invalid argument');
    if (token === '--reason' || token.startsWith('--reason=')) {
      const value = token === '--reason' ? tokens[i + 1] : token.slice('--reason='.length);
      if (token === '--reason') i += 1;
      if (reason !== undefined || typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(CLOSE_REASONS, value)) return fail('--reason must be one of: completed, "not planned" (or not_planned)');
      reason = CLOSE_REASONS[value];
    } else if (!token.startsWith('-') && number === undefined && DIGITS_PATTERN.test(token)) number = token;
    else return fail(`argument not allowed: ${JSON.stringify(token)}`);
  }
  if (number === undefined) return fail('number required');
  return { ok: true, bin: 'gh', operation: 'issue-close', number, reason, needsGitHub: true };
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

// `git fetch` / `git merge` は引数を一切取らない。取得元・取得する ref・merge 元は入口がデフォルトブランチから固定するため、
// URL・refspec・ブランチ名・フラグはすべて拒否する。
function parseGitNoArguments(subcommand, tokens, { operation, branchAction = null }) {
  if (tokens.length !== 0) return fail(`git ${subcommand} takes no arguments`);
  return { ok: true, bin: 'git', operation, needsGitHub: true, needsGh: true, ...(branchAction === null ? {} : { guardsDefaultBranch: true, branchAction }) };
}

// 作業フォルダ準備は `prepare worktree <base> <issue番号> <ブランチ> <worktree名>` だけ（owner/repo は拘束済みなので引数に取らない）。
function validatePreparedTask(issue, branch, name) {
  if ([issue, branch, name].some(hasUnsafeCharacter)) return fail('invalid argument');
  if (!DIGITS_PATTERN.test(issue) || Number(issue) === 0) return fail('invalid issue number');
  if (!isSafeBranchName(branch) || branch.startsWith('refs/')) return fail(`unsafe branch name: ${JSON.stringify(branch)}`);
  if (PROTECTED_BRANCH_NAMES.includes(branch)) return fail('working branch cannot be the base or a protected name');
  if (!branch.includes(`/${issue}-`)) return fail(`branch must look like <kind>/${issue}-...`);
  if (!WORKTREE_NAME_PATTERN.test(name)) return fail('worktree name must be letters, digits and hyphens only');
  return { ok: true, bin: 'git', issue, branch, name };
}

function parsePrepareWorktree(tokens) {
  if (tokens.length !== 4) return fail('usage: prepare worktree <base> <issue number> <branch> <worktree name>');
  const [base, issue, branch, name] = tokens;
  if (hasUnsafeCharacter(base) || !isSafeBranchName(base) || base.startsWith('refs/')) return fail(`unsafe base: ${JSON.stringify(base)}`);
  const parsed = validatePreparedTask(issue, branch, name);
  if (!parsed.ok) return parsed;
  if (branch === base) return fail('working branch cannot be the base or a protected name');
  return { ...parsed, operation: 'prepare-worktree', base, needsGitHub: true, needsGh: true };
}

// 起動元が作成済みの worktree を引き受ける操作は `prepare adopt-worktree <base> <issue番号> <ブランチ> <worktree名>`。引数の規則は prepare worktree と同じ。
function parsePrepareAdoptWorktree(tokens) {
  if (tokens.length !== 4) return fail('usage: prepare adopt-worktree <base> <issue number> <branch> <worktree name>');
  const parsed = parsePrepareWorktree(tokens);
  return parsed.ok ? { ...parsed, operation: 'prepare-adopt-worktree' } : parsed;
}

// 引数の規則は adopt と共有するが、基点・通信は復帰には不要。
function parsePrepareReattachBranch(tokens) {
  if (tokens.length !== 3) return fail('usage: prepare reattach-branch <issue number> <branch> <worktree name>');
  const parsed = validatePreparedTask(...tokens);
  if (!parsed.ok) return parsed;
  return { ...parsed, operation: 'prepare-reattach-branch' };
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

// ファイル入力（--title-file / --body-file）を持つ解析結果に、実行段階で読むための textFiles を付ける（pr create / issue create / issue comment / pr comment 共通）。
function withTextFiles(parsed, build) {
  if (!parsed.ok) return parsed;
  const built = build(parsed);
  const hasFiles = parsed.textFiles.title !== undefined || parsed.textFiles.body !== undefined;
  return hasFiles ? { ...built, textFiles: parsed.textFiles } : built;
}

/**
 * 入口に渡された argv（`git status` など）を検証し、実行する git / gh の argv に組み立て直す。
 * 許可リストに無いものはすべて ok: false（理由つき）。
 * @param {ReadonlyArray<string>} argv 先頭が操作名（git / gh）の引数列
 * @returns {{ok: true, operation?: string, bin?: string, args?: string[], requiresBoundRepository?: boolean, needsGitHub?: boolean} | {ok: false, error: string}}
 */
function parseTaskCommand(argv) {
  if (!Array.isArray(argv) || argv.some((token) => typeof token !== 'string')) return fail('invalid argument list');
  const [tool, ...rest] = argv;
  if (tool === 'protected-sync') {
    if (rest.length !== 1 || !PROTECTED_SYNC_TARGETS.some((entry) => entry.target === rest[0])) return fail('protected-sync target is not registered');
    return { ok: true, operation: 'protected-sync', target: rest[0], requiresBoundRepository: true };
  }
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
      case 'merge-base': return parseGitMergeBase(tokens);
      case 'add': return parseGitAdd(tokens);
      case 'commit': return parseGitCommit(tokens);
      case 'push': return parseGitPush(tokens);
      case 'fetch': return parseGitNoArguments('fetch', tokens, { operation: 'fetch-default-branch' });
      case 'merge': return parseGitNoArguments('merge', tokens, { operation: 'merge-default-branch', branchAction: 'merge' });
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
    const operationName = `gh ${group} ${action}`;
    const command = (parts, args) => ({ ...ghCommand(parts, args), ...(targetRepo === undefined ? {} : { targetRepo }) });
    if (Object.hasOwn(GH_OPERATION_HANDLERS, operationName)) {
      return GH_OPERATION_HANDLERS[operationName](tokens, targetRepo, command);
    }
    return fail(`gh ${[group, action].filter((part) => part !== undefined).map((part) => JSON.stringify(part)).join(' ')} is not allowed`);
  }
  if (tool === 'prepare') {
    const [target, ...tokens] = rest;
    if (target === 'worktree') return parsePrepareWorktree(tokens);
    if (target === 'reattach-branch') return parsePrepareReattachBranch(tokens);
    if (target === 'adopt-worktree') return parsePrepareAdoptWorktree(tokens);
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

// git merge だけが追加で拒否する項目。リポジトリ内の設定で merge の戦略・オプション・署名検証を差し替えられると、
// 入口が固定した引数（--strategy=ort など）の前提が崩れるため。他の操作には影響させない。
const MERGE_UNSAFE_GIT_CONFIG_PATTERNS = Object.freeze([
  /^branch\..*\.mergeoptions$/,
  /^pull\.(twohead|octopus)$/,
  /^merge\.verifysignatures$/,
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
 * git merge の前に、merge の戦略・オプションを差し替えうる設定項目を探す。見つかった最初のキー（無ければ null）。
 * @param {string} output `git config --list --null` の出力
 * @returns {string|null}
 */
function findMergeUnsafeKey(output) {
  for (const { rawKey, key } of listConfigRecords(output)) {
    if (MERGE_UNSAFE_GIT_CONFIG_PATTERNS.some((pattern) => pattern.test(key.toLowerCase()))) return rawKey;
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
  return { ok: true, root, repo: parseGitHubRepo(originUrl), networkUnsafeKey: findNetworkUnsafeKey(listing.stdout), mergeUnsafeKey: findMergeUnsafeKey(listing.stdout) };
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
 * @param {{cwd: string, run: Function, action?: string}} params action は拒否メッセージに入れる操作名（既定は commit。git merge は merge）
 * @returns {string|null}
 */
function checkCommitBranch({ cwd, run, action = 'commit' }) {
  const head = run(['symbolic-ref', '-q', 'HEAD'], cwd);
  const ref = head.status === 0 ? String(head.stdout).trim() : '';
  if (ref === '') return `task command rejected: cannot ${action} on a detached HEAD; switch to a working branch first`;
  if (!ref.startsWith('refs/heads/')) return 'task command rejected: HEAD does not point to a local branch; switch to a working branch first';
  const defaults = defaultBranchRefs({ cwd, run });
  if (defaults.has(ref)) return `task command rejected: cannot ${action} on the default branch ${JSON.stringify(ref.slice('refs/heads/'.length))}; switch to a working branch first`;
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

/** 拘束した URL からブランチ 1 本だけを refs/remotes/origin/<ブランチ> へ取得する fetch の引数（prepare worktree と git fetch が共有する）。 */
function boundFetchArgs(binding, branch, gitDir = null) {
  return [
    ...FIXED_GIT_PREFIX, ...networkGitConfig(binding),
    // 設定の一覧にも現れる値のため、FIXED_GIT_PREFIX ではなく取得の引数にだけ付ける（設定の検査が自分の指定を拒否しないように）。
    '-c', 'core.alternateRefsCommand=',
    ...(gitDir === null ? [] : [`--git-dir=${gitDir}`]),
    'fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', boundRemoteUrl(binding), `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
  ];
}

function networkEnvironment(binding) {
  return buildChildEnvironment(binding, { allowProtocol: binding.remoteBase.startsWith('https://') ? 'https' : 'file' });
}

// ─── 書き込み先を OS が制限して実行する（書き込み先の制限） ─────────────

const SANDBOX_EXEC_PATH = '/usr/bin/sandbox-exec';

/**
 * コマンドを、書き込み先を allowWrite 配下に限る OS 制限（macOS の sandbox-exec / Linux の bubblewrap）で包む。
 * macOS は書き込み時にリンクを解決した実パスを判定する。Linux は検査済みディレクトリを記述子で bind する。
 * 許可した場所の外には書けない。denyWrite は allowWrite の内側で、書き込みを禁じる場所（フックや設定ファイルなど）。
 * macOS のパスは -D の値として渡す。Linux は O_NOFOLLOW で開いた実体を --bind-fd で固定し、denyWrite を必要とする既存操作は拒否する。
 * @param {{bin: string, args: string[], allowWrite: string[], denyWrite?: string[], snapshot?: Array<{path: string, dev: number, ino: number}>, directoryFds?: number[]}} params 許可・禁止のパスは固定の絶対パス
 * @param {{platform?: string, fs?: object, spawnSync?: Function}} deps OS・ファイルシステムのテスト用差し替え
 * @returns {{bin: string, args: string[], stdio?: Array, close?: Function}} Linux は起動後に close で親の記述子を閉じる
 */
function restrictWrites({ bin, args, allowWrite, denyWrite = [], snapshot = [], directoryFds = [] }, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'linux') {
    if (denyWrite.length) throw new TrustError('write-restricted execution is not available');
    const fsImpl = deps.fs || nodeFs;
    const executable = resolveTrustedPath(fsImpl, '/usr/bin/bwrap', { uid: 0, finalKind: 'file' }).realPath;
    const spawnSync = deps.spawnSync || childProcess.spawnSync;
    const help = spawnSync(executable, ['--help'], { env: {}, encoding: 'utf8', timeout: 10000 });
    if (help.status !== 0 || !String(help.stdout).includes('--bind-fd')) throw new TrustError('write-restricted execution is not available');
    const fds = [];
    try {
      const binds = allowWrite.flatMap((dir, index) => {
        // 呼び出し元の記述子を複製し、ラッパーが所有する分だけ閉じる。
        const fd = directoryFds[index] === undefined
          ? fsImpl.openSync(dir, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY | nodeFs.constants.O_NOFOLLOW)
          : fsImpl.openSync(`/proc/self/fd/${directoryFds[index]}`, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY);
        fds.push(fd);
        const actual = fsImpl.fstatSync(fd);
        const expected = snapshot.find((entry) => entry.path === dir);
        if (!actual.isDirectory() || (expected && (actual.dev !== expected.dev || actual.ino !== expected.ino))) throw new TrustError('write directory changed');
        return ['--dir', `/run/vk-protected-sync/target${index}`, '--bind-fd', String(2 + fds.length), `/run/vk-protected-sync/target${index}`];
      });
      return { bin: executable, args: ['--ro-bind', '/', '/', '--dev', '/dev', '--new-session', '--die-with-parent', '--unshare-net',
        '--dir', '/run', '--tmpfs', '/run', '--dir', '/run/vk-protected-sync',
        ...binds, '--', bin, ...args], stdio: ['pipe', 'pipe', 'pipe', ...fds],
        close: () => fds.forEach((fd) => fsImpl.closeSync(fd)) };
    } catch (error) {
      fds.forEach((fd) => fsImpl.closeSync(fd));
      throw error;
    }
  }
  if (platform !== 'darwin') throw new TrustError('write-restricted execution is not available');
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

// 対応表は入口の配布コードだけが持つ。リポジトリ・環境変数から追加しない。
const PROTECTED_SYNC_TARGETS = Object.freeze([Object.freeze({
  repo: 'vektor-inc/vk-orchestrator', source: 'src/help/helper-skill.md', target: '.agents/skills/vk-orchestrator-helper/SKILL.md',
})]);

// 能力照会と実行で Git・Node の信頼性と、書き込み先 bind を通る同じ起動テストを使う。
function getProtectedSyncCapabilities(deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  let probe;
  try {
    const platform = deps.platform || process.platform;
    if (platform === 'darwin') resolveTrustedPath(fsImpl, SANDBOX_EXEC_PATH, { finalKind: 'file' });
    const git = deps.git || resolveTrustedExecutable(fsImpl, 'git', deps.toolDirs || listToolSearchDirs(require('node:os').homedir(), process.env.PATH), { uid: deps.uid });
    resolveTrustedPath(fsImpl, git, { finalKind: 'file', uid: deps.uid });
    const version = spawnSync(git, ['version'], { env: {}, encoding: 'utf8', timeout: 10000 });
    if (version.status !== 0 || !isSupportedGitVersion(version.stdout)) throw new Error('unsupported Git');
    const node = resolveTrustedPath(fsImpl, process.execPath, { finalKind: 'file', uid: deps.uid }).realPath;
    // root 所有の固定フォルダで起動だけを確かめ、照会では書き込まない。
    const fixed = resolveTrustedPath(fsImpl, '/usr', { uid: 0, finalKind: 'directory' }).realPath;
    const stat = fsImpl.lstatSync(fixed);
    probe = restrictWrites({ bin: node, args: ['-e', 'process.exit(0)'], allowWrite: [fixed],
      snapshot: [{ path: fixed, dev: stat.dev, ino: stat.ino }] }, deps);
    const result = spawnSync(probe.bin, probe.args, { env: {}, encoding: 'utf8', timeout: 10000, stdio: probe.stdio });
    if (result.error || result.status !== 0) throw new Error('probe failed');
    return { available: true, reason: null, targets: PROTECTED_SYNC_TARGETS };
  } catch (_error) {
    return { available: false, reason: 'write-restricted execution is not available', targets: PROTECTED_SYNC_TARGETS };
  } finally {
    if (probe && probe.close) probe.close();
  }
}

/**
 * 実行ファイルの探索先を決める。固定の場所を先に、次にアプリ自身の PATH の絶対パス（Volta など利用者がインストールした場所）。
 * ここで挙げるのは候補だけで、採用するかは resolveTrustedExecutableDetailed が所有者・権限で検証する。
 * Codex 実行時の PATH は使わない（決めた絶対パスをランチャーへ固定する）。
 */
function listToolSearchDirs(homeDir, pathEnv) {
  const fromPath = String(pathEnv || '').split(path.delimiter).filter((entry) => path.isAbsolute(entry));
  // mise の global / latest は実バージョンのフォルダへのリンク。リンクの向き先も resolveTrustedExecutableDetailed が 1 段ずつ検証する。shims は mise 本体へのリンクのため対象にしない。
  const miseNodeDirs = ['global', 'latest'].map((alias) => path.join(homeDir, '.local', 'share', 'mise', 'installs', 'node', alias, 'bin'));
  return [...new Set(['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', path.join(homeDir, '.volta', 'bin'), ...miseNodeDirs, ...fromPath])];
}

// 起動時の関数だけを子へ渡し、照会時にリポジトリのコードを読み直さない。
const capabilityCode = [
  "const nodeFs=require('node:fs'),path=require('node:path'),childProcess=require('node:child_process');",
  `const TRUSTED_GROUP_IDS=${JSON.stringify(TRUSTED_GROUP_IDS)},MAX_LINK_HOPS=${MAX_LINK_HOPS},TOOL_NAME_PATTERN=${TOOL_NAME_PATTERN},MIN_GIT_VERSION=${JSON.stringify(MIN_GIT_VERSION)},SANDBOX_EXEC_PATH=${JSON.stringify(SANDBOX_EXEC_PATH)},PROTECTED_SYNC_TARGETS=${JSON.stringify(PROTECTED_SYNC_TARGETS)};`,
  TrustError, currentUid, isTrustedOwner, hasUntrustedWrite, resolveTrustedPath,
  resolveTrustedExecutableDetailed, resolveTrustedExecutable, isSupportedGitVersion,
  listToolSearchDirs, restrictWrites, getProtectedSyncCapabilities,
].map(String).join('\n');

// main プロセスを止めず、同時照会だけをまとめる。失敗は保持しない。
let capabilityPromise;
function getProtectedSyncCapabilitiesAsync(deps = {}) {
  if (capabilityPromise) return capabilityPromise;
  const unavailable = { available: false, reason: 'write-restricted execution is not available', targets: PROTECTED_SYNC_TARGETS };
  const pending = Promise.resolve().then(() => new Promise((resolve) => {
    const fsImpl = deps.fs || nodeFs;
    // ランチャーと同じ候補を所有者・権限で検証する。
    const toolDirs = listToolSearchDirs(require('node:os').homedir(), process.env.PATH);
    const node = resolveTrustedExecutable(fsImpl, 'node', toolDirs);
    if (node === null) { resolve(unavailable); return; }
    (deps.execFile || childProcess.execFile)(node, ['-e', capabilityCode + `\nprocess.stdout.write(JSON.stringify(getProtectedSyncCapabilities({toolDirs:${JSON.stringify(toolDirs)}})))`],
      { env: {}, timeout: 40000 }, (error, stdout) => {
        try { resolve(error ? unavailable : JSON.parse(stdout)); }
        catch (_) { resolve(unavailable); }
      });
  }));
  // 探索や起動の同期例外も利用不可へ変換し、拒否を呼び出し元へ渡さない。
  capabilityPromise = pending.catch(() => unavailable).finally(() => { capabilityPromise = undefined; });
  return capabilityPromise;
}

// 生成元の読み取りは短命の子だけで作業フォルダを移動して行う。
function protectedSourceChild() {
  const fs = require('node:fs');
  const held = [];
  try {
    const { rootIdentity, segments, limit } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const root = fs.statSync('.');
    if (!root.isDirectory() || root.dev !== rootIdentity.dev || root.ino !== rootIdentity.ino) throw new Error('source root changed');
    for (const name of segments.slice(0, -1)) {
      const fd = fs.openSync(name, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
      held.push(fd);
      const opened = fs.fstatSync(fd);
      if (!opened.isDirectory()) throw new Error('source directory required');
      process.chdir(name);
      const current = fs.statSync('.');
      if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('source directory changed');
    }
    const fd = fs.openSync(segments[segments.length - 1], fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    held.push(fd);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit) throw new Error('invalid source file');
    // 読み取り前に親からの相対名と記述子を照合する。
    const current = fs.lstatSync(segments[segments.length - 1]);
    if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1) throw new Error('source name changed');
    // 読み取り量を上限 + 1 バイトに固定する。
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = fs.readSync(fd, buffer, size, buffer.length - size, size);
      if (!count) break;
      size += count;
    }
    if (size > limit) throw new Error('source exceeds limit');
    process.stdout.write(buffer.subarray(0, size));
  } catch (error) {
    process.stderr.write(`protected-sync source rejected: ${error.message}\n`);
    process.exitCode = 2;
  } finally {
    for (const fd of held.reverse()) fs.closeSync(fd);
  }
}

// 子へ送る固定コード。標準モジュールだけを使い、作業リポジトリのコードを実行しない。
function protectedSyncChild() {
  const fs = require('node:fs');
  const path = require('node:path');
  const crypto = require('node:crypto');
  let temporary;
  let directoryFd;
  try {
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const { parent, snapshot, target, bytes, mode } = input;
    // 子は sandbox 内の親を開き、以後はその記述子を使う。
    directoryFd = fs.openSync(parent, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_DIRECTORY);
    const stat = fs.fstatSync(directoryFd);
    const expected = snapshot.find((entry) => entry.path === parent);
    if (!expected || !stat.isDirectory() || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new Error('parent changed after verification');
    const directory = process.platform === 'linux' ? `/proc/self/fd/${directoryFd}` : parent;
    const destination = path.join(directory, path.basename(target));
    const content = Buffer.from(bytes, 'base64');
    temporary = path.join(directory, `.protected-sync-${crypto.randomBytes(16).toString('hex')}`);
    const fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode & 0o777);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, destination);
    temporary = undefined;
    const readFd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      const finalStat = fs.fstatSync(readFd);
      if (!finalStat.isFile() || finalStat.nlink !== 1 || !fs.readFileSync(readFd).equals(content)) throw new Error('copied bytes do not match');
    } finally { fs.closeSync(readFd); }
  } catch (error) {
    process.stderr.write(`task command rejected: protected-sync failed: ${error.message}\n`);
    process.exitCode = 2;
  } finally {
    if (temporary) { try { fs.unlinkSync(temporary); } catch (_) {} }
    if (directoryFd !== undefined) fs.closeSync(directoryFd);
  }
}

function executeProtectedSync({ parsed, binding, cwd, fsImpl, runGit, spawnSync, env, reject, inspected, deps }) {
  const entry = PROTECTED_SYNC_TARGETS.find((entry) => entry.target === parsed.target);
  if (binding.repo !== entry.repo || inspected.repo !== entry.repo) return reject('task command rejected: protected-sync repository is not registered');
  if (binding.member && binding.member.parentSandbox === 'read-only') return reject('task command rejected: protected-sync requires write access');
  const heldFds = [];
  try {
    const root = fsImpl.realpathSync(cwd);
    const rootIdentity = inspected.rootIdentity;
    if (root !== path.resolve(cwd) || root !== inspected.root) throw new TrustError('protected-sync must run at the registered worktree root');
    const listed = runGit(['worktree', 'list', '--porcelain', '-z'], binding.root);
    if (listed.status !== 0 || !String(listed.stdout).split('\0').includes(`worktree ${root}`)) throw new TrustError('worktree is not registered');
    const paths = [entry.source, entry.target];
    const conflict = runGit(['ls-files', '--unmerged', '--', ...paths], cwd);
    if (conflict.status !== 0 || String(conflict.stdout) !== '') throw new TrustError('source or target has unresolved index entries');
    const tracked = runGit(['ls-files', '--error-unmatch', '--', entry.target], cwd);
    if (tracked.status !== 0) throw new TrustError('protected-sync target is not tracked');
    const capability = getProtectedSyncCapabilities({ ...deps, git: binding.git });
    if (!capability.available) throw new TrustError(capability.reason);
    const linux = (deps.platform || process.platform) === 'linux';
    const snapshot = [];
    let sourceFd;
    let sourceParentFd;
    let parentFd;
    let targetStat;
    // Linux は worktree の記述子から各要素を一段ずつ開く。
    let rootFd;
    if (linux) {
      const expected = rootIdentity;
      rootFd = fsImpl.openSync(root, nodeFs.constants.O_RDONLY | nodeFs.constants.O_DIRECTORY | nodeFs.constants.O_NOFOLLOW);
      heldFds.push(rootFd);
      const actual = fsImpl.fstatSync(rootFd);
      if (!actual.isDirectory() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new TrustError('worktree root changed');
    }

    for (const relative of paths) {
      let current = root;
      let parent = rootFd;
      const segments = relative.split('/');
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index];
        const file = index === segments.length - 1;
        current = path.join(current, segment);
        let stat;
        let opened;
        if (linux) {
          opened = fsImpl.openSync(`/proc/self/fd/${parent}/${segment}`, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK | (file ? 0 : nodeFs.constants.O_DIRECTORY));
          heldFds.push(opened);
          stat = fsImpl.fstatSync(opened);
        } else {
          stat = fsImpl.lstatSync(current);
        }
        if (stat.isSymbolicLink() || (file ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new TrustError('source or target is a link or not a regular path');
        snapshot.push({ path: current, dev: stat.dev, ino: stat.ino, file });
        if (file && relative === entry.source) { sourceFd = opened; sourceParentFd = parent; }
        if (file && relative === entry.target) { parentFd = parent; targetStat = stat; }
        parent = opened;
      }
    }
    const source = path.join(root, entry.source);
    const node = resolveTrustedPath(fsImpl, process.execPath, { finalKind: 'file', uid: deps.uid }).realPath;
    let content;
    if (!linux) {
      const read = spawnSync(node, ['-e', `(${protectedSourceChild.toString()})()`], { cwd: root, env, timeout: 10000, maxBuffer: PROTECTED_SYNC_MAX_SOURCE_BYTES + 1024,
        input: JSON.stringify({ rootIdentity, segments: entry.source.split('/'), limit: PROTECTED_SYNC_MAX_SOURCE_BYTES }) });
      if (read.error || read.status !== 0 || !Buffer.isBuffer(read.stdout) || read.stdout.length > PROTECTED_SYNC_MAX_SOURCE_BYTES) throw new TrustError('protected-sync source could not be verified');
      content = Buffer.from(read.stdout);
    } else {
      const fd = sourceFd;
      const stat = fsImpl.fstatSync(fd);
      const expected = snapshot.find((entry) => entry.path === source);
      if (!stat.isFile() || stat.nlink !== 1 || stat.dev !== expected.dev || stat.ino !== expected.ino) throw new TrustError('source changed after verification');
      if (stat.size > PROTECTED_SYNC_MAX_SOURCE_BYTES) throw new TrustError('protected-sync source exceeds 256 KiB');
      // 読み取り前に親の記述子からの相対名を照合する。
      const current = fsImpl.lstatSync(`/proc/self/fd/${sourceParentFd}/${path.basename(entry.source)}`);
      if (!current.isFile() || current.dev !== stat.dev || current.ino !== stat.ino || current.nlink !== 1) throw new TrustError('source name changed');
      // 上限 + 1 バイトまでに制限し、並行した追記でも無制限に読み込まない。
      const buffer = Buffer.alloc(PROTECTED_SYNC_MAX_SOURCE_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const count = fsImpl.readSync(fd, buffer, size, buffer.length - size, size);
        if (count === 0) break;
        size += count;
      }
      if (size > PROTECTED_SYNC_MAX_SOURCE_BYTES) throw new TrustError('protected-sync source exceeds 256 KiB');
      content = buffer.subarray(0, size);
    }
    const destination = path.join(root, entry.target);
    const parent = path.dirname(destination);
    const command = restrictWrites({ bin: node, args: ['-e', `(${protectedSyncChild.toString()})()`], allowWrite: [parent], snapshot, directoryFds: linux ? [parentFd] : [] }, deps);
    let result;
    try { result = spawnSync(command.bin, command.args, { cwd: root, env, encoding: 'utf8', timeout: 30000, stdio: command.stdio,
      input: JSON.stringify({ parent: linux ? '/run/vk-protected-sync/target0' : parent,
        snapshot: [{ ...snapshot.find((item) => item.path === parent), path: linux ? '/run/vk-protected-sync/target0' : parent }],
        target: destination, bytes: content.toString('base64'), mode: targetStat.mode }) });
    } finally { if (command.close) command.close(); }
    if (result.error || result.status !== 0) return reject(`task command rejected: write-restricted execution is not available or protected-sync failed${result.stderr ? `: ${String(result.stderr).trim()}` : ''}`);
    return 0;
  } catch (error) {
    return reject(`task command rejected: ${error instanceof TrustError ? error.message : 'protected-sync paths could not be verified'}`);
  } finally {
    for (const fd of heldFds.reverse()) fsImpl.closeSync(fd);
  }
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

// ─── デフォルトブランチの取得と取り込み（git fetch / git merge。issue #479） ─────────────

/**
 * 拘束した owner/repo のデフォルトブランチ名を GitHub から読む（gh api の固定エンドポイント）。読めない・安全でない名前なら null。
 * origin/HEAD や呼び出し側の指定は使わない。
 */
function readDefaultBranch({ binding, cwd, env, spawnSync }) {
  const result = spawnSync(binding.gh, ['api', '--jq', '.default_branch', `repos/${binding.repo}`], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  if (result.error || result.status !== 0) return null;
  const name = String(result.stdout || '').trim();
  return isSafeBranchName(name) && !name.startsWith('refs/') && name !== 'HEAD' ? name : null;
}

/**
 * 書き込み制限つき fetch の共通準備（git fetch と prepare worktree が共有する）。
 * 制限をかけられない環境（sandbox-exec が無い・信頼できない、Git 管理領域・gh 設定が解決できない）では ok: false を返す。
 * 返すもの: Git の制御ファイル（hooks・config・config.worktree・info/attributes・objects/info。extraControlFiles で追加可）を書けなくした実行の包み、
 * 追跡 ref 1 本分の書き込み許可パス（ref・ログとそれぞれのロック）、親フォルダの計算と作成、base を取得する関数。
 * @param {{binding: object, cwd: string, fsImpl: object, runGit: Function, spawnSync: Function, plainEnv: object, deps: object, base: string, extraControlFiles?: Function}} params
 *   extraControlFiles(gitPath) は追加で書き込みを禁じるパスの配列を返す
 *   commonDir / gitDir は検査済みの値を呼び出し側が渡す場合の固定先（省略時はここで 1 度だけ求める）。取得は常に gitDir を明示して実行し、
 *   その gitDir の設定を取得の直前に検査し直す
 */
function prepareRestrictedFetch({ binding, cwd, fsImpl, runGit, spawnSync, plainEnv, deps, base, extraControlFiles = () => [], commonDir: givenCommonDir = null, gitDir: givenGitDir = null }) {
  if ((deps.platform || process.platform) !== 'darwin') return { ok: false, error: 'task command rejected: write-restricted execution is not available' };
  const commonDir = givenCommonDir === null ? resolveGitCommonDir({ dir: cwd, run: runGit, fsImpl }) : givenCommonDir;
  let gitDir = givenGitDir;
  let ghConfigReal = null;
  try {
    resolveTrustedPath(fsImpl, SANDBOX_EXEC_PATH, { uid: deps.uid, finalKind: 'file' });
    if (commonDir === null) throw new TrustError('git directory could not be resolved');
    if (gitDir === null) {
      const resolved = runGit(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
      if (resolved.status !== 0) throw new TrustError('git directory could not be resolved');
      gitDir = fsImpl.realpathSync(path.resolve(cwd, String(resolved.stdout).trim()));
    }
    ghConfigReal = resolveTrustedPath(fsImpl, binding.ghConfig, { uid: deps.uid, rejectFinalLink: true }).realPath;
  } catch (_error) {
    return { ok: false, error: 'task command rejected: write-restricted execution is not available' };
  }
  // 固定した gitDir の設定を検査し直す（呼び出し側の検査は、固定前の .git を通した結果のため）。
  const listing = spawnSync(binding.git, [...FIXED_GIT_PREFIX, `--git-dir=${gitDir}`, 'config', '--list', '--null'], { cwd, env: plainEnv, encoding: 'utf8' });
  if (listing.error || listing.status !== 0) return { ok: false, error: 'task command rejected: repository configuration could not be read' };
  const pinnedUnsafe = inspectGitConfigListing(listing.stdout).unsafeKey || findNetworkUnsafeKey(listing.stdout);
  if (pinnedUnsafe) return { ok: false, error: `task command rejected: repository configuration is not allowed: ${JSON.stringify(pinnedUnsafe)}` };
  // 各段階が書いてよい場所は、その段階が実際に書く場所だけに絞る（Git 管理領域全体は許さない）。
  const gitPath = (...parts) => path.join(commonDir, ...parts);
  const controlFiles = [
    gitPath('hooks'), gitPath('config'), gitPath('config.worktree'), gitPath('info', 'attributes'), gitPath('objects', 'info'),
    ...extraControlFiles(gitPath),
  ];
  const restricted = (command, allowWrite) => restrictWrites({ ...command, allowWrite, denyWrite: controlFiles });
  const runRestricted = (command, options) => spawnSync(command.bin, command.args, { cwd, encoding: 'utf8', ...options });
  // ref とログは「その 1 本のファイルとロックファイル」だけに書き込みを許す（refs/heads などの階層全体は許さない）。
  const refFile = (...parts) => gitPath('refs', ...parts);
  const logFile = (...parts) => gitPath('logs', 'refs', ...parts);
  const remoteParts = ['remotes', 'origin', ...base.split('/')];
  const writableRef = (parts) => [refFile(...parts), `${refFile(...parts)}.lock`, logFile(...parts), `${logFile(...parts)}.lock`];
  // 作る必要がある親フォルダ（mkdir は作るだけで、既存の中身には触れない）。
  const parentDirs = (parts) => {
    const dirs = [];
    for (let i = 1; i < parts.length; i += 1) dirs.push(refFile(...parts.slice(0, i)), logFile(...parts.slice(0, i)));
    return dirs;
  };
  // 書き込みを許すのは「まだ存在しないフォルダ」だけ（既存のフォルダの中身には書き込み権を与えない）。
  const makeDirs = (dirs) => {
    const missing = dirs.filter((dir) => lstatOrNull(fsImpl, dir) === null);
    if (missing.length === 0) return true;
    const made = runRestricted(restricted({ bin: '/bin/mkdir', args: ['-p', '--', ...missing] }, missing), { env: plainEnv });
    return !made.error && made.status === 0;
  };
  // 取得（通信あり）。書き込み先は、取得したオブジェクトと base の追跡 ref と gh の設定だけ。
  const fetchBase = (networkEnv) => {
    // 固定した gitDir が、リンクや .git ファイルに差し替わっていないフォルダのままであることを実行の直前に確かめる。
    const gitDirStat = lstatOrNull(fsImpl, gitDir);
    if (gitDirStat === null || gitDirStat.isSymbolicLink() || !gitDirStat.isDirectory()) return { error: { code: 'EGITDIR' } };
    return runRestricted(
      restricted({ bin: binding.git, args: boundFetchArgs(binding, base, gitDir) }, [gitPath('objects'), ...writableRef(remoteParts), ghConfigReal]),
      { env: networkEnv, stdio: 'inherit' },
    );
  };
  return { ok: true, gitDir, gitPath, restricted, runRestricted, writableRef, parentDirs, makeDirs, remoteParts, fetchBase };
}

/**
 * `git fetch`（引数なし）。GitHub から読んだデフォルトブランチだけを、拘束した URL から refs/remotes/origin/<デフォルトブランチ> へ取得する。
 * prepare worktree の取得と同じ引数（boundFetchArgs）・同じ書き込み制限（取得したオブジェクト・その 1 本の追跡 ref とログ・gh の設定だけ）で実行する。
 */
function executeFetchDefaultBranch({ binding, cwd, fsImpl, runGit, spawnSync, networkEnv, plainEnv, reject, inspected, writeOut, deps }) {
  if (inspected.networkUnsafeKey) return reject(`task command rejected: repository configuration can redirect network access: ${JSON.stringify(inspected.networkUnsafeKey)}`);
  const base = readDefaultBranch({ binding, cwd, env: plainEnv, spawnSync });
  if (base === null) return reject('task command rejected: default branch could not be read from GitHub');
  const remoteRef = `refs/remotes/origin/${base}`;

  const prepared = prepareRestrictedFetch({ binding, cwd, fsImpl, runGit, spawnSync, plainEnv, deps, base });
  if (!prepared.ok) return reject(prepared.error);
  const { gitPath, parentDirs, makeDirs, remoteParts } = prepared;
  if (!makeDirs([gitPath('refs'), gitPath('logs'), gitPath('logs', 'refs'), ...parentDirs(remoteParts)])) return reject('task command rejected: could not prepare the git directories');

  const fetched = prepared.fetchBase(networkEnv);
  if (fetched.error) return reject(`task command failed to start: ${fetched.error.code || 'error'}`);
  if (fetched.status !== 0) return typeof fetched.status === 'number' ? fetched.status : 2;
  const sha = runGit(['rev-parse', '--verify', '-q', remoteRef], cwd);
  if (sha.status !== 0) return reject(`task command rejected: could not fetch the default branch ${JSON.stringify(base)}`);
  writeOut(`DEFAULT_BRANCH=${base}\nFETCHED_REF=${remoteRef}\nFETCHED_SHA=${String(sha.stdout).trim()}\n`);
  return 0;
}

/**
 * `git merge`（引数なし）。直前の `git fetch` で取得した refs/remotes/origin/<デフォルトブランチ> だけを、現在の作業ブランチへ merge commit つきで取り込む。
 * 作業ブランチ上であること（main / master・デフォルトブランチ・detached HEAD は実行前に拒否済み）・追跡ファイルの変更が無いこと・merge 中でないこと・取得済み ref があることを確かめる。
 * 競合したときは戻さず終了コード 1 で返し、Codex がファイルを直して既存の `git add` / `git commit -m` で完成させる。
 */
function executeMergeDefaultBranch({ binding, cwd, runGit, spawnSync, plainEnv, reject, inspected }) {
  if (inspected.mergeUnsafeKey) return reject(`task command rejected: repository configuration can change how merge works: ${JSON.stringify(inspected.mergeUnsafeKey)}`);
  const base = readDefaultBranch({ binding, cwd, env: plainEnv, spawnSync });
  if (base === null) return reject('task command rejected: default branch could not be read from GitHub');
  // ローカルの origin/HEAD が無くても、GitHub から読んだデフォルトブランチ上では取り込まない。
  const head = runGit(['symbolic-ref', '-q', 'HEAD'], cwd);
  if (head.status === 0 && String(head.stdout).trim() === `refs/heads/${base}`) return reject(`task command rejected: cannot merge on the default branch ${JSON.stringify(base)}; switch to a working branch first`);
  const remoteRef = `refs/remotes/origin/${base}`;
  if (runGit(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], cwd).status === 0) return reject('task command rejected: a merge is already in progress; finish it with git add and git commit first');
  const status = runGit(['status', '--porcelain', '--untracked-files=no'], cwd);
  if (status.status !== 0) return reject('task command rejected: working tree status could not be read');
  if (String(status.stdout).trim() !== '') return reject('task command rejected: uncommitted changes exist; commit them before git merge');
  if (runGit(['show-ref', '--verify', '--quiet', remoteRef], cwd).status !== 0) return reject(`task command rejected: ${remoteRef} has not been fetched; run git fetch first`);

  // 引数は固定。早送りで済む場合も merge commit を作り（--no-ff）、編集画面・フック・署名・stash は使わない。
  const args = [...FIXED_GIT_PREFIX, 'merge', '--no-ff', '--no-edit', '--no-squash', '--commit', '--strategy=ort', '--no-verify', '--no-verify-signatures', '--no-autostash', '--no-gpg-sign', '--no-rerere-autoupdate', remoteRef];
  const result = spawnSync(binding.git, args, { cwd, env: plainEnv, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) return reject(`task command failed to start: ${result.error.code || 'error'}`);
  return typeof result.status === 'number' ? result.status : 2;
}

// ─── レビュー合格ラベルの操作（gh label / gh pr の add-label・has-label） ─────────────

/**
 * vk-agents の vk-kore 9-3（label-exists / label-create / label-add / issue-has-label）と同じ判定語を返す。
 * gh の呼び出しは、入口が固定の owner/repo から組み立てた REST エンドポイントだけ（利用者は gh api を指定できない）。
 * `gh pr edit --add-label` は権限不足でも終了コード 0 のまま付かないことがあるため使わず、付与後は読み返して LABEL_OK / LABEL_NG で判定する。
 */
function executeReviewLabel({ parsed, binding, explicitGitHubTarget, spawnSync, env, cwd, reject, write, writeOut }) {
  const repo = explicitGitHubTarget || binding.repo;
  const labelsEndpoint = `repos/${repo}/labels`;
  const callGh = (args) => spawnSync(binding.gh, args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  const readNames = (endpoint) => {
    const result = callGh(['api', '--paginate', '--jq', '.[].name', `${endpoint}?per_page=100`]);
    if (result.error || result.status !== 0) return null;
    return String(result.stdout || '').split('\n').map((line) => line.replace(/\r$/, ''));
  };
  const hasLabel = (names) => names.includes(REVIEW_PASSED_LABEL);
  // 番号が PR であることを固定エンドポイント repos/<repo>/pulls/<番号> の取得で確かめる（issue 番号なら 404 になる）。
  const isPullRequest = () => {
    const result = callGh(['api', '--jq', '.number', `repos/${repo}/pulls/${parsed.number}`]);
    return !result.error && result.status === 0;
  };

  switch (parsed.operation) {
    case 'label-exists': {
      const names = readNames(labelsEndpoint);
      if (names === null) return reject('task command failed: could not read labels');
      writeOut(hasLabel(names) ? 'LABEL_EXISTS\n' : 'LABEL_MISSING\n');
      return 0;
    }
    case 'label-create': {
      const names = readNames(labelsEndpoint);
      if (names === null) return reject('task command failed: could not read labels');
      if (hasLabel(names)) {
        writeOut('LABEL_EXISTS\n');
        return 0;
      }
      const result = callGh([
        'api', '--method', 'POST', labelsEndpoint,
        '-f', `name=${REVIEW_PASSED_LABEL}`, '-f', `color=${REVIEW_PASSED_LABEL_COLOR}`, '-f', `description=${REVIEW_PASSED_LABEL_DESCRIPTION}`,
      ]);
      if (result.error) return reject(`task command failed to start: ${result.error.code || 'error'}`);
      if (result.status !== 0) {
        // 同時に別の実行が作った場合などに備え、一覧を読み直す。あれば成功、無ければ失敗のまま返す。
        const reread = readNames(labelsEndpoint);
        if (reread !== null && hasLabel(reread)) {
          writeOut('LABEL_EXISTS\n');
          return 0;
        }
        return typeof result.status === 'number' ? result.status : 2;
      }
      writeOut('LABEL_CREATED\n');
      return 0;
    }
    case 'pr-add-label': {
      if (!isPullRequest()) return reject(`task command rejected: ${parsed.number} is not a pull request of ${repo}, or it could not be read`);
      const result = callGh(['api', '--method', 'POST', `repos/${repo}/issues/${parsed.number}/labels`, '-f', `labels[]=${REVIEW_PASSED_LABEL}`]);
      if (result.error) return reject(`task command failed to start: ${result.error.code || 'error'}`);
      if (result.status !== 0) return typeof result.status === 'number' ? result.status : 2;
      // 付いたかどうかは、続けて has-label で読み返して確かめる（この出力だけで成功と見なさない）。
      writeOut('LABEL_ADDED\n');
      return 0;
    }
    case 'pr-has-label': {
      if (!isPullRequest()) {
        write(`task command failed: ${parsed.number} is not a pull request of ${repo}, or it could not be read\n`);
        writeOut('LABEL_NG\n');
        return 1;
      }
      const names = readNames(`repos/${repo}/issues/${parsed.number}/labels`);
      if (names !== null && hasLabel(names)) {
        writeOut('LABEL_OK\n');
        return 0;
      }
      if (names === null) write('task command failed: could not read PR labels\n');
      writeOut('LABEL_NG\n');
      return 1;
    }
    default:
      return reject('task command rejected: unknown label operation');
  }
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

// 本文の照合は、GitHub 側の改行コード（CRLF → LF）と末尾の空白の正規化を許す（gh pr edit の本文照合と同じ）。
function normalizeBody(value) {
  return String(value).replace(/\r\n/g, '\n').trimEnd();
}

/**
 * `gh issue edit <番号> --body-file <名前>`（issue #522）。固定したリポジトリの issue 本文だけを更新する。
 * 1. 本文ファイルを読んで検証する（ここまでに失敗したら gh を起動しない）。
 * 2. 拘束した --repo だけを付けて gh issue edit --body を実行する（読んだ値はシェルを通さず argv で渡す）。
 * 3. issue を読み戻し、本文が一致したときだけ成功とする（権限不足でも終了コード 0 で反映されないことがあるため、判定は 3 だけで行う）。
 */
function executeIssueEditBody({ parsed, binding, cwd, env, fsImpl, spawnSync, reject, writeOut, deps }) {
  let texts;
  try {
    texts = readPrTextFiles(parsed.textFiles, { binding, fsImpl, deps });
  } catch (error) {
    return reject(`task command rejected: ${error instanceof TrustError ? error.message : 'body file could not be verified'}`);
  }
  const runGh = (args) => spawnSync(binding.gh, args, { cwd, env, encoding: 'utf8' });
  const failed = (result) => Boolean(result.error) || result.status !== 0;
  const detail = (result) => String(result.stderr || '').trim().split('\n')[0] || (result.error && result.error.code) || `exit ${result.status}`;
  const edited = runGh(withBoundRepository(['issue', 'edit', parsed.number, '--body', texts.body], binding.repo));
  if (failed(edited)) return reject(`task command failed: gh issue edit failed: ${detail(edited)}`);
  const viewed = runGh(withBoundRepository(['issue', 'view', parsed.number, '--json', 'body'], binding.repo));
  if (failed(viewed)) return reject(`task command failed: could not verify the update: ${detail(viewed)}`);
  let issue;
  try {
    issue = JSON.parse(String(viewed.stdout));
  } catch (error) {
    return reject('task command failed: could not verify the update: unreadable response');
  }
  if (!(typeof (issue && issue.body) === 'string' && normalizeBody(issue.body) === normalizeBody(texts.body))) {
    return reject(`task command failed: the update was not applied: body of issue #${parsed.number} does not match`);
  }
  writeOut(`updated issue #${parsed.number}: body\n`);
  return 0;
}

/**
 * `gh issue edit <番号> --remove-label …`（issue #522）。固定したリポジトリの issue からラベルを外す。
 * gh issue edit は権限不足でも終了コード 0 で何もしないことがあるため、成功の判定は読み戻しで指定ラベルがすべて外れていることを確かめて行う。
 */
function executeIssueRemoveLabel({ parsed, binding, cwd, env, spawnSync, reject, writeOut }) {
  const runGh = (args) => spawnSync(binding.gh, args, { cwd, env, encoding: 'utf8' });
  const failed = (result) => Boolean(result.error) || result.status !== 0;
  const detail = (result) => String(result.stderr || '').trim().split('\n')[0] || (result.error && result.error.code) || `exit ${result.status}`;
  const editArgs = ['issue', 'edit', parsed.number];
  for (const label of parsed.removeLabels) editArgs.push('--remove-label', label);
  const edited = runGh(withBoundRepository(editArgs, binding.repo));
  if (failed(edited)) return reject(`task command failed: gh issue edit failed: ${detail(edited)}`);
  const viewed = runGh(withBoundRepository(['issue', 'view', parsed.number, '--json', 'labels'], binding.repo));
  if (failed(viewed)) return reject(`task command failed: could not verify the update: ${detail(viewed)}`);
  let issue;
  try {
    issue = JSON.parse(String(viewed.stdout));
  } catch (error) {
    return reject('task command failed: could not verify the update: unreadable response');
  }
  if (!Array.isArray(issue && issue.labels)) return reject('task command failed: could not verify the update: unreadable response');
  const currentLabels = new Set(issue.labels.map((item) => item && item.name));
  const remaining = parsed.removeLabels.find((label) => currentLabels.has(label));
  if (remaining !== undefined) return reject(`task command failed: the update was not applied: ${JSON.stringify(remaining)} is still on issue #${parsed.number}`);
  writeOut(`updated issue #${parsed.number}: removed labels=${JSON.stringify(parsed.removeLabels)}\n`);
  return 0;
}

/**
 * `gh issue close <番号> [--reason …]`（issue #522）。固定したリポジトリの issue を close する。
 * 成功の判定は読み戻しで state が CLOSED になったことを確かめて行う（--reason を指定したときは stateReason の一致も見る）。
 */
function executeIssueClose({ parsed, binding, cwd, env, spawnSync, reject, writeOut }) {
  const runGh = (args) => spawnSync(binding.gh, args, { cwd, env, encoding: 'utf8' });
  const failed = (result) => Boolean(result.error) || result.status !== 0;
  const detail = (result) => String(result.stderr || '').trim().split('\n')[0] || (result.error && result.error.code) || `exit ${result.status}`;
  const closeArgs = ['issue', 'close', parsed.number];
  if (parsed.reason !== undefined) closeArgs.push('--reason', parsed.reason);
  const closed = runGh(withBoundRepository(closeArgs, binding.repo));
  if (failed(closed)) return reject(`task command failed: gh issue close failed: ${detail(closed)}`);
  const viewed = runGh(withBoundRepository(['issue', 'view', parsed.number, '--json', 'state,stateReason'], binding.repo));
  if (failed(viewed)) return reject(`task command failed: could not verify the update: ${detail(viewed)}`);
  let issue;
  try {
    issue = JSON.parse(String(viewed.stdout));
  } catch (error) {
    return reject('task command failed: could not verify the update: unreadable response');
  }
  if (!(issue && issue.state === 'CLOSED')) return reject(`task command failed: the update was not applied: issue #${parsed.number} is not closed`);
  const expectedReason = parsed.reason === undefined ? undefined : parsed.reason.toUpperCase().replace(' ', '_');
  if (expectedReason !== undefined && issue.stateReason !== expectedReason) {
    return reject(`task command failed: the update was not applied: close reason of issue #${parsed.number} does not match`);
  }
  writeOut(`closed issue #${parsed.number}${parsed.reason === undefined ? '' : `: reason=${JSON.stringify(parsed.reason)}`}\n`);
  return 0;
}

// PR のタイトル・本文のファイルを読む（gh を起動する前に呼ぶ）。入出力フォルダの検証と読み込みは member start と同じ（readMemberInput）。
// 検証を通らなければ TrustError。返すのは { title, body }（指定の無い項目は undefined）。
function readPrTextFiles(textFiles, { binding, fsImpl, deps }) {
  const result = {};
  if (textFiles.title === undefined && textFiles.body === undefined) return result;
  const member = binding.member;
  if (member === null) throw new TrustError('--title-file / --body-file need the member input/output folder, which this launcher does not have');
  const uid = currentUid(deps);
  // 専用フォルダはランチャーが実パスで固定している。リンクを通る場合は拒否する。
  if (resolveTrustedPath(fsImpl, member.io, { uid, rejectFinalLink: true }).realPath !== member.io) throw new TrustError(`path is not a real directory: ${member.io}`);
  const decode = (name, maxBytes) => {
    const bytes = readMemberInput(fsImpl, member.io, name, maxBytes, uid);
    try {
      // 不正な UTF-8 は拒否する。BOM は内容として残す（読んだ値をそのまま gh へ渡す）。
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (error) {
      throw new TrustError(`${name} is not valid UTF-8`);
    }
  };
  if (textFiles.title !== undefined) {
    // タイトルは 1 行。末尾の改行 1 つだけ除き、ほかの制御文字（改行を含む）は拒否する。
    // 見えない文字（C1 制御文字・ゼロ幅/向き制御の文字・行区切り・BOM）も拒否する。ZWNJ/ZWJ（U+200C/D）は絵文字や一部の文字で正当に使うため許す。
    // 前後の空白は削ってから送る（GitHub 側の正規化で読み戻しが食い違わないようにするため）。
    const title = decode(textFiles.title, PR_TITLE_MAX_BYTES).replace(/\r?\n$/, '');
    if (PR_TITLE_FORBIDDEN_PATTERN.test(title)) throw new TrustError(`${textFiles.title} must be a single line without control characters`);
    if (title.trim() === '') throw new TrustError(`${textFiles.title} is blank`);
    if ([...title].length > PR_TITLE_MAX_CHARS) throw new TrustError(`${textFiles.title} is longer than ${PR_TITLE_MAX_CHARS} characters`);
    result.title = title.trim();
  }
  if (textFiles.body !== undefined) {
    // 本文は改行（\n \r）とタブだけ許す。
    // 先頭の BOM（Windows のエディタが付ける）は除去する。ほかの位置の U+FEFF は拒否する。
    const body = decode(textFiles.body, PR_BODY_MAX_BYTES).replace(/^\ufeff/, '');
    if (PR_BODY_FORBIDDEN_PATTERN.test(body)) throw new TrustError(`${textFiles.body} contains control characters`);
    if (body.trim() === '') throw new TrustError(`${textFiles.body} is blank`);
    if ([...body].length > PR_BODY_MAX_CHARS) throw new TrustError(`${textFiles.body} is longer than ${PR_BODY_MAX_CHARS} characters`);
    result.body = body;
  }
  return result;
}

// `gh pr edit` は題名・本文の更新だけ。実行の流れ:
// 1. --title-file / --body-file を読んで検証する（ここまでに失敗したら gh を起動しない）。
// 2. 拘束した --repo だけを付けて gh pr edit を実行する。
// 3. gh pr view で題名・本文を読み戻し、指定した値と一致したときだけ成功とする。gh pr edit は権限不足などで終了コード 0 のまま反映されないことがあるため、成功の判定は 3 だけで行う。
// 本文の照合は、GitHub 側の改行コード（CRLF → LF）と末尾の空白の正規化を許す。題名は完全一致で見る。
function executePrEdit({ parsed, binding, cwd, env, fsImpl, spawnSync, reject, writeOut, deps }) {
  let texts;
  try {
    texts = readPrTextFiles(parsed.textFiles, { binding, fsImpl, deps });
  } catch (error) {
    return reject(`task command rejected: ${error instanceof TrustError ? error.message : 'title/body file could not be verified'}`);
  }
  const title = parsed.title !== undefined ? parsed.title : texts.title;
  const body = parsed.body !== undefined ? parsed.body : texts.body;
  const runGh = (args) => spawnSync(binding.gh, args, { cwd, env, encoding: 'utf8' });
  const failed = (result) => Boolean(result.error) || result.status !== 0;
  const detail = (result) => String(result.stderr || '').trim().split('\n')[0] || (result.error && result.error.code) || `exit ${result.status}`;

  const editArgs = ['pr', 'edit', parsed.number];
  if (title !== undefined) editArgs.push('--title', title);
  if (body !== undefined) editArgs.push('--body', body);
  const edited = runGh(withBoundRepository(editArgs, binding.repo));
  if (failed(edited)) return reject(`task command failed: gh pr edit failed: ${detail(edited)}`);

  const viewed = runGh(withBoundRepository(['pr', 'view', parsed.number, '--json', 'title,body'], binding.repo));
  if (failed(viewed)) return reject(`task command failed: could not verify the update: ${detail(viewed)}`);
  let pr;
  try {
    pr = JSON.parse(String(viewed.stdout));
  } catch (error) {
    return reject('task command failed: could not verify the update: unreadable response');
  }
  const normalize = normalizeBody;
  const titleMismatch = title !== undefined && !(typeof (pr && pr.title) === 'string' && pr.title === title);
  const bodyMismatch = body !== undefined && !(typeof (pr && pr.body) === 'string' && normalize(pr.body) === normalize(body));
  if (titleMismatch || bodyMismatch) {
    return reject(`task command failed: the update was not applied: ${titleMismatch ? 'title' : 'body'} of PR #${parsed.number} does not match`);
  }
  writeOut(`updated PR #${parsed.number}: ${[title !== undefined ? 'title' : null, body !== undefined ? 'body' : null].filter(Boolean).join(', ')}\n`);
  return 0;
}

// `gh pr merge <番号>` は、PR・レビュー・CI・マージ可能状態を読み戻してから、確認済み head に固定して squash マージする。
// gh の終了コードだけでは成功とせず、最後に state が MERGED になったことを読み戻して判定する。
function executePrMerge({ parsed, binding, cwd, env, spawnSync, reject, writeOut }) {
  const runGh = (args) => spawnSync(binding.gh, withBoundRepository(args, binding.repo), { cwd, env, encoding: 'utf8' });
  const detail = (result) => String(result.stderr || '').trim().split('\n')[0] || (result.error && result.error.code) || `exit ${result.status}`;
  const parseJson = (result, description, { acceptNonzero = false } = {}) => {
    if (result.error || (!acceptNonzero && result.status !== 0)) return { error: `task command rejected: ${description} could not be read: ${detail(result)}` };
    try {
      return { value: JSON.parse(String(result.stdout)) };
    } catch (_error) {
      return { error: `task command rejected: ${description} returned invalid JSON` };
    }
  };

  // 1. PR の現在状態と、以降の判定・マージに固定する head SHA を読む。
  const fields = 'state,isDraft,headRefOid,labels,comments,mergeable,mergeStateStatus,statusCheckRollup';
  const viewed = parseJson(runGh(['pr', 'view', parsed.number, '--json', fields]), 'PR');
  if (viewed.error) return reject(viewed.error);
  const pr = viewed.value;
  if (!pr || pr.state !== 'OPEN') return reject(`task command rejected: PR state is ${JSON.stringify(pr && pr.state)} (expected OPEN)`);
  if (pr.isDraft !== false) return reject('task command rejected: PR is a draft');
  const head = pr.headRefOid;
  if (typeof head !== 'string' || !/^[0-9a-fA-F]{40}$/.test(head)) return reject('task command rejected: PR head SHA is missing or invalid');
  if (!Array.isArray(pr.statusCheckRollup)) return reject('task command rejected: PR statusCheckRollup is missing or invalid');

  // 2. ラベルと、権限のある投稿者による最新のレビュー完了マーカーが現在の head と一致することを確かめる。
  const labels = Array.isArray(pr.labels) ? pr.labels.map((label) => label && label.name) : [];
  if (!labels.includes(REVIEW_PASSED_LABEL)) return reject(`task command rejected: PR does not have the ${REVIEW_PASSED_LABEL} label`);
  const associations = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
  const markers = (Array.isArray(pr.comments) ? pr.comments : []).flatMap((comment, index) => {
    if (!comment || !associations.has(comment.authorAssociation) || typeof comment.body !== 'string') return [];
    const matches = [...comment.body.matchAll(/^agent-review-passed-sha:[ \t]*([0-9a-fA-F]{40})[ \t]*$/gm)];
    if (matches.length === 0) return [];
    const createdAt = Date.parse(comment.createdAt || '');
    return [{ sha: matches[matches.length - 1][1], createdAt, index }];
  }).sort((a, b) => a.createdAt - b.createdAt || a.index - b.index);
  if (markers.length === 0) return reject('task command rejected: trusted review completion marker was not found');
  if (markers.some((marker) => Number.isNaN(marker.createdAt))) {
    return reject('task command rejected: review completion marker createdAt is invalid');
  }
  const reviewSha = markers[markers.length - 1].sha;
  if (reviewSha !== head) return reject(`task command rejected: review completion marker SHA ${reviewSha} does not match PR head ${head}`);

  // 3. gh pr checks は未完了・失敗・0 件でも非 0 になり得るため、bucket と rollup の両方で判定する。
  const checksResult = runGh(['pr', 'checks', parsed.number, '--json', 'bucket']);
  const noChecksReported = Number.isInteger(checksResult.status) && checksResult.status !== 0
    && String(checksResult.stdout || '').trim() === ''
    && String(checksResult.stderr || '').split('\n')[0].startsWith('no checks reported');
  if (checksResult.error || (checksResult.status !== 0 && !noChecksReported && String(checksResult.stdout || '').trim() === '')) {
    return reject(`task command rejected: PR checks could not be read: ${detail(checksResult)}`);
  }
  let checks;
  if (noChecksReported) {
    checks = [];
  } else {
    try {
      checks = JSON.parse(String(checksResult.stdout));
    } catch (_error) {
      return reject('task command rejected: PR checks returned invalid JSON');
    }
  }
  if (!Array.isArray(checks)) return reject('task command rejected: PR checks returned invalid JSON');
  if (checks.length === 0 && pr.statusCheckRollup.length !== 0) {
    return reject('task command rejected: PR checks reported no checks but statusCheckRollup is not empty');
  }
  for (const check of checks) {
    const bucket = check && check.bucket;
    if (!['pass', 'skipping'].includes(bucket)) return reject(`task command rejected: PR check bucket is ${JSON.stringify(bucket)}`);
  }

  // 4. GitHub が返す値は未知値も拒否する許可リスト方式にする。
  if (pr.mergeable !== 'MERGEABLE') return reject(`task command rejected: mergeable is ${JSON.stringify(pr.mergeable)} (expected MERGEABLE)`);
  if (!['CLEAN', 'HAS_HOOKS'].includes(pr.mergeStateStatus)) {
    return reject(`task command rejected: mergeStateStatus is ${JSON.stringify(pr.mergeStateStatus)} (expected CLEAN or HAS_HOOKS)`);
  }

  // 5. 読み戻した head と squash 方式に固定して実行し、state の再読取だけを成功判定に使う。
  const merged = runGh(['pr', 'merge', parsed.number, '--squash', '--match-head-commit', head]);
  if (merged.error || merged.status !== 0) return reject(`task command failed: gh pr merge failed: ${detail(merged)}`);
  const verified = parseJson(runGh(['pr', 'view', parsed.number, '--json', 'state']), 'merged PR');
  if (verified.error) return reject(verified.error);
  if (!verified.value || verified.value.state !== 'MERGED') {
    return reject(`task command failed: PR #${parsed.number} state is ${JSON.stringify(verified.value && verified.value.state)} after merge (expected MERGED)`);
  }
  writeOut(`merged PR #${parsed.number} with squash at ${head}\n`);
  return 0;
}

/**
 * `prepare worktree <base> <issue番号> <ブランチ> <worktree名>`。vk-agents の repo-prepare.sh issue-worktree と同じ処理を、
 * この入口の中で行う（対象が vk-agents 自身でも、Codex が書き換えられるスクリプトを囲いの外で動かさないため）。
 * 作るのは <拘束ルート>/.codex/worktrees/<名前> の worktree だけで、通常のクローンの切り替えや未コミット変更には触れない。
 */
function executePrepareWorktree({ parsed, binding, cwd, fsImpl, runGit, spawnSync, networkEnv, plainEnv, reject, inspected, write, writeOut, deps }) {
  if (inspected.networkUnsafeKey) return reject(`task command rejected: repository configuration can redirect network access: ${JSON.stringify(inspected.networkUnsafeKey)}`);
  if (inspected.root !== binding.root || fsImpl.realpathSync(cwd) !== binding.root) return reject('task command rejected: prepare worktree must run at the bound repository root');
  const root = binding.root;
  const codexDir = path.join(root, CODEX_WORKTREE_PARENT[0]);
  const worktreeRoot = path.join(root, ...CODEX_WORKTREE_PARENT);
  const worktreePath = path.join(worktreeRoot, parsed.name);
  const remoteRef = `refs/remotes/origin/${parsed.base}`;
  const branchRef = `refs/heads/${parsed.branch}`;

  // 事前の検証（取得より前に、作れないと分かるものを止める）。
  for (const dir of [codexDir, worktreeRoot]) {
    const stat = lstatOrNull(fsImpl, dir);
    if (stat !== null && (stat.isSymbolicLink() || !stat.isDirectory())) return reject(`task command rejected: ${path.relative(root, dir)} is a symbolic link or not a directory`);
  }
  if (lstatOrNull(fsImpl, worktreePath) !== null) return reject(`task command rejected: worktree path already exists: ${worktreePath}`);
  if (runGit(['show-ref', '--verify', '--quiet', branchRef], cwd).status === 0) return reject(`task command rejected: working branch already exists: ${JSON.stringify(parsed.branch)}`);

  // 書き込みを伴う実行はすべて、書き込み先を OS が制限した形で行う。制限をかけられない環境では準備しない。
  // 各 worktree の config.worktree・hooks と、管理領域の中の作業フォルダ用の固定名のファイルも、どの段階でも書けない。
  const adminDirOf = (gitPath) => gitPath('worktrees', parsed.name);
  const prepared = prepareRestrictedFetch({
    binding, cwd, fsImpl, runGit, spawnSync, plainEnv, deps, base: parsed.base,
    extraControlFiles: (gitPath) => [path.join(adminDirOf(gitPath), 'config.worktree'), path.join(adminDirOf(gitPath), 'hooks'), path.join(adminDirOf(gitPath), '.git')],
  });
  if (!prepared.ok) return reject(prepared.error);
  const { gitPath, restricted, runRestricted, writableRef, parentDirs, makeDirs, remoteParts } = prepared;
  const adminDir = adminDirOf(gitPath);
  const infoDir = gitPath('info');
  const excludeFile = path.join(infoDir, 'exclude');
  const branchParts = ['heads', ...parsed.branch.split('/')];

  // 事前検査: 管理領域側の置き場所がリンクや別種のファイルでないこと、同名の管理情報が無いこと。
  const infoStat = lstatOrNull(fsImpl, infoDir);
  if (infoStat !== null && (infoStat.isSymbolicLink() || !infoStat.isDirectory())) return reject('task command rejected: local exclude directory is a symbolic link or not a directory');
  const excludeStat = lstatOrNull(fsImpl, excludeFile);
  if (excludeStat !== null && (excludeStat.isSymbolicLink() || !excludeStat.isFile())) return reject('task command rejected: local exclude file is not a regular file');
  if (lstatOrNull(fsImpl, adminDir) !== null) return reject('task command rejected: worktree administrative entry already exists');

  // Git 管理領域側の置き場所（ref・ログ・worktree 管理情報の親）を先に作る。作るだけで、中身は書かない。
  const gitDirs = [...new Set([...parentDirs(remoteParts), ...parentDirs(branchParts), gitPath('worktrees')])];
  if (!makeDirs([gitPath('refs'), gitPath('logs'), gitPath('logs', 'refs'), ...gitDirs])) return reject('task command rejected: could not prepare the git directories');

  const fetched = prepared.fetchBase(networkEnv);
  if (fetched.error) return reject(`task command failed to start: ${fetched.error.code || 'error'}`);
  if (fetched.status !== 0) return typeof fetched.status === 'number' ? fetched.status : 2;
  if (runGit(['show-ref', '--verify', '--quiet', remoteRef], cwd).status !== 0) return reject(`task command rejected: could not fetch the base branch ${JSON.stringify(parsed.base)}`);

  // 通常のクローンの status に worktree が未追跡として現れないよう、このクローンだけの除外設定へ作成先を登録する（共有の .gitignore は変えない）。
  // 書き込みは Node ではなく、除外ファイルだけに書き込みを限った子プロセスで行う。
  const entry = `/.codex/worktrees/${parsed.name}/`;
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

  // 作成先の親フォルダは、書き込みを .codex/worktrees の実パスに限った子プロセスで作る。
  if (!makeDirs([codexDir, worktreeRoot])) return reject('task command rejected: could not create the worktree parent directory');
  // 作成後の状態を確かめる（拒否の理由を分かりやすくするための検査。安全性は書き込み制限が担う）。
  try {
    for (const dir of [codexDir, worktreeRoot]) {
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

// adopt と復帰の両方で、作業フォルダと管理情報の結び付きを確かめる。
function verifyPreparedWorktree({ parsed, cwd, fsImpl, runGit, inspected, deps }, operation) {
  const failVerification = (error) => ({ ok: false, error });
  // 1) 作業フォルダが linked worktree の直下で、許可した worktree 置き場所の <worktree名> と実パスで一致する。
  let root;
  let commonDir;
  let adminDir;
  try {
    const cwdPath = path.resolve(cwd);
    root = fsImpl.realpathSync(cwd);
    commonDir = resolveGitCommonDir({ dir: cwd, run: runGit, fsImpl });
    if (inspected.root !== root) return failVerification(`task command rejected: prepare ${operation} must run at the root of the prepared worktree`);
    if (commonDir === null || path.basename(commonDir) !== '.git') return failVerification('task command rejected: the clone git directory could not be determined');
    const gitDirResult = runGit(['rev-parse', '--path-format=absolute', '--git-dir'], cwd);
    if (gitDirResult.status !== 0) return failVerification('task command rejected: the worktree git directory could not be resolved');
    adminDir = fsImpl.realpathSync(path.resolve(cwd, String(gitDirResult.stdout).trim()));
    if (path.dirname(adminDir) !== path.join(commonDir, 'worktrees')) return failVerification('task command rejected: the working directory is not a linked worktree');
    const cloneRoot = path.dirname(commonDir);
    const parent = ADOPT_WORKTREE_PARENTS.find((segments) => cwdPath === path.join(cloneRoot, ...segments, parsed.name));
    if (parent === undefined) {
      const candidates = ADOPT_WORKTREE_PARENTS.map((segments) => `${segments.join('/')}/${parsed.name}`).join(' or ');
      return failVerification(`task command rejected: the working directory does not match ${candidates} of the bound clone`);
    }
    for (const dir of [path.join(cloneRoot, parent[0]), path.join(cloneRoot, ...parent)]) {
      const stat = lstatOrNull(fsImpl, dir);
      if (stat === null || stat.isSymbolicLink() || !stat.isDirectory()) return failVerification(`task command rejected: ${path.relative(cloneRoot, dir) || dir} is a symbolic link or not a directory`);
    }
    if (root !== cwdPath) {
      return failVerification(`task command rejected: the working directory does not match ${parent.join('/')}/${parsed.name} of the bound clone`);
    }
    const rootStat = lstatOrNull(fsImpl, root);
    if (rootStat === null || rootStat.isSymbolicLink() || !rootStat.isDirectory()) return failVerification(`task command rejected: ${path.relative(cloneRoot, root) || root} is a symbolic link or not a directory`);
    // 2) 管理ディレクトリ名が worktree 名と一致し、逆参照（gitdir）が現在地直下の .git を指す。
    if (adminDir !== path.join(commonDir, 'worktrees', parsed.name)) return failVerification(`task command rejected: the worktree administrative directory is not ${JSON.stringify(parsed.name)} (a .git file pointing to another worktree)`);
    const dotGit = path.join(root, '.git');
    const dotGitStat = fsImpl.lstatSync(dotGit);
    if (dotGitStat.isSymbolicLink() || !dotGitStat.isFile()) return failVerification('task command rejected: .git of the worktree is not a regular file');
    const backRef = path.join(adminDir, 'gitdir');
    const backRefStat = fsImpl.lstatSync(backRef);
    const uid = currentUid(deps);
    if (backRefStat.isSymbolicLink() || !backRefStat.isFile() || !(uid === undefined || backRefStat.uid === uid || backRefStat.uid === 0)) return failVerification('task command rejected: the worktree back reference could not be trusted');
    const backTarget = String(fsImpl.readFileSync(backRef, 'utf8')).split('\n')[0].trim();
    // Git 2.48 以降の worktree.useRelativePaths では逆参照が相対パスになり、管理ディレクトリ基準で解決する。
    const backPath = path.resolve(adminDir, backTarget);
    if (backTarget === '' || path.basename(backPath) !== '.git' || fsImpl.realpathSync(backPath) !== dotGit) return failVerification('task command rejected: the worktree back reference does not point at the working directory');
  } catch (error) {
    return failVerification(`task command rejected: the worktree could not be verified${error && error.code ? ` (${error.code})` : ''}`);
  }

  return { ok: true, root, commonDir, adminDir };
}

/**
 * `prepare adopt-worktree <base> <issue番号> <ブランチ> <worktree名>`。vk-agents の repo-prepare.sh issue-worktree-adopt と同じ検査・処理を、
 * この入口の中で行う。起動元が作った worktree（作業フォルダ）を引き受けて作業ブランチへ切り替えるだけで、worktree は作らない。
 * 通常のクローンの作業ツリーや別タスクの worktree には書き込まない。拒否しても prepare worktree へは切り替えない。
 */
function executePrepareAdoptWorktree({ parsed, binding, cwd, fsImpl, runGit, spawnSync, networkEnv, plainEnv, reject, inspected, writeOut, deps }) {
  if (inspected.networkUnsafeKey) return reject(`task command rejected: repository configuration can redirect network access: ${JSON.stringify(inspected.networkUnsafeKey)}`);
  const remoteRef = `refs/remotes/origin/${parsed.base}`;
  const branchRef = `refs/heads/${parsed.branch}`;

  const verified = verifyPreparedWorktree({ parsed, cwd, fsImpl, runGit, inspected, deps }, 'adopt-worktree');
  if (!verified.ok) return reject(verified.error);
  const { root, commonDir, adminDir } = verified;

  // 検査後の Git 操作は、検査を通した管理ディレクトリと作業ツリーに固定する（.git ファイルの差し替えは無視する）。
  const pinnedPrefix = [...FIXED_GIT_PREFIX, '-c', 'core.splitIndex=false', `--git-dir=${adminDir}`, `--work-tree=${root}`];
  const runPinned = (args) => spawnSync(binding.git, [...pinnedPrefix, ...args], { cwd: root, env: plainEnv, encoding: 'utf8' });
  const stdoutOf = (result) => String(result.stdout || '').trim();

  // 3) 未追跡を含む未コミット変更が無い（無視ファイルは対象外）。
  const status = runPinned(['--no-optional-locks', 'status', '--porcelain=v1', '--untracked-files=all']);
  if (status.error || status.status !== 0) return reject('task command rejected: could not read the worktree status');
  if (stdoutOf(status) !== '') return reject('task command rejected: the worktree has uncommitted changes');

  // 4) 現在のブランチの状態で、取得より前に拒否できるものを止める。
  const headRef = runPinned(['symbolic-ref', '-q', 'HEAD']);
  if (headRef.error || (headRef.status !== 0 && headRef.status !== 1)) return reject('task command rejected: could not read HEAD');
  const currentRef = headRef.status === 0 ? stdoutOf(headRef) : '';
  const resuming = currentRef === branchRef;
  if (currentRef !== '' && !resuming) return reject(`task command rejected: the worktree is on another branch (${currentRef.replace(/^refs\/heads\//, '')}); it cannot be adopted`);
  if (currentRef === '' && runPinned(['show-ref', '--verify', '--quiet', branchRef]).status === 0) return reject(`task command rejected: working branch already exists: ${JSON.stringify(parsed.branch)}`);

  // 書き込みを伴う実行はすべて、書き込み先を OS が制限した形で行う。この worktree の管理情報の制御ファイルと .git ファイルは、どの段階でも書けない。
  const prepared = prepareRestrictedFetch({
    binding, cwd, fsImpl, runGit, spawnSync, plainEnv, deps, base: parsed.base, commonDir, gitDir: adminDir,
    extraControlFiles: () => ['config.worktree', 'hooks', 'commondir', 'gitdir', 'locked'].map((name) => path.join(adminDir, name)).concat(path.join(root, '.git')),
  });
  if (!prepared.ok) return reject(prepared.error);
  const { gitPath, restricted, runRestricted, writableRef, parentDirs, makeDirs, remoteParts } = prepared;
  const branchParts = ['heads', ...parsed.branch.split('/')];
  const gitDirs = [...new Set([...parentDirs(remoteParts), ...parentDirs(branchParts)])];
  if (!makeDirs([gitPath('refs'), gitPath('logs'), gitPath('logs', 'refs'), ...gitDirs])) return reject('task command rejected: could not prepare the git directories');

  // 5) 最新の origin/<base> を制限付き fetch で取得する。
  const fetched = prepared.fetchBase(networkEnv);
  if (fetched.error) return reject(`task command failed to start: ${fetched.error.code || 'error'}`);
  if (fetched.status !== 0) return typeof fetched.status === 'number' ? fetched.status : 2;
  const baseResult = runPinned(['rev-parse', '--verify', remoteRef]);
  if (baseResult.status !== 0) return reject(`task command rejected: could not fetch the base branch ${JSON.stringify(parsed.base)}`);
  const baseSha = stdoutOf(baseResult);

  // 6) HEAD が取得した origin/<base> の祖先であること。
  const headResult = runPinned(['rev-parse', '--verify', 'HEAD']);
  if (headResult.status !== 0) return reject('task command rejected: could not resolve HEAD');
  const headSha = stdoutOf(headResult);
  if (runPinned(['merge-base', '--is-ancestor', headSha, remoteRef]).status !== 0) {
    return reject(`task command rejected: HEAD of the worktree is not an ancestor of origin/${parsed.base} (a different lineage or already committed work)`);
  }

  // 7) 切り替え。段階ごとに書ける場所を分ける（prepare worktree と同じ形）。
  //    (a) ブランチの作成 / 早送り、HEAD の切り替え、index の作り直し: 作業ブランチの ref・ログとそのロック、この worktree の管理情報だけ。作業ファイルには触れない。
  //    (b) 新しい基点で無くなったファイルの削除と、作業ファイルの展開: 作業フォルダだけ。管理領域は許可しない。
  const runStep = (args, allowWrite) => runRestricted(restricted({ bin: binding.git, args: [...pinnedPrefix, ...args] }, allowWrite), { cwd: root, env: plainEnv, stdio: 'inherit' });
  const stepFailure = (result) => {
    if (result.error) return reject(`task command failed to start: ${result.error.code || 'error'}`);
    if (result.status !== 0) return typeof result.status === 'number' ? result.status : 2;
    return null;
  };
  if (headSha !== baseSha || !resuming) {
    // 展開の前に、HEAD の木にあって基点の木に無いファイルを控える（展開だけでは消えないため）。
    let removed = [];
    if (headSha !== baseSha) {
      const diff = runPinned(['diff-tree', '-r', '-z', '--name-only', '--diff-filter=D', '--no-renames', headSha, baseSha]);
      if (diff.error || diff.status !== 0) return reject('task command rejected: could not compare HEAD with the base branch');
      removed = String(diff.stdout).split('\0').filter((name) => name !== '');
    }
    if (resuming) {
      const updated = stepFailure(runStep(['update-ref', '-m', `adopt-worktree: fast-forward to origin/${parsed.base}`, branchRef, baseSha, headSha], [...writableRef(branchParts), adminDir]));
      if (updated !== null) return updated;
    } else {
      const created = stepFailure(runStep(['branch', '--quiet', '--no-track', parsed.branch, remoteRef], writableRef(branchParts)));
      if (created !== null) return created;
      const switched = stepFailure(runStep(['symbolic-ref', '-m', `adopt-worktree: switch to ${parsed.branch}`, 'HEAD', branchRef], [adminDir]));
      if (switched !== null) return switched;
    }
    if (headSha !== baseSha) {
      const indexed = stepFailure(runStep(['read-tree', '--reset', 'HEAD'], [adminDir]));
      if (indexed !== null) return indexed;
      for (let i = 0; i < removed.length; i += 100) {
        const deleted = stepFailure(runRestricted(restricted({ bin: '/bin/rm', args: ['-f', '--', ...removed.slice(i, i + 100)] }, [root]), { cwd: root, env: plainEnv, stdio: 'inherit' }));
        if (deleted !== null) return deleted;
      }
      const checkedOut = stepFailure(runStep(['checkout-index', '--all', '--force'], [root]));
      if (checkedOut !== null) return checkedOut;
    }
  }
  writeOut(`TARGET_REPO=${root}\nWORK_BRANCH=${parsed.branch}\nBASE_SHA=${baseSha}\n`);
  return 0;
}

// ファイルと index は触らず、検査済みの管理領域の HEAD だけを接続する。
function executePrepareReattachBranch(context) {
  const { parsed, binding, fsImpl, spawnSync, plainEnv, reject, writeOut, deps } = context;
  const verified = verifyPreparedWorktree(context, 'reattach-branch');
  if (!verified.ok) return reject(verified.error);
  const { root, adminDir, commonDir } = verified;
  const prefix = [...FIXED_GIT_PREFIX, '--no-optional-locks', `--git-dir=${adminDir}`, `--work-tree=${root}`];
  const runPinned = (args) => spawnSync(binding.git, [...prefix, ...args], { cwd: root, env: plainEnv, encoding: 'utf8', timeout: WORKTREE_GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: WORKTREE_MAX_CAPTURE_BYTES });
  const failed = (result) => result.error || result.status !== 0;
  const text = (result) => String(result.stdout || '').trim();
  const config = runPinned(['config', '--list', '--null']);
  if (failed(config)) return reject('task command rejected: repository configuration could not be read');
  if (inspectGitConfigListing(config.stdout).unsafeKey) return reject('task command rejected: repository configuration is not allowed');
  const headRef = runPinned(['symbolic-ref', '-q', 'HEAD']);
  if (headRef.error || ![0, 1].includes(headRef.status)) return reject('task command rejected: could not read HEAD');
  if (headRef.status === 0) return reject('task command rejected: HEAD is not detached');
  const branchRef = `refs/heads/${parsed.branch}`;
  const branch = runPinned(['rev-parse', '--verify', branchRef]);
  if (failed(branch)) return reject('task command rejected: working branch does not exist or could not be read');
  const head = runPinned(['rev-parse', '--verify', 'HEAD']);
  if (failed(head)) return reject('task command rejected: could not resolve HEAD');
  if (text(head) !== text(branch)) return reject('task command rejected: working branch commit does not match HEAD');
  const worktrees = runPinned(['worktree', 'list', '--porcelain', '-z']);
  if (failed(worktrees) || !String(worktrees.stdout).startsWith('worktree ') || !String(worktrees.stdout).endsWith('\0\0')) return reject('task command rejected: worktree branch usage could not be read');
  if (String(worktrees.stdout).split('\0').includes(`branch ${branchRef}`)) return reject('task command rejected: working branch is already used by another worktree');
  try {
    for (const name of ['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer']) {
      if (lstatOrNull(fsImpl, path.join(adminDir, name)) !== null) return reject(`task command rejected: worktree has an operation in progress: ${name}`);
    }
    const directories = [commonDir, ...fsImpl.readdirSync(path.join(commonDir, 'worktrees')).map((name) => path.join(commonDir, 'worktrees', name))];
    for (const directory of directories) {
      for (const file of ['rebase-merge/head-name', 'rebase-apply/head-name', 'BISECT_START']) {
        const location = path.join(directory, file);
        const marker = file.includes('/') ? path.dirname(location) : location;
        if (lstatOrNull(fsImpl, marker) !== null) {
          const value = fsImpl.readFileSync(location, 'utf8').trim();
          if (value === branchRef || value === parsed.branch) return reject('task command rejected: working branch is already used by another worktree');
        }
      }
    }
    resolveTrustedPath(fsImpl, SANDBOX_EXEC_PATH, { uid: deps.uid, finalKind: 'file' });
  } catch (_error) {
    return reject('task command rejected: worktree operation state or write-restricted execution could not be verified');
  }
  const command = restrictWrites({ bin: binding.git, args: [...prefix, 'symbolic-ref', 'HEAD', branchRef], allowWrite: [adminDir],
    denyWrite: ['config.worktree', 'hooks', 'commondir', 'gitdir', 'locked', 'index', 'index.lock'].map((name) => path.join(adminDir, name)) });
  const result = spawnSync(command.bin, command.args, { cwd: root, env: plainEnv, encoding: 'utf8', timeout: WORKTREE_GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: WORKTREE_MAX_CAPTURE_BYTES });
  if (failed(result)) return reject('task command failed: could not reattach HEAD');
  writeOut(`TARGET_REPO=${root}\nWORK_BRANCH=${parsed.branch}\nHEAD_SHA=${text(head)}\n`);
  return 0;
}

// 管理情報の参照先は、通常ファイルから上限付きで読み取る。
function readWorktreePointer(root, fsImpl = nodeFs) {
  const constants = fsImpl.constants || nodeFs.constants;
  const fd = fsImpl.openSync(path.join(root, '.git'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return null;
    const buffer = Buffer.alloc(4097);
    const length = fsImpl.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > 4096) return null;
    const target = buffer.subarray(0, length).toString('utf8').trim().match(/^gitdir: (.+)$/);
    return target ? fsImpl.realpathSync(path.resolve(root, target[1])) : null;
  } finally { fsImpl.closeSync(fd); }
}

// 読み取り専用で、許可した Git だけを実行する形に包む。
function restrictWorktreeStatus(binding, spawnSync, env, deps = {}) {
  const fsImpl = deps.fs || nodeFs;
  if ((deps.platform || process.platform) !== 'darwin') throw new Error('restricted status unavailable');
  resolveTrustedPath(fsImpl, SANDBOX_EXEC_PATH, { finalKind: 'file' });
  const git = resolveTrustedPath(fsImpl, binding.git, { finalKind: 'file' }).realPath;
  const executables = [git];
  // システムの Git は、選択済みの開発ツールの実体も許可する。
  if (git === '/usr/bin/git') {
    const xcrun = resolveTrustedPath(fsImpl, '/usr/bin/xcrun', { finalKind: 'file' }).realPath;
    const selected = spawnSync(xcrun, ['--no-cache', '--find', 'git'], { env, encoding: 'utf8', timeout: WORKTREE_GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: WORKTREE_MAX_CAPTURE_BYTES });
    if (selected.error || selected.status !== 0) throw new Error('selected git unavailable');
    executables.push(resolveTrustedPath(fsImpl, String(selected.stdout).trim(), { finalKind: 'file' }).realPath);
  }
  const params = executables.flatMap((target, index) => ['-D', `GIT${index}=${target}`]);
  const profile = [
    '(version 1)', '(allow default)', '(deny file-write*)',
    '(allow file-write* (literal "/dev/null"))', '(deny process-exec*)',
    `(allow process-exec ${executables.map((_, index) => `(literal (param "GIT${index}"))`).join(' ')})`,
  ].join('\n');
  return (args, options) => spawnSync(SANDBOX_EXEC_PATH, [...params, '-p', profile, git, ...args], options);
}

// 検証済みの管理情報に固定し、変更内容を公開しない比較用の指紋を作る。
function captureMemberWorktree(binding, cwd, spawnSync = childProcess.spawnSync, identity = null, deadline = Date.now() + 5000, deps = {}) {
  const unavailable = { state: 'unavailable' };
  const env = buildChildEnvironment(binding);
  try {
    if (!identity || nodeFs.realpathSync(cwd) !== identity.root) return unavailable;
    const dotGit = path.join(identity.root, '.git');
    const stat = nodeFs.lstatSync(dotGit);
    if (!stat.isFile() || stat.isSymbolicLink()) return unavailable;
    if (readWorktreePointer(identity.root) !== identity.adminDir) return unavailable;
    const runStatus = restrictWorktreeStatus(binding, spawnSync, env, deps);
    const run = (args, execute = spawnSync) => execute(binding.git, [...FIXED_GIT_PREFIX, '--no-optional-locks', `--git-dir=${identity.adminDir}`, `--work-tree=${identity.root}`, ...args], { cwd: identity.root, env, encoding: 'utf8', timeout: WORKTREE_GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: WORKTREE_MAX_CAPTURE_BYTES });
    const config = run(['config', '--list', '--null']);
    if (config.error || config.status !== 0 || inspectGitConfigListing(config.stdout).unsafeKey) return unavailable;
    const head = run(['rev-parse', '--verify', 'HEAD']);
    const branch = run(['symbolic-ref', '-q', 'HEAD']);
    const status = run(['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all'], (_bin, args, options) => runStatus(args, options));
    if ([head, status].some((r) => r.error || r.status !== 0) || branch.error || ![0, 1].includes(branch.status)) return unavailable;
    const hash = crypto.createHash('sha256').update(status.stdout);
    let remaining = WORKTREE_MAX_CAPTURE_BYTES;
    let precision = 'complete';
    const entries = String(status.stdout).split('\0');
    // 記録されたパスだけを対象に、通常ファイルの内容を逐次集計する。
    for (let i = 0; i < entries.length; i++) {
      if (Date.now() >= deadline) return unavailable;
      const entry = entries[i];
      if (!entry) continue;
      const kind = entry[0];
      const count = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : 1;
      let offset = 0;
      for (let j = 0; j < count; j++) offset = entry.indexOf(' ', offset) + 1;
      const name = entry.slice(offset);
      if (kind === '2') i++;
      const file = path.resolve(identity.root, name);
      if (!isWithinDirectory(file, identity.root) || file === identity.root) return unavailable;
      // 親ディレクトリも実パスで照合する。
      let fd;
      try {
        if (!isWithinDirectory(nodeFs.realpathSync(path.dirname(file)), identity.root)) return unavailable;
        const info = nodeFs.lstatSync(file);
        hash.update(`${name}:${info.mode}:${info.size}:`);
        if (info.isSymbolicLink()) hash.update(nodeFs.readlinkSync(file));
        if (!info.isFile()) continue;
        fd = nodeFs.openSync(file, nodeFs.constants.O_RDONLY | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK);
        if (!nodeFs.fstatSync(fd).isFile()) continue;
        const buffer = Buffer.alloc(65536);
        while (remaining > 0) {
          if (Date.now() >= deadline) return unavailable;
          const n = nodeFs.readSync(fd, buffer, 0, Math.min(buffer.length, remaining), null);
          if (!n) break;
          hash.update(buffer.subarray(0, n));
          remaining -= n;
        }
        if (remaining === 0) precision = 'limited';
      } catch (error) {
        if (error.code !== 'ENOENT') return unavailable;
        hash.update('missing');
      } finally { if (fd !== undefined) nodeFs.closeSync(fd); }
    }
    return { state: 'recorded', root: identity.root, branch: branch.status === 0 ? String(branch.stdout).trim().replace(/^refs\/heads\//, '') : '', head: String(head.stdout).trim(), dirty: status.stdout !== '', precision, changes: `${precision}:${hash.digest('hex')}` };
  } catch (_error) { return unavailable; }
}

function recordMemberIdentity(context) {
  try {
    const { cwd, fsImpl, binding, spawnSync } = context;
    const root = fsImpl.realpathSync(cwd);
    const dotGit = path.join(root, '.git');
    const info = fsImpl.lstatSync(dotGit);
    if (!info.isFile() || info.isSymbolicLink()) return null;
    const adminDir = readWorktreePointer(root, fsImpl);
    if (!adminDir) return null;
    const runGit = (args) => spawnSync(binding.git, [...FIXED_GIT_PREFIX, '--no-optional-locks', `--git-dir=${adminDir}`, `--work-tree=${root}`, ...args], {
      cwd: root, env: buildChildEnvironment(binding), encoding: 'utf8', timeout: WORKTREE_GIT_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: WORKTREE_MAX_CAPTURE_BYTES,
    });
    const verified = verifyPreparedWorktree({ ...context, runGit, parsed: { name: path.basename(cwd) } }, 'member-start');
    return verified.ok ? { root: verified.root, adminDir: verified.adminDir, commonDir: verified.commonDir } : null;
  } catch (_error) { return null; }
}

// 監督プロセスだけが終了前に一度実行する。起動前の保護された記録からだけ復帰先を決める。
function finishMemberWorktree(recovery, deps = {}) {
  if (!recovery) return { before: { state: 'unavailable' }, after: { state: 'unavailable' }, restore: 'not-restored', reason: 'record-unavailable' };
  const { binding, cwd, before, readonly, identity } = recovery;
  const deadline = Date.now() + 10000;
  const originalSpawn = deps.spawnSync || childProcess.spawnSync;
  let timedOut = false;
  const boundedSpawn = (bin, args, options) => {
    const timeout = Math.min(WORKTREE_GIT_TIMEOUT_MS, deadline - Date.now());
    if (timeout <= 0) { timedOut = true; return { status: null, error: { code: 'ETIMEDOUT' } }; }
    const result = originalSpawn(bin, args, { ...options, timeout, killSignal: 'SIGKILL', maxBuffer: WORKTREE_MAX_CAPTURE_BYTES });
    if (result.error && result.error.code === 'ETIMEDOUT') timedOut = true;
    return result;
  };
  const fsImpl = deps.fs || nodeFs;
  const afterChild = captureMemberWorktree(binding, cwd, boundedSpawn, identity, deadline);
  if (Date.now() >= deadline) timedOut = true;
  let restore = 'not-restored';
  const restorationReason = () => {
    if (readonly) return 'read-only';
    if (before.state !== 'recorded') return before.reason || 'record-unavailable';
    if (before.branch === '') return 'initially-detached';
    if (afterChild.state !== 'recorded') return 'worktree-unreadable';
    if (afterChild.branch !== '') return 'head-not-detached';
    return '';
  };
  let reason = restorationReason();
  if (reason === '') {
    const match = before.branch.match(/\/([0-9]{1,9})-/);
    const parsed = match ? parsePrepareReattachBranch([match[1], before.branch, path.basename(cwd)]) : { ok: false };
    if (!parsed.ok) reason = 'automatic-restore-failed: invalid-original-task-branch';
    else {
      try {
        resolveTrustedPath(fsImpl, binding.git, { uid: deps.uid, finalKind: 'file' });
        const plainEnv = buildChildEnvironment(binding);
        const runGit = (args, dir) => boundedSpawn(binding.git, [...FIXED_GIT_PREFIX, '--no-optional-locks', `--git-dir=${identity.adminDir}`, `--work-tree=${identity.root}`, ...args], { cwd: identity.root, env: plainEnv, encoding: 'utf8' });
        const inspected = inspectRepository({ cwd, run: runGit, homeDir: binding.home, fsImpl });
        if (!inspected.ok || (inspected.root !== binding.root && !isBoundWorktree({ cwd, run: runGit, bindingRoot: binding.root, inspectedRoot: inspected.root, fsImpl, uid: currentUid(deps) }))) reason = 'repository-verification-failed';
        else {
          const code = executePrepareReattachBranch({ parsed, binding, cwd, fsImpl, runGit, spawnSync: boundedSpawn, plainEnv, inspected, deps, writeOut: () => {}, reject: (message) => { reason = message.replace(/^task command (?:rejected|failed): /, ''); return 2; } });
          if (code === 0) { restore = 'restored'; reason = 'original-branch'; }
        }
      } catch (_error) { reason = 'restore-failed'; }
    }
  }
  if (restore !== 'restored' && !['read-only', 'initially-detached', 'head-not-detached'].includes(reason) && !reason.startsWith('automatic-restore-failed:')) reason = `automatic-restore-failed: ${reason}`;
  const after = captureMemberWorktree(binding, cwd, boundedSpawn, identity, deadline);
  if (Date.now() >= deadline) timedOut = true;
  const keepsReason = restore === 'restored' || ['read-only', 'initially-detached', 'head-not-detached'].includes(reason);
  return { before, afterChild, after, restore, reason: timedOut && !keepsReason ? 'automatic-restore-failed: timeout' : reason };
}

// ─── メンバー起動（member start / member status） ──────────────────────────

/**
 * target が base そのもの、または base の配下（どちらも実パス）かを判定する。
 * 親の書き込み範囲は、親を起動した作業フォルダと専用 config.toml の writable_roots。
 * クローン本体からの起動では `.codex/worktrees/` を writable_roots に加えるため、後から作った worktree も範囲に入る。
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
    // O_NONBLOCK: 名前付きパイプ（FIFO）を開いても書き手を待って止まらないようにする（通常ファイルでなければ下の fstat で拒否する）。
    fd = fsImpl.openSync(path.join(dir, name), constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  } catch (error) {
    const reason = error && error.code === 'ENOENT' ? 'does not exist' : 'is not a plain file';
    throw new TrustError(`${name} ${reason}`);
  }
  try {
    const stat = fsImpl.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) throw new TrustError(`${name} is not a plain file`);
    if (uid !== undefined && stat.uid !== uid) throw new TrustError(`${name} is not owned by the current user`);
    if (stat.size === 0 || stat.size > maxBytes) throw new TrustError(`${name} is empty or too large`);
    // サイズ確認のあとにファイルが伸びても上限を超えて読まないよう、上限 + 1 バイトまでだけ読んで超過を検出する。
    const buffer = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = fsImpl.readSync(fd, buffer, length, buffer.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length === 0 || length > maxBytes) throw new TrustError(`${name} is empty or too large`);
    return buffer.subarray(0, length);
  } finally {
    fsImpl.closeSync(fd);
  }
}

// 新規ファイルを、既にある（リンクを含む）なら失敗する形で作って書く。
// verify を渡すと、作成した直後・書き込み前に verify(fd) を呼ぶ。投げたら中身を書かずに閉じ、作ったファイル自身（fd と同じ dev/ino）だけを消して再投する。
function createExclusiveFile(fsImpl, filePath, content, mode = 0o600, { verify = null } = {}) {
  const constants = fsImpl.constants || nodeFs.constants;
  const fd = fsImpl.openSync(filePath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
  let closed = false;
  try {
    if (verify !== null) verify(fd);
    if (content.length > 0) fsImpl.writeFileSync(fd, content);
  } catch (error) {
    if (verify !== null) {
      try {
        const created = fsImpl.fstatSync(fd);
        fsImpl.closeSync(fd);
        closed = true;
        const current = fsImpl.lstatSync(filePath);
        if (current.dev === created.dev && current.ino === created.ino) fsImpl.unlinkSync(filePath);
      } catch (_cleanupError) {
        // 後始末は最善努力（パスが差し替えられて辿れない場合は消せない）。
      }
    }
    throw error;
  } finally {
    if (!closed) fsImpl.closeSync(fd);
  }
}

// 実行の記録フォルダに、member start 自身または監督プロセスが作りうるファイル名（失敗した起動の後始末で消す）。
const MEMBER_RUN_FILES = ['prompt.txt', 'schema.json', 'meta.json', 'meta.tmp', 'log.txt', 'result.txt', 'result-state.tmp', 'result-state', 'exit.tmp', 'exit', 'worktree-state.json'];
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
      // exit の存在が、復帰と結果の記録も完了したことを意味する。
      try {
        const worktree = finishMemberWorktree(payload.recovery, deps);
        createExclusiveFile(fsImpl, inRunDir('worktree-state.json'), Buffer.from(`${JSON.stringify(worktree)}\n`));
      } catch (_error) { /* status は記録失敗を表示する */ }
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
function executeMemberStart({ parsed, binding, cwd, fsImpl, inspected, reject, writeOut, deps, spawnSync }) {
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
    // 子の作業フォルダと一致するときだけ、状態記録と自動復帰を有効にする。
    const sameWorkingDirectory = fsImpl.realpathSync(cwd) === memberRoot;
    const identity = sameWorkingDirectory ? recordMemberIdentity({ binding, spawnSync, cwd, fsImpl, inspected, deps }) : null;
    const before = sameWorkingDirectory ? captureMemberWorktree(binding, memberRoot, spawnSync, identity) : { state: 'unavailable', reason: 'working-directory-mismatch' };
    const meta = { pid: null, startedAt: new Date().toISOString(), readonly, out: outPath, worktreeBefore: before };
    createExclusiveFile(fsImpl, paths.meta, Buffer.from(`${JSON.stringify(meta)}\n`));

    // 子の結果（-o）は、子から書き換えられない実行の記録フォルダ内に書かせる。入出力フォルダへの公開は監督プロセスが行う。
    const codexArgs = buildMemberCodexArgs({ root: memberRoot, schemaPath: paths.schema, outPath: paths.result, model: parsed.model, readonly });
    const payload = { codex: member.codex, args: codexArgs, cwd: memberRoot, env: buildMemberEnvironment(binding), runDir, recovery: { binding, cwd: memberRoot, before, readonly, identity } };
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
  let worktree = null;
  if (exitCode !== null) {
    try { worktree = JSON.parse(String(readMemberInput(fsImpl, runDir, 'worktree-state.json', 64 * 1024, uid))); } catch (_error) { /* 記録失敗を表示する */ }
  }
  const snapshotLines = (prefix, snapshot) => snapshot && snapshot.state === 'recorded'
    ? [`${prefix}_STATE=recorded`, `${prefix}_BRANCH=${snapshot.branch || 'detached'}`, `${prefix}_HEAD=${snapshot.head}`, `${prefix}_DIRTY=${snapshot.dirty}`, `${prefix}_CHANGES=${snapshot.changes}`]
    : [`${prefix}_STATE=unavailable`];
  writeOut([
    `MEMBER_ID=${parsed.id}`,
    `STATE=${state}`,
    ...(exitCode === null ? [] : [`EXIT_CODE=${exitCode}`]),
    ...(resultState === null ? [] : resultState === 'published' ? ['RESULT_STATE=published'] : ['RESULT_STATE=failed', `RESULT_FAILURE=${resultState.slice('failed '.length)}`]),
    `OUT=${String(meta.out)}`,
    `LOG=${path.join(runDir, 'log.txt')}`,
    ...snapshotLines('WORKTREE_BEFORE', meta.worktreeBefore),
    ...(exitCode === null ? [] : [
      ...snapshotLines('WORKTREE_AFTER_CHILD', worktree && worktree.afterChild),
      ...snapshotLines('WORKTREE_AFTER', worktree && worktree.after),
      `WORKTREE_CHANGED=${worktree && worktree.before.state === 'recorded' && worktree.after.state === 'recorded' ? JSON.stringify(worktree.before) !== JSON.stringify(worktree.after) : 'unknown'}`,
      `BRANCH_RESTORE=${worktree ? worktree.restore : 'not-restored'}`,
      `BRANCH_RESTORE_REASON=${worktree ? worktree.reason : 'automatic-restore-record-failed'}`,
    ]),
    ...(tail === null || tail === '' ? [] : ['--- log tail ---', tail.replace(/\n$/, '')]),
    '',
  ].join('\n'));
  return 0;
}

// 画像の中身（先頭のバイト列）から形式を判定する。png / jpeg / gif / webp 以外（SVG を含む）は null。
function detectImageType(buffer) {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
  const gifHead = buffer.subarray(0, 6).toString('latin1');
  if (gifHead === 'GIF87a' || gifHead === 'GIF89a') return 'gif';
  if (buffer.length >= 12 && buffer.subarray(0, 4).toString('latin1') === 'RIFF' && buffer.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// 1 回分の取得。リダイレクトは追わず、状態・Location・本文（上限つき）を返す。上限超過・時間切れは TrustError。
function requestAttachment(url, { headers, maxBytes, timeoutMs }, deps = {}) {
  const httpsImpl = deps.https || https;
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const finish = (settle, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settle(value);
    };
    const req = httpsImpl.request(url, { method: 'GET', headers }, (res) => {
      const status = res.statusCode;
      if (status !== 200) {
        // 本文は使わない。受信が続いてもサイズ・時間の上限が効かなくなるため、状態と Location を取ったら接続ごと閉じる。
        res.on('error', () => {});
        const location = res.headers.location;
        res.destroy();
        req.destroy();
        finish(resolve, { status, location });
        return;
      }
      const declared = Number(res.headers['content-length']);
      if (Number.isFinite(declared) && declared > maxBytes) {
        req.destroy();
        finish(reject, new TrustError('image is too large'));
        return;
      }
      const chunks = [];
      let total = 0;
      res.on('data', (chunk) => {
        total += chunk.length;
        if (total > maxBytes) {
          req.destroy();
          finish(reject, new TrustError('image is too large'));
        } else chunks.push(chunk);
      });
      res.on('end', () => finish(resolve, { status, body: Buffer.concat(chunks) }));
      res.on('error', (error) => finish(reject, error));
    });
    timer = setTimeout(() => {
      req.destroy();
      finish(reject, new TrustError('download timed out'));
    }, timeoutMs);
    req.on('error', (error) => finish(reject, error));
    req.end();
  });
}

// 添付画像を取得する。リダイレクトは各ホップで URL（https・ホスト許可リスト・認証情報なし）を再検査し、認証トークンは許可したホスト（github.com）への要求にだけ付ける。
async function downloadAttachment(startUrl, { token, request, maxBytes = ATTACHMENT_MAX_BYTES, timeoutMs = ATTACHMENT_TIMEOUT_MS }) {
  let current = startUrl;
  for (let hop = 0; hop <= ATTACHMENT_MAX_REDIRECTS; hop += 1) {
    const headers = { 'User-Agent': 'vk-task-ops', Accept: 'image/*', 'Accept-Encoding': 'identity' };
    if (token !== null && ATTACHMENT_TOKEN_HOSTS.includes(current.hostname)) headers.Authorization = `Bearer ${token}`;
    const response = await request(current, { headers, maxBytes, timeoutMs });
    if (ATTACHMENT_REDIRECT_STATUSES.includes(response.status)) {
      let next = null;
      if (typeof response.location === 'string' && ATTACHMENT_URL_PRINTABLE_PATTERN.test(response.location)) {
        try {
          next = parseAttachmentUrl(new URL(response.location, current).href, { redirect: true });
        } catch (_error) {
          next = null;
        }
      }
      if (next === null) throw new TrustError('redirect target is not an allowed GitHub attachment host');
      current = next;
    } else if (response.status === 200) {
      return response.body;
    } else {
      throw new TrustError(`download failed with HTTP ${response.status}`);
    }
  }
  throw new TrustError('too many redirects');
}

// `gh issue save-image`: 入出力フォルダ直下へ添付画像を保存する。実行の流れ:
// 1. 入出力フォルダの実体と保存先（既存ファイルが無いこと）を確かめる。ここまでに失敗したら通信しない。
// 2. gh の認証トークンを読み（無ければ無しで続ける）、許可ホストだけをたどって取得する。
// 3. 中身のマジックバイトで形式を判定し、拡張子と一致するときだけ、既存ファイルを開かない形（O_EXCL・O_NOFOLLOW）で保存する。
async function executeIssueImageSave({ parsed, binding, env, fsImpl, spawnSync, reject, writeOut, deps }) {
  const member = binding.member;
  if (member === null) return reject('task command rejected: gh issue save-image needs the member input/output folder, which this launcher does not have');
  const uid = currentUid(deps);
  const target = path.join(member.io, parsed.out);
  try {
    if (resolveTrustedPath(fsImpl, member.io, { uid, rejectFinalLink: true }).realPath !== member.io) throw new TrustError(`path is not a real directory: ${member.io}`);
    if (lstatOrNull(fsImpl, target) !== null) throw new TrustError(`${parsed.out} already exists`);
    const startUrl = parseAttachmentUrl(parsed.url);
    if (startUrl === null) throw new TrustError('url is not a GitHub attachment image url');
    let token = null;
    if (binding.gh !== null && ATTACHMENT_TOKEN_HOSTS.includes(startUrl.hostname)) {
      const result = spawnSync(binding.gh, ['auth', 'token'], { cwd: binding.home, env, encoding: 'utf8' });
      const value = result && result.status === 0 && typeof result.stdout === 'string' ? result.stdout.trim() : '';
      if (ATTACHMENT_TOKEN_PATTERN.test(value)) token = value;
    }
    const request = deps.requestAttachment || ((url, options) => requestAttachment(url, options, deps));
    const buffer = await downloadAttachment(startUrl, { token, request });
    const type = detectImageType(buffer);
    if (type === null) throw new TrustError('downloaded file is not a png, jpeg, gif or webp image');
    const extension = parsed.out.slice(parsed.out.lastIndexOf('.') + 1);
    if (!IMAGE_TYPE_EXTENSIONS[type].includes(extension)) throw new TrustError(`${parsed.out} does not match the image type (${type})`);
    // 取得中に入出力フォルダが差し替えられていないことを書く直前にも確かめる。
    if (resolveTrustedPath(fsImpl, member.io, { uid, rejectFinalLink: true }).realPath !== member.io) throw new TrustError(`path is not a real directory: ${member.io}`);
    // 検査と作成は別の操作なので、その間に入出力フォルダがリンクや別のフォルダに差し替えられても外へ書かないよう、
    // 作成の前後でフォルダの dev/ino・実パスと、作ったファイルの fd とパスの dev/ino の一致を確かめる（食い違えば書き込まずに消して失敗）。
    const ioBefore = fsImpl.lstatSync(member.io);
    const verify = (fd) => {
      const created = fsImpl.fstatSync(fd);
      const entry = fsImpl.lstatSync(target);
      const ioAfter = fsImpl.lstatSync(member.io);
      if (!created.isFile() || !entry.isFile() || entry.isSymbolicLink() || created.dev !== entry.dev || created.ino !== entry.ino) throw new TrustError(`${parsed.out} was not created inside the input/output folder`);
      if (ioAfter.isSymbolicLink() || !ioAfter.isDirectory() || ioAfter.dev !== ioBefore.dev || ioAfter.ino !== ioBefore.ino || fsImpl.realpathSync(member.io) !== member.io) throw new TrustError('the input/output folder was replaced while saving');
    };
    try {
      createExclusiveFile(fsImpl, target, buffer, 0o600, { verify });
    } catch (error) {
      if (error instanceof TrustError) throw error;
      throw new TrustError(error && error.code === 'EEXIST' ? `${parsed.out} already exists` : `${parsed.out} could not be written`);
    }
    writeOut(`SAVED=${target}\nTYPE=${type}\nBYTES=${buffer.length}\n`);
    return 0;
  } catch (error) {
    // 取得の失敗理由は種類だけを出す（署名付き URL を含みうるため URL・応答本文は出さない）。
    return reject(`task command rejected: ${error instanceof TrustError ? error.message : `download failed (${error && error.code ? error.code : 'error'})`}`);
  }
}

/**
 * 検証を通った操作だけを実行し、終了コードを返す。
 * 実行環境・git / gh の絶対パス・対象リポジトリはランチャーが固定した VK_TASK_*（deps.env）から読み、
 * 呼び出し元の環境には依存しない。
 * @param {ReadonlyArray<string>} argv 先頭が git / gh の引数列
 * @param {object} [deps] テスト用の差し替え（cwd / env / spawnSync / fs / write / uid）
 * @returns {number|Promise<number>} プロセスの終了コード（拒否・検証失敗は 2）。通信する `gh issue save-image` だけは Promise
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
    let rootIdentity;
    if (parsed.operation === 'protected-sync') {
      try { rootIdentity = fsImpl.lstatSync(cwd); }
      catch (_) { return reject('task command rejected: worktree root could not be verified'); }
    }
    inspected = inspectRepository({ cwd, run: runGit, homeDir: binding.home, fsImpl });
    if (rootIdentity) {
      try {
        const after = fsImpl.lstatSync(cwd);
        if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() || after.dev !== rootIdentity.dev || after.ino !== rootIdentity.ino) return reject('task command rejected: worktree root changed');
        inspected.rootIdentity = { dev: rootIdentity.dev, ino: rootIdentity.ino };
      } catch (_) { return reject('task command rejected: worktree root could not be verified'); }
    }
    if (!inspected.ok) return reject(inspected.error);
    if (inspected.root !== binding.root && !isBoundWorktree({ cwd, run: runGit, bindingRoot: binding.root, inspectedRoot: inspected.root, fsImpl, uid: currentUid(deps) })) {
      return reject('task command rejected: working directory is not the bound repository');
    }
    if ((parsed.needsGitHub || parsed.requiresBoundRepository) && (binding.repo === null || inspected.repo !== binding.repo)) {
      return reject('task command rejected: origin does not match the bound github.com repository');
    }
  }

  if (parsed.operation === 'protected-sync') return executeProtectedSync({ parsed, binding, cwd, fsImpl, runGit, spawnSync, env, reject, inspected, deps });

  if (parsed.guardsDefaultBranch) {
    const branchError = checkCommitBranch({ cwd, run: runGit, action: parsed.branchAction });
    if (branchError !== null) return reject(branchError);
  }

  if (parsed.operation === 'member-start' || parsed.operation === 'member-status') {
    const context = { parsed, binding, cwd, fsImpl, inspected, reject, writeOut, deps, spawnSync };
    return parsed.operation === 'member-start' ? executeMemberStart(context) : executeMemberStatus(context);
  }

  if (parsed.operation === 'prepare-reattach-branch') return executePrepareReattachBranch({ parsed, binding, cwd, fsImpl, runGit, spawnSync, plainEnv: env, reject, inspected, writeOut, deps });

  if (parsed.operation === 'push' || parsed.operation === 'prepare-worktree' || parsed.operation === 'prepare-adopt-worktree') {
    const networkEnv = networkEnvironment(binding);
    const context = { parsed, binding, cwd, fsImpl, runGit, spawnSync, networkEnv, plainEnv: env, reject, inspected, write, writeOut, deps };
    if (parsed.operation === 'push') return executePush(context);
    return parsed.operation === 'prepare-worktree' ? executePrepareWorktree(context) : executePrepareAdoptWorktree(context);
  }

  if (parsed.operation === 'fetch-default-branch') {
    const networkEnv = networkEnvironment(binding);
    return executeFetchDefaultBranch({ binding, cwd, fsImpl, runGit, spawnSync, networkEnv, plainEnv: env, reject, inspected, writeOut, deps });
  }
  if (parsed.operation === 'merge-default-branch') return executeMergeDefaultBranch({ binding, cwd, runGit, spawnSync, plainEnv: env, reject, inspected });

  if (REVIEW_LABEL_OPERATIONS.has(parsed.operation)) {
    // 明示先の gh と同じく、呼び出し元 cwd の Git 設定に依存させない。
    const labelCwd = explicitGitHubTarget === undefined ? cwd : binding.home;
    return executeReviewLabel({ parsed, binding, explicitGitHubTarget, spawnSync, env, cwd: labelCwd, reject, write, writeOut });
  }
  if (parsed.operation === 'issue-edit') return executeIssueEdit({ parsed, binding, cwd, env, spawnSync, reject, writeOut });
  if (parsed.operation === 'issue-edit-body') return executeIssueEditBody({ parsed, binding, cwd, env, fsImpl, spawnSync, reject, writeOut, deps });
  if (parsed.operation === 'issue-remove-label') return executeIssueRemoveLabel({ parsed, binding, cwd, env, spawnSync, reject, writeOut });
  if (parsed.operation === 'issue-close') return executeIssueClose({ parsed, binding, cwd, env, spawnSync, reject, writeOut });
  if (parsed.operation === 'pr-edit') return executePrEdit({ parsed, binding, cwd, env, fsImpl, spawnSync, reject, writeOut, deps });
  if (parsed.operation === 'pr-merge') return executePrMerge({ parsed, binding, cwd, env, spawnSync, reject, writeOut });
  if (parsed.operation === 'issue-image-save') return executeIssueImageSave({ parsed, binding, env, fsImpl, spawnSync, reject, writeOut, deps });

  const bin = parsed.bin === 'gh' ? binding.gh : binding.git;
  let ghArgs = parsed.args;
  if (parsed.textFiles !== undefined) {
    // gh pr create / issue create / issue comment / pr comment の --title-file / --body-file。読み込みと検査はここ（gh を起動する前）で行い、読んだ値を --title / --body の argv として渡す。
    try {
      const texts = readPrTextFiles(parsed.textFiles, { binding, fsImpl, deps });
      // 読んだ値は、gh のサブコマンド部分（pr create / issue comment 7 など。'-' で始まらない語）の直後に差し込む。
      const flagStart = parsed.args.findIndex((token) => token.startsWith('-'));
      const at = flagStart === -1 ? parsed.args.length : flagStart;
      ghArgs = [...parsed.args.slice(0, at), ...(texts.title === undefined ? [] : ['--title', texts.title]), ...(texts.body === undefined ? [] : ['--body', texts.body]), ...parsed.args.slice(at)];
    } catch (error) {
      return reject(`task command rejected: ${error instanceof TrustError ? error.message : 'title/body file could not be verified'}`);
    }
  }
  // gh repo view は --repo を持たないため、対象は位置引数として末尾に付ける（issue #520）。
  const args = parsed.bin !== 'gh' ? ghArgs
    : parsed.repoPositional ? [...ghArgs, explicitGitHubTarget || binding.repo]
      : withBoundRepository(ghArgs, explicitGitHubTarget || binding.repo);
  // 明示先の gh は呼び出し元 cwd の Git 設定にも依存させず、固定した HOME から実行する。
  const executionCwd = explicitGitHubTarget === undefined ? cwd : binding.home;
  const result = spawnSync(bin, args, { cwd: executionCwd, env, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) return reject(`task command failed to start: ${result.error.code || 'error'}`);
  return typeof result.status === 'number' ? result.status : 2;
}

module.exports = {
  listToolSearchDirs,
  getProtectedSyncCapabilities,
  getProtectedSyncCapabilitiesAsync,
  protectedSyncChild,
  protectedSourceChild,
  prepareRestrictedFetch,
  PROTECTED_SYNC_TARGETS,
  captureMemberWorktree,
  recordMemberIdentity,
  parseTaskCommand,
  ACCEPTED_GH_OPERATIONS,
  ISSUE_LIST_JSON_FIELDS,
  REPO_VIEW_JSON_FIELDS,
  runTaskCommand,
  requestAttachment,
  readBinding,
  buildChildEnvironment,
  withBoundRepository,
  inspectRepository,
  isBoundWorktree,
  checkCommitBranch,
  inspectGitConfigListing,
  findNetworkUnsafeKey,
  findMergeUnsafeKey,
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
    Promise.resolve(runTaskCommand(process.argv.slice(2))).then((code) => { process.exitCode = code; });
  }
}
