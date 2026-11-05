// Codex 版 issue 対応手順（vektor-inc/vk-agents の codex/vk-kore/）が要求する Git / GitHub 操作の一覧（issue #523）。
// 固定入口（utils/codexTaskOps.js）が許可する形と食い違っていないかを tests/codexTaskOpsCoverage.test.js が照合する。
//
// この一覧は vk-agents の実ファイルから「写した」もの。CI には vk-agents が無いため、テストはこのファイルだけで完結する。
// 手順側を変えたとき（または vk-agents を clone している環境で補助チェックが失敗したとき）の更新方法は docs/codex-task-policy.md
// 「手順の操作一覧との照合（issue #523）」を参照。
//
// 各項目の共通の欄:
//   procedureOperation: 手順が使う操作名（gh-read.sh / gh-write.sh / repo-prepare.sh の操作名、run-member-agent.sh の起動、素の git サブコマンド）
//   source: 出典。vk-agents のルートからの相対パスと行番号（codex/vk-kore/<ファイル>.md:<行>）
//   argv: 固定入口へ渡す引数（vk-task-ops の第 2 引数以降。手順の書き方を固定入口の呼び方へ読み替えた形）
//   procedureNames: （任意）手順が同じ操作を別の名前（素の `gh pr view` など）で書くときの名前。補助チェックの照合に使う
//   sourceNeedle: （任意）出典の行に含まれるべき語。省略時は操作名から導く
// 手順にまだ出典が無い入口の追加操作は launcherOnlyOperations に分け、source は捏造しない。
// requiredOperations だけの欄:
//   expected: parseTaskCommand の結果に含まれるべき値（bin と、gh なら先頭の args、git なら gitSubcommand が args に入ること、そのほかは operation）
//   note: （任意）手順の書式をそのまま写せず読み替えた旨と理由
//   explicitRepo: true のとき、`gh <owner/repo> …` の明示形式でも受理され、targetRepo が付くこと
// knownGaps だけの欄:
//   expectedError: 固定入口が返すべき拒否理由（parsed.error と照合する）。別の理由で拒否されたり、argv を書き損じたりしたときに気づくため
//   reason: 固定入口が受理しない理由と、現時点で除外している判断
//   alternative: 代替になりうる固定入口の操作（無ければ null）

// 写した時点の vk-agents のコミット（git -C <vk-agents> rev-parse --short HEAD）。
const SNAPSHOT_VK_AGENTS_COMMIT = '73f8e7d0';

const SHA_A = 'abc1234def5678abc1234def5678abc1234def56';
const SHA_B = '0123456789abcdef0123456789abcdef01234567';
const WORK_BRANCH = 'feature/523-codex-ops-coverage-test';
const REVIEW_LABEL = 'agent-review-passed';
const ATTACHMENT_URL = 'https://github.com/user-attachments/assets/123e4567-e89b-12d3-a456-426614174000';
const MEMBER_RUN_ID = 'a'.repeat(24);

const requiredOperations = [
  // ── 事前準備・issue の分析 ──
  { procedureOperation: 'gh-read.sh issue-view', source: 'codex/vk-kore/step-1-2.md:38', argv: ['gh', 'issue', 'view', '523', '--json', 'title,body,labels,assignees,comments'], expected: { bin: 'gh', args: ['issue', 'view', '523', '--json', 'title,body,labels,assignees,comments'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh issue-view', source: 'codex/vk-kore/step-2-1-split-into-sub-issues.md:27', argv: ['gh', 'issue', 'view', '518', '--json', 'assignees'], expected: { bin: 'gh', args: ['issue', 'view', '518', '--json', 'assignees'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh issue-comments', source: 'codex/vk-kore/step-1-2.md:13', argv: ['gh', 'issue', 'view', '523', '--comments'], expected: { bin: 'gh', args: ['issue', 'view', '523', '--comments'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh pr-comments', source: 'codex/vk-kore/step-1-2.md:13', argv: ['gh', 'pr', 'view', '529', '--comments'], expected: { bin: 'gh', args: ['pr', 'view', '529', '--comments'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh issue-labels', source: 'codex/vk-kore/step-1-2.md:13', argv: ['gh', 'issue', 'view', '523', '--json', 'labels'], expected: { bin: 'gh', args: ['issue', 'view', '523', '--json', 'labels'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh issue-assets', source: 'codex/vk-kore/step-1-2.md:39', argv: ['gh', 'issue', 'save-image', ATTACHMENT_URL, '--out', 'asset-1.png'], expected: { bin: 'gh', operation: 'issue-image-save' }, explicitRepo: false },
  { procedureOperation: 'repo-prepare.sh issue-worktree', source: 'codex/vk-kore/step-1-2.md:26', argv: ['prepare', 'worktree', 'main', '523', WORK_BRANCH, 'codex-1'], expected: { operation: 'prepare-worktree' }, explicitRepo: false },
  { procedureOperation: 'repo-prepare.sh issue-worktree-adopt', source: 'codex/vk-kore/step-1-2.md:25', argv: ['prepare', 'adopt-worktree', 'main', '523', WORK_BRANCH, 'codex-1'], expected: { operation: 'prepare-adopt-worktree' }, explicitRepo: false },
  { procedureOperation: 'git status', source: 'codex/vk-kore/step-3-7-implementation-and-pr.md:26', argv: ['git', 'status', '--porcelain'], expected: { bin: 'git', gitSubcommand: 'status' }, explicitRepo: false },

  // ── 実装・PR 作成 ──
  { procedureOperation: 'gh-write.sh push', source: 'codex/vk-kore/step-3-7-implementation-and-pr.md:29', argv: ['git', 'push', WORK_BRANCH], expected: { operation: 'push' }, explicitRepo: false },
  { procedureOperation: 'gh-write.sh pr-create', source: 'codex/vk-kore/step-3-7-implementation-and-pr.md:66', argv: ['gh', 'pr', 'create', '--head', WORK_BRANCH, '--title-file', 'pr-title.txt', '--body-file', 'pr-body.md'], expected: { bin: 'gh', args: ['pr', 'create', '--head', WORK_BRANCH] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh pr-view', procedureNames: ['gh pr view'], source: 'codex/vk-kore/step-3-7-implementation-and-pr.md:80', argv: ['gh', 'pr', 'view', '529', '--json', 'title,body'], expected: { bin: 'gh', args: ['pr', 'view', '529', '--json', 'title,body'] }, explicitRepo: true },
  { procedureOperation: 'gh-write.sh pr-edit', source: 'codex/vk-kore/step-3-7-implementation-and-pr.md:82', argv: ['gh', 'pr', 'edit', '529', '--title-file', 'pr-title.txt', '--body-file', 'pr-body.md'], expected: { operation: 'pr-edit' }, explicitRepo: false },
  { procedureOperation: 'gh-write.sh issue-comment', source: 'codex/vk-kore/step-1-2.md:16', argv: ['gh', 'issue', 'comment', '523', '--body-file', 'comment.md'], expected: { bin: 'gh', args: ['issue', 'comment', '523'] }, explicitRepo: true },

  // ── レビュー ──
  { procedureOperation: 'gh-read.sh pr-view', source: 'codex/vk-kore/step-8-2b-split-review.md:21', argv: ['gh', 'pr', 'view', '529', '--json', 'baseRefName'], expected: { bin: 'gh', args: ['pr', 'view', '529', '--json', 'baseRefName'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh pr-view', source: 'codex/vk-kore/step-8-review-gate.md:105', argv: ['gh', 'pr', 'view', '529', '--json', 'headRefOid'], expected: { bin: 'gh', args: ['pr', 'view', '529', '--json', 'headRefOid'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh pr-diff', procedureNames: ['gh pr diff'], source: 'codex/vk-kore/step-8-review-gate.md:71', argv: ['gh', 'pr', 'diff', '529', '--name-only'], expected: { bin: 'gh', args: ['pr', 'diff', '529', '--name-only'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh pr-diff', source: 'codex/vk-kore/step-8-review-gate.md:105', argv: ['gh', 'pr', 'diff', '529', '--patch'], expected: { bin: 'gh', args: ['pr', 'diff', '529', '--patch'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh compare-merge-base', source: 'codex/vk-kore/step-8-2b-split-review.md:35', argv: ['git', 'merge-base', 'origin/main', SHA_A], expected: { bin: 'git', gitSubcommand: 'merge-base' }, explicitRepo: false, note: '手順は GitHub のコンペア API でマージベースを取る。固定入口には無いため、ローカルの git merge-base に読み替えた（先に git fetch が要る）。' },
  { procedureOperation: 'git fetch', source: 'codex/vk-kore/step-8-2b-split-review.md:60', argv: ['git', 'fetch'], expected: { operation: 'fetch-default-branch' }, explicitRepo: false, note: '手順は git fetch origin <ベースブランチ名> と引数つき。固定入口の git fetch は引数なしで既定ブランチだけを取るため読み替えた。ベースが既定ブランチ以外の PR では同じ働きにならない。' },
  { procedureOperation: 'git diff', source: 'codex/vk-kore/step-8-2b-split-review.md:70', argv: ['git', 'diff', '--no-renames', '--name-only', SHA_B, SHA_A], expected: { bin: 'git', gitSubcommand: 'diff' }, explicitRepo: false, note: '手順は git -C <dir> -c core.quotePath=false diff … > <ファイル> と書く。-C は作業フォルダの指定、リダイレクトは入口が受けないため外して読み替えた。-c core.quotePath=false を外した件は knownGaps に別項目で登録している。' },
  { procedureOperation: 'git diff', source: 'codex/vk-kore/step-8-2b-split-review.md:236', argv: ['git', 'diff', '--no-renames', SHA_B, SHA_A, '--', 'utils/codexTaskOps.js'], expected: { bin: 'git', gitSubcommand: 'diff' }, explicitRepo: false, note: '出典は実行するコマンドの行（243 行は paths が空のまま実行しない注意書き）。-C・-c core.quotePath=false・pathspec の配列展開・リダイレクトを外し、パスを 1 つ直接書く形に読み替えた。' },
  { procedureOperation: 'run-member-agent.sh --engine codex', source: 'codex/vk-kore/step-1-2.md:14', argv: ['member', 'start', '--engine', 'codex', '--prompt', 'review-prompt.txt', '--schema', 'review-schema.json', '--out', 'review-result.json'], expected: { operation: 'member-start' }, explicitRepo: false },
  { procedureOperation: 'run-member-agent.sh --readonly', source: 'codex/vk-kore/step-1-2.md:14', argv: ['member', 'start', '--engine', 'codex', '--readonly', '--prompt', 'review-prompt.txt', '--schema', 'review-schema.json', '--out', 'review-result.json'], expected: { operation: 'member-start' }, explicitRepo: false },
  { procedureOperation: 'run-member-agent.sh --engine codex', source: 'codex/vk-kore/step-1-2.md:14', argv: ['member', 'status', MEMBER_RUN_ID], expected: { operation: 'member-status' }, explicitRepo: false },

  // ── レビュー完了マーカー・CI ──
  { procedureOperation: 'gh-read.sh pr-checks', source: 'codex/vk-kore/step-9-markers.md:86', argv: ['gh', 'pr', 'checks', '529', '--json', 'name,bucket'], expected: { bin: 'gh', args: ['pr', 'checks', '529', '--json', 'name,bucket'] }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh label-exists', source: 'codex/vk-kore/step-9-markers.md:111', argv: ['gh', 'label', 'exists', REVIEW_LABEL], expected: { operation: 'label-exists' }, explicitRepo: true },
  { procedureOperation: 'gh-write.sh label-create', source: 'codex/vk-kore/step-9-markers.md:117', argv: ['gh', 'label', 'create', REVIEW_LABEL], expected: { operation: 'label-create' }, explicitRepo: true },
  { procedureOperation: 'gh-write.sh label-add', source: 'codex/vk-kore/step-9-markers.md:123', argv: ['gh', 'pr', 'add-label', '529', REVIEW_LABEL], expected: { operation: 'pr-add-label' }, explicitRepo: true },
  { procedureOperation: 'gh-read.sh issue-has-label', source: 'codex/vk-kore/step-9-markers.md:129', argv: ['gh', 'pr', 'has-label', '529', REVIEW_LABEL], expected: { operation: 'pr-has-label' }, explicitRepo: true },
  { procedureOperation: 'gh-write.sh pr-comment', source: 'codex/vk-kore/step-9-markers.md:151', argv: ['gh', 'pr', 'comment', '529', '--body-file', 'marker.md'], expected: { bin: 'gh', args: ['pr', 'comment', '529'] }, explicitRepo: true },

  // ── マージ・完了処理 ──
  { procedureOperation: 'gh-read.sh pr-view', sourceNeedle: 'headRefName', source: 'codex/vk-kore/step-10-1-merge-on-instruction.md:7', argv: ['gh', 'pr', 'view', '529', '--json', 'headRefName'], expected: { bin: 'gh', args: ['pr', 'view', '529', '--json', 'headRefName'] }, explicitRepo: true },
  { procedureOperation: 'gh pr merge', source: 'codex/vk-kore/step-10-1-merge-on-instruction.md:9', argv: ['gh', 'pr', 'merge', '529'], expected: { operation: 'pr-merge' }, explicitRepo: false },
  { procedureOperation: 'gh-read.sh pr-view', source: 'codex/vk-kore/step-10-1-merge-on-instruction.md:11', argv: ['gh', 'pr', 'view', '529', '--json', 'state'], expected: { bin: 'gh', args: ['pr', 'view', '529', '--json', 'state'] }, explicitRepo: true },
  { procedureOperation: 'gh-write.sh label-remove', source: 'codex/vk-kore/step-10-1-merge-on-instruction.md:12', argv: ['gh', 'issue', 'edit', '523', '--remove-label', 'working'], expected: { operation: 'issue-remove-label' }, explicitRepo: false },
  { procedureOperation: 'gh issue close', source: 'codex/vk-kore/step-10-1-merge-on-instruction.md:12', argv: ['gh', 'issue', 'close', '523'], expected: { operation: 'issue-close' }, explicitRepo: false },
];

// 手順が要求するのに、固定入口が受理しない操作（既知の不足）。除外リストとして扱い、受理されるようになったらテストが失敗して
// requiredOperations への移動を促す。固定入口の許可範囲は、この一覧のために勝手に広げない（広げるかどうかは別 issue で判断する）。
const knownGaps = [
  {
    procedureOperation: 'gh-read.sh auth-status',
    source: 'codex/vk-kore/step-1-2.md:5',
    procedureNames: ['gh auth status'],
    argv: ['gh', 'auth', 'status'],
    expectedError: /gh "auth" "status" is not allowed/,
    reason: '手順の最初に `gh auth status` で認証を確認するが、固定入口に `gh auth` は無い。入口は専用の gh 設定で認証済みの前提で動く。',
    alternative: null,
  },
  {
    procedureOperation: 'repo-prepare.sh issue-branch',
    source: 'codex/vk-kore/step-1-2.md:28',
    argv: ['prepare', 'branch', 'main', '523', WORK_BRANCH],
    expectedError: /prepare "branch" is not allowed/,
    reason: '連携起動でない場合の作業ブランチ準備（通常クローンで切り替える）。固定入口は worktree 方式の `prepare worktree` / `prepare adopt-worktree` だけで、同じ働きの操作が無い。',
    alternative: 'prepare worktree',
  },
  {
    procedureOperation: 'git clone',
    source: 'codex/vk-kore/step-1-2.md:23',
    argv: ['git', 'clone', 'https://github.com/vektor-inc/vk-terminals.git'],
    expectedError: /git "clone" is not allowed/,
    reason: '`TARGET_REPO` が起動元から渡されないときだけ使う clone。固定入口は起動時に固定したリポジトリだけを扱い、clone は持たない。',
    alternative: null,
  },
  {
    procedureOperation: 'git switch (ブランチの切り替え)',
    source: 'codex/vk-kore/step-8-7-e2e.md:37',
    sourceNeedle: '切り替え',
    argv: ['git', 'switch', WORK_BRANCH],
    expectedError: /git "switch" is not allowed/,
    reason: 'e2e が失敗したとき `TARGET_REPO` を `WORK_BRANCH` へ切り替える。手順はコマンドを明示していないが、固定入口に `git switch` / `git checkout` は無い。',
    alternative: null,
  },
  {
    procedureOperation: 'git rev-parse',
    source: 'codex/vk-kore/step-9-markers.md:81',
    argv: ['git', 'rev-parse', `refs/heads/${WORK_BRANCH}`],
    expectedError: /git "rev-parse" is not allowed/,
    reason: 'マーカー付与前に、作業ブランチの先頭コミットを `git rev-parse` で控える。固定入口に `git rev-parse` は無い。',
    alternative: 'git show -s <ref>（出力形式が違うため手順の読み替えが要る）',
  },
  {
    procedureOperation: 'git cat-file',
    source: 'codex/vk-kore/step-8-2b-split-review.md:53',
    argv: ['git', 'cat-file', '-e', `${SHA_A}^{commit}`],
    expectedError: /git "cat-file" is not allowed/,
    reason: '分割レビューで、レビュー対象コミットとマージベースがローカルに存在するか `git cat-file -e` で確かめる。固定入口に `git cat-file` は無い。',
    alternative: 'git show -s <sha>（存在しなければ失敗する。手順の読み替えが要る）',
  },
  {
    procedureOperation: 'git ls-tree',
    source: 'codex/vk-kore/step-8-2b-split-review.md:102',
    argv: ['git', 'ls-tree', SHA_B, '--', 'utils/codexTaskOps.js'],
    expectedError: /git "ls-tree" is not allowed/,
    reason: '分割レビューで、名前変更だけのファイルを mode と blob で判定するため `git ls-tree` を使う。固定入口に `git ls-tree` は無い。',
    alternative: null,
  },
  {
    procedureOperation: 'git diff',
    source: 'codex/vk-kore/step-8-2b-split-review.md:92',
    argv: ['git', 'diff', '-M', '--name-status', SHA_B, SHA_A],
    expectedError: /flag not allowed: "-M"/,
    reason: '分割レビューが名前変更の検出に使う `git diff -M`。固定入口の `git diff` は `-M` を受けない。',
    alternative: '`--no-renames` つきの `git diff`（名前変更を検出できない）',
  },
  {
    procedureOperation: 'git diff',
    source: 'codex/vk-kore/step-8-2b-split-review.md:70',
    argv: ['git', '-c', 'core.quotePath=false', 'diff', '--no-renames', '--name-only', SHA_B, SHA_A],
    expectedError: /git "-c" is not allowed/,
    reason: '分割レビューが日本語パスを引用符で囲まない出力にするため付ける `git -c core.quotePath=false`。固定入口は `git` の直後に `-c` を受けない。',
    alternative: null,
  },
  {
    procedureOperation: 'run-member-agent.sh --engine claude',
    source: 'codex/vk-kore/step-8-review-execution.md:62',
    argv: ['member', 'start', '--engine', 'claude', '--prompt', 'review-prompt.txt', '--schema', 'review-schema.json', '--out', 'review-result.json'],
    expectedError: /engine not supported: "claude"/,
    reason: 'レビュアーを Claude Code で起動する経路。固定入口の `member start` は `--engine codex` だけに対応している（Claude Code は別対応）。',
    alternative: 'member start --engine codex',
  },
];

// 固定入口の操作ではない（コマンドとして照合する対象ではない）手順上の操作名。
const notApplicable = [
  {
    procedureOperation: 'gh-read.sh out-dir',
    source: 'codex/vk-kore/step-1-2.md:13',
    reason: '本文ファイルの置き場所を返す操作。固定入口では起動時の案内（専用入出力フォルダの絶対パス）で渡されるため、コマンドが要らない。',
  },
  {
    procedureOperation: 'run-member-agent.sh out-dir',
    source: 'codex/vk-kore/step-1-2.md:14',
    reason: 'メンバー起動用の入出力フォルダを返す操作。固定入口では起動時の案内で渡されるため、コマンドが要らない。',
  },
  {
    procedureOperation: 'gh pr edit',
    source: 'codex/vk-kore/step-1-2.md:18',
    reason: '生の `gh pr edit` は例外なく毎回承認と禁止されている文脈（step-9-markers.md:120 の `gh pr edit --add-label` も「使わない」）。PR の編集は gh-write.sh pr-edit の項目で照合する。',
  },
  {
    procedureOperation: 'gh pr checkout',
    source: 'codex/vk-kore/step-1-2.md:18',
    reason: '生の `gh pr checkout` は入口を通らない変更系として禁止されている文脈で、手順が実行する操作ではない。',
  },
  {
    procedureOperation: 'gh auth token',
    source: 'codex/vk-kore/step-1-2.md:21',
    reason: 'トークン値を出力するコマンドとして実行を禁止されている文脈で、手順が実行する操作ではない。',
  },
  {
    procedureOperation: 'gh api compare',
    source: 'codex/vk-kore/step-8-2b-split-review.md:197',
    reason: 'GitHub のコンペア API を指す説明で、手順が生の `gh api` を実行するわけではない（マージベースの取得は gh-read.sh compare-merge-base の項目で照合する）。',
  },
  {
    procedureOperation: 'git mv',
    source: 'codex/vk-kore/step-8-2b-split-review.md:95',
    reason: '名前変更と実行ビット付与が同時に起きる例を説明する文中の例示で、手順が実行する操作ではない。',
  },
];

// 後続の手順更新に先立って実装した操作。手順が採用した時点で出典付きの requiredOperations へ移す。
const launcherOnlyOperations = [
  { procedureOperation: 'prepare reattach-branch', source: null, argv: ['prepare', 'reattach-branch', '544', 'feature/544-reattach-branch', 'codex-544'], expected: { operation: 'prepare-reattach-branch' }, explicitRepo: false, note: 'issue #544。vk-agents の手順では未使用のため出典の行は無い。' },
];

module.exports = {
  SNAPSHOT_VK_AGENTS_COMMIT,
  requiredOperations,
  launcherOnlyOperations,
  knownGaps,
  notApplicable,
};
