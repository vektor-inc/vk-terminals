// 自動処理用 Codex の固定入口（utils/codexTaskOps.js。issue #428）の検証。
// 許可する操作の組み立て結果、許可リスト外（出力先指定・ファイル読み込み・リポジトリ指定・暗黙の push など）の拒否、
// 実際の Git リポジトリと偽の gh を使った実行時の検証（環境の固定・リポジトリへの拘束・外部実行設定の拒否・信頼境界）を確認する。
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  captureMemberWorktree,
  FIXED_GIT_PREFIX,
  assertChainUnchanged,
  buildChildEnvironment,
  buildMemberCodexArgs,
  isWithinDirectory,
  superviseMemberRun,
  inspectGitConfigListing,
  isSupportedGitVersion,
  inspectRepository,
  findNetworkUnsafeKey,
  restrictWrites,
  parseGitHubRepo,
  parseTaskCommand,
  readBinding,
  requestAttachment,
  resolveTrustedExecutable,
  resolveTrustedExecutableDetailed,
  resolveTrustedPath,
  runTaskCommand,
} = require('../utils/codexTaskOps');

const GIT_PREFIX = [...FIXED_GIT_PREFIX];
const DIFF_SAFETY = ['--no-ext-diff', '--no-textconv'];
const argv = (line) => line.split(' ');

// ─── 許可する操作 ────────────────────────────────────────────────────────

test('許可: 閲覧系の Git 操作は検証済みの値だけで組み立て直し、外部コマンドを呼ぶ機能を無効化する', () => {
  assert.deepEqual(parseTaskCommand(argv('git status --short --branch')), { ok: true, bin: 'git', args: [...GIT_PREFIX, 'status', '--short', '--branch'], needsGitHub: false });
  assert.deepEqual(parseTaskCommand(['git', 'diff', '--stat', 'origin/main...HEAD', '--', 'src/a.js']).args, [...GIT_PREFIX, 'diff', ...DIFF_SAFETY, '--stat', 'origin/main...HEAD', '--', 'src/a.js']);
  assert.deepEqual(parseTaskCommand(argv('git log --oneline -n 5 main')).args, [...GIT_PREFIX, 'log', ...DIFF_SAFETY, '--oneline', '-n', '5', 'main']);
  assert.deepEqual(parseTaskCommand(argv('git log -3 --max-count=2')).args, [...GIT_PREFIX, 'log', ...DIFF_SAFETY, '-3', '--max-count=2']);
  assert.deepEqual(parseTaskCommand(argv('git show --stat HEAD~1')).args, [...GIT_PREFIX, 'show', ...DIFF_SAFETY, '--stat', 'HEAD~1']);
  assert.deepEqual(parseTaskCommand(['git', 'add', '--', 'a.txt', 'dir/b.txt']).args, [...GIT_PREFIX, 'add', '--', 'a.txt', 'dir/b.txt']);
  assert.deepEqual(parseTaskCommand(['git', 'add', '-A']).args, [...GIT_PREFIX, 'add', '-A']);
  assert.deepEqual(parseTaskCommand(['git', 'commit', '-m', 'メッセージ', '--message=2段落目']).args, [...GIT_PREFIX, 'commit', '-m', 'メッセージ', '-m', '2段落目']);
});

test('許可: gh は番号・本文・head を検証する（対象リポジトリは入口が検証済みの --repo を付ける）', () => {
  assert.deepEqual(parseTaskCommand(argv('gh issue view 428 --comments --json title,body')), { ok: true, bin: 'gh', args: ['issue', 'view', '428', '--comments', '--json', 'title,body'], needsGitHub: true });
  assert.deepEqual(parseTaskCommand(['gh', 'issue', 'comment', '428', '--body', '完了']).args, ['issue', 'comment', '428', '--body', '完了']);
  assert.deepEqual(parseTaskCommand(argv('gh pr view 429')).args, ['pr', 'view', '429']);
  assert.deepEqual(parseTaskCommand(argv('gh pr checks 429')).args, ['pr', 'checks', '429']);
  assert.deepEqual(parseTaskCommand(['gh', 'pr', 'comment', '429', '-b', 'ok']).args, ['pr', 'comment', '429', '--body', 'ok']);
  // レビュー合格マーカーは空白なしの 1 トークンなら引用符なしで入口を通る。空白入りで分かれると拒否される。
  const marker = `agent-review-passed-sha:${'a'.repeat(40)}`;
  assert.deepEqual(parseTaskCommand(['gh', 'pr', 'comment', '429', '--body', marker]).args, ['pr', 'comment', '429', '--body', marker]);
  assert.equal(parseTaskCommand(['gh', 'pr', 'comment', '429', '--body', 'agent-review-passed-sha:', 'a'.repeat(40)]).ok, false);
  assert.deepEqual(
    parseTaskCommand(['gh', 'pr', 'create', '--title', '題', '--body', '本文', '--head', 'issue/428-x', '--base', 'main', '--draft']).args,
    ['pr', 'create', '--head', 'issue/428-x', '--title', '題', '--body', '本文', '--base', 'main', '--draft'],
  );
  assert.deepEqual(
    parseTaskCommand(['gh', 'Vektor-Inc/another.repo', 'issue', 'view', '428']),
    { ok: true, bin: 'gh', args: ['issue', 'view', '428'], needsGitHub: true, targetRepo: 'Vektor-Inc/another.repo' },
  );
});

test('許可: gh issue list / gh repo view は読み取り用のフラグと許可リストの JSON 項目だけ（issue #520）', () => {
  assert.deepEqual(parseTaskCommand(argv('gh issue list')), { ok: true, bin: 'gh', args: ['issue', 'list'], needsGitHub: true });
  assert.deepEqual(
    parseTaskCommand(['gh', 'issue', 'list', '--state', 'all', '--search', '重複 -label:bug', '--limit', '20', '--label', 'task-queue', '--json', 'number,title,state']).args,
    ['issue', 'list', '--state', 'all', '--search=重複 -label:bug', '--limit', '20', '--json', 'number,title,state', '--label', 'task-queue'],
  );
  // 日本語の検索語・ラベル除外・空白入りの既存ラベル名は通る。
  assert.equal(parseTaskCommand(['gh', 'issue', 'list', '--search', '重複 確認 -label:bug label:task-queue v1.2_x', '--label', 'good first issue', '--label', 'type: bug']).ok, true);
  assert.deepEqual(parseTaskCommand(['gh', 'issue', 'list', '--state=closed', '--search=-x', '--limit=100', '--json=url']).args, ['issue', 'list', '--state', 'closed', '--search=-x', '--limit', '100', '--json', 'url']);
  assert.deepEqual(
    parseTaskCommand(['gh', 'Vektor-Inc/another.repo', 'issue', 'list', '--state', 'open']),
    { ok: true, bin: 'gh', args: ['issue', 'list', '--state', 'open'], needsGitHub: true, targetRepo: 'Vektor-Inc/another.repo' },
  );
  assert.deepEqual(
    parseTaskCommand(argv('gh repo view --json visibility,isPrivate,defaultBranchRef,nameWithOwner')),
    { ok: true, bin: 'gh', args: ['repo', 'view', '--json', 'visibility,isPrivate,defaultBranchRef,nameWithOwner'], needsGitHub: true, repoPositional: true },
  );
  assert.equal(parseTaskCommand(argv('gh repo view --json=visibility')).ok, true);
  // 位置引数の owner/repo も、先頭に置く明示形式と同じ targetRepo として扱う。
  assert.equal(parseTaskCommand(['gh', 'Vektor-Inc/another.repo', 'repo', 'view', '--json', 'visibility']).targetRepo, 'Vektor-Inc/another.repo');
  assert.equal(parseTaskCommand(['gh', 'repo', 'view', 'Vektor-Inc/another.repo', '--json', 'visibility']).targetRepo, 'Vektor-Inc/another.repo');
});

test('拒否: gh issue list / gh repo view の --web・--jq・--template・--repo・許可外の項目・範囲外の値・制御文字（issue #520）', () => {
  const rejected = [
    ['gh', 'issue', 'list', '--web'],
    ['gh', 'issue', 'list', '-w'],
    ['gh', 'issue', 'list', '--jq', '.'],
    ['gh', 'issue', 'list', '-q', '.'],
    ['gh', 'issue', 'list', '--json', 'number', '--jq', '.[]'],
    ['gh', 'issue', 'list', '--template', '{{.}}'],
    ['gh', 'issue', 'list', '-t', '{{.}}'],
    ['gh', 'issue', 'list', '--json', 'number,notAField'],
    ['gh', 'issue', 'list', '--json', 'title;id'],
    ['gh', 'issue', 'list', '--json', 'number,'],
    ['gh', 'issue', 'list', '--json'],
    ['gh', 'issue', 'list', '--json', 'number', '--json', 'title'],
    ['gh', 'issue', 'list', '--state', 'merged'],
    ['gh', 'issue', 'list', '--state'],
    ['gh', 'issue', 'list', '--limit', '0'],
    ['gh', 'issue', 'list', '--limit', '101'],
    ['gh', 'issue', 'list', '--limit', '-1'],
    ['gh', 'issue', 'list', '--limit', 'abc'],
    ['gh', 'issue', 'list', '--limit', '1', '--limit', '2'],
    ['gh', 'issue', 'list', '--search', ''],
    ['gh', 'issue', 'list', '--search', 'a\nb'],
    ['gh', 'issue', 'list', '--search', 'a\u202eb'],
    ['gh', 'issue', 'list', '--search', 'a'.repeat(257)],
    ['gh', 'issue', 'list', '--search', 'x', '--search', 'y'],
    ['gh', 'issue', 'list', '--search', 'x ) OR repo:other/private OR ( x'],
    ['gh', 'issue', 'list', '--search', '(x)'],
    ['gh', 'issue', 'list', '--search', '"quoted phrase"'],
    ['gh', 'issue', 'list', '--search', "it's"],
    ['gh', 'issue', 'list', '--search', 'repo:other/private'],
    ['gh', 'issue', 'list', '--search', 'org:other'],
    ['gh', 'issue', 'list', '--search', 'user:other'],
    ['gh', 'issue', 'list', '--search', 'is:private'],
    ['gh', 'issue', 'list', '--search', 'in:body'],
    ['gh', 'issue', 'list', '--search', '-repo:other/private'],
    ['gh', 'issue', 'list', '--search', 'label:"a b"'],
    ['gh', 'issue', 'list', '--search', 'a OR b'],
    ['gh', 'issue', 'list', '--search', 'a and b'],
    ['gh', 'issue', 'list', '--search', 'NOT a'],
    ['gh', 'issue', 'list', '--search', 'a\u3000b'],
    ['gh', 'issue', 'list', '--label', 'a) OR repo:other/private'],
    ['gh', 'issue', 'list', '--label', 'a(b'],
    ['gh', 'issue', 'list', '--label', "it's"],
    ['gh', 'issue', 'list', '--label', 'a\\b'],
    ['gh', 'issue', 'list', '--label', 'a  b'],
    ['gh', 'issue', 'list', '--label', '-bad'],
    ['gh', 'issue', 'list', '--label', 'a,b'],
    ['gh', 'issue', 'list', '--author', 'x'],
    ['gh', 'issue', 'list', '--assignee', 'x'],
    ['gh', 'issue', 'list', '--repo', 'other/repo'],
    ['gh', 'issue', 'list', '-R', 'other/repo'],
    ['gh', 'issue', 'list', '--repo=other/repo'],
    ['gh', 'issue', 'list', '5'],
    ['gh', 'issue', 'list', '-s', 'all'],
    ['gh', 'issue', 'list', '--state', 'all\u0000'],
    ['gh', 'repo', 'view'],
    ['gh', 'repo', 'view', '--web'],
    ['gh', 'repo', 'view', '-w', '--json', 'visibility'],
    ['gh', 'repo', 'view', '--json', 'visibility', '--jq', '.'],
    ['gh', 'repo', 'view', '--json', 'visibility', '--template', '{{.}}'],
    ['gh', 'repo', 'view', '--json', 'readme'],
    ['gh', 'repo', 'view', '--json', 'visibility,secrets'],
    ['gh', 'repo', 'view', '--json', 'visibility', '--json', 'name'],
    ['gh', 'repo', 'view', '--json', 'vis\nibility'],
    ['gh', 'repo', 'view', '--json', 'visibility', '--repo', 'other/repo'],
    ['gh', 'repo', 'view', '--json', 'visibility', '-R', 'other/repo'],
    ['gh', 'repo', 'view', '--json', 'visibility', '--branch', 'main'],
    ['gh', 'repo', 'view', '--json', 'visibility', 'notarepo'],
    ['gh', 'repo', 'view', '--json', 'visibility', '../repo'],
    ['gh', 'repo', 'view', '--json', 'visibility', 'owner/repo/extra'],
    ['gh', 'repo', 'view', '--json', 'visibility', 'a/b', 'c/d'],
    ['gh', 'repo', 'view', '--json', 'visibility', 'https://github.com/o/r'],
    ['gh', 'a/b', 'repo', 'view', 'c/d', '--json', 'visibility'],
    ['gh', 'repo', 'clone', 'a/b'],
    ['gh', 'repo', 'delete', 'a/b'],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, /^task command rejected/);
  }
});

// ─── 拒否する操作（許可操作を経由した副作用を含む） ─────────────────────────

test('拒否: ファイル出力・外部コマンド・設定変更・履歴改変につながる Git のフラグと操作', () => {
  const rejected = [
    ['git', 'diff', '--output=/tmp/x'],
    ['git', 'diff', '--output', '/tmp/x'],
    ['git', 'log', '--output=/tmp/x'],
    ['git', 'show', '--output=/tmp/x'],
    ['git', 'diff', '--ext-diff'],
    ['git', 'diff', '--textconv'],
    ['git', 'diff', '--no-index', '/etc/passwd', '/dev/null'],
    ['git', 'log', '--format=%H', '--exec-path'],
    ['git', 'diff', '--exec=x'],
    ['git', '-c', 'core.pager=sh', 'diff'],
    ['git', '-c', 'core.hooksPath=/tmp', 'commit', '-m', 'x'],
    ['git', '--git-dir=/tmp/x', 'status'],
    ['git', 'push'],
    ['git', 'push', '--force'],
    ['git', 'reset', '--hard'],
    ['git', 'config', 'core.hooksPath', '/tmp'],
    ['git', 'checkout', '-f', 'main'],
    ['git', 'clean', '-fdx'],
    ['git', 'rm', '-rf', '.'],
    ['git', 'remote', 'add', 'x', 'https://example.com'],
    ['git', 'status', '--ignored'],
    ['git', 'status', 'src'],
    ['git', 'commit', '--amend', '-m', 'x'],
    ['git', 'commit', '-F', '/etc/passwd'],
    ['git', 'commit', '--file=/etc/passwd'],
    ['git', 'commit', '-C', 'HEAD'],
    ['git', 'commit', '--no-verify', '-m', 'x'],
    ['git', 'commit', '--author=x <x@example.com>', '-m', 'x'],
    ['git', 'commit'],
    ['git', 'commit', '-m'],
    ['git', 'commit', '-m', ''],
    ['git', 'add'],
    ['git', 'add', '-f', 'ignored.txt'],
    ['git', 'add', '--chmod=+x', 'a'],
    ['git', 'add', '--intent-to-add', 'a'],
    ['git', 'add', '-p'],
    ['git', 'add', '/etc/passwd'],
    ['git', 'add', '../outside.txt'],
    ['git', 'add', 'a/../../outside.txt'],
    ['git', 'add', '.git/config'],
    ['git', 'add', ':(top)x'],
    ['git', 'add', '~/x'],
    ['git', 'diff', '--', '../../etc/passwd'],
    ['git', 'diff', '--', '/etc/passwd'],
    ['git', 'diff', '/etc/passwd'],
    ['git', 'show', 'HEAD:secret'],
    ['git', 'log', '-n', 'abc'],
    ['git'],
    [],
    ['sh', '-c', 'id'],
    ['node', '-e', '1'],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, /^task command rejected/);
  }
});

test('拒否: gh のリポジトリ指定・ファイル読み込み・ブラウザ/エディタ起動・暗黙の push・範囲の広い操作', () => {
  const rejected = [
    ['gh', 'api', 'repos/x/y'],
    ['gh', 'owner/repo', 'api', 'repos/owner/repo'],
    ['gh', 'owner/repo/extra', 'issue', 'view', '1'],
    ['gh', '-owner/repo', 'issue', 'view', '1'],
    ['gh', 'owner/-repo', 'issue', 'view', '1'],
    ['gh', '../repo', 'issue', 'view', '1'],
    ['gh', 'pr', 'close', '1'],
    ['gh', 'pr', 'edit', '1'],
    ['gh', 'pr', 'checkout', '1'],
    ['gh', 'issue', 'reopen', '1'],
    ['gh', 'repo', 'delete', 'x/y'],
    ['gh', 'auth', 'token'],
    ['gh', 'secret', 'list'],
    ['gh', 'issue', 'view', '1', '--repo', 'other/repo'],
    ['gh', 'issue', 'view', '1', '-R', 'other/repo'],
    ['gh', 'issue', 'view', 'https://github.com/other/repo/issues/1'],
    ['gh', 'issue', 'view', '1', '--web'],
    ['gh', 'owner/repo', 'issue', 'view', '1', '--web'],
    ['gh', 'issue', 'view', '1', '--json', 'title;id'],
    ['gh', 'issue', 'view', '1', '--jq', '.'],
    ['gh', 'issue', 'view'],
    ['gh', 'issue', 'comment', '1', '--body-file', '/etc/passwd'],
    ['gh', 'issue', 'comment', '1', '-F', '/etc/passwd'],
    ['gh', 'issue', 'comment', '1', '--editor'],
    ['gh', 'issue', 'comment', '1', '--edit-last', '--body', 'x'],
    ['gh', 'issue', 'comment', '1', '--web'],
    ['gh', 'issue', 'comment', '--body', 'x'],
    ['gh', 'issue', 'comment', '1'],
    ['gh', 'issue', 'comment', '1', '--body', ''],
    ['gh', 'pr', 'view'],
    ['gh', 'pr', 'checks'],
    ['gh', 'pr', 'view', 'feature-branch'],
    ['gh', 'pr', 'view', '--web'],
    ['gh', 'pr', 'checks', '--watch'],
    ['gh', 'pr', 'comment', '1', '--body-file', '../x'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b'],
    ['gh', 'pr', 'create', '--fill'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'owner:branch'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', '-evil'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'a..b'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'x', '--base', 'a:b'],
    ['gh', 'pr', 'create', '--title', 't', '--head', 'x'],
    ['gh', 'pr', 'create', '--body', 'b', '--head', 'x'],
    ['gh', 'pr', 'create', '--title', 't', '--body-file', '/etc/passwd', '--head', 'x'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'x', '--web'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'x', '--repo', 'o/r'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'x', '--head', 'y'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'x', '--recover', 'f'],
    ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'x', '--reviewer', 'someone'],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
  }
});

test('許可: gh issue create は title/body 必須で、担当者・ラベルを複数指定でき、検証済みの値だけで組み立て直す', () => {
  assert.deepEqual(parseTaskCommand(['gh', 'issue', 'create', '--title', '題', '--body', '本文']), { ok: true, bin: 'gh', args: ['issue', 'create', '--title', '題', '--body', '本文'], needsGitHub: true });
  assert.deepEqual(
    parseTaskCommand(['gh', 'issue', 'create', '--label', 'task-queue', '--title', '題', '--assignee', 'kurudrive', '--body', '本文', '--label', 'bug', '--assignee', 'a-b']).args,
    ['issue', 'create', '--title', '題', '--body', '本文', '--assignee', 'kurudrive', '--assignee', 'a-b', '--label', 'task-queue', '--label', 'bug'],
  );
  assert.deepEqual(parseTaskCommand(['gh', 'issue', 'create', '--title=題', '--body=--本文', '--assignee=kurudrive', '--label=status:waiting-merge']).args, ['issue', 'create', '--title', '題', '--body', '--本文', '--assignee', 'kurudrive', '--label', 'status:waiting-merge']);
  assert.deepEqual(parseTaskCommand(['gh', 'issue', 'create', '-t', 't', '-b', 'b', '-a', 'u', '-l', 'good first issue']).args, ['issue', 'create', '--title', 't', '--body', 'b', '--assignee', 'u', '--label', 'good first issue']);
  for (const label of ['task-queue', 'status:waiting-merge', '不具合', '要 確認', 'a'.repeat(50)]) {
    assert.equal(parseTaskCommand(['gh', 'issue', 'create', '--title', 't', '--body', 'b', '--label', label]).ok, true, label);
  }
});

test('拒否: gh issue create の必須欠落・許可外オプション・不正な担当者とラベル', () => {
  const base = ['gh', 'issue', 'create', '--title', 't', '--body', 'b'];
  const rejected = [
    ['gh', 'issue', 'create'],
    ['gh', 'issue', 'create', '--title', 't'],
    ['gh', 'issue', 'create', '--body', 'b'],
    ['gh', 'issue', 'create', '--title', ' ', '--body', 'b'],
    ['gh', 'issue', 'create', '--title', 't', '--body', ''],
    ['gh', 'issue', 'create', '--title', 't', '--body'],
    ['gh', 'issue', 'create', '--title', 't', '--title', 'u', '--body', 'b'],
    [...base, '--repo', 'o/r'],
    [...base, '-R', 'o/r'],
    [...base, '--repo=o/r'],
    ['gh', 'issue', 'create', '--title', 't', '--body-file', '/etc/passwd'],
    [...base, '--body-file', '/etc/passwd'],
    [...base, '--web'],
    [...base, '--editor'],
    [...base, '-e'],
    [...base, '--template', 'bug'],
    [...base, '--project', 'p'],
    [...base, '--milestone', 'm'],
    [...base, '--recover', 'f'],
    [...base, 'extra'],
    [...base, '--assignee', '@me'],
    [...base, '--assignee', '-evil'],
    [...base, '--assignee', 'a,b'],
    [...base, '--assignee', 'a b'],
    [...base, '--assignee', ''],
    [...base, '--assignee', 'a'.repeat(40)],
    [...base, '--assignee'],
    [...base, '--label', ''],
    [...base, '--label', ' '],
    [...base, '--label', ' lead'],
    [...base, '--label', 'trail '],
    [...base, '--label', '-bug'],
    [...base, '--label', 'a,b'],
    [...base, '--label', '"bug'],
    [...base, '--label', 'a"b'],
    [...base, '--label', 'bug"'],
    [...base, '--label', '"bug"'],
    [...base, '--label=a"b'],
    [...base, '--label', 'a\nb'],
    [...base, '--label', 'a\u0007b'],
    [...base, '--label', 'a\u0000b'],
    [...base, '--label', 'a'.repeat(51)],
    [...base, '--label'],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, /^task command rejected/);
  }
});

test('実行: gh issue create は拘束した --repo が付き、作成された issue の URL がそのまま標準出力に返る', () => {
  const fixture = createFixture();
  try {
    let stdout = '';
    let stdio;
    const result = run(fixture, ['gh', 'issue', 'create', '--title', '題', '--body', '本文', '--assignee', 'kurudrive', '--label', 'task-queue', '--label', 'bug'], {
      spawnSync: (bin, args, options) => {
        stdio = options.stdio;
        const spawned = childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
        stdout = spawned.stdout;
        return spawned;
      },
    });
    assert.equal(result.code, 0);
    assert.equal(stdio, 'inherit');
    assert.equal(stdout.trim(), 'https://github.com/vektor-inc/vk-terminals/issues/999');
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [
      ['issue', 'create', '--title', '題', '--body', '本文', '--assignee', 'kurudrive', '--label', 'task-queue', '--label', 'bug', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    // 拒否された issue 作成は gh を呼ばない。
    assert.equal(run(fixture, ['gh', 'issue', 'create', '--title', 't', '--body', 'b', '--repo', 'other/repo']).code, 2);
    assert.equal(fixture.readCalls().length, 1);
  } finally {
    fixture.cleanup();
  }
});

// ─── gh issue edit（担当者・既存ラベルの追加。issue #472） ─────────────────────

test('許可: gh issue edit は番号と --add-assignee / --add-label だけを受け、検証済みの値で組み立て直す', () => {
  const ok = (command) => parseTaskCommand(['gh', 'issue', 'edit', ...command]);
  assert.deepEqual(ok(['5', '--add-assignee', 'kurudrive']), { ok: true, bin: 'gh', operation: 'issue-edit', number: '5', assignees: ['kurudrive'], labels: [], needsGitHub: true });
  assert.deepEqual(ok(['5', '--add-label', 'task-queue']), { ok: true, bin: 'gh', operation: 'issue-edit', number: '5', assignees: [], labels: ['task-queue'], needsGitHub: true });
  const both = ok(['--add-label', 'good first issue', '5', '--add-assignee', 'a-b', '--add-label=不具合', '--add-assignee=kurudrive']);
  assert.equal(both.ok, true);
  assert.equal(both.number, '5');
  assert.deepEqual(both.assignees, ['a-b', 'kurudrive']);
  assert.deepEqual(both.labels, ['good first issue', '不具合']);
});

test('拒否: gh issue edit は別リポジトリ指定・対象を変える引数・削除系・不正な値・必須欠落をすべて拒否する', () => {
  const base = ['gh', 'issue', 'edit', '5', '--add-assignee', 'kurudrive'];
  const rejected = [
    ['gh', 'vektor-inc/other', 'issue', 'edit', '5', '--add-assignee', 'kurudrive'],
    ['gh', 'VEKTOR-INC/vk-terminals', 'issue', 'edit', '5', '--add-label', 'bug'],
    ['gh', 'issue', 'edit'],
    ['gh', 'issue', 'edit', '5'],
    ['gh', 'issue', 'edit', '--add-assignee', 'kurudrive'],
    [...base, '--repo', 'o/r'],
    [...base, '-R', 'o/r'],
    [...base, '--repo=o/r'],
    [...base, '--title', 't'],
    [...base, '--body', 'b'],
    [...base, '--body-file', '/etc/passwd'],
    [...base, '--remove-label', 'bug'],
    [...base, '--remove-assignee', 'kurudrive'],
    [...base, '--milestone', 'm'],
    [...base, '--add-project', 'p'],
    [...base, '--add-assignee', '@me'],
    [...base, '--add-assignee', '-evil'],
    [...base, '--add-assignee', 'a,b'],
    [...base, '--add-assignee'],
    [...base, '--add-label', ''],
    [...base, '--add-label', ' x'],
    [...base, '--add-label', 'a,b'],
    [...base, '--add-label', '"bug"'],
    [...base, '--add-label', '-bug'],
    [...base, '--add-label', 'a'.repeat(51)],
    [...base, '--add-label'],
    [...base, '--add-label', '--remove-label'],
    [...base, '--unknown'],
    [...base, 'extra'],
    [...base, '7'],
    ['gh', 'issue', 'edit', 'abc', '--add-assignee', 'kurudrive'],
    ['gh', 'issue', 'edit', '5; rm', '--add-assignee', 'kurudrive'],
    ['gh', 'issue', 'edit', '1234567890', '--add-assignee', 'kurudrive'],
    ['gh', 'issue', 'edit', 'https://github.com/o/r/issues/5', '--add-assignee', 'kurudrive'],
    ['gh', 'issue', 'edit', '-5', '--add-assignee', 'kurudrive'],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, /^task command rejected/);
  }
});

// gh だけを差し替える spawnSync。呼び出しを記録し、gh 以外（git）は実物に流す。
function issueEditHarness(fixture, { labels = ['task-queue', 'bug', 'good first issue'], applied, viewStdout, editStatus = 0, listStatus = 0, viewStatus = 0 } = {}) {
  const calls = [];
  const spawnSync = (bin, args, options) => {
    if (bin !== fixture.env.VK_TASK_GH) return childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    calls.push(args);
    if (args[0] === 'api') return { status: listStatus, stdout: labels.join('\n') + '\n', stderr: listStatus === 0 ? '' : 'list failed\n' };
    if (args[0] === 'issue' && args[1] === 'edit') return { status: editStatus, stdout: '', stderr: editStatus === 0 ? '' : 'edit failed\n' };
    if (args[0] === 'issue' && args[1] === 'view') return { status: viewStatus, stdout: viewStdout !== undefined ? viewStdout : JSON.stringify(applied), stderr: viewStatus === 0 ? '' : 'view failed\n' };
    return { status: 1, stdout: '', stderr: 'unexpected\n' };
  };
  return { calls, spawnSync };
}

const issueState = (assignees, labels) => ({ assignees: assignees.map((login) => ({ login })), labels: labels.map((name) => ({ name })) });

test('実行: gh issue edit はラベル確認 → 更新 → 読み戻しの順に、拘束した --repo だけで動き、読み戻しで全値を確認できたときだけ成功する', () => {
  const fixture = createFixture();
  try {
    const stdout = [];
    const { calls, spawnSync } = issueEditHarness(fixture, { applied: issueState(['Kurudrive', 'other'], ['task-queue', 'bug', 'pre-existing']) });
    const result = run(fixture, ['gh', 'issue', 'edit', '5', '--add-assignee', 'kurudrive', '--add-label', 'task-queue', '--add-label', 'bug'], { spawnSync, writeOut: (m) => stdout.push(m) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.deepEqual(calls, [
      ['api', '--paginate', 'repos/vektor-inc/vk-terminals/labels?per_page=100', '--jq', '.[].name'],
      ['issue', 'edit', '5', '--add-assignee', 'kurudrive', '--add-label', 'task-queue', '--add-label', 'bug', '--repo', 'vektor-inc/vk-terminals'],
      ['issue', 'view', '5', '--json', 'assignees,labels', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    assert.match(stdout.join(''), /updated issue #5/);

    // 担当者だけのときはラベル一覧を取らない。既に付いている値の再指定（冪等）も、読み戻せれば成功する。
    const second = issueEditHarness(fixture, { applied: issueState(['kurudrive'], ['bug']) });
    assert.equal(run(fixture, ['gh', 'issue', 'edit', '5', '--add-assignee', 'kurudrive'], { spawnSync: second.spawnSync, writeOut: () => {} }).code, 0);
    assert.deepEqual(second.calls.map((args) => args.slice(0, 2)), [['issue', 'edit'], ['issue', 'view']]);
    const third = issueEditHarness(fixture, { applied: issueState([], ['bug']) });
    assert.equal(run(fixture, ['gh', 'issue', 'edit', '5', '--add-label', 'bug'], { spawnSync: third.spawnSync, writeOut: () => {} }).code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh issue edit はラベルが存在しない・更新や確認に失敗・読み戻しで値が無いとき、成功を返さない（存在しないラベルでは更新もしない）', () => {
  const fixture = createFixture();
  try {
    const command = ['gh', 'issue', 'edit', '5', '--add-assignee', 'kurudrive', '--add-label', 'bug'];
    const good = issueState(['kurudrive'], ['bug']);
    const cases = [
      // 完全一致で存在しない（大文字小文字違い・部分一致は存在とみなさない）。更新は呼ばない。
      { label: 'ラベル不在', options: { applied: good, labels: ['Bug', 'bugs', 'task-queue'] }, expectedCalls: 1, message: /label does not exist/ },
      { label: 'ラベル一覧の取得失敗', options: { applied: good, listStatus: 1 }, expectedCalls: 1, message: /could not list labels/ },
      { label: '更新失敗', options: { applied: good, editStatus: 1 }, expectedCalls: 2, message: /gh issue edit failed/ },
      { label: '読み戻し失敗', options: { applied: good, viewStatus: 1 }, expectedCalls: 3, message: /could not verify/ },
      { label: '読み戻しが不正な JSON', options: { viewStdout: 'not json' }, expectedCalls: 3, message: /could not verify/ },
      // 終了コード 0 でも何も付いていなければ失敗（権限不足で何もしない gh を想定）。
      { label: '担当者が付いていない', options: { applied: issueState([], ['bug']) }, expectedCalls: 3, message: /"kurudrive" is not on issue #5/ },
      { label: 'ラベルが付いていない', options: { applied: issueState(['kurudrive'], []) }, expectedCalls: 3, message: /"bug" is not on issue #5/ },
      { label: 'ラベル名が完全一致しない', options: { applied: issueState(['kurudrive'], ['Bug']) }, expectedCalls: 3, message: /"bug" is not on issue #5/ },
      { label: '別の担当者だけ', options: { applied: issueState(['someone-else'], ['bug']) }, expectedCalls: 3, message: /"kurudrive" is not on issue #5/ },
    ];
    for (const { label, options, expectedCalls, message } of cases) {
      const { calls, spawnSync } = issueEditHarness(fixture, options);
      const stdout = [];
      const result = run(fixture, command, { spawnSync, writeOut: (m) => stdout.push(m) });
      assert.notEqual(result.code, 0, label);
      assert.match(result.messages.join(''), message, label);
      assert.equal(calls.length, expectedCalls, label);
      assert.equal(stdout.join(''), '', label);
    }
  } finally {
    fixture.cleanup();
  }
});

test('実行: 拒否された gh issue edit は gh を一度も呼ばない（別リポジトリ指定・--repo・削除系・不正値）', () => {
  const fixture = createFixture();
  try {
    const plain = path.join(fixture.root, 'plain');
    fs.mkdirSync(plain);
    for (const command of [
      ['gh', 'vektor-inc/other-repo', 'issue', 'edit', '5', '--add-assignee', 'kurudrive'],
      ['gh', 'issue', 'edit', '5', '--add-assignee', 'kurudrive', '--repo', 'o/r'],
      ['gh', 'issue', 'edit', '5', '--remove-label', 'bug'],
      ['gh', 'issue', 'edit', '5', '--add-assignee', '@me'],
      ['gh', 'issue', 'edit', 'x', '--add-label', 'bug'],
    ]) {
      const { calls, spawnSync } = issueEditHarness(fixture, { applied: issueState(['kurudrive'], ['bug']) });
      const result = run(fixture, command, { spawnSync, cwd: plain });
      assert.equal(result.code, 2, JSON.stringify(command));
      assert.equal(calls.length, 0, JSON.stringify(command));
    }
    assert.equal(fixture.readCalls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('PR 作成: 受理された組み立て結果は必ず --head を含み、push や対象指定を変えるフラグを含まない', () => {
  const heads = ['issue/428-x', 'feature_1', 'a.b-c'];
  for (const head of heads) {
    for (const extra of [[], ['--draft'], ['--base', 'main']]) {
      const result = parseTaskCommand(['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', head, ...extra]);
      assert.equal(result.ok, true);
      assert.equal(result.args[result.args.indexOf('--head') + 1], head);
      const flags = result.args.filter((token) => token.startsWith('-'));
      assert.deepEqual(flags.filter((flag) => !['--head', '--title', '--body', '--base', '--draft'].includes(flag)), []);
    }
  }
});

// ─── 実行時の検証（実際の Git リポジトリ・偽の gh） ────────────────────────

function git(cwd, ...args) {
  return childProcess.execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

const TRUSTED_TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
const GIT_PATH = resolveTrustedExecutable(fs, 'git', [...TRUSTED_TOOL_DIRS, ...String(process.env.PATH).split(path.delimiter).filter(path.isAbsolute)]);
const GITHUB_ORIGIN = 'https://github.com/vektor-inc/vk-terminals.git';

function initRepo(repo, { origin } = {}) {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  if (origin) git(repo, 'remote', 'add', 'origin', origin);
}

// 偽の gh は受け取った引数と環境変数を記録するだけ。シバンは絶対パスの Node（実行時の PATH に Node が無くても動く）。
function createFixture({ origin = GITHUB_ORIGIN } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-task-ops-')));
  const repo = path.join(root, 'repo');
  initRepo(repo, { origin });
  // 入口は main / master への commit を拒否するため、既定では作業ブランチに切り替えておく（既定ブランチ上の挙動は専用テストで確かめる）。
  git(repo, 'checkout', '-q', '-b', 'work/test');
  const binDir = path.join(root, 'bin');
  const record = path.join(root, 'gh-calls.jsonl');
  const home = path.join(root, 'home');
  fs.mkdirSync(binDir);
  fs.mkdirSync(home);
  const ghConfig = path.join(root, 'gh-config');
  fs.mkdirSync(ghConfig, { mode: 0o700 });
  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(ghPath, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }) + '\\n');\nif (process.argv[2] === 'issue' && process.argv[3] === 'create') console.log('https://github.com/vektor-inc/vk-terminals/issues/999');\n`, { mode: 0o755 });
  const gitConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n\tname = "Bound User"\n\temail = "bound@example.com"\n');
  const env = {
    VK_TASK_ROOT: repo,
    VK_TASK_REPO: parseGitHubRepo(origin) || '',
    VK_TASK_ALLOWED_OWNERS: 'vektor-inc,another-owner',
    VK_TASK_GIT: GIT_PATH,
    VK_TASK_GH: ghPath,
    VK_TASK_HOME: home,
    VK_TASK_GITCONFIG: gitConfig,
    VK_TASK_GHCONFIG: ghConfig,
  };
  const readCalls = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { root, repo, home, env, readCalls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function run(fixture, command, extra = {}) {
  const messages = [];
  const code = runTaskCommand(command, {
    cwd: fixture.repo,
    env: fixture.env,
    write: (message) => messages.push(message),
    spawnSync: (bin, args, options) => childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' }),
    ...extra,
  });
  return { code, messages };
}

test('実行: 許可された Git 操作は実際に動き、--output は拒否されてファイルが作られない', () => {
  const fixture = createFixture();
  try {
    fs.writeFileSync(path.join(fixture.repo, 'b.txt'), 'two\n');
    assert.equal(run(fixture, ['git', 'status', '--short']).code, 0);
    assert.equal(run(fixture, ['git', 'add', '--', 'b.txt']).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'add b']).code, 0);
    assert.equal(git(fixture.repo, 'log', '-1', '--format=%s'), 'add b');
    // リポジトリ内の設定は local の user.name（Test）より、固定した global の代替設定ではなく local が優先される。
    assert.equal(git(fixture.repo, 'log', '-1', '--format=%an'), 'Test');

    const target = path.join(fixture.root, 'written.txt');
    for (const command of [['git', 'diff', `--output=${target}`], ['git', 'log', '--output', target]]) {
      const result = run(fixture, command);
      assert.equal(result.code, 2);
      assert.match(result.messages.join(''), /flag not allowed/);
    }
    assert.equal(fs.existsSync(target), false);
  } finally {
    fixture.cleanup();
  }
});

test('実行: 明示した許可 owner の GitHub 操作は Git 管理外の cwd から実行し、完全一致しない owner は拒否する', () => {
  const fixture = createFixture();
  try {
    const plain = path.join(fixture.root, 'plain');
    fs.mkdirSync(plain);
    const allowed = run(fixture, ['gh', 'VEKTOR-INC/other-repo', 'issue', 'create', '--title', '題', '--body', '本文', '--assignee', 'kurudrive', '--label', 'task-queue'], { cwd: plain });
    assert.equal(allowed.code, 0, allowed.messages.join(''));
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [[
      'issue', 'create', '--title', '題', '--body', '本文', '--assignee', 'kurudrive', '--label', 'task-queue', '--repo', 'VEKTOR-INC/other-repo',
    ]]);
    assert.equal(fixture.readCalls()[0].cwd, fixture.home);

    for (const target of ['vektor/other-repo', 'vektor-inc-evil/other-repo', 'other/repo']) {
      const rejected = run(fixture, ['gh', target, 'issue', 'view', '1'], { cwd: plain });
      assert.equal(rejected.code, 2, target);
      assert.match(rejected.messages.join(''), /owner .* is not allowed/);
    }
    assert.equal(fixture.readCalls().length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('実行: 固定した global 設定の author 情報で commit できる（個人の global 設定は使わない）', () => {
  const fixture = createFixture();
  try {
    git(fixture.repo, 'config', '--unset', 'user.name');
    git(fixture.repo, 'config', '--unset', 'user.email');
    fs.writeFileSync(path.join(fixture.repo, 'b.txt'), 'two\n');
    assert.equal(run(fixture, ['git', 'add', '-A']).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'by bound identity']).code, 0);
    assert.equal(git(fixture.repo, 'log', '-1', '--format=%an <%ae>'), 'Bound User <bound@example.com>');
  } finally {
    fixture.cleanup();
  }
});

test('実行: リポジトリ内の外部 diff / textconv / clean filter / 署名プログラムの設定があれば何も実行せず拒否する', () => {
  const settings = [
    ['diff.external', 'ext'],
    ['diff.evil.textconv', 'ext'],
    ['filter.evil.clean', 'ext'],
    ['filter.evil.smudge', 'ext'],
    ['filter.evil.process', 'ext'],
    ['gpg.program', 'ext'],
    ['gpg.ssh.program', 'ext'],
    ['core.sshCommand', 'ext'],
    ['core.editor', 'ext'],
    ['credential.helper', '!ext'],
    ['merge.evil.driver', 'ext'],
    ['include.path', 'included.cfg'],
  ];
  for (const [key, value] of settings) {
    const fixture = createFixture();
    try {
      const marker = path.join(fixture.root, 'external-ran');
      const script = path.join(fixture.root, 'ext.sh');
      fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
      fs.writeFileSync(path.join(fixture.root, 'included.cfg'), '');
      git(fixture.repo, 'config', key, value === 'ext' ? script : value === 'included.cfg' ? path.join(fixture.root, value) : value);
      fs.writeFileSync(path.join(fixture.repo, '.gitattributes'), '*.txt diff=evil filter=evil\n');
      fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'changed\n');
      for (const command of [['git', 'diff'], ['git', 'add', '-A'], ['git', 'commit', '-m', 'x'], ['git', 'status']]) {
        const result = run(fixture, command);
        assert.equal(result.code, 2, `${key}: ${command.join(' ')}`);
        assert.match(result.messages.join(''), /can run external commands/);
      }
      assert.equal(fs.existsSync(marker), false, key);
    } finally {
      fixture.cleanup();
    }
  }
});

test('実行: 個人の global 設定にある clean filter・フックは使われない（HOME の .gitconfig を読まない）', () => {
  const fixture = createFixture();
  try {
    const marker = path.join(fixture.root, 'global-ran');
    const script = path.join(fixture.root, 'global.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\ncat\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(fixture.home, '.gitconfig'), `[filter "evil"]\n\tclean = ${script}\n[core]\n\thooksPath = ${fixture.root}/hooks\n`);
    fs.mkdirSync(path.join(fixture.home, '.config', 'git'), { recursive: true });
    fs.writeFileSync(path.join(fixture.home, '.config', 'git', 'config'), `[filter "evil"]\n\tclean = ${script}\n`);
    fs.writeFileSync(path.join(fixture.repo, '.gitattributes'), '*.txt filter=evil\n');
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'changed\n');
    assert.equal(run(fixture, ['git', 'add', '-A']).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'x']).code, 0);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fixture.cleanup();
  }
});

test('実行: リポジトリのフック（local の core.hooksPath を含む）は入口経由の commit では実行されない', () => {
  const fixture = createFixture();
  try {
    const marker = path.join(fixture.root, 'hook-ran');
    const hookBody = `#!/bin/sh\ntouch ${marker}\n`;
    fs.writeFileSync(path.join(fixture.repo, '.git', 'hooks', 'pre-commit'), hookBody, { mode: 0o755 });
    fs.writeFileSync(path.join(fixture.repo, '.git', 'hooks', 'commit-msg'), hookBody, { mode: 0o755 });
    const customHooks = path.join(fixture.root, 'custom-hooks');
    fs.mkdirSync(customHooks);
    fs.writeFileSync(path.join(customHooks, 'pre-commit'), hookBody, { mode: 0o755 });
    git(fixture.repo, 'config', 'core.hooksPath', customHooks);
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'changed\n');
    assert.equal(run(fixture, ['git', 'add', '-A']).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'x']).code, 0);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fixture.cleanup();
  }
});

// 自動保守（commit の後に走る maintenance run --auto → gc --auto）が、gc.recentObjectsHook で外部コマンドを起動する経路の検証。
// 未参照の古いオブジェクトを大量に作り、gc.auto を 1 にして、commit のたびに自動 gc が走る状態にする。
function prepareAutoGcRepository(fixture) {
  const marker = path.join(fixture.root, 'gc-hook-ran');
  const script = path.join(fixture.root, 'gc-hook.sh');
  fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
  git(fixture.repo, 'config', 'gc.recentObjectsHook', script);
  git(fixture.repo, 'config', 'gc.auto', '1');
  git(fixture.repo, 'config', 'gc.autoDetach', 'false');
  git(fixture.repo, 'config', 'gc.pruneExpire', 'now');
  const loose = path.join(fixture.root, 'loose');
  fs.mkdirSync(loose);
  const names = [];
  for (let i = 0; i < 700; i += 1) {
    const name = path.join(loose, `o${i}`);
    fs.writeFileSync(name, `unreachable ${i}\n`);
    names.push(name);
  }
  childProcess.execFileSync(GIT_PATH, ['hash-object', '-w', '--stdin-paths'], { cwd: fixture.repo, input: names.join('\n'), stdio: ['pipe', 'ignore', 'inherit'] });
  fs.writeFileSync(path.join(fixture.repo, 'next.txt'), 'next\n');
  git(fixture.repo, 'add', 'next.txt');
  return marker;
}

test('自動保守: commit 後の自動 gc で gc.recentObjectsHook の外部コマンドが起動しない（固定の指定が無ければ起動する対照つき）', () => {
  assert.ok(FIXED_GIT_PREFIX.includes('maintenance.auto=false'));
  assert.ok(FIXED_GIT_PREFIX.includes('gc.auto=0'));
  // FIXED_GIT_PREFIX から、指定した設定（-c <設定> の組）だけを取り除いた引数列を返す。
  const withoutConfig = (settings) => GIT_PREFIX.filter((arg, index) => !settings.includes(arg) && !(arg === '-c' && settings.includes(GIT_PREFIX[index + 1])));
  const commitWith = (fixture, prefix) => childProcess.spawnSync(GIT_PATH, [...prefix, 'commit', '-q', '-m', 'auto'], {
    cwd: fixture.repo,
    env: { PATH: '/usr/bin:/bin', HOME: fixture.home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    encoding: 'utf8',
  });

  // 対照: 自動保守の無効化を外すと、この構成では外部コマンドが起動する（テストが意味を持つ確認）。
  const control = createFixture();
  try {
    const marker = prepareAutoGcRepository(control);
    const withoutMaintenanceSwitches = withoutConfig(['maintenance.auto=false', 'gc.auto=0']);
    assert.equal(commitWith(control, withoutMaintenanceSwitches).status, 0);
    assert.equal(fs.existsSync(marker), true);
  } finally {
    control.cleanup();
  }

  // 固定の指定（commit にそのまま付く）では起動しない。片方ずつでも止まることを確認する。
  for (const dropped of [null, 'maintenance.auto=false', 'gc.auto=0']) {
    const fixture = createFixture();
    try {
      const marker = prepareAutoGcRepository(fixture);
      assert.equal(commitWith(fixture, withoutConfig(dropped === null ? [] : [dropped])).status, 0, String(dropped));
      assert.equal(fs.existsSync(marker), false, String(dropped));
    } finally {
      fixture.cleanup();
    }
  }
});

test('自動保守: 入口経由では、gc.recentObjectsHook などの外部コマンド起動設定があるリポジトリの commit を拒否し、何も実行しない', () => {
  for (const key of ['gc.recentObjectsHook', 'core.alternateRefsCommand', 'uploadpack.packObjectsHook']) {
    const fixture = createFixture();
    try {
      const marker = prepareAutoGcRepository(fixture);
      git(fixture.repo, 'config', key, path.join(fixture.root, 'gc-hook.sh'));
      for (const command of [['git', 'commit', '-m', 'x'], ['git', 'status'], ['git', 'add', '-A']]) {
        const result = run(fixture, command);
        assert.equal(result.code, 2, `${key}: ${command.join(' ')}`);
        assert.match(result.messages.join(''), /can run external commands/);
      }
      assert.equal(fs.existsSync(marker), false, key);
    } finally {
      fixture.cleanup();
    }
  }
});

test('実行: commit.gpgsign が有効でも署名プログラムは呼ばれない', () => {
  const fixture = createFixture();
  try {
    git(fixture.repo, 'config', 'commit.gpgsign', 'true');
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'changed\n');
    assert.equal(run(fixture, ['git', 'add', '-A']).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'unsigned']).code, 0);
    assert.equal(git(fixture.repo, 'log', '-1', '--format=%G?'), 'N');
  } finally {
    fixture.cleanup();
  }
});

test('拘束: 拘束したリポジトリ以外（別のリポジトリ・入れ子のリポジトリ）では add / commit / gh を実行しない', () => {
  const fixture = createFixture();
  try {
    const other = path.join(fixture.root, 'other');
    initRepo(other, { origin: 'https://github.com/someone/else.git' });
    const nested = path.join(fixture.repo, 'nested');
    initRepo(nested);
    for (const cwd of [other, nested]) {
      fs.writeFileSync(path.join(cwd, 'b.txt'), 'two\n');
      for (const command of [['git', 'add', '-A'], ['git', 'commit', '-m', 'x'], ['git', 'status'], ['gh', 'issue', 'view', '1']]) {
        const result = run(fixture, command, { cwd });
        assert.equal(result.code, 2, `${cwd}: ${command.join(' ')}`);
        assert.match(result.messages.join(''), /not the bound repository/);
      }
      assert.equal(git(cwd, 'log', '--format=%s'), 'init');
    }
    assert.deepEqual(fixture.readCalls(), []);

    // 拘束したリポジトリの下位フォルダからは実行できる。
    const sub = path.join(fixture.repo, 'sub');
    fs.mkdirSync(sub);
    assert.equal(run(fixture, ['git', 'status', '--short'], { cwd: sub }).code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('拘束: gh は検証済みの --repo が必ず付き、origin が拘束した GitHub リポジトリと違えば呼ばれない', () => {
  const fixture = createFixture();
  try {
    assert.equal(run(fixture, ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'issue/428-x']).code, 0);
    assert.equal(run(fixture, ['gh', 'issue', 'view', '428']).code, 0);
    assert.equal(run(fixture, ['gh', 'pr', 'checks', '429']).code, 0);
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [
      ['pr', 'create', '--head', 'issue/428-x', '--title', 't', '--body', 'b', '--repo', 'vektor-inc/vk-terminals'],
      ['issue', 'view', '428', '--repo', 'vektor-inc/vk-terminals'],
      ['pr', 'checks', '429', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    // 拒否された操作は gh を一度も呼ばない。
    const before = fixture.readCalls().length;
    assert.equal(run(fixture, ['gh', 'pr', 'create', '--title', 't', '--body', 'b']).code, 2);
    assert.equal(run(fixture, ['gh', 'issue', 'comment', '1', '--body-file', '/etc/passwd']).code, 2);
    assert.equal(run(fixture, ['gh', 'issue', 'view', '1', '--repo', 'other/repo']).code, 2);

    // origin を別のリポジトリへ差し替えられた（または GitHub 以外にされた）場合。
    for (const url of ['https://github.com/someone/else.git', 'https://example.com/o/r.git', 'https://github.com.evil.example/o/r.git']) {
      git(fixture.repo, 'remote', 'set-url', 'origin', url);
      const result = run(fixture, ['gh', 'issue', 'view', '1']);
      assert.equal(result.code, 2, url);
      assert.match(result.messages.join(''), /does not match the bound github\.com repository/);
    }
    assert.equal(fixture.readCalls().length, before);
  } finally {
    fixture.cleanup();
  }
});

test('拘束: gh issue list は --repo、gh repo view は位置引数として拘束先が付き、許可外 owner は gh を呼ばない（issue #520）', () => {
  const fixture = createFixture();
  try {
    const plain = path.join(fixture.root, 'plain');
    fs.mkdirSync(plain);
    assert.equal(run(fixture, ['gh', 'issue', 'list', '--state', 'all', '--limit', '5']).code, 0);
    assert.equal(run(fixture, ['gh', 'repo', 'view', '--json', 'visibility,defaultBranchRef']).code, 0);
    assert.equal(run(fixture, ['gh', 'repo', 'view', 'VEKTOR-INC/other-repo', '--json', 'isPrivate'], { cwd: plain }).code, 0);
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [
      ['issue', 'list', '--state', 'all', '--limit', '5', '--repo', 'vektor-inc/vk-terminals'],
      ['repo', 'view', '--json', 'visibility,defaultBranchRef', 'vektor-inc/vk-terminals'],
      ['repo', 'view', '--json', 'isPrivate', 'VEKTOR-INC/other-repo'],
    ]);
    const before = fixture.readCalls().length;
    for (const target of ['other/repo', 'vektor-inc-evil/other-repo']) {
      assert.equal(run(fixture, ['gh', 'repo', 'view', target, '--json', 'visibility'], { cwd: plain }).code, 2, target);
      assert.equal(run(fixture, ['gh', target, 'issue', 'list'], { cwd: plain }).code, 2, target);
    }
    assert.equal(run(fixture, ['gh', 'repo', 'view', '--json', 'visibility', '--repo', 'other/repo']).code, 2);
    // 検索構文で拘束先の外へ広げる入力は、gh を起動する前に拒否する。
    assert.equal(run(fixture, ['gh', 'issue', 'list', '--search', 'x ) OR repo:other/private OR ( x']).code, 2);
    assert.equal(run(fixture, ['gh', 'issue', 'list', '--search', 'repo:other/private']).code, 2);
    assert.equal(run(fixture, ['gh', 'issue', 'list', '--label', 'a) OR repo:other/private']).code, 2);
    assert.equal(fixture.readCalls().length, before);
  } finally {
    fixture.cleanup();
  }
});

test('拘束: 起動時に GitHub のリポジトリを確定できなかった場合は gh を実行しないが、git は使える', () => {
  const fixture = createFixture({ origin: 'https://example.com/o/r.git' });
  try {
    assert.equal(fixture.env.VK_TASK_REPO, '');
    const result = run(fixture, ['gh', 'issue', 'view', '1']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /does not match the bound github\.com repository/);
    assert.equal(run(fixture, ['git', 'status']).code, 0);
    assert.deepEqual(fixture.readCalls(), []);
  } finally {
    fixture.cleanup();
  }
});

test('拘束: Git 管理外・ホームそのもの・拘束の設定が無い／不正な場合は何も実行しない', () => {
  const fixture = createFixture();
  try {
    const outside = path.join(fixture.root, 'plain');
    fs.mkdirSync(outside);
    assert.match(run(fixture, ['git', 'status'], { cwd: outside }).messages.join(''), /not inside a git repository/);
    // リポジトリのルートがホームそのもの（ホーム全体が Git 管理）なら拒否する。
    const result = run(fixture, ['git', 'status'], { env: { ...fixture.env, VK_TASK_HOME: fixture.repo } });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /not a project directory/);

    const broken = [
      {},
      { ...fixture.env, VK_TASK_ROOT: 'relative' },
      { ...fixture.env, VK_TASK_GIT: '' },
      { ...fixture.env, VK_TASK_GITCONFIG: "/tmp/a'b" },
      { ...fixture.env, VK_TASK_REPO: 'not a repo' },
      { ...fixture.env, VK_TASK_ALLOWED_OWNERS: 'good,bad/owner' },
      { ...fixture.env, VK_TASK_ALLOWED_OWNERS: '-evil' },
      { ...fixture.env, VK_TASK_GH: 'gh' },
      { ...fixture.env, VK_TASK_GHCONFIG: '' },
      { ...fixture.env, VK_TASK_GHCONFIG: 'relative' },
    ];
    for (const env of broken) {
      const rejected = run(fixture, ['git', 'status'], { env });
      assert.equal(rejected.code, 2, JSON.stringify(env));
      assert.match(rejected.messages.join(''), /launcher binding is missing or invalid/);
    }
    assert.equal(readBinding({}), null);
    assert.deepEqual(readBinding(fixture.env), {
      root: fixture.repo, repo: 'vektor-inc/vk-terminals', allowedOwners: ['vektor-inc', 'another-owner'], git: GIT_PATH, gh: fixture.env.VK_TASK_GH, home: fixture.home, gitConfig: fixture.env.VK_TASK_GITCONFIG, ghConfig: fixture.env.VK_TASK_GHCONFIG, remoteBase: 'https://github.com', member: null,
    });
  } finally {
    fixture.cleanup();
  }
});

test('環境: 子プロセスへは許可リストの変数だけを渡し、親の NODE_OPTIONS・LD_PRELOAD・GIT_*・GH_* は引き継がない', () => {
  const fixture = createFixture();
  try {
    const poisoned = {
      ...fixture.env,
      NODE_OPTIONS: '--require /tmp/evil.js', LD_PRELOAD: '/tmp/evil.so', DYLD_INSERT_LIBRARIES: '/tmp/evil.dylib',
      GIT_DIR: '/tmp/x', GIT_EXEC_PATH: '/tmp/x', GIT_SSH_COMMAND: 'x', GIT_CONFIG_COUNT: '1', GH_REPO: 'evil/repo', GH_HOST: 'evil.example',
      GH_TOKEN: 'secret', PATH: '/tmp/evil-bin', HOME: '/tmp/evil-home', XDG_CONFIG_HOME: '/tmp/evil-xdg', GH_CONFIG_DIR: '/tmp/evil-gh', PAGER: 'x', EDITOR: 'x',
    };
    assert.equal(run(fixture, ['gh', 'issue', 'view', '1'], { env: poisoned }).code, 0);
    const [{ env }] = fixture.readCalls();
    const expected = buildChildEnvironment({ git: GIT_PATH, gh: fixture.env.VK_TASK_GH, home: fixture.home, gitConfig: fixture.env.VK_TASK_GITCONFIG, ghConfig: fixture.env.VK_TASK_GHCONFIG });
    // 子プロセスの環境は、固定値だけ（Node が自分で足す変数を除く）。
    for (const [key, value] of Object.entries(expected)) assert.equal(env[key], value, key);
    for (const key of Object.keys(env)) assert.ok(key in expected || /^(__CF_USER_TEXT_ENCODING|SHLVL|_)$/.test(key), key);
    assert.equal(expected.HOME, fixture.home);
    // gh の設定は個人の ~/.config/gh ではなく、ランチャーが生成した専用フォルダだけを指す。
    assert.equal(expected.GH_CONFIG_DIR, fixture.env.VK_TASK_GHCONFIG);
    assert.equal(expected.XDG_CONFIG_HOME, path.dirname(fixture.env.VK_TASK_GHCONFIG));
    assert.ok(!expected.GH_CONFIG_DIR.startsWith(fixture.home));
    assert.equal(expected.GIT_CONFIG_SYSTEM, '/dev/null');
    assert.equal(expected.GIT_NO_LAZY_FETCH, '1');
    assert.equal(expected.GIT_ALLOW_PROTOCOL, '');
    assert.match(expected.PATH, new RegExp(`^${path.dirname(GIT_PATH)}`));
  } finally {
    fixture.cleanup();
  }
});

test('設定の解析: 外部コマンドを起動しうる項目だけを見つけ、origin の生の URL を返す', () => {
  const listing = (...entries) => entries.map(([key, value]) => `${key}\n${value}\0`).join('');
  assert.deepEqual(inspectGitConfigListing(listing(['core.bare', 'false'], ['remote.origin.url', GITHUB_ORIGIN], ['user.name', 'x'])), { unsafeKey: null, originUrl: GITHUB_ORIGIN });
  for (const key of ['filter.lfs.clean', 'filter.a.b.smudge', 'diff.x.textconv', 'diff.external', 'gpg.program', 'gpg.ssh.program', 'core.sshcommand', 'include.path', 'includeif.gitdir:/x.path', 'credential.https://x.helper', 'merge.m.driver', 'remote.origin.promisor', 'remote.o.partialclonefilter', 'remote.o.vcs', 'extensions.partialclone', 'gc.recentObjectsHook', 'gc.recentobjectshook', 'core.alternateRefsCommand', 'uploadpack.packObjectsHook']) {
    assert.equal(inspectGitConfigListing(listing([key, 'v'])).unsafeKey, key, key);
  }
  assert.equal(parseGitHubRepo('https://github.com/o/r.git'), 'o/r');
  assert.equal(parseGitHubRepo('git@github.com:o/r'), 'o/r');
  assert.equal(parseGitHubRepo('ssh://git@github.com/o/r.git'), 'o/r');
  for (const url of [null, '', 'https://example.com/o/r', 'https://github.com.evil.example/o/r', 'https://evil.example/https://github.com/o/r', 'https://github.com/o']) {
    assert.equal(parseGitHubRepo(url), null, String(url));
  }
});

test('遅延取得: 部分クローンで不足オブジェクトを参照しても通信・外部コマンドは起動せず、環境が無ければ起動する（対照）', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-task-lazy-')));
  try {
    const server = path.join(root, 'server');
    initRepo(server, { origin: null });
    git(server, 'config', 'uploadpack.allowFilter', 'true');
    git(server, 'config', 'uploadpack.allowAnySHA1InWant', 'true');
    const clone = path.join(root, 'clone');
    git(root, '-c', 'protocol.file.allow=always', 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${server}`, clone);
    // 通信が起きると印のファイルが作られる偽のアップロードパック。
    const marker = path.join(root, 'marker');
    const helper = path.join(root, 'upload-pack.sh');
    fs.writeFileSync(helper, `#!/bin/sh\ntouch ${marker}\nexec git-upload-pack "$@"\n`, { mode: 0o755 });
    git(clone, 'config', 'remote.origin.uploadpack', helper);
    const spawn = (env) => childProcess.spawnSync(GIT_PATH, ['-c', 'protocol.file.allow=always', 'show', 'HEAD:a.txt'], { cwd: clone, env, encoding: 'utf8' });
    const base = { PATH: `${path.dirname(GIT_PATH)}:/usr/bin:/bin`, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

    // 対照: 無効化しなければ自動取得が走る（この対照が通らないと、下の検証は意味を持たない）。
    assert.equal(spawn(base).status, 0);
    assert.ok(fs.existsSync(marker));
    fs.rmSync(marker);
    // 対照で取得済みになったため、取り直して再び不足オブジェクトのある状態にする。
    fs.rmSync(clone, { recursive: true });
    git(root, '-c', 'protocol.file.allow=always', 'clone', '-q', '--no-checkout', '--filter=blob:none', `file://${server}`, clone);
    git(clone, 'config', 'remote.origin.uploadpack', helper);

    // 固定環境: 失敗はするが、通信も外部コマンドの起動も起きない。環境変数ごとに単独でも止まる。
    const env = buildChildEnvironment({ git: GIT_PATH, gh: null, home: root, gitConfig: '/dev/null', ghConfig: null });
    for (const guarded of [env, { ...base, GIT_NO_LAZY_FETCH: '1' }, { ...base, GIT_ALLOW_PROTOCOL: '' }]) {
      assert.notEqual(spawn(guarded).status, 0);
      assert.ok(!fs.existsSync(marker));
    }

    // 部分クローンのリポジトリは、引数の検証を通る操作でも、リポジトリ検査が設定を理由に拒否する。
    const rejected = run({ repo: clone, env: { VK_TASK_ROOT: clone, VK_TASK_REPO: '', VK_TASK_GIT: GIT_PATH, VK_TASK_HOME: root, VK_TASK_GITCONFIG: path.join(root, 'gitconfig') } }, ['git', 'show', 'HEAD']);
    assert.equal(rejected.code, 2);
    assert.match(rejected.messages.join(''), /repository configuration can run external commands: "remote\.origin\.promisor"/);
    assert.ok(!fs.existsSync(marker));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Git バージョン: 遅延取得を無効化できる 2.46 以上だけを受け入れ、読めない出力は拒否する', () => {
  for (const output of ['git version 2.46.0\n', 'git version 2.47.0', 'git version 3.0.1', 'git version 2.50.1 (Apple Git-155)']) assert.equal(isSupportedGitVersion(output), true, output);
  for (const output of ['git version 2.45.2', 'git version 2.44.0', 'git version 2.43.5', 'git version 2.39.5 (Apple Git-154)', 'git version 1.9.0', '', 'fatal: error', 'git version x.y']) assert.equal(isSupportedGitVersion(output), false, output);
  const fakeRun = (stdout, status = 0) => (args) => (args[0] === 'version' ? { status, stdout } : { status: 1, stdout: '' });
  for (const [stdout, status] of [['git version 2.45.0', 0], ['git version 2.44.0', 0], ['git version 2.47.0', 1]]) {
    const result = inspectRepository({ cwd: '/tmp', run: fakeRun(stdout, status), homeDir: '/tmp', fsImpl: fs });
    assert.equal(result.ok, false);
    assert.match(result.error, /2\.46 or later/);
  }
});

// ─── 信頼境界（所有者・権限・リンク） ───────────────────────────────────────

test('信頼境界: 根から末端までの全階層について、リンク・他人の所有・他人が書ける権限を拒否する', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-trust-')));
  try {
    const dir = path.join(root, 'a', 'b');
    fs.mkdirSync(dir, { recursive: true });
    const { chain: snapshot, realPath } = resolveTrustedPath(fs, dir);
    assert.equal(snapshot[snapshot.length - 1].path, dir);
    assert.equal(realPath, dir);

    // 他人（グループ・その他）が書き込める祖先／末端。
    for (const [target, mode] of [[path.join(root, 'a'), 0o777], [path.join(root, 'a'), 0o775], [dir, 0o757]]) {
      const original = fs.statSync(target).mode & 0o777;
      fs.chmodSync(target, mode);
      try {
        assert.throws(() => resolveTrustedPath(fs, dir), /writable by other users/, `${target} ${mode.toString(8)}`);
      } finally {
        fs.chmodSync(target, original);
      }
    }
    // 所有者が違う。
    assert.throws(() => resolveTrustedPath(fs, dir, { uid: process.getuid() + 1 }), /not owned by/);
    // 祖先がリンク（自分の所有で、向き先の全階層が検証を通れば実パスへ解決される）。末端自体のリンクは rejectFinalLink で拒否する。
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'link'));
    assert.equal(resolveTrustedPath(fs, path.join(root, 'link', 'b')).realPath, dir);
    assert.throws(() => resolveTrustedPath(fs, path.join(root, 'link'), { rejectFinalLink: true }), /path is a symbolic link/);
    assert.throws(() => resolveTrustedPath(fs, path.join(root, 'link', 'b'), { uid: process.getuid() + 1 }), /not owned by/);
    // 末端が種別違い。
    fs.writeFileSync(path.join(root, 'file'), 'x');
    assert.throws(() => resolveTrustedPath(fs, path.join(root, 'file')), /not a directory/);
    assert.doesNotThrow(() => resolveTrustedPath(fs, path.join(root, 'file'), { finalKind: 'file' }));
    assert.throws(() => resolveTrustedPath(fs, dir, { finalKind: 'file' }), /not a regular file/);

    // 検証後に祖先が別のフォルダへ差し替えられたことを検知する。
    const verified = resolveTrustedPath(fs, dir).chain;
    fs.renameSync(path.join(root, 'a'), path.join(root, 'a-old'));
    fs.mkdirSync(path.join(root, 'a', 'b'), { recursive: true });
    assert.throws(() => assertChainUnchanged(fs, verified), /changed after it was verified/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('信頼境界: 実行ファイルは固定の探索先から、他人が書けない場所のものだけを選ぶ（PATH は見ない）', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-exec-')));
  try {
    const trusted = path.join(root, 'trusted');
    const open = path.join(root, 'open');
    const real = path.join(root, 'real');
    for (const dir of [trusted, open, real]) fs.mkdirSync(dir);
    for (const dir of [trusted, open]) fs.writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(open, 0o777);

    assert.equal(resolveTrustedExecutable(fs, 'tool', [open, trusted]), path.join(trusted, 'tool'));
    assert.equal(resolveTrustedExecutable(fs, 'tool', [open]), null);
    assert.equal(resolveTrustedExecutable(fs, 'missing', [trusted]), null);
    assert.equal(resolveTrustedExecutable(fs, '../tool', [trusted]), null);
    // 実行権限が無いファイル・他人が書き込めるファイル。
    fs.writeFileSync(path.join(trusted, 'plain'), 'x', { mode: 0o644 });
    assert.equal(resolveTrustedExecutable(fs, 'plain', [trusted]), null);
    fs.writeFileSync(path.join(trusted, 'writable'), '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(path.join(trusted, 'writable'), 0o757);
    assert.equal(resolveTrustedExecutable(fs, 'writable', [trusted]), null);
    // リンクは向き先を 1 段ずつ検証し、リンク側のパスを返す（argv[0] で挙動を変えるツールのため）。
    fs.writeFileSync(path.join(real, 'impl'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(path.join(real, 'impl'), path.join(trusted, 'linked'));
    assert.equal(resolveTrustedExecutable(fs, 'linked', [trusted]), path.join(trusted, 'linked'));
    fs.chmodSync(real, 0o777);
    assert.equal(resolveTrustedExecutable(fs, 'linked', [trusted]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 実行ファイルへのリンクを検証する一時ツリー（trusted/tool → hop/tool → store/impl）。
function createLinkTree() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-link-')));
  const dirs = Object.fromEntries(['trusted', 'hop', 'store', 'open'].map((name) => [name, path.join(root, name)]));
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dirs.store, 'impl'), '#!/bin/sh\n', { mode: 0o755 });
  fs.symlinkSync(path.join(dirs.store, 'impl'), path.join(dirs.hop, 'tool'));
  fs.symlinkSync(path.join(dirs.hop, 'tool'), path.join(dirs.trusted, 'tool'));
  return { root, ...dirs };
}

test('信頼境界: 実行ファイルへのリンクは途中の全階層（リンク・フォルダ）を検証し、未検証の経路を残さない', () => {
  const tree = createLinkTree();
  try {
    const resolved = resolveTrustedExecutableDetailed(fs, 'tool', [tree.trusted]);
    assert.equal(resolved.path, path.join(tree.trusted, 'tool'));
    // 途中のリンクが検証結果に残り、向き先まで記録される。
    assert.deepEqual(resolved.chain.filter((entry) => entry.link !== undefined).map((entry) => entry.path), [path.join(tree.trusted, 'tool'), path.join(tree.hop, 'tool')]);
    assert.doesNotThrow(() => assertChainUnchanged(fs, resolved.chain));

    // 途中のリンクの向き先が検証後に別の実行物へ張り替えられたら検知する。
    fs.writeFileSync(path.join(tree.open, 'evil'), '#!/bin/sh\n', { mode: 0o755 });
    fs.rmSync(path.join(tree.hop, 'tool'));
    fs.symlinkSync(path.join(tree.open, 'evil'), path.join(tree.hop, 'tool'));
    assert.throws(() => assertChainUnchanged(fs, resolved.chain), /changed after it was verified/);
    // 張り替え先が他人の書けるフォルダなら、候補ごと採用しない。
    fs.chmodSync(tree.open, 0o777);
    assert.equal(resolveTrustedExecutable(fs, 'tool', [tree.trusted]), null);
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('信頼境界: 途中のリンクを置いたフォルダが他人に書ける・リンクの所有者が違う・相対リンクで書込可能な場所へ出る場合は拒否する', () => {
  // 途中のリンクを置くフォルダが他人に書ける（リンクを差し替えられる）。
  let tree = createLinkTree();
  try {
    fs.chmodSync(tree.hop, 0o777);
    assert.equal(resolveTrustedExecutable(fs, 'tool', [tree.trusted]), null);
    assert.throws(() => resolveTrustedPath(fs, path.join(tree.trusted, 'tool'), { finalKind: 'file' }), /writable by other users/);
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
  // リンクの所有者が、実行ユーザーでも root でもない。
  tree = createLinkTree();
  try {
    assert.equal(resolveTrustedExecutable(fs, 'tool', [tree.trusted], { uid: process.getuid() + 1 }), null);
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
  // 相対リンクの '..' 経由で、他人の書けるフォルダの実行物へ出る。
  tree = createLinkTree();
  try {
    fs.writeFileSync(path.join(tree.open, 'evil'), '#!/bin/sh\n', { mode: 0o755 });
    fs.chmodSync(tree.open, 0o777);
    fs.rmSync(path.join(tree.trusted, 'tool'));
    fs.symlinkSync('../hop/../open/evil', path.join(tree.trusted, 'tool'));
    assert.equal(resolveTrustedExecutable(fs, 'tool', [tree.trusted]), null);
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
  // リンクの循環・長すぎる連鎖。
  tree = createLinkTree();
  try {
    fs.rmSync(path.join(tree.hop, 'tool'));
    fs.symlinkSync(path.join(tree.trusted, 'tool'), path.join(tree.hop, 'tool'));
    assert.equal(resolveTrustedExecutable(fs, 'tool', [tree.trusted]), null);
  } finally {
    fs.rmSync(tree.root, { recursive: true, force: true });
  }
});

test('信頼境界: 無いフォルダは検証済みの親の下に 1 段ずつ 0700 で作り、書込可能な親の下には作らない', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-create-')));
  try {
    const target = path.join(root, 'a', 'b', 'c');
    const { realPath, chain } = resolveTrustedPath(fs, target, { createMissing: true });
    assert.equal(realPath, target);
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.equal(chain[chain.length - 1].path, target);
    assert.throws(() => resolveTrustedPath(fs, path.join(root, 'x', 'y')), /ENOENT/);
    assert.equal(fs.existsSync(path.join(root, 'x')), false);
    // 書込可能な親の下には作らない（検証が作成より先）。
    fs.mkdirSync(path.join(root, 'shared'));
    fs.chmodSync(path.join(root, 'shared'), 0o777);
    assert.throws(() => resolveTrustedPath(fs, path.join(root, 'shared', 'new', 'dir'), { createMissing: true }), /writable by other users/);
    assert.equal(fs.existsSync(path.join(root, 'shared', 'new')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('実行: gh へのリンクの途中が他人に書ける場所へ張り替えられた場合は実行しない', () => {
  const fixture = createFixture();
  try {
    const hop = path.join(fixture.root, 'hop');
    fs.mkdirSync(hop);
    const realGh = path.join(fixture.root, 'bin', 'gh');
    const linked = path.join(fixture.root, 'linked-gh');
    fs.symlinkSync(path.join(hop, 'gh'), linked);
    fs.symlinkSync(realGh, path.join(hop, 'gh'));
    const env = { ...fixture.env, VK_TASK_GH: linked };
    assert.equal(run(fixture, ['gh', 'issue', 'view', '1'], { env }).code, 0);
    fs.chmodSync(hop, 0o777);
    const result = run(fixture, ['gh', 'issue', 'view', '2'], { env });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /writable by other users/);
    assert.equal(fixture.readCalls().length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh の専用設定フォルダが他人に書ける・リンクの場合は gh を実行しない', () => {
  const fixture = createFixture();
  try {
    fs.chmodSync(fixture.env.VK_TASK_GHCONFIG, 0o777);
    const writable = run(fixture, ['gh', 'issue', 'view', '1']);
    assert.equal(writable.code, 2);
    assert.match(writable.messages.join(''), /writable by other users/);
    fs.chmodSync(fixture.env.VK_TASK_GHCONFIG, 0o700);
    const elsewhere = path.join(fixture.root, 'personal-gh');
    fs.mkdirSync(elsewhere);
    fs.rmSync(fixture.env.VK_TASK_GHCONFIG, { recursive: true });
    fs.symlinkSync(elsewhere, fixture.env.VK_TASK_GHCONFIG);
    const linked = run(fixture, ['gh', 'issue', 'view', '1']);
    assert.equal(linked.code, 2);
    assert.match(linked.messages.join(''), /symbolic link/);
    assert.deepEqual(fixture.readCalls(), []);
  } finally {
    fixture.cleanup();
  }
});

test('実行: git / gh の実行ファイルが他人の書ける場所へ移された・差し替えられた場合は実行しない', () => {
  const fixture = createFixture();
  try {
    fs.chmodSync(path.dirname(fixture.env.VK_TASK_GH), 0o777);
    const result = run(fixture, ['gh', 'issue', 'view', '1']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /writable by other users/);
    assert.deepEqual(fixture.readCalls(), []);
    // gh を使わない操作は影響を受けない。
    assert.equal(run(fixture, ['git', 'status']).code, 0);
    const missingGh = run(fixture, ['gh', 'issue', 'view', '1'], { env: { ...fixture.env, VK_TASK_GH: '' } });
    assert.match(missingGh.messages.join(''), /gh is not available/);
  } finally {
    fixture.cleanup();
  }
});

// ─── worktree の受け入れと既定ブランチへの commit 拒否（issue #433） ────────────

// 拘束先のリポジトリに worktree を作る。dir は worktree の置き場所（拘束先の内側・外側のどちらでもよい）。
function addWorktree(fixture, dir, branch) {
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  git(fixture.repo, 'worktree', 'add', '-q', '-b', branch, dir);
  return fs.realpathSync(dir);
}

test('worktree: 拘束先の内側・外側のどちらの worktree でも add / commit / 閲覧ができる', () => {
  const fixture = createFixture();
  try {
    const inside = addWorktree(fixture, path.join(fixture.repo, '.claude', 'worktrees', 'x'), 'work/inside');
    const outside = addWorktree(fixture, path.join(fixture.root, 'outside-wt'), 'work/outside');
    for (const [cwd, branch] of [[inside, 'work/inside'], [outside, 'work/outside']]) {
      fs.writeFileSync(path.join(cwd, 'wt.txt'), `${branch}\n`);
      assert.equal(run(fixture, ['git', 'status', '--short'], { cwd }).code, 0, cwd);
      assert.equal(run(fixture, ['git', 'add', '--', 'wt.txt'], { cwd }).code, 0, cwd);
      assert.equal(run(fixture, ['git', 'commit', '-m', `in ${branch}`], { cwd }).code, 0, cwd);
      assert.equal(git(cwd, 'log', '-1', '--format=%s'), `in ${branch}`);
      // 拘束先のブランチは動かない。
      assert.equal(git(fixture.repo, 'rev-parse', '--abbrev-ref', 'HEAD'), 'work/test');
    }
    // 拘束先の下位フォルダと同様、worktree の下位フォルダからも実行できる。
    fs.mkdirSync(path.join(outside, 'sub'));
    assert.equal(run(fixture, ['git', 'status', '--short'], { cwd: path.join(outside, 'sub') }).code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('worktree: gh pr create は worktree からも、拘束した --repo 付きで呼ばれる（origin が違えば呼ばれない）', () => {
  const fixture = createFixture();
  try {
    const wt = addWorktree(fixture, path.join(fixture.root, 'wt-gh'), 'work/gh');
    assert.equal(run(fixture, ['gh', 'pr', 'create', '--head', 'work/gh', '--title', 't', '--body', 'b'], { cwd: wt }).code, 0);
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [
      ['pr', 'create', '--head', 'work/gh', '--title', 't', '--body', 'b', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    git(fixture.repo, 'remote', 'set-url', 'origin', 'https://github.com/someone/else.git');
    const result = run(fixture, ['gh', 'issue', 'view', '1'], { cwd: wt });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /does not match the bound github\.com repository/);
    assert.equal(fixture.readCalls().length, 1);
  } finally {
    fixture.cleanup();
  }
});

test('worktree: 同じ origin を持つ別クローン・別リポジトリの worktree・入れ子のリポジトリは、Git 管理領域が違うので拒否する', () => {
  const fixture = createFixture();
  try {
    const clone = path.join(fixture.root, 'clone');
    git(fixture.root, 'clone', '-q', fixture.repo, clone);
    git(clone, 'remote', 'set-url', 'origin', GITHUB_ORIGIN);
    git(clone, 'checkout', '-q', '-b', 'work/clone');
    const other = path.join(fixture.root, 'other');
    initRepo(other, { origin: GITHUB_ORIGIN });
    git(other, 'checkout', '-q', '-b', 'work/other');
    const otherWt = path.join(fixture.root, 'other-wt');
    git(other, 'worktree', 'add', '-q', '-b', 'work/other-wt', otherWt);
    const nested = path.join(fixture.repo, 'nested');
    initRepo(nested, { origin: GITHUB_ORIGIN });
    git(nested, 'checkout', '-q', '-b', 'work/nested');
    for (const cwd of [clone, other, fs.realpathSync(otherWt), nested]) {
      fs.writeFileSync(path.join(cwd, 'b.txt'), 'two\n');
      for (const command of [['git', 'add', '-A'], ['git', 'commit', '-m', 'x'], ['gh', 'pr', 'view', '1']]) {
        const result = run(fixture, command, { cwd });
        assert.equal(result.code, 2, `${cwd}: ${command.join(' ')}`);
        assert.match(result.messages.join(''), /not the bound repository/);
      }
    }
    assert.deepEqual(fixture.readCalls(), []);
  } finally {
    fixture.cleanup();
  }
});

test('worktree: worktree 側の cwd でも、外部コマンドを起動しうる設定があれば拒否する', () => {
  const fixture = createFixture();
  try {
    const wt = addWorktree(fixture, path.join(fixture.root, 'wt-cfg'), 'work/cfg');
    git(fixture.repo, 'config', 'core.editor', 'sh -c "touch /tmp/never"');
    const result = run(fixture, ['git', 'status'], { cwd: wt });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /can run external commands/);
  } finally {
    fixture.cleanup();
  }
});

test('既定ブランチ: main / master / origin/HEAD の指す先 / detached HEAD では commit を拒否し、作業ブランチなら通る（拘束先・worktree の両方）', () => {
  const fixture = createFixture();
  try {
    const wt = addWorktree(fixture, path.join(fixture.root, 'wt-branch'), 'work/wt');
    // 変更を add してから commit を試み、拒否された場合は HEAD が動いていないことも確かめる。
    const attempt = (cwd, label) => {
      fs.writeFileSync(path.join(cwd, 'c.txt'), `${label}\n`);
      assert.equal(run(fixture, ['git', 'add', '-A'], { cwd }).code, 0);
      const before = git(cwd, 'rev-parse', 'HEAD');
      const result = run(fixture, ['git', 'commit', '-m', label], { cwd });
      if (result.code === 2) assert.equal(git(cwd, 'rev-parse', 'HEAD'), before, `${label}: 拒否されたのに commit された`);
      return result;
    };

    // main / master（拘束先）。
    for (const name of ['main', 'master']) {
      git(fixture.repo, 'checkout', '-q', '-B', name);
      const result = attempt(fixture.repo, `repo on ${name}`);
      assert.equal(result.code, 2);
      assert.match(result.messages.join(''), /task command rejected: cannot commit on the default branch/);
    }
    // detached HEAD（拘束先）。
    git(fixture.repo, 'checkout', '-q', '--detach');
    const detachedRepo = attempt(fixture.repo, 'repo detached');
    assert.equal(detachedRepo.code, 2);
    assert.match(detachedRepo.messages.join(''), /cannot commit on a detached HEAD/);
    // 作業ブランチに戻せば通る。
    git(fixture.repo, 'checkout', '-q', '-B', 'work/test');
    assert.equal(attempt(fixture.repo, 'repo on work').code, 0);

    // worktree: 同じブランチ名は 2 か所で開けないので、拘束先を切り離してから worktree 側で切り替える。
    git(fixture.repo, 'checkout', '-q', '--detach');
    for (const name of ['main', 'master']) {
      git(wt, 'checkout', '-q', '-B', name);
      const result = attempt(wt, `wt on ${name}`);
      assert.equal(result.code, 2, name);
      assert.match(result.messages.join(''), /cannot commit on the default branch/);
    }
    git(wt, 'checkout', '-q', '--detach');
    const detachedWt = attempt(wt, 'wt detached');
    assert.equal(detachedWt.code, 2);
    assert.match(detachedWt.messages.join(''), /cannot commit on a detached HEAD/);
    git(wt, 'checkout', '-q', '-B', 'work/wt');
    assert.equal(attempt(wt, 'wt on work').code, 0);

    // リモートの既定ブランチ（origin/HEAD の指す先）。main / master 以外の名前でも拒否する。
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(fixture.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    git(wt, 'checkout', '-q', '-B', 'develop');
    const remoteDefault = attempt(wt, 'wt on remote default');
    assert.equal(remoteDefault.code, 2);
    assert.match(remoteDefault.messages.join(''), /default branch "develop"/);
    // origin/HEAD が無ければ判定に使わない（develop は通常の作業ブランチ）。
    git(fixture.repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    assert.equal(attempt(wt, 'wt on develop without origin/HEAD').code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('既定ブランチ: commit 以外（add / status / gh）は既定ブランチ上でも拒否しない', () => {
  const fixture = createFixture();
  try {
    git(fixture.repo, 'checkout', '-q', '-B', 'main');
    fs.writeFileSync(path.join(fixture.repo, 'b.txt'), 'two\n');
    assert.equal(run(fixture, ['git', 'add', '-A']).code, 0);
    assert.equal(run(fixture, ['git', 'status']).code, 0);
    assert.equal(run(fixture, ['gh', 'issue', 'view', '1']).code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('結合: worktree 作成 → 編集 → add → commit → gh pr create の経路が入口経由で通る', () => {
  const fixture = createFixture();
  try {
    // 拘束先は main のまま（Codex が通常クローンで main にいる状態）。
    git(fixture.repo, 'checkout', '-q', '-B', 'main');
    const wt = addWorktree(fixture, path.join(fixture.repo, '.claude', 'worktrees', 'codex-1303'), 'issue/433-flow');
    fs.writeFileSync(path.join(wt, 'feature.txt'), 'feature\n');
    fs.writeFileSync(path.join(wt, 'a.txt'), 'edited\n');
    assert.equal(run(fixture, ['git', 'add', '--', 'feature.txt', 'a.txt'], { cwd: wt }).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', '[ 機能追加 ] 例'], { cwd: wt }).code, 0);
    assert.equal(git(wt, 'log', '-1', '--format=%s'), '[ 機能追加 ] 例');
    assert.equal(git(wt, 'status', '--porcelain'), '');
    assert.equal(run(fixture, ['gh', 'pr', 'create', '--head', 'issue/433-flow', '--title', '題', '--body', '本文'], { cwd: wt }).code, 0);
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [
      ['pr', 'create', '--head', 'issue/433-flow', '--title', '題', '--body', '本文', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    // 拘束先の main には何も積まれていない。
    assert.equal(git(fixture.repo, 'log', '-1', '--format=%s'), 'init');
  } finally {
    fixture.cleanup();
  }
});

test('再起動: 拘束は起動時の cwd（通常のクローン）だけで決まるため、同じ拘束の設定のまま既存の worktree で作業を続けられる', () => {
  const fixture = createFixture();
  try {
    const wt = addWorktree(fixture, path.join(fixture.root, 'wt-restart'), 'work/restart');
    fs.writeFileSync(path.join(wt, 'r.txt'), '1\n');
    assert.equal(run(fixture, ['git', 'add', '-A'], { cwd: wt }).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'before restart'], { cwd: wt }).code, 0);
    // 再起動 = 通常のクローンから決まる同じ VK_TASK_* で、入口が新しいプロセスとして呼ばれる。
    const restartedEnv = { ...fixture.env };
    fs.writeFileSync(path.join(wt, 'r.txt'), '2\n');
    assert.equal(run(fixture, ['git', 'add', '-A'], { cwd: wt, env: restartedEnv }).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'after restart'], { cwd: wt, env: restartedEnv }).code, 0);
    assert.equal(git(wt, 'log', '--format=%s', '-2'), 'after restart\nbefore restart');
  } finally {
    fixture.cleanup();
  }
});

// ─── worktree の登録確認（偽装の拒否）と既定ブランチの完全名比較（issue #433 レビュー対応） ─────

test('worktree 偽装: 偽の commondir・複製した .git ファイル・リンク経由は拒否し、正規の worktree は通る', () => {
  const fixture = createFixture();
  try {
    const adminRoot = path.join(fixture.repo, '.git', 'worktrees');
    const legit = addWorktree(fixture, path.join(fixture.root, 'wt-legit'), 'work/legit');
    const legitInside = addWorktree(fixture, path.join(fixture.repo, '.claude', 'worktrees', 'legit'), 'work/legit-inside');
    const attempt = (cwd, label) => {
      fs.writeFileSync(path.join(cwd, 'z.txt'), `${label}\n`);
      const results = [['git', 'add', '-A'], ['git', 'commit', '-m', label], ['git', 'status']].map((command) => run(fixture, command, { cwd }));
      return results;
    };
    const assertRejected = (cwd, label) => {
      for (const result of attempt(cwd, label)) {
        assert.equal(result.code, 2, label);
        assert.match(result.messages.join(''), /not the bound repository/, label);
      }
    };

    // 1. 偽の gitdir / commondir（worktrees/ の外に置く）。Git 自身は拘束先の管理領域として解決できる状態にしておく。
    const fakeGitDir = path.join(fixture.root, 'fake-gitdir');
    fs.mkdirSync(fakeGitDir);
    fs.writeFileSync(path.join(fakeGitDir, 'HEAD'), 'ref: refs/heads/work/test\n');
    fs.writeFileSync(path.join(fakeGitDir, 'commondir'), `${path.join(fixture.repo, '.git')}\n`);
    const fake = path.join(fixture.root, 'fake');
    fs.mkdirSync(fake);
    fs.writeFileSync(path.join(fake, '.git'), `gitdir: ${fakeGitDir}\n`);
    assert.equal(fs.realpathSync(git(fake, 'rev-parse', '--path-format=absolute', '--git-common-dir')), path.join(fixture.repo, '.git'));
    assertRejected(fake, 'fake commondir');

    // 2. worktrees/ の直下に置いた未登録の管理領域（逆参照が無い／別の場所を指す）。
    for (const [name, backRef] of [['nobackref', null], ['wrongref', path.join(fixture.root, 'elsewhere', '.git')]]) {
      const dir = path.join(adminRoot, name);
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/work/test\n');
      fs.writeFileSync(path.join(dir, 'commondir'), '../..\n');
      if (backRef !== null) fs.writeFileSync(path.join(dir, 'gitdir'), `${backRef}\n`);
      const unregistered = path.join(fixture.root, `unregistered-${name}`);
      fs.mkdirSync(unregistered);
      fs.writeFileSync(path.join(unregistered, '.git'), `gitdir: ${dir}\n`);
      assertRejected(fs.realpathSync(unregistered), name);
    }

    // 3. 登録済み worktree の .git ファイルを別フォルダへ複製（gitdir は登録済みの管理領域を指す）。
    const copy = path.join(fixture.root, 'copy');
    fs.mkdirSync(copy);
    fs.copyFileSync(path.join(legit, '.git'), path.join(copy, '.git'));
    assert.equal(git(copy, 'rev-parse', '--abbrev-ref', 'HEAD'), 'work/legit');
    assertRejected(fs.realpathSync(copy), 'copied .git file');

    // 4. .git がリンク（登録済み worktree の .git ファイルへ）／逆参照ファイルがリンク。
    const linked = path.join(fixture.root, 'linked');
    fs.mkdirSync(linked);
    fs.symlinkSync(path.join(legit, '.git'), path.join(linked, '.git'));
    assertRejected(fs.realpathSync(linked), 'symlinked .git');

    const legitAdmin = path.join(adminRoot, path.basename(git(legit, 'rev-parse', '--git-dir')));
    const backRefFile = path.join(legitAdmin, 'gitdir');
    const original = fs.readFileSync(backRefFile, 'utf8');
    const realBackRef = path.join(fixture.root, 'real-gitdir-file');
    fs.writeFileSync(realBackRef, original);
    fs.rmSync(backRefFile);
    fs.symlinkSync(realBackRef, backRefFile);
    assertRejected(legit, 'symlinked back reference');
    fs.rmSync(backRefFile);
    fs.writeFileSync(backRefFile, original);

    // 5. 正規の worktree（拘束先の外側・内側）は引き続き通る。
    for (const [cwd, label] of [[legit, 'legit outside'], [legitInside, 'legit inside']]) {
      const [add, commit, status] = attempt(cwd, label);
      assert.deepEqual([add.code, commit.code, status.code], [0, 0, 0], label);
    }
    assert.deepEqual(fixture.readCalls(), []);
  } finally {
    fixture.cleanup();
  }
});

test('worktree 偽装: extensions.worktreeConfig と config.worktree に外部コマンドを起動しうる設定を置いた worktree は拒否する', () => {
  const fixture = createFixture();
  try {
    const wt = addWorktree(fixture, path.join(fixture.root, 'wt-wtcfg'), 'work/wtcfg');
    git(fixture.repo, 'config', 'extensions.worktreeConfig', 'true');
    const adminDir = path.resolve(wt, git(wt, 'rev-parse', '--git-dir'));
    const marker = path.join(fixture.root, 'editor-ran');
    fs.writeFileSync(path.join(adminDir, 'config.worktree'), `[core]\n\teditor = touch ${marker}\n`);
    assert.equal(git(wt, 'config', '--worktree', 'core.editor'), `touch ${marker}`);
    fs.writeFileSync(path.join(wt, 'w.txt'), 'w\n');
    for (const command of [['git', 'status'], ['git', 'add', '-A'], ['git', 'commit', '-m', 'x']]) {
      const result = run(fixture, command, { cwd: wt });
      assert.equal(result.code, 2, command.join(' '));
      assert.match(result.messages.join(''), /can run external commands/);
    }
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fixture.cleanup();
  }
});

test('既定ブランチ: 同名のタグや origin/ で始まるローカルブランチ名があっても、完全名で判定して拒否する', () => {
  const fixture = createFixture();
  try {
    const attempt = (label) => {
      fs.writeFileSync(path.join(fixture.repo, 'c.txt'), `${label}\n`);
      assert.equal(run(fixture, ['git', 'add', '-A']).code, 0);
      return run(fixture, ['git', 'commit', '-m', label]);
    };
    // main と同名のタグ。短縮名は heads/main になる（ここで前提を確かめる）。
    git(fixture.repo, 'checkout', '-q', '-B', 'main');
    git(fixture.repo, 'tag', 'main');
    assert.equal(git(fixture.repo, 'symbolic-ref', '--short', 'HEAD'), 'heads/main');
    const tagged = attempt('main with tag');
    assert.equal(tagged.code, 2);
    assert.match(tagged.messages.join(''), /default branch "main"/);

    // origin/HEAD の指す先と同名のタグ。
    git(fixture.repo, 'checkout', '-q', '-B', 'work/test');
    git(fixture.repo, 'branch', 'develop');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(fixture.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    git(fixture.repo, 'tag', 'develop');
    git(fixture.repo, 'checkout', '-q', 'develop');
    const remoteTagged = attempt('develop with tag');
    assert.equal(remoteTagged.code, 2);
    assert.match(remoteTagged.messages.join(''), /default branch "develop"/);

    // origin/ で始まる名前のローカルブランチは、既定ブランチではない（短縮名の origin/develop と取り違えない）。
    git(fixture.repo, 'checkout', '-q', '-b', 'origin/develop');
    assert.equal(attempt('local branch named origin/develop').code, 0);
  } finally {
    fixture.cleanup();
  }
});

// ─── git push / prepare worktree（issue #440） ─────────────────────────────

// 一時フォルダの bare リポジトリを GitHub の代わりにする。基点（VK_TASK_REMOTE_BASE）はランチャーが固定する値で、
// 入口は `<基点>/<owner>/<repo>.git` を組み立てて送る。origin（偽の github.com の URL）には一切通信しない。
function attachRemote(fixture) {
  const base = path.join(fixture.root, 'remote-base');
  const bare = path.join(base, 'vektor-inc', 'vk-terminals.git');
  fs.mkdirSync(bare, { recursive: true });
  git(bare, 'init', '-q', '--bare', '-b', 'main');
  git(fixture.repo, 'push', '-q', bare, 'main:main');
  fixture.env.VK_TASK_REMOTE_BASE = base;
  const remoteRef = (ref) => {
    try {
      return git(bare, 'rev-parse', '--verify', '-q', ref);
    } catch (_error) {
      return null;
    }
  };
  return { base, bare, url: bare, remoteRef };
}

// 実行した外部コマンドの argv と環境を記録する spawnSync。
function recordingSpawn(calls) {
  return (bin, args, options) => {
    calls.push({ bin, args, env: options.env });
    return childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
  };
}

function commitFile(cwd, name, content = 'x\n') {
  fs.writeFileSync(path.join(cwd, name), content);
  git(cwd, 'add', name);
  git(cwd, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', `add ${name}`);
}

const hasPushCall = (calls) => calls.some((call) => call.args.includes('push'));

test('許可: git push はブランチ名 1 つだけを受け付け、prepare worktree は 4 つの引数だけを受け付ける', () => {
  assert.deepEqual(parseTaskCommand(argv('git push issue/440-x')), { ok: true, bin: 'git', operation: 'push', branch: 'issue/440-x', needsGitHub: true, needsGh: true });
  assert.deepEqual(parseTaskCommand(argv('prepare worktree main 440 issue/440-x codex-440')), {
    ok: true, bin: 'git', operation: 'prepare-worktree', base: 'main', issue: '440', branch: 'issue/440-x', name: 'codex-440', needsGitHub: true, needsGh: true,
  });
});

test('拒否: git push の force 系・削除・タグ・任意の refspec・別の remote・既定ブランチ・不正なブランチ名', () => {
  const rejected = [
    ['git', 'push'],
    ['git', 'push', '--force'],
    ['git', 'push', '-f', 'issue/440-x'],
    ['git', 'push', '--force-with-lease', 'issue/440-x'],
    ['git', 'push', '--force-with-lease=issue/440-x', 'issue/440-x'],
    ['git', 'push', '--force-if-includes', 'issue/440-x'],
    ['git', 'push', 'issue/440-x', '--force'],
    ['git', 'push', '--delete', 'issue/440-x'],
    ['git', 'push', '-d', 'issue/440-x'],
    ['git', 'push', '--mirror'],
    ['git', 'push', '--tags'],
    ['git', 'push', '--all'],
    ['git', 'push', '--prune'],
    ['git', 'push', '--follow-tags'],
    ['git', 'push', '--no-verify', 'issue/440-x'],
    ['git', 'push', '-u', 'issue/440-x'],
    ['git', 'push', '--set-upstream', 'issue/440-x'],
    ['git', 'push', '--receive-pack=x', 'issue/440-x'],
    ['git', 'push', '--repo=https://example.com/x.git', 'issue/440-x'],
    ['git', 'push', '-o', 'x', 'issue/440-x'],
    // 別の remote・URL・複数指定
    ['git', 'push', 'origin', 'issue/440-x'],
    ['git', 'push', 'https://example.com/o/r.git', 'issue/440-x'],
    ['git', 'push', 'https://example.com/o/r.git'],
    ['git', 'push', 'git@github.com:o/r.git'],
    ['git', 'push', 'issue/440-x', 'issue/440-y'],
    // 任意の refspec・強制を意味する + や削除を意味する :
    ['git', 'push', '+issue/440-x'],
    ['git', 'push', '+issue/440-x:issue/440-x'],
    ['git', 'push', ':issue/440-x'],
    ['git', 'push', 'issue/440-x:issue/440-x'],
    ['git', 'push', 'issue/440-x:main'],
    ['git', 'push', 'HEAD:refs/heads/issue/440-x'],
    ['git', 'push', 'refs/heads/issue/440-x'],
    ['git', 'push', 'refs/tags/v1'],
    ['git', 'push', 'issue/440-*'],
    ['git', 'push', 'issue/440-x^'],
    // 既定ブランチ・HEAD
    ['git', 'push', 'main'],
    ['git', 'push', 'master'],
    ['git', 'push', 'HEAD'],
    // 不正なブランチ名・パス
    ['git', 'push', ''],
    ['git', 'push', '..'],
    ['git', 'push', 'a/../b'],
    ['git', 'push', '../x'],
    ['git', 'push', '/etc/passwd'],
    ['git', 'push', 'a//b'],
    ['git', 'push', 'a/'],
    ['git', 'push', 'x.lock'],
    ['git', 'push', '.hidden'],
    ['git', 'push', 'a b'],
    ['git', 'push', 'a\0b'],
    ['git', 'push', '-'],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, /^task command rejected/);
  }
});

test('拒否: prepare の許可外の操作・引数・不正なブランチ名と worktree 名・.. ・owner/repo の指定', () => {
  const rejected = [
    ['prepare'],
    ['prepare', 'branch', 'main', '440', 'issue/440-x'],
    ['prepare', 'switch', 'main', '440', 'issue/440-x', 'wt'],
    ['prepare', 'worktree'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', 'wt', 'extra'],
    // owner/repo を引数に取らない（付けると引数の数が合わない・base として不正になる）。
    ['prepare', 'worktree', 'vektor-inc/vk-terminals', 'main', '440', 'issue/440-x', 'wt'],
    ['prepare', 'worktree', '--repo=o/r', 'main', '440', 'issue/440-x'],
    // base
    ['prepare', 'worktree', '../main', '440', 'issue/440-x', 'wt'],
    ['prepare', 'worktree', 'a..b', '440', 'issue/440-x', 'wt'],
    ['prepare', 'worktree', '+main', '440', 'issue/440-x', 'wt'],
    ['prepare', 'worktree', 'main:other', '440', 'issue/440-x', 'wt'],
    ['prepare', 'worktree', '-main', '440', 'issue/440-x', 'wt'],
    ['prepare', 'worktree', 'refs/heads/main', '440', 'issue/440-x', 'wt'],
    ['prepare', 'worktree', '', '440', 'issue/440-x', 'wt'],
    // issue 番号
    ['prepare', 'worktree', 'main', 'x', 'issue/440-x', 'wt'],
    ['prepare', 'worktree', 'main', '0', 'issue/0-x', 'wt'],
    ['prepare', 'worktree', 'main', '-1', 'issue/-1-x', 'wt'],
    ['prepare', 'worktree', 'main', '44 0', 'issue/44 0-x', 'wt'],
    // ブランチ名
    ['prepare', 'worktree', 'main', '440', 'issue/441-x', 'wt'],
    ['prepare', 'worktree', 'main', '44', 'issue/440-x', 'wt'],
    ['prepare', 'worktree', 'main', '440', '440-x', 'wt'],
    ['prepare', 'worktree', 'main', '440', 'issue/440', 'wt'],
    ['prepare', 'worktree', 'main', '440', 'main', 'wt'],
    ['prepare', 'worktree', 'main', '440', 'issue/../440-x', 'wt'],
    ['prepare', 'worktree', 'main', '440', '../issue/440-x', 'wt'],
    ['prepare', 'worktree', 'main', '440', '+issue/440-x', 'wt'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x:y', 'wt'],
    ['prepare', 'worktree', 'main', '440', '-b/440-x', 'wt'],
    ['prepare', 'worktree', 'main', '440', 'refs/heads/issue/440-x', 'wt'],
    ['prepare', 'worktree', 'issue/440-x', '440', 'issue/440-x', 'wt'],
    // worktree 名（フォルダの外へ出られない）
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', '..'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', '../wt'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', 'a/b'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', '/tmp/wt'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', '-wt'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', 'w t'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', '.hidden'],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', ''],
    ['prepare', 'worktree', 'main', '440', 'issue/440-x', 'a'.repeat(101)],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, /^task command rejected/);
  }
});

test('実行: git push は拘束先でも worktree でも、固定の URL・refspec・資格情報の指定で bare リポジトリへ通る（origin は使わない）', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const calls = [];
    const options = (cwd) => ({ cwd, spawnSync: recordingSpawn(calls) });
    commitFile(fixture.repo, 'root.txt');
    const rootPush = run(fixture, ['git', 'push', 'work/test'], options(fixture.repo));
    assert.equal(rootPush.code, 0, rootPush.messages.join(''));
    assert.equal(remote.remoteRef('refs/heads/work/test'), git(fixture.repo, 'rev-parse', 'work/test'));

    // 実行した push の引数: origin ではなく入口が組み立てた URL、固定の refspec、+ や --force は無い。
    const pushCall = calls.find((call) => call.args.includes('push'));
    const pushIndex = pushCall.args.indexOf('push');
    assert.deepEqual(pushCall.args.slice(pushIndex), ['push', '--no-verify', '--no-follow-tags', '--no-recurse-submodules', '--no-signed', remote.url, 'refs/heads/work/test:refs/heads/work/test']);
    assert.deepEqual(pushCall.args.slice(0, FIXED_GIT_PREFIX.length), FIXED_GIT_PREFIX);
    // 資格情報: 既存の指定を空にしてから、検証済み gh の auth git-credential だけを指定する。
    assert.deepEqual(pushCall.args.slice(FIXED_GIT_PREFIX.length, pushIndex), [
      '-c', 'credential.helper=',
      '-c', 'credential.https://github.com.helper=',
      '-c', `credential.https://github.com.helper=!'${fixture.env.VK_TASK_GH}' auth git-credential`,
    ]);
    assert.equal(pushCall.args.some((arg) => /--force|--delete|--mirror|--tags|--all|--prune|^\+/.test(arg)), false);
    assert.equal(pushCall.args.some((arg) => arg.includes('github.com/vektor-inc')), false);
    // 通信を許すプロトコルは 1 つだけ（既定の空 = 不許可のままにはしない）。
    assert.equal(pushCall.env.GIT_ALLOW_PROTOCOL, 'file');
    assert.equal(pushCall.env.GIT_TERMINAL_PROMPT, '0');

    // worktree からも通る。
    const wt = addWorktree(fixture, path.join(fixture.repo, '.claude', 'worktrees', 'p1'), 'work/440-wt');
    commitFile(wt, 'wt.txt');
    assert.equal(run(fixture, ['git', 'push', 'work/440-wt'], options(wt)).code, 0);
    assert.equal(remote.remoteRef('refs/heads/work/440-wt'), git(wt, 'rev-parse', 'HEAD'));

    // 早送り（追記）は通る。
    commitFile(wt, 'wt2.txt');
    assert.equal(run(fixture, ['git', 'push', 'work/440-wt'], options(wt)).code, 0);
    assert.equal(remote.remoteRef('refs/heads/work/440-wt'), git(wt, 'rev-parse', 'HEAD'));
  } finally {
    fixture.cleanup();
  }
});

test('実行: git push は新規作成と早送りだけで、履歴を書き換えた（非早送りの）push は強制せず失敗する', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    commitFile(fixture.repo, 'a1.txt');
    assert.equal(run(fixture, ['git', 'push', 'work/test']).code, 0);
    const pushed = remote.remoteRef('refs/heads/work/test');
    // 直前のコミットを作り直す（リモートの履歴と枝分かれする）。
    git(fixture.repo, '-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '-q', '--amend', '-m', 'rewritten');
    const result = run(fixture, ['git', 'push', 'work/test']);
    assert.notEqual(result.code, 0);
    assert.equal(remote.remoteRef('refs/heads/work/test'), pushed);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: git push は main / 既定ブランチ / リモートの既定ブランチ / detached HEAD / 存在しないブランチへは送らない', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const calls = [];
    const attempt = (branch) => run(fixture, ['git', 'push', branch], { spawnSync: recordingSpawn(calls) });

    // 存在しないローカルブランチ。
    let result = attempt('work/never-created');
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /local branch does not exist/);
    // main（パースの段階で拒否。ローカルに存在しても同じ）。
    result = run(fixture, ['git', 'push', 'main']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /cannot push "main"/);

    // origin/HEAD の指す先（develop）。
    git(fixture.repo, 'branch', 'develop');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(fixture.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    result = attempt('develop');
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /default branch "develop"/);
    assert.equal(remote.remoteRef('refs/heads/develop'), null);

    // origin/HEAD が無い clone でも、リモートの既定ブランチ（bare の HEAD）は拒否する。
    git(fixture.repo, 'symbolic-ref', '--delete', 'refs/remotes/origin/HEAD');
    git(fixture.repo, 'branch', 'trunk');
    git(fixture.repo, 'push', '-q', remote.url, 'trunk:trunk');
    git(remote.bare, 'symbolic-ref', 'HEAD', 'refs/heads/trunk');
    const before = remote.remoteRef('refs/heads/trunk');
    result = attempt('trunk');
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /remote default branch "trunk"/);
    assert.equal(remote.remoteRef('refs/heads/trunk'), before);

    // detached HEAD。
    git(fixture.repo, 'checkout', '-q', '--detach');
    result = attempt('work/test');
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /detached HEAD/);
    assert.equal(remote.remoteRef('refs/heads/work/test'), null);
    // どの拒否でも、push そのものは一度も実行されていない。
    assert.equal(hasPushCall(calls), false);
  } finally {
    fixture.cleanup();
  }
});

test('拘束: git push は別のリポジトリ・同じ origin を持つ別クローン・入れ子のリポジトリからは送らず、origin が違えば拒否する', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const calls = [];
    const options = (cwd) => ({ cwd, spawnSync: recordingSpawn(calls) });
    // 同じ origin を持つ別クローン。
    const clone = path.join(fixture.root, 'clone');
    initRepo(clone, { origin: GITHUB_ORIGIN });
    git(clone, 'checkout', '-q', '-b', 'work/clone');
    // 別のリポジトリ。
    const stranger = path.join(fixture.root, 'stranger');
    initRepo(stranger, { origin: 'https://github.com/other/repo.git' });
    git(stranger, 'checkout', '-q', '-b', 'work/stranger');
    // 入れ子のリポジトリ。
    const nested = path.join(fixture.repo, 'nested');
    initRepo(nested, { origin: GITHUB_ORIGIN });
    git(nested, 'checkout', '-q', '-b', 'work/nested');
    for (const [cwd, branch] of [[clone, 'work/clone'], [stranger, 'work/stranger'], [nested, 'work/nested']]) {
      const result = run(fixture, ['git', 'push', branch], options(cwd));
      assert.equal(result.code, 2, cwd);
      assert.match(result.messages.join(''), /not the bound repository/, cwd);
      assert.equal(remote.remoteRef(`refs/heads/${branch}`), null, branch);
    }
    // 拘束先であっても、origin が拘束した GitHub のリポジトリと違えば送らない。
    git(fixture.repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    const mismatch = run(fixture, ['git', 'push', 'work/test'], options(fixture.repo));
    assert.equal(mismatch.code, 2);
    assert.match(mismatch.messages.join(''), /origin does not match/);
    assert.equal(remote.remoteRef('refs/heads/work/test'), null);
    assert.equal(hasPushCall(calls), false);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: 接続先や経路を書き換えうるリポジトリ設定（url.*.insteadOf・http.*）があれば push も prepare も通信しない（閲覧系は従来どおり）', () => {
  const settings = [
    ['url.https://evil.example/.insteadOf', 'https://github.com/'],
    ['url.file:///tmp/evil/.pushInsteadOf', 'file:///x/'],
    ['http.proxy', 'http://evil.example:8080'],
    ['http.https://github.com/.extraHeader', 'X: y'],
    ['http.sslVerify', 'false'],
  ];
  for (const [key, value] of settings) {
    const fixture = createFixture();
    try {
      const remote = attachRemote(fixture);
      git(fixture.repo, 'config', key, value);
      const calls = [];
      const options = { spawnSync: recordingSpawn(calls) };
      const pushed = run(fixture, ['git', 'push', 'work/test'], options);
      assert.equal(pushed.code, 2, key);
      assert.match(pushed.messages.join(''), /can redirect network access/, key);
      const prepared = run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-x', 'wt'], options);
      assert.equal(prepared.code, 2, key);
      assert.match(prepared.messages.join(''), /can redirect network access/, key);
      assert.equal(remote.remoteRef('refs/heads/work/test'), null, key);
      assert.equal(fs.existsSync(path.join(fixture.repo, '.claude')), false, key);
      assert.equal(run(fixture, ['git', 'status', '--short']).code, 0, key);
    } finally {
      fixture.cleanup();
    }
  }
  assert.equal(findNetworkUnsafeKey('core.bare\nfalse\0user.name\nx\0'), null);
  assert.equal(findNetworkUnsafeKey('url.https://x/.insteadof\nhttps://github.com/\0'), 'url.https://x/.insteadof');
});

test('実行: git push では、リポジトリのフック（pre-push）は実行されず、リポジトリ内の credential helper の設定は拒否される', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const marker = path.join(fixture.root, 'hook-ran');
    const hooks = path.join(fixture.repo, '.git', 'hooks');
    fs.mkdirSync(hooks, { recursive: true });
    fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    commitFile(fixture.repo, 'hook.txt');
    const result = run(fixture, ['git', 'push', 'work/test']);
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(fs.existsSync(marker), false);
    assert.ok(remote.remoteRef('refs/heads/work/test'));
    git(fixture.repo, 'config', 'credential.helper', '!echo username=evil');
    assert.equal(run(fixture, ['git', 'push', 'work/test']).code, 2);
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh が使えない（VK_TASK_GH が空）ときは push も prepare も通信しない', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const env = { ...fixture.env, VK_TASK_GH: '' };
    delete env.VK_TASK_GHCONFIG;
    const pushed = run(fixture, ['git', 'push', 'work/test'], { env });
    assert.equal(pushed.code, 2);
    assert.equal(remote.remoteRef('refs/heads/work/test'), null);
    assert.equal(run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-x', 'wt'], { env }).code, 2);
  } finally {
    fixture.cleanup();
  }
});

test('設定: 基点の指定は GitHub の固定値か絶対パスだけで、相対パス・.. ・未知の URL は拘束の設定として不正になる', () => {
  const fixture = createFixture();
  try {
    assert.equal(readBinding(fixture.env).remoteBase, 'https://github.com');
    assert.equal(readBinding({ ...fixture.env, VK_TASK_REMOTE_BASE: '' }).remoteBase, 'https://github.com');
    assert.equal(readBinding({ ...fixture.env, VK_TASK_REMOTE_BASE: '/tmp/remote' }).remoteBase, '/tmp/remote');
    for (const value of ['relative/path', 'https://evil.example', 'http://github.com', 'ssh://git@github.com', 'git@github.com:', 'file:///tmp/x', '/tmp/../etc', "/tmp/a'b", 'https://github.com/']) {
      assert.equal(readBinding({ ...fixture.env, VK_TASK_REMOTE_BASE: value }), null, value);
    }
  } finally {
    fixture.cleanup();
  }
});

test('実行: prepare worktree は最新の base から .codex/worktrees/<名前> に作業ブランチ付きの worktree を作り、通常のクローンは切り替えない', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    // 取得されることを確かめるため、リモートの main だけを先に進める。
    const other = path.join(fixture.root, 'other-clone');
    git(fixture.root, 'clone', '-q', remote.bare, other);
    commitFile(other, 'latest.txt');
    git(other, 'push', '-q', 'origin', 'main');
    const latest = git(other, 'rev-parse', 'HEAD');
    const rootBefore = { head: git(fixture.repo, 'rev-parse', 'HEAD'), branch: git(fixture.repo, 'symbolic-ref', '--short', 'HEAD') };

    const out = [];
    const calls = [];
    const result = run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-flow', 'codex-440'], { writeOut: (message) => out.push(message), spawnSync: recordingSpawn(calls) });
    assert.equal(result.code, 0, result.messages.join(''));
    const worktree = path.join(fixture.repo, '.codex', 'worktrees', 'codex-440');
    assert.equal(out.join(''), `TARGET_REPO=${worktree}\nWORK_BRANCH=issue/440-flow\nBASE_SHA=${latest}\n`);
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), latest);
    assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), 'issue/440-flow');
    // 追跡先を持たない（--no-track）。
    assert.throws(() => git(worktree, 'config', '--get', 'branch.issue/440-flow.remote'));
    // 通常のクローンは切り替えず、worktree は未追跡として現れない。
    assert.deepEqual({ head: git(fixture.repo, 'rev-parse', 'HEAD'), branch: git(fixture.repo, 'symbolic-ref', '--short', 'HEAD') }, rootBefore);
    assert.equal(git(fixture.repo, 'status', '--porcelain'), '');
    // 取得は origin の設定値ではなく固定の URL・固定の refspec・固定の資格情報の指定。
    const fetchCall = calls.find((call) => call.args.includes('fetch'));
    // 書き込みを制限する OS の仕組みで包んで実行する（git 本体の引数は包みの後ろ）。
    assert.equal(fetchCall.bin, '/usr/bin/sandbox-exec');
    const fetchArgs = fetchCall.args.slice(fetchCall.args.indexOf(GIT_PATH) + 1);
    const fetchIndex = fetchArgs.indexOf('fetch');
    assert.deepEqual(fetchArgs.slice(fetchIndex), ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', remote.url, '+refs/heads/main:refs/remotes/origin/main']);
    assert.deepEqual(fetchArgs.slice(FIXED_GIT_PREFIX.length, fetchIndex), [
      '-c', 'credential.helper=',
      '-c', 'credential.https://github.com.helper=',
      '-c', `credential.https://github.com.helper=!'${fixture.env.VK_TASK_GH}' auth git-credential`,
      '-c', 'core.alternateRefsCommand=',
      `--git-dir=${path.join(fs.realpathSync(fixture.repo), '.git')}`,
    ]);
    assert.equal(fetchCall.env.GIT_ALLOW_PROTOCOL, 'file');
    // worktree の追加は通信しない環境（プロトコル不許可）で行う。
    assert.equal(calls.find((call) => call.args.includes('worktree')).env.GIT_ALLOW_PROTOCOL, '');

    // info/exclude へ 1 行。別の名前で作ると行が増える。
    const exclude = () => fs.readFileSync(path.join(fixture.repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((line) => line.startsWith('/.codex/worktrees/'));
    assert.deepEqual(exclude(), ['/.codex/worktrees/codex-440/']);
    assert.equal(run(fixture, ['prepare', 'worktree', 'main', '441', 'issue/441-second', 'codex-441']).code, 0);
    assert.deepEqual(exclude(), ['/.codex/worktrees/codex-440/', '/.codex/worktrees/codex-441/']);
  } finally {
    fixture.cleanup();
  }
});

test('結合: prepare で作った worktree で、そのまま add・commit・push が通り、bare リポジトリにブランチができる', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    git(fixture.repo, 'checkout', '-q', 'main');
    assert.equal(run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-flow', 'codex-440']).code, 0);
    const worktree = fs.realpathSync(path.join(fixture.repo, '.codex', 'worktrees', 'codex-440'));
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'feature\n');
    assert.equal(run(fixture, ['git', 'add', '--', 'feature.txt'], { cwd: worktree }).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', '[ 機能追加 ] 例'], { cwd: worktree }).code, 0);
    const pushed = run(fixture, ['git', 'push', 'issue/440-flow'], { cwd: worktree });
    assert.equal(pushed.code, 0, pushed.messages.join(''));
    assert.equal(remote.remoteRef('refs/heads/issue/440-flow'), git(worktree, 'rev-parse', 'HEAD'));
    assert.equal(git(remote.bare, 'log', '-1', '--format=%s', 'issue/440-flow'), '[ 機能追加 ] 例');
    // main は動いていない。
    assert.equal(remote.remoteRef('refs/heads/main'), git(fixture.repo, 'rev-parse', 'main'));
  } finally {
    fixture.cleanup();
  }
});

test('拒否: prepare worktree の同名ブランチ・同名パス・.codex のリンク・取得できない base・ルート以外での実行・別クローン', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    const worktreeCount = () => git(fixture.repo, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length;
    const baseCount = worktreeCount();
    const prepare = (args, extra = {}) => run(fixture, ['prepare', 'worktree', 'main', '440', ...args], extra);
    const branchExists = (name) => {
      try {
        git(fixture.repo, 'rev-parse', '--verify', '-q', `refs/heads/${name}`);
        return true;
      } catch (_error) {
        return false;
      }
    };

    // 同名のブランチ。
    git(fixture.repo, 'branch', 'issue/440-dup');
    let result = prepare(['issue/440-dup', 'wt-a']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /working branch already exists/);
    // 同名のパス。
    fs.mkdirSync(path.join(fixture.repo, '.codex', 'worktrees', 'wt-b'), { recursive: true });
    result = prepare(['issue/440-b', 'wt-b']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /worktree path already exists/);
    assert.equal(branchExists('issue/440-b'), false);

    // .codex/worktrees がリンク。
    const elsewhere = path.join(fixture.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.rmSync(path.join(fixture.repo, '.codex'), { recursive: true });
    fs.mkdirSync(path.join(fixture.repo, '.codex'));
    fs.symlinkSync(elsewhere, path.join(fixture.repo, '.codex', 'worktrees'));
    result = prepare(['issue/440-c', 'wt-c']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /symbolic link/);
    // .codex がリンク。
    fs.rmSync(path.join(fixture.repo, '.codex'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(fixture.repo, '.codex'));
    result = prepare(['issue/440-d', 'wt-d']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /symbolic link/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.unlinkSync(path.join(fixture.repo, '.codex'));

    // リモートに無い base（取得に失敗する）。worktree もブランチも作られない。
    result = run(fixture, ['prepare', 'worktree', 'no-such-base', '440', 'issue/440-e', 'wt-e']);
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(path.join(fixture.repo, '.codex', 'worktrees', 'wt-e')), false);
    assert.equal(branchExists('issue/440-e'), false);

    // 拘束先のルート以外（worktree の中・サブフォルダ）からは作らない。
    const inner = addWorktree(fixture, path.join(fixture.root, 'outside-wt'), 'work/outside');
    result = prepare(['issue/440-f', 'wt-f'], { cwd: inner });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /bound repository root/);
    fs.mkdirSync(path.join(fixture.repo, 'sub'));
    result = prepare(['issue/440-g', 'wt-g'], { cwd: path.join(fixture.repo, 'sub') });
    assert.equal(result.code, 2);

    // 同じ origin を持つ別クローン・別のリポジトリ。
    const clone = path.join(fixture.root, 'clone');
    initRepo(clone, { origin: GITHUB_ORIGIN });
    const stranger = path.join(fixture.root, 'stranger');
    initRepo(stranger, { origin: 'https://github.com/other/repo.git' });
    for (const cwd of [clone, stranger]) {
      result = prepare(['issue/440-h', 'wt-h'], { cwd });
      assert.equal(result.code, 2, cwd);
      assert.equal(fs.existsSync(path.join(cwd, '.codex')), false, cwd);
    }
    // origin が拘束した GitHub のリポジトリと違えば作らない。
    git(fixture.repo, 'remote', 'set-url', 'origin', 'https://github.com/other/repo.git');
    result = prepare(['issue/440-i', 'wt-i']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /origin does not match/);
    assert.equal(worktreeCount(), baseCount + 1); // outside-wt だけ（このテスト自身が作ったもの）
  } finally {
    fixture.cleanup();
  }
});

// ─── 書き込み先の制限とリモート既定ブランチの確定（差し戻し対応） ───────────────

test('制限: 書き込みは許可した実パスの配下だけで、リンクを辿って外へ出る書き込みと禁止した場所への書き込みは OS が拒否する', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-restrict-')));
  try {
    const allowed = path.join(root, 'allowed');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(path.join(allowed, 'sub'), { recursive: true });
    fs.mkdirSync(path.join(allowed, 'hooks'));
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(allowed, 'link'));
    const tryWrite = (target) => {
      const command = restrictWrites({ bin: '/bin/sh', args: ['-c', 'echo x > "$1"', 'sh', target], allowWrite: [allowed], denyWrite: [path.join(allowed, 'hooks')] });
      return childProcess.spawnSync(command.bin, command.args, { encoding: 'utf8' }).status === 0;
    };
    assert.equal(tryWrite(path.join(allowed, 'sub', 'ok.txt')), true);
    assert.equal(tryWrite(path.join(outside, 'no.txt')), false);
    assert.equal(tryWrite(path.join(allowed, 'link', 'no.txt')), false);
    assert.equal(tryWrite(path.join(allowed, 'hooks', 'pre-commit')), false);
    assert.equal(fs.existsSync(path.join(outside, 'no.txt')), false);
    // パスはプロファイルの文字列に入らない（引用符を含む名前でも許可範囲は変わらない）。
    const odd = path.join(root, 'odd"name');
    fs.mkdirSync(odd);
    const command = restrictWrites({ bin: '/bin/sh', args: ['-c', 'echo x > "$1"', 'sh', path.join(outside, 'no2.txt')], allowWrite: [odd] });
    assert.notEqual(childProcess.spawnSync(command.bin, command.args, { encoding: 'utf8' }).status, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 呼び出しの前後に任意の処理（フォルダのリンクへの差し替え）を挟める spawnSync。実際の実行は本物。
function interposeSpawn({ before = () => {}, after = () => {} }) {
  return (bin, args, options) => {
    before(bin, args);
    const result = childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    after(bin, args);
    return result;
  };
}

const involves = (args, word) => args.includes(word);

test('競合: 取得の最中に .codex が外部フォルダへのリンクへ差し替えられても、拘束ルートの外には何も作られない', () => {
  for (const variant of ['codex', 'worktrees']) {
    const fixture = createFixture();
    try {
      attachRemote(fixture);
      const outside = path.join(fixture.root, 'outside-target');
      fs.mkdirSync(outside);
      fs.mkdirSync(path.join(fixture.repo, '.codex', 'worktrees'), { recursive: true });
      const swap = () => {
        if (variant === 'codex') {
          fs.rmSync(path.join(fixture.repo, '.codex'), { recursive: true });
          fs.symlinkSync(outside, path.join(fixture.repo, '.codex'));
        } else {
          fs.rmSync(path.join(fixture.repo, '.codex', 'worktrees'), { recursive: true });
          fs.symlinkSync(outside, path.join(fixture.repo, '.codex', 'worktrees'));
        }
      };
      let swapped = false;
      const result = run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-race', 'wt-race'], {
        spawnSync: interposeSpawn({ after: (_bin, args) => { if (involves(args, 'fetch') && !swapped) { swapped = true; swap(); } } }),
      });
      assert.equal(swapped, true, variant);
      assert.notEqual(result.code, 0, variant);
      assert.deepEqual(fs.readdirSync(outside), [], variant);
      assert.equal(fs.existsSync(path.join(outside, 'wt-race')), false, variant);
    } finally {
      fixture.cleanup();
    }
  }
});

test('競合: 最後の検査の後（worktree の追加の直前）に .codex 系のフォルダが外部へのリンクへ差し替えられても、拘束ルートの外には何も作られない', () => {
  for (const variant of ['codex', 'worktrees', 'hooks']) {
    const fixture = createFixture();
    try {
      attachRemote(fixture);
      const outside = path.join(fixture.root, 'outside-target');
      fs.mkdirSync(outside);
      // hooks: 拘束ルートの内側でも、フックのフォルダへ向けたリンクには書けない。
      const target = variant === 'hooks' ? path.join(fixture.repo, '.git', 'hooks') : outside;
      fs.mkdirSync(target, { recursive: true });
      const hooksBefore = fs.readdirSync(path.join(fixture.repo, '.git', 'hooks')).sort();
      let swapped = false;
      const swap = () => {
        const codex = path.join(fixture.repo, '.codex');
        if (variant === 'codex') {
          fs.rmSync(codex, { recursive: true });
          fs.symlinkSync(target, codex);
        } else {
          fs.rmSync(path.join(codex, 'worktrees'), { recursive: true });
          fs.symlinkSync(target, path.join(codex, 'worktrees'));
        }
      };
      const result = run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-race', 'wt-race'], {
        spawnSync: interposeSpawn({ before: (_bin, args) => { if (involves(args, 'worktree') && involves(args, '--no-checkout') && !swapped) { swapped = true; swap(); } } }),
      });
      assert.equal(swapped, true, variant);
      assert.notEqual(result.code, 0, variant);
      assert.deepEqual(fs.readdirSync(outside), [], variant);
      assert.deepEqual(fs.readdirSync(path.join(fixture.repo, '.git', 'hooks')).sort(), hooksBefore, variant);
    } finally {
      fixture.cleanup();
    }
  }
});

test('競合: 親フォルダの作成の直前に差し替えられても、拘束ルートの外にはフォルダが作られない', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    const outside = path.join(fixture.root, 'outside-target');
    fs.mkdirSync(outside);
    let swapped = false;
    const result = run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-race', 'wt-race'], {
      spawnSync: interposeSpawn({
        before: (_bin, args) => {
          if (args.includes('/bin/mkdir') && args.includes(path.join(fixture.repo, '.codex', 'worktrees')) && !swapped) {
            swapped = true;
            fs.symlinkSync(outside, path.join(fixture.repo, '.codex'));
          }
        },
      }),
    });
    assert.equal(swapped, true);
    assert.notEqual(result.code, 0);
    assert.deepEqual(fs.readdirSync(outside), []);
  } finally {
    fixture.cleanup();
  }
});

// フォルダ配下の全ファイルについて、種類・リンク先・内容を再帰的に並べる（直下の名前だけでは中身の書き換えを検知できないため）。
function deepSnapshot(dir) {
  const stat = (() => {
    try {
      return fs.lstatSync(dir);
    } catch (_error) {
      return null;
    }
  })();
  if (stat === null) return ['(missing)'];
  const lines = [];
  const walk = (current, label) => {
    const info = fs.lstatSync(current);
    if (info.isSymbolicLink()) {
      lines.push(`${label} -> ${fs.readlinkSync(current)}`);
    } else if (info.isDirectory()) {
      lines.push(`${label}/`);
      for (const name of fs.readdirSync(current).sort()) walk(path.join(current, name), `${label}/${name}`);
    } else {
      lines.push(`${label} #${fs.readFileSync(current).toString('base64')}`);
    }
  };
  walk(dir, '.');
  return lines;
}

// 差し替え先に、Git が書き込み段階まで進める有効な管理領域（HEAD・commondir・gitdir 等）を用意し、差し替え後の状態を基準にする。
// 制限が効いていれば、その後の prepare は基準の内容を 1 バイトも変えない。
function raceCase({ label, trigger, makeTarget, swap, untouched, mustFail = true }) {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    let swapped = false;
    let before = null;
    const snapshot = () => untouched(fixture).map((dir) => [dir, deepSnapshot(dir)]);
    const result = run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-race', 'wt-race'], {
      spawnSync: interposeSpawn({
        before: (_bin, args) => {
          if (trigger(args) && !swapped) {
            swapped = true;
            swap(fixture, makeTarget(fixture));
            before = snapshot();
          }
        },
      }),
    });
    assert.equal(swapped, true, label);
    if (mustFail) assert.notEqual(result.code, 0, label);
    assert.deepEqual(snapshot(), before, label);
  } finally {
    fixture.cleanup();
  }
}

const adminOf = (fixture) => path.join(fixture.repo, '.git', 'worktrees', 'wt-race');
const worktreeOf = (fixture) => path.join(fixture.repo, '.codex', 'worktrees', 'wt-race');
// 現在の管理領域の写し（HEAD・commondir・gitdir を含む）を target に作る。
function copyAdmin(fixture, target) {
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(adminOf(fixture), target, { recursive: true });
  // 相対の commondir は写し先では別の場所を指すので、Git が書き込み段階まで進めるよう絶対パスにする。
  fs.writeFileSync(path.join(target, 'commondir'), `${path.join(fixture.repo, '.git')}\n`);
  return target;
}

test('競合: info/exclude の追記は書き込み制限つきの子プロセスで行い、info や exclude が差し替えられても拘束ルートの外へは追記されない', () => {
  const appendTrigger = (args) => args.includes('/bin/sh') && args.some((arg) => arg.includes('printf'));
  // info 自体が外部フォルダへのリンク（検査前から）。
  {
    const fixture = createFixture();
    try {
      attachRemote(fixture);
      const outside = path.join(fixture.root, 'outside-info');
      fs.mkdirSync(outside);
      fs.rmSync(path.join(fixture.repo, '.git', 'info'), { recursive: true });
      fs.symlinkSync(outside, path.join(fixture.repo, '.git', 'info'));
      assert.notEqual(run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-race', 'wt-race']).code, 0);
      assert.deepEqual(fs.readdirSync(outside), []);
    } finally {
      fixture.cleanup();
    }
  }
  // 検査の後（追記の直前）に info がリンクへ差し替えられる。差し替え先は外部と、Git 管理領域の中（objects 配下）。
  for (const variant of ['outside', 'objects/info', 'objects/pack']) {
    raceCase({
      label: `info:${variant}`,
      trigger: appendTrigger,
      makeTarget: (fixture) => {
        const dir = variant === 'outside' ? path.join(fixture.root, 'outside-info') : path.join(fixture.repo, '.git', ...variant.split('/'));
        fs.mkdirSync(dir, { recursive: true });
        return dir;
      },
      swap: (fixture, target) => {
        fs.rmSync(path.join(fixture.repo, '.git', 'info'), { recursive: true });
        fs.symlinkSync(target, path.join(fixture.repo, '.git', 'info'));
      },
      untouched: (fixture) => [path.join(fixture.root, 'outside-info'), path.join(fixture.repo, '.git', 'objects', 'info'), path.join(fixture.repo, '.git', 'objects', 'pack')],
    });
  }
  // 検査の後に exclude 自体が外部ファイルへのリンクへ差し替えられる。
  raceCase({
    label: 'exclude',
    trigger: appendTrigger,
    makeTarget: (fixture) => {
      const file = path.join(fixture.root, 'outside-exclude');
      fs.writeFileSync(file, 'original\n');
      return file;
    },
    swap: (fixture, target) => {
      fs.rmSync(path.join(fixture.repo, '.git', 'info', 'exclude'), { force: true });
      fs.symlinkSync(target, path.join(fixture.repo, '.git', 'info', 'exclude'));
    },
    untouched: (fixture) => [path.join(fixture.root, 'outside-exclude')],
  });
});

test('競合: 作業フォルダの置き場所が Git 管理領域・.codex 内の別フォルダ・外部へのリンクに差し替えられても、どこにも書かれない（追加の直前・index 作成の直前・展開の直前）', () => {
  const outsideDirs = (fixture) => [
    path.join(fixture.repo, '.git', 'objects', 'info'),
    path.join(fixture.repo, '.git', 'objects', 'pack'),
    path.join(fixture.repo, '.git', 'refs', 'tags'),
    path.join(fixture.repo, '.git', 'hooks'),
    path.join(fixture.repo, '.codex', 'other'),
    path.join(fixture.root, 'outside-target'),
  ];
  const places = {
    'objects/info': (fixture) => path.join(fixture.repo, '.git', 'objects', 'info'),
    'objects/pack': (fixture) => path.join(fixture.repo, '.git', 'objects', 'pack'),
    'refs/tags': (fixture) => path.join(fixture.repo, '.git', 'refs', 'tags'),
    'hooks': (fixture) => path.join(fixture.repo, '.git', 'hooks'),
    '.codex 内の別フォルダ': (fixture) => path.join(fixture.repo, '.codex', 'other'),
    '拘束ルートの外': (fixture) => path.join(fixture.root, 'outside-target'),
  };
  const triggers = [
    ['追加の直前', (args) => involves(args, 'worktree') && involves(args, '--no-checkout')],
    ['index 作成の直前', (args) => involves(args, 'read-tree')],
    ['展開の直前', (args) => involves(args, 'checkout-index')],
  ];
  const swapWorktree = (fixture, target) => {
    fs.rmSync(worktreeOf(fixture), { recursive: true, force: true });
    fs.symlinkSync(target, worktreeOf(fixture));
  };
  for (const [placeLabel, place] of Object.entries(places)) {
    for (const [timing, trigger] of triggers) {
      raceCase({
        label: `${placeLabel} / ${timing}`,
        trigger,
        makeTarget: (fixture) => {
          fs.mkdirSync(place(fixture), { recursive: true });
          return place(fixture);
        },
        swap: swapWorktree,
        untouched: outsideDirs,
      });
    }
  }
  // 展開先が、この worktree 自身の管理領域（commondir・gitdir・HEAD を持つ）へのリンクに差し替えられる（index 作成は管理領域に書くのが正当なので、展開の直前だけ）。
  for (const [timing, trigger] of triggers.slice(2)) {
    raceCase({
      label: `管理領域そのもの / ${timing}`,
      trigger,
      makeTarget: (fixture) => adminOf(fixture),
      swap: swapWorktree,
      untouched: (fixture) => [adminOf(fixture)],
    });
  }
});

test('競合: worktree の管理情報（.git/worktrees/<名前>）が index 作成・展開の直前に、有効な管理領域を備えた別の場所へのリンクへ差し替えられても、そこには書かれない', () => {
  for (const [timing, trigger] of [['index 作成の直前', (args) => involves(args, 'read-tree')], ['展開の直前', (args) => involves(args, 'checkout-index')]]) {
    for (const variant of ['objects/info', 'objects/pack', 'hooks', '外部']) {
      const targetOf = (fixture) => (variant === '外部' ? path.join(fixture.root, 'outside-target') : path.join(fixture.repo, '.git', ...variant.split('/'), 'evil-admin'));
      raceCase({
        label: `${variant} / ${timing}`,
        trigger,
        makeTarget: (fixture) => {
          fs.mkdirSync(path.dirname(targetOf(fixture)), { recursive: true });
          return copyAdmin(fixture, targetOf(fixture));
        },
        swap: (fixture, target) => {
          fs.rmSync(adminOf(fixture), { recursive: true, force: true });
          fs.symlinkSync(target, adminOf(fixture));
        },
        untouched: (fixture) => [targetOf(fixture)],
        // 展開の直前の差し替えは、展開が管理領域に書かないので成功してよい（差し替え先が変わらないことだけを確かめる）。
        mustFail: timing === 'index 作成の直前',
      });
    }
  }
});

test('実行: prepare は Git の制御ファイル（hooks・config・objects/info）を書き換えず、書き込みを伴う呼び出しはすべて書き込み制限つきで行う', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    const gitDir = path.join(fixture.repo, '.git');
    const config = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const hooks = fs.readdirSync(path.join(gitDir, 'hooks')).sort();
    const objectsInfo = fs.readdirSync(path.join(gitDir, 'objects', 'info')).sort();
    const calls = [];
    const result = run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-flow', 'codex-440'], { spawnSync: recordingSpawn(calls) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(fs.readFileSync(path.join(gitDir, 'config'), 'utf8'), config);
    assert.deepEqual(fs.readdirSync(path.join(gitDir, 'hooks')).sort(), hooks);
    assert.deepEqual(fs.readdirSync(path.join(gitDir, 'objects', 'info')).sort(), objectsInfo);
    const worktree = path.join(fixture.repo, '.codex', 'worktrees', 'codex-440');
    assert.equal(git(worktree, 'status', '--porcelain'), '');
    assert.ok(fs.readdirSync(worktree).length > 1);
    const mentions = (call, word) => call.args.some((arg) => arg === word);
    const writers = calls.filter((call) => ['fetch', 'worktree', 'read-tree', 'checkout-index', '/bin/mkdir'].some((word) => mentions(call, word)) || call.args.some((arg) => arg.includes('printf')));
    assert.ok(writers.length >= 7);
    for (const call of writers) assert.equal(call.bin, '/usr/bin/sandbox-exec');
  } finally {
    fixture.cleanup();
  }
});

test('制限: ブランチの作成は別プロセスで ref・ログ（とロック）だけに書き込みを許し、worktree の追加を含む他の段階は refs/heads・logs/refs/heads の既存データを消せない', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    const gitDir = path.join(fixture.repo, '.git');
    // 既存のブランチ（packed と loose の両方）と、それぞれの記録を用意する。
    git(fixture.repo, 'branch', 'packed-one');
    git(fixture.repo, 'pack-refs', '--all');
    git(fixture.repo, 'branch', 'loose-one');
    const protectedPaths = [
      path.join(gitDir, 'refs', 'heads', 'loose-one'), path.join(gitDir, 'logs', 'refs', 'heads', 'loose-one'),
      path.join(gitDir, 'logs', 'refs', 'heads', 'main'), path.join(gitDir, 'packed-refs'),
    ];
    const heads = [path.join(gitDir, 'refs', 'heads'), path.join(gitDir, 'logs', 'refs', 'heads'), path.join(gitDir, 'packed-refs')];
    const calls = [];
    assert.equal(run(fixture, ['prepare', 'worktree', 'main', '440', 'issue/440-flow', 'codex-440'], { spawnSync: recordingSpawn(calls) }).code, 0);

    const allowOf = (call) => call.args.filter((arg, i) => call.args[i - 1] === '-D' && arg.startsWith('ALLOW')).map((arg) => arg.slice(arg.indexOf('=') + 1));
    const sandboxed = calls.filter((call) => call.bin === '/usr/bin/sandbox-exec');
    const branchCall = sandboxed.find((call) => call.args.includes('branch'));
    const addCall = sandboxed.find((call) => call.args.includes('worktree'));
    // 構造: add は -b を使わず既存のブランチを指定し、書き込みの許可に refs / logs の階層を含まない。
    assert.equal(addCall.args.includes('-b'), false);
    assert.ok(addCall.args.includes('issue/440-flow'));
    for (const allowed of allowOf(addCall)) assert.equal(/\/(refs|logs)(\/|$)/.test(allowed), false, allowed);
    // ブランチの作成は、そのブランチの ref・ログとロックの 4 ファイルだけ。
    assert.deepEqual(allowOf(branchCall).map((p) => path.relative(gitDir, p)).sort(), [
      'logs/refs/heads/issue/440-flow', 'logs/refs/heads/issue/440-flow.lock', 'refs/heads/issue/440-flow', 'refs/heads/issue/440-flow.lock',
    ]);

    // 実効: 各段階のプロセスに与えた書き込み制限（実際のプロファイル）の下で、Git の代わりに
    // 「refs/heads・logs/refs/heads・packed-refs を再帰的に消す／追記する／動かす」処理を走らせ、既存データが変わらないことを確かめる。
    // （Git 内部の失敗時の後片付けが走る時点を外から作ることはできないため、後片付けが最大限に働いた場合に相当する操作で代替する。）
    const newBranchFiles = [path.join(gitDir, 'refs', 'heads', 'issue', '440-flow'), path.join(gitDir, 'logs', 'refs', 'heads', 'issue', '440-flow')];
    const snapshot = (extra) => [...protectedPaths, ...extra].map((target) => [target, deepSnapshot(target)]);
    const standIn = 'for t in "$@"; do rm -rf "$t" 2>/dev/null; printf x >> "$t" 2>/dev/null; done; for t in "$@"; do if [ -d "$t" ]; then mv "$t" "$t.moved" 2>/dev/null; fi; done; exit 0';
    const replay = (call) => {
      const head = call.args.slice(0, call.args.indexOf('-p') + 2);
      return childProcess.spawnSync(call.bin, [...head, '/bin/sh', '-c', standIn, 'sh', ...heads], { encoding: 'utf8' });
    };
    const others = sandboxed.filter((call) => call !== branchCall);
    assert.ok(others.length >= 7);
    for (const call of others) {
      // フォルダ作成の段階が書けるのは、実行前には存在しなかったフォルダだけ（作成したブランチの置き場所は、その配下に新しい ref ができる前から許可されたもの）。
      const extra = call.args.includes('/bin/mkdir') ? [] : newBranchFiles;
      const before = snapshot(extra);
      replay(call);
      assert.deepEqual(snapshot(extra), before, allowOf(call).join(' '));
    }
    // 作成の段階は自分の 1 本の ref とログには書ける（代替処理が効いている確認）が、既存のブランチには触れない。
    const before = snapshot([]);
    replay(branchCall);
    assert.deepEqual(snapshot([]), before);
    assert.equal(fs.existsSync(newBranchFiles[0]), false);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: リモートの既定ブランチを確定できない（ls-remote の失敗・symref の欠落）ときは push を実行しない', () => {
  const cases = [
    ['通信の失敗', { status: 128, stdout: '', stderr: 'fatal: unable to access' }],
    ['symref の欠落', { status: 0, stdout: '', stderr: '' }],
    ['HEAD の行だけで symref が無い', { status: 0, stdout: '0123456789012345678901234567890123456789\tHEAD\n', stderr: '' }],
    ['ブランチでない symref', { status: 0, stdout: 'ref: refs/tags/v1\tHEAD\n', stderr: '' }],
  ];
  for (const [label, fake] of cases) {
    const fixture = createFixture();
    try {
      const remote = attachRemote(fixture);
      commitFile(fixture.repo, 'c.txt');
      const calls = [];
      const result = run(fixture, ['git', 'push', 'work/test'], {
        spawnSync: (bin, args, options) => {
          calls.push({ bin, args });
          return args.includes('ls-remote') ? { ...fake, error: undefined } : childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
        },
      });
      assert.equal(result.code, 2, label);
      assert.match(result.messages.join(''), /remote default branch could not be verified/, label);
      assert.equal(hasPushCall(calls), false, label);
      assert.equal(remote.remoteRef('refs/heads/work/test'), null, label);
    } finally {
      fixture.cleanup();
    }
  }
});

// ─── メンバー起動（member start / member status。issue #441） ─────────────────

const MEMBER_START = ['member', 'start', '--engine', 'codex', '--prompt', 'prompt.md', '--schema', 'schema.json', '--out', 'out.json'];

test('許可: member start は engine・入出力の名前・モデル・readonly だけを受け、member status は実行 ID だけを受ける', () => {
  assert.deepEqual(parseTaskCommand(MEMBER_START), {
    ok: true, bin: 'codex', operation: 'member-start', engine: 'codex', prompt: 'prompt.md', schema: 'schema.json', out: 'out.json', model: null, readonly: false, needsGitHub: false,
  });
  const full = parseTaskCommand([...MEMBER_START, '--model', 'gpt-5.5', '--readonly']);
  assert.equal(full.ok, true);
  assert.equal(full.model, 'gpt-5.5');
  assert.equal(full.readonly, true);
  assert.equal(parseTaskCommand(['member', 'start', '--engine=codex', '--prompt=a.md', '--schema=b.json', '--out=c.json', '--model=gpt-5.5']).ok, true);
  assert.deepEqual(parseTaskCommand(['member', 'status', '0123456789abcdef01234567']), { ok: true, bin: 'codex', operation: 'member-status', id: '0123456789abcdef01234567', needsGitHub: false });
});

test('拒否: member start の --repo・絶対パス・..・サブフォルダ・囲いを外す指定・codex 以外の engine・未知のオプション', () => {
  const withOption = (...extra) => [...MEMBER_START, ...extra];
  const replaceValue = (option, value) => MEMBER_START.map((token, index) => (MEMBER_START[index - 1] === option ? value : token));
  const rejected = [
    // 対象リポジトリや作業フォルダの指定
    withOption('--repo', '/tmp/other'),
    withOption('--repo=/tmp/other'),
    withOption('--cwd', '/tmp'),
    withOption('-C', '/tmp'),
    withOption('--cd', '/tmp'),
    withOption('--add-dir', '/'),
    // 囲いを外す指定・sandbox や承認の上書き
    withOption('--dangerously-bypass-approvals-and-sandbox'),
    withOption('--dangerously-bypass-hook-trust'),
    withOption('--sandbox', 'danger-full-access'),
    withOption('-s', 'danger-full-access'),
    withOption('--full-auto'),
    withOption('-a', 'never'),
    withOption('-c', 'sandbox_mode="danger-full-access"'),
    withOption('--config', 'x=y'),
    withOption('--profile', 'wide'),
    withOption('--worktree'),
    // パスの指定
    replaceValue('--prompt', '/etc/passwd'),
    replaceValue('--prompt', '../prompt.md'),
    replaceValue('--prompt', 'sub/prompt.md'),
    replaceValue('--prompt', '..'),
    replaceValue('--prompt', 'a..b.md'),
    replaceValue('--prompt', '.hidden'),
    replaceValue('--prompt', '~/prompt.md'),
    replaceValue('--schema', '/dev/fd/3'),
    replaceValue('--schema', 'sub\\schema.json'),
    replaceValue('--out', '/tmp/out.json'),
    replaceValue('--out', '../out.json'),
    replaceValue('--out', ''),
    // engine
    replaceValue('--engine', 'claude'),
    replaceValue('--engine', 'Codex'),
    // 必須・重複・同名・値の欠落・未知
    MEMBER_START.filter((_token, index) => index !== 2 && index !== 3),
    MEMBER_START.filter((_token, index) => index < 4 || index > 5),
    MEMBER_START.filter((_token, index) => index < 6 || index > 7),
    MEMBER_START.filter((_token, index) => index < 8),
    withOption('--prompt', 'other.md'),
    withOption('--readonly', '--readonly'),
    replaceValue('--out', 'prompt.md'),
    MEMBER_START.slice(0, -1),
    withOption('--model', '-x'),
    withOption('--model', 'a b'),
    withOption('--model', 'x'.repeat(65)),
    withOption('--unknown'),
    withOption('extra'),
    ['member', 'run', ...MEMBER_START.slice(2)],
    ['member'],
    ['member', 'start'],
    ['member', 'status'],
    ['member', 'status', 'abc'],
    ['member', 'status', '0123456789abcdef01234567', 'extra'],
    ['member', 'status', '../0123456789abcdef0123'],
  ];
  for (const command of rejected) {
    const parsed = parseTaskCommand(command);
    assert.equal(parsed.ok, false, command.join(' '));
    assert.match(parsed.error, /^task command rejected: /);
  }
});

test('子の起動引数: 親と同じ sandbox（-s workspace-write / read-only）・-a never・-C が付き、囲いを外す指定は入らない', () => {
  const base = { root: '/work/repo', schemaPath: '/runs/a/schema.json', outPath: '/io/out.json', model: null, readonly: false };
  const normal = buildMemberCodexArgs(base);
  assert.deepEqual(normal, ['-a', 'never', 'exec', '-C', '/work/repo', '-s', 'workspace-write', '--color', 'never', '--output-schema', '/runs/a/schema.json', '-o', '/io/out.json', '-']);
  const readonly = buildMemberCodexArgs({ ...base, readonly: true, model: 'gpt-5.5' });
  assert.deepEqual(readonly, ['-a', 'never', 'exec', '-C', '/work/repo', '-s', 'read-only', '--ignore-rules', '--color', 'never', '--output-schema', '/runs/a/schema.json', '-o', '/io/out.json', '--model', 'gpt-5.5', '-']);
  for (const args of [normal, readonly]) {
    assert.equal(args.some((arg) => /dangerously|full-auto|danger-full-access/.test(arg)), false);
    assert.equal(args.includes('workspace-write') !== args.includes('read-only'), true);
  }
});

// メンバー起動の試験環境。専用の入出力フォルダ・実行の記録フォルダ・子用 CODEX_HOME・偽の codex を用意する。
function createMemberFixture({ withMember = true, parentSandbox = 'workspace-write', parentCwd } = {}) {
  const fixture = createFixture();
  const codexPath = path.join(fixture.root, 'bin', 'codex');
  const io = path.join(fixture.root, 'io');
  const runs = path.join(fixture.root, 'runs');
  const memberHome = path.join(fixture.root, 'member-home');
  for (const dir of [io, runs, memberHome]) fs.mkdirSync(dir, { mode: 0o700 });
  const record = path.join(fixture.root, 'codex-record.json');
  fs.writeFileSync(codexPath, `#!${process.execPath}\nconst fs = require('fs');\nconst input = fs.readFileSync(0, 'utf8');\nfs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env, input, cwd: process.cwd() }));\nconst outIndex = process.argv.indexOf('-o');\nfs.writeFileSync(process.argv[outIndex + 1], '{"ok":true}');\nconsole.log('fake codex output');\nif (input.includes('SLEEP')) setTimeout(() => process.exit(0), 1500);\nelse process.exit(input.includes('FAIL') ? 3 : 0);\n`, { mode: 0o755 });
  const env = withMember
    ? {
      ...fixture.env, VK_TASK_CODEX: codexPath, VK_TASK_MEMBER_HOME: memberHome, VK_TASK_MEMBER_IO: io, VK_TASK_MEMBER_RUNS: runs,
      VK_TASK_PARENT_CWD: parentCwd || fixture.repo, VK_TASK_PARENT_SANDBOX: parentSandbox,
    }
    : fixture.env;
  fs.writeFileSync(path.join(io, 'prompt.md'), 'do the task\n');
  fs.writeFileSync(path.join(io, 'schema.json'), '{"type":"object"}');
  const calls = [];
  const spawn = (bin, args, options) => {
    calls.push({ bin, args, options });
    return { pid: 424242, unref: () => {} };
  };
  const outputs = [];
  const runMember = (command, extra = {}) => run({ ...fixture, env }, command, { spawn, writeOut: (text) => outputs.push(text), randomId: () => 'aaaaaaaaaaaaaaaaaaaaaaaa', ...extra });
  return { ...fixture, env, io, runs, memberHome, codexPath, record, calls, outputs, runMember };
}

test('実行: member start は拘束ルートで、親と同じ sandbox の子 Codex をバックグラウンドで起動し、子用の CODEX_HOME と最小の環境だけを渡す', () => {
  const fixture = createMemberFixture();
  try {
    const result = fixture.runMember(MEMBER_START);
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(fixture.outputs.join(''), `MEMBER_ID=aaaaaaaaaaaaaaaaaaaaaaaa\nOUT=${path.join(fixture.io, 'out.json')}\nLOG=${path.join(fixture.runs, 'aaaaaaaaaaaaaaaaaaaaaaaa', 'log.txt')}\n`);
    assert.equal(fixture.calls.length, 1);
    const [{ bin, args, options }] = fixture.calls;
    const runDir = path.join(fixture.runs, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    // 切り離して起動するのは入口自身（監督プロセス）。設定は環境変数で渡し、子の結果（-o）は保護された実行の記録フォルダ内に書かせる。
    assert.equal(bin, process.execPath);
    assert.deepEqual(args, [path.join(__dirname, '..', 'utils', 'codexTaskOps.js')]);
    assert.deepEqual(Object.keys(options.env), ['VK_TASK_MEMBER_SUPERVISE']);
    const payload = JSON.parse(options.env.VK_TASK_MEMBER_SUPERVISE);
    assert.equal(payload.codex, fixture.codexPath);
    assert.equal(payload.runDir, runDir);
    assert.deepEqual(payload.args, ['-a', 'never', 'exec', '-C', fixture.repo, '-s', 'workspace-write', '--color', 'never', '--output-schema', path.join(runDir, 'schema.json'), '-o', path.join(runDir, 'result.txt'), '-']);
    assert.equal(payload.args.some((arg) => /dangerously|danger-full-access/.test(arg)), false);
    assert.equal(payload.args.includes(path.join(fixture.io, 'out.json')), false);
    // 子の環境は親から引き継がず、CODEX_HOME は子用の専用フォルダ。
    assert.equal(payload.cwd, fixture.repo);
    assert.equal(options.cwd, fixture.repo);
    assert.equal(options.detached, true);
    assert.equal(options.stdio.length, 4);
    assert.equal(payload.env.CODEX_HOME, fixture.memberHome);
    assert.deepEqual(Object.keys(payload.env).sort(), ['CODEX_HOME', 'HOME', 'NO_COLOR', 'PATH']);
    assert.equal(payload.env.HOME, fixture.home);
    // 入力は実行用の専用フォルダへ写し取られ、出力先は新規に確保される。
    assert.equal(fs.readFileSync(path.join(runDir, 'prompt.txt'), 'utf8'), 'do the task\n');
    assert.equal(fs.readFileSync(path.join(runDir, 'schema.json'), 'utf8'), '{"type":"object"}');
    assert.equal(fs.readFileSync(path.join(fixture.io, 'out.json'), 'utf8'), '');
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8')).pid, 424242);

    // --readonly と --model。
    fixture.calls.length = 0;
    const readonly = fixture.runMember([...MEMBER_START.slice(0, -1), 'out2.json', '--readonly', '--model', 'gpt-5.5'], { randomId: () => 'bbbbbbbbbbbbbbbbbbbbbbbb' });
    assert.equal(readonly.code, 0, readonly.messages.join(''));
    const childArgs = JSON.parse(fixture.calls[0].options.env.VK_TASK_MEMBER_SUPERVISE).args;
    assert.deepEqual(childArgs.slice(0, 7), ['-a', 'never', 'exec', '-C', fixture.repo, '-s', 'read-only']);
    assert.ok(childArgs.includes('--ignore-rules'));
    assert.deepEqual(childArgs.slice(childArgs.indexOf('--model')), ['--model', 'gpt-5.5', '-']);
  } finally {
    fixture.cleanup();
  }
});

test('実行: member start が途中で失敗したら、この起動で作った --out と実行の記録を消し、同じ名前で再実行できる', () => {
  const fixture = createMemberFixture();
  try {
    const outPath = path.join(fixture.io, 'out.json');
    const runDir = path.join(fixture.runs, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    // 監督プロセスの起動が例外・pid なしで失敗する場合。
    for (const brokenSpawn of [() => { throw Object.assign(new Error('x'), { code: 'EAGAIN' }); }, () => ({})]) {
      const failed = fixture.runMember(MEMBER_START, { spawn: brokenSpawn });
      assert.equal(failed.code, 2);
      assert.equal(fs.existsSync(outPath), false);
      assert.equal(fs.existsSync(runDir), false);
    }
    // 実行の記録フォルダを作れない場合（同名が既にある）。既にあったものは消さず、--out だけ消す。
    fs.mkdirSync(runDir, { mode: 0o700 });
    fs.writeFileSync(path.join(runDir, 'keep.txt'), 'x');
    const mkdirFailed = fixture.runMember(MEMBER_START);
    assert.equal(mkdirFailed.code, 2);
    assert.equal(fs.existsSync(outPath), false);
    assert.equal(fs.existsSync(path.join(runDir, 'keep.txt')), true);
    fs.rmSync(runDir, { recursive: true });
    // pid の記録に失敗した場合は、起動した監督プロセスを止め、終了を確かめてから後始末する。
    const brokenRename = { ...fs, constants: fs.constants, renameSync: () => { throw Object.assign(new Error('x'), { code: 'EIO' }); } };
    const supervisorOutputs = ['result.txt', 'result-state.tmp', 'result-state', 'exit.tmp', 'exit'];
    // 監督プロセスを模す。SIGTERM のあと stopsAfterSleeps 回待ったら終了し、止まる直前（最後の待ちの間）にも生成物を書く。
    const simulateSupervisor = ({ stopsAfterSleeps, existingOutputs }) => {
      const state = { signals: [], sleeps: 0, stopped: false };
      const spawn = () => {
        for (const name of existingOutputs) fs.writeFileSync(path.join(runDir, name), 'x');
        return { pid: 424242, unref: () => {} };
      };
      const kill = (pid, signal) => {
        if (signal === 0) {
          if (state.stopped) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
          return true;
        }
        state.signals.push([pid, signal]);
        return true;
      };
      const sleep = () => {
        state.sleeps += 1;
        if (state.sleeps >= stopsAfterSleeps) {
          for (const name of supervisorOutputs) fs.writeFileSync(path.join(runDir, name), 'late');
          state.stopped = true;
        }
      };
      return { state, options: { spawn, kill, sleep, fs: brokenRename } };
    };
    for (const existingOutputs of [supervisorOutputs, []]) {
      const { state, options } = simulateSupervisor({ stopsAfterSleeps: 2, existingOutputs });
      const renameFailed = fixture.runMember(MEMBER_START, options);
      assert.equal(renameFailed.code, 2);
      assert.deepEqual(state.signals, [[-424242, 'SIGTERM']]);
      assert.equal(state.stopped, true);
      assert.equal(fs.existsSync(outPath), false);
      assert.equal(fs.existsSync(runDir), false);
    }
    // 止まったと確かめられないときは、書き込みの競合を避けて記録フォルダには触れない（SIGKILL まで送り、--out は消す）。
    const stuck = simulateSupervisor({ stopsAfterSleeps: Infinity, existingOutputs: ['exit'] });
    const stuckResult = fixture.runMember(MEMBER_START, stuck.options);
    assert.equal(stuckResult.code, 2);
    assert.deepEqual(stuck.state.signals, [[-424242, 'SIGTERM'], [-424242, 'SIGKILL']]);
    assert.equal(fs.existsSync(path.join(runDir, 'exit')), true);
    assert.equal(fs.existsSync(outPath), false);
    fs.rmSync(runDir, { recursive: true });
    // グループの確認に失敗したとき（ps の失敗、kill の EPERM）は終了済みと扱わず、記録フォルダを保持する。
    const unconfirmable = [
      ['ps の失敗', { listProcessStates: () => null }],
      ['kill の EPERM', { kill: () => { throw Object.assign(new Error('x'), { code: 'EPERM' }); }, listProcessStates: () => false }],
    ];
    for (const [label, override] of unconfirmable) {
      const sim = simulateSupervisor({ stopsAfterSleeps: Infinity, existingOutputs: ['exit'] });
      const result = fixture.runMember(MEMBER_START, { ...sim.options, ...override });
      assert.equal(result.code, 2, label);
      assert.equal(fs.existsSync(path.join(runDir, 'exit')), true, label);
      assert.equal(fs.existsSync(outPath), false, label);
      fs.rmSync(runDir, { recursive: true });
    }
    // 監督プロセスが先に終わっても、同じグループに子が残る間は終了と扱わない。SIGTERM を無視する子には SIGKILL まで進む。
    const orphanChild = (killedBySigkill) => {
      const state = { signals: [], sleeps: 0, childAlive: true };
      const spawn = () => {
        fs.writeFileSync(path.join(runDir, 'exit'), 'x');
        return { pid: 424242, unref: () => {} };
      };
      const kill = (pid, signal) => {
        if (signal === 0) return true;
        state.signals.push([pid, signal]);
        if (signal === 'SIGKILL' && killedBySigkill) state.childAlive = false;
        return true;
      };
      const sleep = () => { state.sleeps += 1; };
      const listProcessStates = () => state.childAlive;
      return { state, options: { spawn, kill, sleep, listProcessStates, fs: brokenRename } };
    };
    const killable = orphanChild(true);
    assert.equal(fixture.runMember(MEMBER_START, killable.options).code, 2);
    assert.deepEqual(killable.state.signals, [[-424242, 'SIGTERM'], [-424242, 'SIGKILL']]);
    assert.equal(fs.existsSync(runDir), false);
    const unkillable = orphanChild(false);
    assert.equal(fixture.runMember(MEMBER_START, unkillable.options).code, 2);
    assert.deepEqual(unkillable.state.signals, [[-424242, 'SIGTERM'], [-424242, 'SIGKILL']]);
    assert.equal(fs.existsSync(path.join(runDir, 'exit')), true);
    assert.equal(fs.existsSync(outPath), false);
    fs.rmSync(runDir, { recursive: true });
    // 失敗のあとに同じ名前で再実行できる。
    const retry = fixture.runMember(MEMBER_START);
    assert.equal(retry.code, 0, retry.messages.join(''));
  } finally {
    fixture.cleanup();
  }
});

test('実行: member start の直後でも member status は拒否されず、監督プロセスの pid が記録されるまでは starting を返す', () => {
  const fixture = createMemberFixture();
  try {
    const runDir = path.join(fixture.runs, 'aaaaaaaaaaaaaaaaaaaaaaaa');
    let metaBeforeSpawn = null;
    let statusDuringSpawn = null;
    const spawn = () => {
      metaBeforeSpawn = JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8'));
      const lines = [];
      statusDuringSpawn = { code: run(fixture, ['member', 'status', 'aaaaaaaaaaaaaaaaaaaaaaaa'], { writeOut: (text) => lines.push(text) }).code, text: lines.join('') };
      return { pid: 424242, unref: () => {} };
    };
    const started = fixture.runMember(MEMBER_START, { spawn });
    assert.equal(started.code, 0, started.messages.join(''));
    assert.equal(metaBeforeSpawn.pid, null);
    assert.equal(statusDuringSpawn.code, 0);
    assert.match(statusDuringSpawn.text, /^STATE=starting$/m);
    // 起動後は pid が記録され、実行中として見える。
    assert.equal(JSON.parse(fs.readFileSync(path.join(runDir, 'meta.json'), 'utf8')).pid, 424242);
    const after = [];
    assert.equal(run(fixture, ['member', 'status', 'aaaaaaaaaaaaaaaaaaaaaaaa'], { writeOut: (text) => after.push(text), kill: () => true }).code, 0);
    assert.match(after.join(''), /^STATE=running$/m);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: 子用ランチャー（member の設定が空）では member 操作が使えず、入れ子の起動を防ぐ', () => {
  const fixture = createMemberFixture({ withMember: false });
  try {
    for (const command of [MEMBER_START, ['member', 'status', '0123456789abcdef01234567']]) {
      const result = fixture.runMember(command);
      assert.equal(result.code, 2);
      assert.match(result.messages.join(''), /member is not available from this launcher/);
    }
    assert.equal(fixture.calls.length, 0);
    // 設定が一部だけ残っている不正な束縛も拒否する。
    assert.equal(readBinding({ ...fixture.env, VK_TASK_CODEX: '/bin/echo' }), null);
    assert.equal(readBinding({ ...fixture.env, VK_TASK_CODEX: 'codex', VK_TASK_MEMBER_HOME: '/a', VK_TASK_MEMBER_IO: '/b', VK_TASK_MEMBER_RUNS: '/c' }), null);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: member start は別リポジトリ・同じ origin の別クローンからは起動しない（サブフォルダからは親の起動 cwd に読み替えて起動する）', () => {
  const fixture = createMemberFixture();
  try {
    const stranger = path.join(fixture.root, 'stranger');
    const clone = path.join(fixture.root, 'clone');
    initRepo(stranger, { origin: 'https://github.com/other/repo.git' });
    initRepo(clone, { origin: GITHUB_ORIGIN });
    const sub = path.join(fixture.repo, 'sub');
    fs.mkdirSync(sub);
    for (const cwd of [stranger, clone]) {
      const result = fixture.runMember(MEMBER_START, { cwd });
      assert.equal(result.code, 2, cwd);
      assert.match(result.messages.join(''), /not the bound repository/);
    }
    // 親の起動 cwd の配下（サブフォルダ）から呼んでも拒否せず、子の作業フォルダは親の起動 cwd に読み替える。
    const inSub = fixture.runMember(MEMBER_START, { cwd: sub });
    assert.equal(inSub.code, 0, inSub.messages.join(''));
    assert.equal(fixture.calls.length, 1);
    assert.equal(fixture.calls[0].options.cwd, fixture.repo);
    assert.deepEqual(JSON.parse(fixture.calls[0].options.env.VK_TASK_MEMBER_SUPERVISE).args.slice(3, 5), ['-C', fixture.repo]);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: 入力ファイルがリンク・欠落・不正、出力先が既存（リンクを含む）、専用フォルダがリンクなら、子を起動しない', () => {
  const fixture = createMemberFixture();
  try {
    const secret = path.join(fixture.root, 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    const withPrompt = (name) => MEMBER_START.map((token) => (token === 'prompt.md' ? name : token));
    // 入力ファイルがシンボリックリンク。
    fs.symlinkSync(secret, path.join(fixture.io, 'linked.md'));
    let result = fixture.runMember(withPrompt('linked.md'));
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /linked\.md is not a plain file/);
    // 入力ファイルが無い・空・スキーマが JSON でない・サブフォルダ。
    result = fixture.runMember(withPrompt('missing.md'));
    assert.match(result.messages.join(''), /missing\.md does not exist/);
    fs.writeFileSync(path.join(fixture.io, 'empty.md'), '');
    result = fixture.runMember(withPrompt('empty.md'));
    assert.match(result.messages.join(''), /empty\.md is empty or too large/);
    fs.writeFileSync(path.join(fixture.io, 'bad.json'), 'not json');
    result = fixture.runMember(MEMBER_START.map((token) => (token === 'schema.json' ? 'bad.json' : token)));
    assert.equal(result.code, 2);
    fs.mkdirSync(path.join(fixture.io, 'dir.md'));
    result = fixture.runMember(withPrompt('dir.md'));
    assert.match(result.messages.join(''), /dir\.md is not a plain file/);
    // 出力先に事前に置かれたリンクや既存ファイルへは書かない。
    fs.symlinkSync(secret, path.join(fixture.io, 'out.json'));
    result = fixture.runMember(MEMBER_START);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /out\.json already exists/);
    assert.equal(fs.readFileSync(secret, 'utf8'), 'secret');
    assert.equal(fixture.calls.length, 0);

    // 専用フォルダ自体がリンクに差し替えられている。
    fs.rmSync(path.join(fixture.io, 'out.json'));
    const elsewhere = path.join(fixture.root, 'elsewhere');
    fs.cpSync(fixture.io, elsewhere, { recursive: true, verbatimSymlinks: true });
    fs.rmSync(fixture.io, { recursive: true });
    fs.symlinkSync(elsewhere, fixture.io);
    result = fixture.runMember(MEMBER_START);
    assert.equal(result.code, 2);
    assert.equal(fixture.calls.length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('実行: member start → member status で、実際のプロセスの終了コード・結果ファイル・ログ末尾を確かめられる（失敗した子は exited と終了コードを返す）', async () => {
  const fixture = createMemberFixture();
  try {
    const start = (prompt, out, id) => {
      fs.writeFileSync(path.join(fixture.io, prompt), prompt.includes('fail') ? 'FAIL please' : 'fine');
      const result = run(fixture, ['member', 'start', '--engine', 'codex', '--prompt', prompt, '--schema', 'schema.json', '--out', out], { writeOut: () => {}, randomId: () => id });
      assert.equal(result.code, 0, result.messages.join(''));
      return id;
    };
    const status = (id, extra = {}) => {
      const outputs = [];
      const result = run(fixture, ['member', 'status', id], { writeOut: (text) => outputs.push(text), ...extra });
      assert.equal(result.code, 0, result.messages.join(''));
      return outputs.join('');
    };
    const waitForExit = async (id) => {
      for (let i = 0; i < 100; i += 1) {
        if (fs.existsSync(path.join(fixture.runs, id, 'exit'))) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('member run did not finish');
    };

    const ok = start('ok.md', 'ok-out.json', '111111111111111111111111');
    await waitForExit(ok);
    const okStatus = status(ok);
    assert.match(okStatus, /^STATE=exited$/m);
    assert.match(okStatus, /^EXIT_CODE=0$/m);
    assert.match(okStatus, /^RESULT_STATE=published$/m);
    assert.equal(/RESULT_FAILURE/.test(okStatus), false);
    assert.ok(okStatus.includes(`OUT=${path.join(fixture.io, 'ok-out.json')}\n`));
    assert.match(okStatus, /--- log tail ---\nfake codex output/);
    assert.equal(fs.readFileSync(path.join(fixture.io, 'ok-out.json'), 'utf8'), '{"ok":true}');
    // 子には、プロンプトが標準入力で渡され、CODEX_HOME は子用の専用フォルダ。
    const recorded = JSON.parse(fs.readFileSync(fixture.record, 'utf8'));
    assert.equal(recorded.input, 'fine');
    assert.equal(recorded.env.CODEX_HOME, fixture.memberHome);
    assert.equal(fs.realpathSync(recorded.cwd), fixture.repo);
    assert.deepEqual(recorded.args.slice(0, 7), ['-a', 'never', 'exec', '-C', fixture.repo, '-s', 'workspace-write']);

    const failed = start('fail.md', 'fail-out.json', '222222222222222222222222');
    await waitForExit(failed);
    assert.match(status(failed), /^EXIT_CODE=3$/m);

    // 見つからない場合と、終了コードのファイルが無い場合（プロセスがいれば running、いなければ lost）。
    const unknown = run(fixture, ['member', 'status', '333333333333333333333333']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.messages.join(''), /unknown member run/);
    const lostId = '444444444444444444444444';
    fs.mkdirSync(path.join(fixture.runs, lostId), { mode: 0o700 });
    fs.writeFileSync(path.join(fixture.runs, lostId, 'meta.json'), JSON.stringify({ pid: 999999, out: '/x' }));
    const noProcess = () => {
      const error = new Error('no such process');
      error.code = 'ESRCH';
      throw error;
    };
    assert.match(status(lostId, { kill: noProcess }), /^STATE=lost$/m);
    assert.match(status(lostId, { kill: () => true }), /^STATE=running$/m);
  } finally {
    fixture.cleanup();
  }
});

test('親の sandbox を超えない: 親が read-only なら、--readonly を省略しても子は read-only（--ignore-rules 付き）で起動する', () => {
  const fixture = createMemberFixture({ parentSandbox: 'read-only' });
  try {
    for (const [index, extra] of [[], ['--readonly']].entries()) {
      fixture.calls.length = 0;
      const out = `out${index}.json`;
      const result = fixture.runMember([...MEMBER_START.slice(0, -1), out, ...extra], { randomId: () => `${index}`.repeat(24) });
      assert.equal(result.code, 0, result.messages.join(''));
      const { args } = JSON.parse(fixture.calls[0].options.env.VK_TASK_MEMBER_SUPERVISE);
      assert.deepEqual(args.slice(0, 7), ['-a', 'never', 'exec', '-C', fixture.repo, '-s', 'read-only']);
      assert.ok(args.includes('--ignore-rules'));
      assert.equal(args.includes('workspace-write'), false);
      assert.equal(JSON.parse(fs.readFileSync(path.join(fixture.runs, `${index}`.repeat(24), 'meta.json'), 'utf8')).readonly, true);
    }
    // 親の sandbox が不正な束縛は、全体を無効にする。
    assert.equal(readBinding({ ...fixture.env, VK_TASK_PARENT_SANDBOX: 'danger-full-access' }), null);
    assert.equal(readBinding({ ...fixture.env, VK_TASK_PARENT_SANDBOX: '' }), null);
    assert.equal(readBinding({ ...fixture.env, VK_TASK_PARENT_CWD: 'relative' }), null);
  } finally {
    fixture.cleanup();
  }
});

test('親の書き込み範囲を超えない: 子の -C と監督プロセスの cwd は常に親の起動 cwd。配下の worktree から呼んでも、そこがリンクに置き換えられても、範囲外は渡らない。親の範囲外からは起動しない', () => {
  const root = createMemberFixture();
  const sub = createMemberFixture();
  try {
    const supervisePayload = (fixture) => JSON.parse(fixture.calls[fixture.calls.length - 1].options.env.VK_TASK_MEMBER_SUPERVISE);
    const assertPinned = (fixture, pinned) => {
      const call = fixture.calls[fixture.calls.length - 1];
      const payload = supervisePayload(fixture);
      assert.equal(call.options.cwd, pinned);
      assert.equal(payload.cwd, pinned);
      assert.equal(payload.args[payload.args.indexOf('-C') + 1], pinned);
      assert.equal(payload.args.filter((arg) => arg === '-C').length, 1);
    };
    // 親をルートで起動した場合: ルート・配下の worktree（prepare worktree が作る .codex/worktrees/ の下）のどちらから呼んでも、-C と cwd は親の起動 cwd。
    const inside = path.join(root.repo, '.codex', 'worktrees', 'inside');
    git(root.repo, 'worktree', 'add', '-q', '-b', 'work/inside', inside);
    const outside = path.join(root.root, 'outside-worktree');
    git(root.repo, 'worktree', 'add', '-q', '-b', 'work/outside', outside);
    const insideReal = fs.realpathSync(inside);
    let result = root.runMember(MEMBER_START, { cwd: root.repo });
    assert.equal(result.code, 0, result.messages.join(''));
    assertPinned(root, root.repo);
    result = root.runMember([...MEMBER_START.slice(0, -1), 'wt-out.json'], { cwd: insideReal, randomId: () => 'cccccccccccccccccccccccc' });
    assert.equal(result.code, 0, result.messages.join(''));
    assertPinned(root, root.repo);

    // 検査のあとに配下の worktree が範囲外へのリンクに置き換えられても、範囲外は -C にも cwd にも渡らない（起動の時点で置き換えを再現する）。
    const escapeTarget = path.join(root.root, 'escape-target');
    fs.mkdirSync(escapeTarget);
    const spawnThenSwap = (bin, args, options) => {
      root.calls.push({ bin, args, options });
      fs.rmSync(inside, { recursive: true, force: true });
      fs.symlinkSync(escapeTarget, inside);
      return { pid: 424242, unref: () => {} };
    };
    root.calls.length = 0;
    result = root.runMember([...MEMBER_START.slice(0, -1), 'swap-out.json'], { cwd: insideReal, randomId: () => 'eeeeeeeeeeeeeeeeeeeeeeee', spawn: spawnThenSwap });
    assert.equal(result.code, 0, result.messages.join(''));
    assertPinned(root, root.repo);
    const swappedPayload = supervisePayload(root);
    for (const value of [root.calls[0].options.cwd, swappedPayload.cwd, ...swappedPayload.args]) {
      assert.equal(String(value).includes('escape-target'), false);
      assert.equal(String(value).includes('inside'), false);
    }
    // すでにリンクに置き換わった配下から呼ばれた場合は、呼び出し位置の実パスが親の範囲外になるので拒否する。
    root.calls.length = 0;
    result = root.runMember([...MEMBER_START.slice(0, -1), 'link-out.json'], { cwd: inside, randomId: () => 'ffffffffffffffffffffffff' });
    assert.equal(result.code, 2);
    assert.equal(root.calls.length, 0);

    // 親の範囲の外に登録された worktree から呼んだ場合は拒否する。
    root.calls.length = 0;
    result = root.runMember([...MEMBER_START.slice(0, -1), 'outside-out.json'], { cwd: fs.realpathSync(outside), randomId: () => 'dddddddddddddddddddddddd' });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /must run inside the parent working directory/);
    assert.equal(root.calls.length, 0);
    assert.equal(fs.existsSync(path.join(root.io, 'outside-out.json')), false);

    // 親をサブフォルダで起動した場合: ルートで入口を呼んでも起動しない。
    const subDir = path.join(sub.repo, 'sub');
    fs.mkdirSync(subDir);
    const narrow = createMemberFixture({ parentCwd: fs.realpathSync(subDir) });
    try {
      result = narrow.runMember(MEMBER_START, { cwd: narrow.repo });
      assert.equal(result.code, 2);
      assert.match(result.messages.join(''), /must run inside the parent working directory/);
      assert.equal(narrow.calls.length, 0);
      assert.equal(fs.existsSync(path.join(narrow.io, 'out.json')), false);
    } finally {
      narrow.cleanup();
    }

    // 親が worktree で起動された場合: ルートからは起動しない。
    const wt = path.join(sub.repo, '.claude', 'worktrees', 'parent-wt');
    git(sub.repo, 'worktree', 'add', '-q', '-b', 'work/parent-wt', wt);
    const inWorktree = createMemberFixture({ parentCwd: fs.realpathSync(wt) });
    try {
      assert.equal(isWithinDirectory(inWorktree.repo, fs.realpathSync(wt)), false);
      assert.equal(isWithinDirectory(`${fs.realpathSync(wt)}-other`, fs.realpathSync(wt)), false);
      assert.equal(isWithinDirectory(path.join(fs.realpathSync(wt), 'a', 'b'), fs.realpathSync(wt)), true);
      // .. で始まる普通のフォルダ名は配下として扱う。本物の親（..）は範囲外。
      assert.equal(isWithinDirectory(path.join(fs.realpathSync(wt), '..repo'), fs.realpathSync(wt)), true);
      assert.equal(isWithinDirectory(path.join(fs.realpathSync(wt), '..repo', 'sub'), fs.realpathSync(wt)), true);
      assert.equal(isWithinDirectory(path.dirname(fs.realpathSync(wt)), fs.realpathSync(wt)), false);
      assert.equal(inWorktree.runMember(MEMBER_START, { cwd: inWorktree.repo }).code, 2);
    } finally {
      inWorktree.cleanup();
    }
    // 親の起動 cwd が実パスでない（リンクを通る）場合は拒否する。
    const linkParent = path.join(sub.root, 'parent-link');
    fs.symlinkSync(sub.repo, linkParent);
    const linked = createMemberFixture({ parentCwd: linkParent });
    try {
      assert.equal(linked.runMember(MEMBER_START, { cwd: linked.repo }).code, 2);
      assert.equal(linked.calls.length, 0);
    } finally {
      linked.cleanup();
    }
  } finally {
    root.cleanup();
    sub.cleanup();
  }
});

test('出力先の差し替え: 作成後に出力先の名前がリンクへ差し替えられても、外部のファイルと他の実行の終了記録は書き換わらない（結果は保護された実行の記録フォルダ経由で、保持した記述子へ公開される）', async () => {
  const fixture = createMemberFixture();
  try {
    const victim = path.join(fixture.root, 'victim.txt');
    fs.writeFileSync(victim, 'original');
    const otherRun = path.join(fixture.runs, 'eeeeeeeeeeeeeeeeeeeeeeee');
    fs.mkdirSync(otherRun, { mode: 0o700 });
    fs.writeFileSync(path.join(otherRun, 'exit'), '0\n');
    fs.writeFileSync(path.join(fixture.io, 'slow.md'), 'SLEEP');
    const id = 'ffffffffffffffffffffffff';
    const started = run(fixture, ['member', 'start', '--engine', 'codex', '--prompt', 'slow.md', '--schema', 'schema.json', '--out', 'swap.json'], { writeOut: () => {}, randomId: () => id });
    assert.equal(started.code, 0, started.messages.join(''));
    // 子の実行中に、出力先の名前をリンク（外部のファイル・他の実行の終了記録）に差し替える。
    const swapped = path.join(fixture.io, 'swap.json');
    fs.rmSync(swapped);
    fs.symlinkSync(victim, swapped);
    const runDir = path.join(fixture.runs, id);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(runDir, 'exit')); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(path.join(runDir, 'exit'), 'utf8'), '0\n');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'original');
    assert.equal(fs.readFileSync(path.join(otherRun, 'exit'), 'utf8'), '0\n');
    // 子の結果は保護された実行の記録フォルダに残り、Codex の -o はそこを指していた。
    assert.equal(fs.readFileSync(path.join(runDir, 'result.txt'), 'utf8'), '{"ok":true}');
    const recorded = JSON.parse(fs.readFileSync(fixture.record, 'utf8'));
    assert.equal(recorded.args[recorded.args.indexOf('-o') + 1], path.join(runDir, 'result.txt'));
    assert.equal(recorded.args.includes(swapped), false);

    // 差し替えが無ければ、公開は保持した記述子へのコピーで、公開が終わってから終了コードが現れる。
    fs.writeFileSync(path.join(fixture.io, 'fast.md'), 'fine');
    const fastId = '999999999999999999999999';
    assert.equal(run(fixture, ['member', 'start', '--engine', 'codex', '--prompt', 'fast.md', '--schema', 'schema.json', '--out', 'fast.json'], { writeOut: () => {}, randomId: () => fastId }).code, 0);
    for (let i = 0; i < 100 && !fs.existsSync(path.join(fixture.runs, fastId, 'exit')); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(fs.readFileSync(path.join(fixture.io, 'fast.json'), 'utf8'), '{"ok":true}');
  } finally {
    fixture.cleanup();
  }
});

test('結果の公開に失敗した実行は、正常終了（EXIT_CODE=0）でも RESULT_STATE=failed と理由で区別できる（結果なし・大きすぎる・書き込み失敗・成否の記録なし）', async () => {
  const fixture = createMemberFixture();
  try {
    const exitZero = ['-e', 'process.exit(0)'];
    const supervise = async (name, prepare, deps = {}) => {
      const id = name.repeat(24);
      const runDir = path.join(fixture.runs, id);
      fs.mkdirSync(runDir, { mode: 0o700 });
      fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'x');
      prepare(runDir);
      const published = path.join(fixture.root, `published-${name}.txt`);
      const outFd = fs.openSync(published, 'wx', 0o600);
      const code = await superviseMemberRun({ codex: process.execPath, args: exitZero, cwd: fixture.repo, env: {}, runDir }, { outFd, ...deps });
      assert.equal(code, 0);
      fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ pid: 1, out: published }));
      const outputs = [];
      assert.equal(run(fixture, ['member', 'status', id], { writeOut: (text) => outputs.push(text) }).code, 0);
      return { text: outputs.join(''), published };
    };
    // 結果ファイルが無い。
    let result = await supervise('a', () => {});
    assert.match(result.text, /^EXIT_CODE=0$/m);
    assert.match(result.text, /^RESULT_STATE=failed$/m);
    assert.match(result.text, /^RESULT_FAILURE=result-missing$/m);
    // サイズ超過。
    result = await supervise('b', (runDir) => { fs.writeFileSync(path.join(runDir, 'result.txt'), ''); fs.truncateSync(path.join(runDir, 'result.txt'), 16 * 1024 * 1024 + 1); });
    assert.match(result.text, /^RESULT_STATE=failed$/m);
    assert.match(result.text, /^RESULT_FAILURE=result-too-large$/m);
    assert.equal(fs.readFileSync(result.published, 'utf8'), '');
    // 書き込み失敗（公開先の記述子が使えない）。
    result = await supervise('c', (runDir) => fs.writeFileSync(path.join(runDir, 'result.txt'), '{"ok":true}'), { outFd: 9999 });
    assert.match(result.text, /^RESULT_STATE=failed$/m);
    assert.match(result.text, /^RESULT_FAILURE=result-write-failed$/m);
    // 成功。
    result = await supervise('d', (runDir) => fs.writeFileSync(path.join(runDir, 'result.txt'), '{"ok":true}'));
    assert.match(result.text, /^RESULT_STATE=published$/m);
    assert.equal(fs.readFileSync(result.published, 'utf8'), '{"ok":true}');
    // exit だけがあって成否の記録が無い実行は、成功として扱わない。
    const bareId = 'e'.repeat(24);
    fs.mkdirSync(path.join(fixture.runs, bareId), { mode: 0o700 });
    fs.writeFileSync(path.join(fixture.runs, bareId, 'meta.json'), JSON.stringify({ pid: 1, out: '/x' }));
    fs.writeFileSync(path.join(fixture.runs, bareId, 'exit'), '0\n');
    const bare = [];
    assert.equal(run(fixture, ['member', 'status', bareId], { writeOut: (text) => bare.push(text) }).code, 0);
    assert.match(bare.join(''), /^RESULT_STATE=failed$/m);
    assert.match(bare.join(''), /^RESULT_FAILURE=result-state-unrecorded$/m);
    // 実行中は RESULT_STATE を出さない。
    const runningId = 'f'.repeat(24);
    fs.mkdirSync(path.join(fixture.runs, runningId), { mode: 0o700 });
    fs.writeFileSync(path.join(fixture.runs, runningId, 'meta.json'), JSON.stringify({ pid: 1, out: '/x' }));
    const running = [];
    run(fixture, ['member', 'status', runningId], { writeOut: (text) => running.push(text), kill: () => true });
    assert.equal(/RESULT_STATE/.test(running.join('')), false);
  } finally {
    fixture.cleanup();
  }
});

test('監督プロセス: 結果ファイルがリンクなら公開せず、子の終了コードを記録する。設定が不正なら起動しない', async () => {
  const fixture = createMemberFixture();
  try {
    const runDir = path.join(fixture.root, 'supervised');
    fs.mkdirSync(runDir, { mode: 0o700 });
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'x');
    const secret = path.join(fixture.root, 'secret.txt');
    fs.writeFileSync(secret, 'secret');
    fs.symlinkSync(secret, path.join(runDir, 'result.txt'));
    const outPath = path.join(fixture.root, 'published.txt');
    const outFd = fs.openSync(outPath, 'wx', 0o600);
    const code = await superviseMemberRun({ codex: process.execPath, args: ['-e', 'process.exit(5)'], cwd: fixture.repo, env: {}, runDir }, { outFd });
    assert.equal(code, 5);
    assert.equal(fs.readFileSync(path.join(runDir, 'exit'), 'utf8'), '5\n');
    assert.equal(fs.readFileSync(outPath, 'utf8'), '');
    // 公開できなかったことは、終了コードとは別に保護された実行の記録フォルダへ残る（正常終了と区別できる）。
    assert.equal(fs.readFileSync(path.join(runDir, 'result-state'), 'utf8'), 'failed result-not-a-regular-file\n');
    // 起動できない子は 127 を記録する。
    const missingDir = path.join(fixture.root, 'supervised-missing');
    fs.mkdirSync(missingDir, { mode: 0o700 });
    fs.writeFileSync(path.join(missingDir, 'prompt.txt'), 'x');
    const outFd2 = fs.openSync(path.join(fixture.root, 'published2.txt'), 'wx', 0o600);
    assert.equal(await superviseMemberRun({ codex: path.join(fixture.root, 'no-such-codex'), args: [], cwd: fixture.repo, env: {}, runDir: missingDir }, { outFd: outFd2 }), 127);
    assert.equal(fs.readFileSync(path.join(missingDir, 'exit'), 'utf8'), '127\n');
    assert.equal(fs.readFileSync(path.join(missingDir, 'result-state'), 'utf8'), 'failed result-missing\n');
    // 環境変数から入口を差し込まれても、不正な設定では何もしない。
    const bad = childProcess.spawnSync(process.execPath, [path.join(__dirname, '..', 'utils', 'codexTaskOps.js')], { env: { VK_TASK_MEMBER_SUPERVISE: '{"codex":"relative"}' }, encoding: 'utf8' });
    assert.equal(bad.status, 2);
  } finally {
    fixture.cleanup();
  }
});

// ─── レビュー合格ラベル（agent-review-passed）の操作 ─────────────────────────────

const REVIEW_LABEL = 'agent-review-passed';

// 偽の gh：api 呼び出しを記録し、エンドポイントごとに用意した標準出力・終了コードを返す（用意が無ければ空出力・終了 0）。
function installLabelGh(fixture, responses = {}) {
  const ghPath = fixture.env.VK_TASK_GH;
  const responsesPath = path.join(fixture.root, 'gh-responses.json');
  fs.writeFileSync(responsesPath, JSON.stringify(responses));
  const record = path.join(fixture.root, 'gh-calls.jsonl');
  fs.writeFileSync(ghPath, `#!${process.execPath}
const fs = require('fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
const responses = JSON.parse(fs.readFileSync(${JSON.stringify(responsesPath)}, 'utf8'));
const endpoint = args.find((arg) => arg.startsWith('repos/')) || '';
const key = args.includes('--method') ? 'POST ' + endpoint : endpoint;
// sequence があれば、同じキーへの n 回目の呼び出しに n 番目の応答を返す（読み直しで結果が変わる場面の再現用）。
const earlier = fs.readFileSync(${JSON.stringify(record)}, 'utf8').trim().split('\\n').map((line) => JSON.parse(line)).filter((call) => {
  const callEndpoint = call.args.find((arg) => arg.startsWith('repos/')) || '';
  return (call.args.includes('--method') ? 'POST ' + callEndpoint : callEndpoint) === key;
}).length - 1;
let response = responses[key] || {};
if (Array.isArray(response.sequence)) response = response.sequence[Math.min(earlier, response.sequence.length - 1)];
if (response.stdout) process.stdout.write(response.stdout);
process.exit(response.status || 0);
`, { mode: 0o755 });
}

function runCapture(fixture, command, extra = {}) {
  let stdout = '';
  const result = run(fixture, command, { writeOut: (message) => { stdout += message; }, ...extra });
  return { ...result, stdout };
}

test('許可: レビュー合格ラベルの 4 操作は固定形だけで組み立て直される（owner/repo の明示も可）', () => {
  assert.deepEqual(parseTaskCommand(['gh', 'label', 'exists', REVIEW_LABEL]), { ok: true, bin: 'gh', args: [], needsGitHub: true, operation: 'label-exists', label: REVIEW_LABEL });
  assert.equal(parseTaskCommand(['gh', 'label', 'create', REVIEW_LABEL]).operation, 'label-create');
  assert.deepEqual(parseTaskCommand(['gh', 'pr', 'add-label', '471', REVIEW_LABEL]).number, '471');
  assert.equal(parseTaskCommand(['gh', 'pr', 'has-label', '471', REVIEW_LABEL]).operation, 'pr-has-label');
  assert.equal(parseTaskCommand(['gh', 'vektor-inc/other-repo', 'pr', 'has-label', '5', REVIEW_LABEL]).targetRepo, 'vektor-inc/other-repo');
});

test('拒否: ラベル操作は許可外のラベル名・不正な PR 番号・未知のオプション・--repo・汎用 gh api を通さない', () => {
  const rejected = [
    ['gh', 'label', 'exists', 'bug'],
    ['gh', 'label', 'exists', 'Agent-Review-Passed'],
    ['gh', 'label', 'exists', `${REVIEW_LABEL} `],
    ['gh', 'label', 'exists'],
    ['gh', 'label', 'create', 'task-queue'],
    ['gh', 'label', 'create', REVIEW_LABEL, '--color', 'ff0000'],
    ['gh', 'label', 'create', REVIEW_LABEL, '--description', 'x'],
    ['gh', 'label', 'create', '--color', 'ff0000', REVIEW_LABEL],
    ['gh', 'label', 'delete', REVIEW_LABEL],
    ['gh', 'label', 'list'],
    ['gh', 'label', 'exists', REVIEW_LABEL, '--repo', 'o/r'],
    ['gh', 'label', 'exists', '--repo=o/r', REVIEW_LABEL],
    ['gh', 'pr', 'add-label', '0', REVIEW_LABEL],
    ['gh', 'pr', 'add-label', '007', REVIEW_LABEL],
    ['gh', 'pr', 'add-label', 'abc', REVIEW_LABEL],
    ['gh', 'pr', 'add-label', '-1', REVIEW_LABEL],
    ['gh', 'pr', 'add-label', '1/labels', REVIEW_LABEL],
    ['gh', 'pr', 'add-label', '1', 'bug'],
    ['gh', 'pr', 'add-label', REVIEW_LABEL],
    ['gh', 'pr', 'add-label', '1', REVIEW_LABEL, 'bug'],
    ['gh', 'pr', 'add-label', '1', REVIEW_LABEL, '--repo', 'o/r'],
    ['gh', 'pr', 'add-label', '1', REVIEW_LABEL, '--unknown'],
    ['gh', 'pr', 'has-label', '0', REVIEW_LABEL],
    ['gh', 'pr', 'has-label', '1', 'bug'],
    ['gh', 'pr', 'has-label', '1', REVIEW_LABEL, '-R', 'o/r'],
    ['gh', 'pr', 'edit', '1', '--add-label', REVIEW_LABEL],
    ['gh', 'api', 'repos/vektor-inc/vk-terminals/issues/1/labels'],
    ['gh', 'api', '--method', 'POST', 'repos/o/r/labels'],
    ['gh', 'issue', 'add-label', '1', REVIEW_LABEL],
  ];
  for (const command of rejected) assert.equal(parseTaskCommand(command).ok, false, JSON.stringify(command));
});

test('実行: gh label exists は完全一致で LABEL_EXISTS / LABEL_MISSING を返し、固定のエンドポイントだけを読む', () => {
  const fixture = createFixture();
  try {
    const endpoint = 'repos/vektor-inc/vk-terminals/labels?per_page=100';
    installLabelGh(fixture, { [endpoint]: { stdout: `bug\n${REVIEW_LABEL}\n` } });
    const exists = runCapture(fixture, ['gh', 'label', 'exists', REVIEW_LABEL]);
    assert.equal(exists.code, 0, exists.messages.join(''));
    assert.equal(exists.stdout, 'LABEL_EXISTS\n');
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [['api', '--paginate', '--jq', '.[].name', endpoint]]);

    // 部分一致（接頭辞・接尾辞つき）は存在と見なさない。
    installLabelGh(fixture, { [endpoint]: { stdout: `${REVIEW_LABEL}-old\nx-${REVIEW_LABEL}\n${REVIEW_LABEL} \n` } });
    const missing = runCapture(fixture, ['gh', 'label', 'exists', REVIEW_LABEL]);
    assert.equal(missing.code, 0);
    assert.equal(missing.stdout, 'LABEL_MISSING\n');

    // gh の失敗は MISSING と見なさない（誤って作成へ進まない）。
    installLabelGh(fixture, { [endpoint]: { status: 1 } });
    const failed = runCapture(fixture, ['gh', 'label', 'exists', REVIEW_LABEL]);
    assert.notEqual(failed.code, 0);
    assert.equal(failed.stdout, '');
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh label create はラベルが無いときだけ、固定の色・説明で作る', () => {
  const fixture = createFixture();
  try {
    const endpoint = 'repos/vektor-inc/vk-terminals/labels';
    installLabelGh(fixture, { [`${endpoint}?per_page=100`]: { stdout: 'bug\n' } });
    const created = runCapture(fixture, ['gh', 'label', 'create', REVIEW_LABEL]);
    assert.equal(created.code, 0, created.messages.join(''));
    assert.equal(created.stdout, 'LABEL_CREATED\n');
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [
      ['api', '--paginate', '--jq', '.[].name', `${endpoint}?per_page=100`],
      ['api', '--method', 'POST', endpoint, '-f', `name=${REVIEW_LABEL}`, '-f', 'color=0e8a16', '-f', 'description=エージェントのレビュー完了マーカー（最終レビュー・e2e ゲート通過）'],
    ]);

    // すでにあれば作らない。
    fs.rmSync(path.join(fixture.root, 'gh-calls.jsonl'));
    installLabelGh(fixture, { [`${endpoint}?per_page=100`]: { stdout: `${REVIEW_LABEL}\n` } });
    const again = runCapture(fixture, ['gh', 'label', 'create', REVIEW_LABEL]);
    assert.equal(again.code, 0);
    assert.equal(again.stdout, 'LABEL_EXISTS\n');
    assert.equal(fixture.readCalls().length, 1);

    // 作成 API が失敗しても、読み直してラベルがあれば（別の実行が先に作った場合）LABEL_EXISTS で終了 0。
    fs.rmSync(path.join(fixture.root, 'gh-calls.jsonl'));
    installLabelGh(fixture, { [`${endpoint}?per_page=100`]: { sequence: [{ stdout: 'bug\n' }, { stdout: `bug\n${REVIEW_LABEL}\n` }] }, [`POST ${endpoint}`]: { status: 1 } });
    const raced = runCapture(fixture, ['gh', 'label', 'create', REVIEW_LABEL]);
    assert.equal(raced.code, 0, raced.messages.join(''));
    assert.equal(raced.stdout, 'LABEL_EXISTS\n');
    assert.equal(fixture.readCalls().length, 3);

    // 作成 API の失敗は成功として返さない（読み直してもラベルが無ければ失敗のまま）。
    installLabelGh(fixture, { [`${endpoint}?per_page=100`]: { stdout: 'bug\n' }, [`POST ${endpoint}`]: { status: 1 } });
    const failed = runCapture(fixture, ['gh', 'label', 'create', REVIEW_LABEL]);
    assert.notEqual(failed.code, 0);
    assert.equal(failed.stdout, '');
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh pr add-label は REST で付与し（gh pr edit を使わない）、gh pr has-label は完全一致で LABEL_OK / LABEL_NG を返す', () => {
  const fixture = createFixture();
  try {
    const labels = 'repos/vektor-inc/vk-terminals/issues/471/labels';
    installLabelGh(fixture, { [`${labels}?per_page=100`]: { stdout: `bug\n${REVIEW_LABEL}\n` } });
    const added = runCapture(fixture, ['gh', 'pr', 'add-label', '471', REVIEW_LABEL]);
    assert.equal(added.code, 0, added.messages.join(''));
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [
      ['api', '--jq', '.number', 'repos/vektor-inc/vk-terminals/pulls/471'],
      ['api', '--method', 'POST', labels, '-f', `labels[]=${REVIEW_LABEL}`],
    ]);
    assert.equal(fixture.readCalls().some((call) => call.args[0] === 'pr'), false);

    const ok = runCapture(fixture, ['gh', 'pr', 'has-label', '471', REVIEW_LABEL]);
    assert.equal(ok.code, 0);
    assert.equal(ok.stdout, 'LABEL_OK\n');
    assert.deepEqual(fixture.readCalls()[3].args, ['api', '--paginate', '--jq', '.[].name', `${labels}?per_page=100`]);

    // 付与 API が失敗したら非 0（権限不足を成功にしない）。
    installLabelGh(fixture, { [`POST ${labels}`]: { status: 1 } });
    assert.notEqual(runCapture(fixture, ['gh', 'pr', 'add-label', '471', REVIEW_LABEL]).code, 0);

    // 付いていない・部分一致・gh 失敗はすべて LABEL_NG（終了 1）。
    for (const response of [{ stdout: 'bug\n' }, { stdout: `${REVIEW_LABEL}-x\nx${REVIEW_LABEL}\n` }, { stdout: '' }, { status: 1, stdout: `${REVIEW_LABEL}\n` }]) {
      installLabelGh(fixture, { [`${labels}?per_page=100`]: response });
      const ng = runCapture(fixture, ['gh', 'pr', 'has-label', '471', REVIEW_LABEL]);
      assert.equal(ng.code, 1, JSON.stringify(response));
      assert.equal(ng.stdout, 'LABEL_NG\n');
    }
  } finally {
    fixture.cleanup();
  }
});

test('実行: pulls が 404 を返す番号（issue 番号など）は、add-label は書き込まずに拒否し、has-label は LABEL_NG にする', () => {
  const fixture = createFixture();
  try {
    const pulls = 'repos/vektor-inc/vk-terminals/pulls/12';
    const labels = 'repos/vektor-inc/vk-terminals/issues/12/labels';
    installLabelGh(fixture, { [pulls]: { status: 1 }, [`${labels}?per_page=100`]: { stdout: `${REVIEW_LABEL}\n` } });
    const added = runCapture(fixture, ['gh', 'pr', 'add-label', '12', REVIEW_LABEL]);
    assert.equal(added.code, 2);
    assert.equal(added.stdout, '');
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [['api', '--jq', '.number', pulls]]);
    // ラベルが付いて見える番号でも、PR でなければ LABEL_OK にしない。
    const checked = runCapture(fixture, ['gh', 'pr', 'has-label', '12', REVIEW_LABEL]);
    assert.equal(checked.code, 1);
    assert.equal(checked.stdout, 'LABEL_NG\n');
    assert.equal(fixture.readCalls().some((call) => call.args.includes('--method') || call.args.includes('--paginate')), false);
  } finally {
    fixture.cleanup();
  }
});

test('実行: ラベル操作は許可 owner の明示先リポジトリのエンドポイントを使い、許可外 owner は gh を呼ばず拒否する', () => {
  const fixture = createFixture();
  try {
    installLabelGh(fixture, { 'repos/vektor-inc/other-repo/issues/9/labels?per_page=100': { stdout: `${REVIEW_LABEL}\n` } });
    const plain = path.join(fixture.root, 'plain');
    fs.mkdirSync(plain);
    const ok = runCapture(fixture, ['gh', 'vektor-inc/other-repo', 'pr', 'has-label', '9', REVIEW_LABEL], { cwd: plain });
    assert.equal(ok.stdout, 'LABEL_OK\n');
    assert.equal(fixture.readCalls()[0].cwd, fixture.home);
    assert.equal(fixture.readCalls()[0].args.at(-1), 'repos/vektor-inc/other-repo/pulls/9');
    assert.equal(fixture.readCalls()[1].args.at(-1), 'repos/vektor-inc/other-repo/issues/9/labels?per_page=100');

    const rejected = runCapture(fixture, ['gh', 'evil/other-repo', 'label', 'exists', REVIEW_LABEL], { cwd: plain });
    assert.equal(rejected.code, 2);
    assert.equal(fixture.readCalls().length, 2);
  } finally {
    fixture.cleanup();
  }
});

// ─── PR のタイトル・本文のファイル指定（issue #477） ──────────────────────

test('許可: gh pr create / gh pr edit は --title-file / --body-file（入出力フォルダ直下のファイル名）を受け、直接指定も残る', () => {
  const create = parseTaskCommand(['gh', 'pr', 'create', '--head', 'feature/477-x', '--title-file', 'title.txt', '--body-file=body.md', '--base', 'main']);
  assert.deepEqual(create, { ok: true, bin: 'gh', args: ['pr', 'create', '--head', 'feature/477-x', '--base', 'main'], needsGitHub: true, textFiles: { title: 'title.txt', body: 'body.md' } });
  // 一方だけをファイルにしてもよい。直接指定だけなら従来と同じ結果（textFiles を持たない）。
  const mixed = parseTaskCommand(['gh', 'pr', 'create', '--head', 'a', '--title', 't', '--body-file', 'body.md']);
  assert.deepEqual(mixed.textFiles, { title: undefined, body: 'body.md' });
  assert.equal('textFiles' in parseTaskCommand(['gh', 'pr', 'create', '--head', 'a', '--title', 't', '--body', 'b']), false);
  // 別リポジトリの明示でもファイル指定を受ける。
  assert.equal(parseTaskCommand(['gh', 'vektor-inc/other', 'pr', 'create', '--head', 'a', '--title-file', 't', '--body-file', 'b']).targetRepo, 'vektor-inc/other');

  const edit = (...tokens) => parseTaskCommand(['gh', 'pr', 'edit', ...tokens]);
  assert.deepEqual(edit('7', '--title-file', 'title.txt', '--body-file', 'body.md'), { ok: true, bin: 'gh', operation: 'pr-edit', number: '7', title: undefined, body: undefined, textFiles: { title: 'title.txt', body: 'body.md' }, needsGitHub: true });
  assert.equal(edit('7', '--body-file', 'body.md').ok, true);
  assert.equal(edit('--title', 'x', '7').title, 'x');
  assert.equal(edit('7', '--body=本文').body, '本文');
});

test('拒否: PR のファイル指定は不正な名前・併用・必須欠落・未許可フラグ・別リポジトリの gh pr edit をすべて拒否する', () => {
  const create = (...tokens) => parseTaskCommand(['gh', 'pr', 'create', '--head', 'a', ...tokens]);
  const names = ['/etc/passwd', '../x', 'a/b', '.hidden', 'a..b', 'x.', '', '-x', 'a\u0000b', 'あ.txt'];
  for (const name of names) {
    assert.equal(create('--title-file', name, '--body', 'b').ok, false, `title-file ${JSON.stringify(name)}`);
    assert.equal(create('--title', 't', '--body-file', name).ok, false, `body-file ${JSON.stringify(name)}`);
    assert.equal(parseTaskCommand(['gh', 'pr', 'edit', '5', '--body-file', name]).ok, false, `edit ${JSON.stringify(name)}`);
  }
  const rejected = [
    create('--title', 't', '--title-file', 'a', '--body', 'b'),
    create('--title', 't', '--body', 'b', '--body-file', 'a'),
    create('--title-file', 'a'),
    create('--body-file', 'a'),
    create('--title-file'),
    parseTaskCommand(['gh', 'pr', 'edit']),
    parseTaskCommand(['gh', 'pr', 'edit', '5']),
    parseTaskCommand(['gh', 'pr', 'edit', 'x', '--title', 't']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--title', 't', '--title-file', 'a']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--body', 'b', '--body-file', 'a']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--body', ' ']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--title', 't', '6']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--add-label', 'bug']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--add-assignee', 'kurudrive']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--remove-label', 'bug']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--base', 'main']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--title', 't', '--repo', 'o/r']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--title', 't', '-R', 'o/r']),
    parseTaskCommand(['gh', 'pr', 'edit', '5', '--draft']),
    parseTaskCommand(['gh', 'vektor-inc/other', 'pr', 'edit', '5', '--title', 't']),
    parseTaskCommand(['gh', 'VEKTOR-INC/vk-terminals', 'pr', 'edit', '5', '--title-file', 'a']),
  ];
  for (const result of rejected) {
    assert.equal(result.ok, false, JSON.stringify(result));
    assert.match(result.error, /^task command rejected/);
  }
});

const PR_TITLE = '[ 機能追加 ] 空白 と 日本語を含む　タイトル';
const PR_BODY = '## 概要\n\n日本語の本文です。\n\n- 箇条書き\t(タブ)\n- `code` と "引用符" と \'単一引用符\' と $HOME と $(whoami) と ; | & > <\r\n\n最終行';

// 入出力フォルダ直下にファイルを作る。content は文字列か Buffer。
function writeIo(fixture, name, content) {
  fs.writeFileSync(path.join(fixture.io, name), content);
}

const CREATE_WITH_FILES = ['gh', 'pr', 'create', '--head', 'feature/477-x', '--title-file', 'title.txt', '--body-file', 'body.md'];

test('実行: gh pr create は --title-file / --body-file の内容（日本語・空白・複数行・シェル記号）を、そのまま gh の argv の値として渡す', () => {
  const fixture = createMemberFixture();
  try {
    // タイトルは末尾の改行 1 つ（LF でも CRLF でも）だけ除かれる。本文は一切加工しない。
    for (const ending of ['', '\n', '\r\n']) {
      writeIo(fixture, 'title.txt', PR_TITLE + ending);
      writeIo(fixture, 'body.md', PR_BODY);
      const before = fixture.readCalls().length;
      const result = fixture.runMember(CREATE_WITH_FILES);
      assert.equal(result.code, 0, result.messages.join(''));
      const call = fixture.readCalls()[before];
      assert.deepEqual(call.args, ['pr', 'create', '--title', PR_TITLE, '--body', PR_BODY, '--head', 'feature/477-x', '--repo', 'vektor-inc/vk-terminals']);
    }

    // 直接指定とファイル指定の混在、別リポジトリの明示（cwd を問わず入出力フォルダから読める）。
    const plain = path.join(fixture.root, 'plain');
    fs.mkdirSync(plain);
    const before = fixture.readCalls().length;
    const mixed = fixture.runMember(['gh', 'vektor-inc/other-repo', 'pr', 'create', '--head', 'a', '--title', 'plain-title', '--body-file', 'body.md', '--draft'], { cwd: plain });
    assert.equal(mixed.code, 0, mixed.messages.join(''));
    assert.deepEqual(fixture.readCalls()[before].args, ['pr', 'create', '--body', PR_BODY, '--head', 'a', '--title', 'plain-title', '--draft', '--repo', 'vektor-inc/other-repo']);
  } finally {
    fixture.cleanup();
  }
});

test('実行: 拒否されたラベル操作は gh を一度も呼ばない', () => {
  const fixture = createFixture();
  try {
    installLabelGh(fixture);
    for (const command of [['gh', 'label', 'exists', 'bug'], ['gh', 'pr', 'add-label', '0', REVIEW_LABEL], ['gh', 'pr', 'has-label', '1', REVIEW_LABEL, '--repo', 'o/r'], ['gh', 'api', 'repos/o/r/labels']]) {
      assert.equal(run(fixture, command).code, 2, JSON.stringify(command));
    }
    assert.equal(fixture.readCalls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: gh pr create のファイル指定は不正な内容・ファイル・入出力フォルダ無しのとき、gh を一度も起動しない', () => {
  const fixture = createMemberFixture();
  try {
    const validBody = 'ok body\n';
    const big = (bytes) => Buffer.alloc(bytes, 'a');
    const cases = [
      { label: 'ファイル無し', setup: () => fs.rmSync(path.join(fixture.io, 'title.txt'), { force: true }), message: /does not exist/ },
      { label: '空のタイトル', title: '', message: /empty or too large/ },
      { label: '改行だけのタイトル', title: '\n', message: /blank/ },
      { label: '空白と改行だけのタイトル', title: '  \t \n', message: /single line/ },
      { label: '全角空白だけのタイトル', title: '　　', message: /blank/ },
      { label: 'タイトル中の改行', title: 'a\nb', message: /single line/ },
      { label: 'タイトル末尾の改行 2 つ', title: 'a\n\n', message: /single line/ },
      { label: 'タイトル中の CR', title: 'a\rb', message: /single line/ },
      { label: 'タイトルの制御文字', title: 'a\u0007b', message: /single line/ },
      { label: 'タイトルの NUL', title: 'a\u0000b', message: /single line/ },
      { label: 'タイトルの DEL', title: 'a\u007fb', message: /single line/ },
      { label: 'タイトルのタブ', title: 'a\tb', message: /single line/ },
      { label: 'タイトルが 1 KiB 超', title: big(1025), message: /empty or too large/ },
      { label: 'タイトルが 256 文字超', title: 'あ'.repeat(257), message: /longer than 256/ },
      { label: '不正な UTF-8 のタイトル', title: Buffer.from([0x61, 0xff, 0xfe, 0x62]), message: /not valid UTF-8/ },
      { label: '空の本文', body: '', message: /empty or too large/ },
      { label: '空白だけの本文', body: ' \n\t\n', message: /blank/ },
      { label: '本文の NUL', body: 'a\u0000b', message: /control characters/ },
      { label: '本文の ESC', body: 'a\u001b[31mb', message: /control characters/ },
      { label: '本文の DEL', body: 'a\u007fb', message: /control characters/ },
      { label: '本文の VT/FF', body: 'a\u000bb\u000c', message: /control characters/ },
      { label: '不正な UTF-8 の本文', body: Buffer.from([0xc3, 0x28]), message: /not valid UTF-8/ },
      { label: '本文が 256 KiB 超', body: big(256 * 1024 + 1), message: /empty or too large/ },
      { label: '本文が 65536 文字超', body: 'a'.repeat(65537), message: /longer than 65536/ },
      { label: 'シンボリックリンクのタイトル', setup: () => { writeIo(fixture, 'real.txt', 'x'); fs.rmSync(path.join(fixture.io, 'title.txt')); fs.symlinkSync(path.join(fixture.io, 'real.txt'), path.join(fixture.io, 'title.txt')); }, message: /not a plain file/ },
      { label: 'ハードリンクのタイトル', setup: () => { writeIo(fixture, 'real.txt', 'x'); fs.rmSync(path.join(fixture.io, 'title.txt')); fs.linkSync(path.join(fixture.io, 'real.txt'), path.join(fixture.io, 'title.txt')); }, message: /not a plain file/ },
      { label: 'ディレクトリのタイトル', setup: () => { fs.rmSync(path.join(fixture.io, 'title.txt')); fs.mkdirSync(path.join(fixture.io, 'title.txt')); }, message: /not a plain file/ },
      { label: '他人所有のタイトル', extra: { fs: { ...fs, fstatSync: (fd) => { const stat = fs.fstatSync(fd); return Object.create(stat, { uid: { value: stat.uid + 1 } }); } } }, message: /not owned by the current user/ },
    ];
    for (const { label, title = 'valid title', body = validBody, setup, extra, message } of cases) {
      for (const name of ['title.txt', 'body.md', 'real.txt']) fs.rmSync(path.join(fixture.io, name), { recursive: true, force: true });
      writeIo(fixture, 'title.txt', title);
      writeIo(fixture, 'body.md', body);
      if (setup) setup();
      const before = fixture.readCalls().length;
      const result = fixture.runMember(CREATE_WITH_FILES, extra);
      assert.equal(result.code, 2, label);
      assert.match(result.messages.join(''), message, label);
      assert.equal(fixture.readCalls().length, before, `${label}: gh が起動された`);
    }

    // 併用・不正な名前は parse 段階で拒否される。
    writeIo(fixture, 'title.txt', 'valid title');
    writeIo(fixture, 'body.md', validBody);
    for (const command of [
      [...CREATE_WITH_FILES, '--title', 't'],
      ['gh', 'pr', 'create', '--head', 'a', '--title-file', '../title.txt', '--body-file', 'body.md'],
      ['gh', 'pr', 'create', '--head', 'a', '--title-file', 'sub/title.txt', '--body-file', 'body.md'],
    ]) {
      assert.equal(fixture.runMember(command).code, 2, JSON.stringify(command));
    }
    assert.equal(fixture.readCalls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: 入出力フォルダが無い入口（子用）と、リンクに差し替えられた入出力フォルダでは --title-file / --body-file を使えず、gh を起動しない', () => {
  const noMember = createMemberFixture({ withMember: false });
  try {
    const result = noMember.runMember(CREATE_WITH_FILES);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /need the member input\/output folder/);
    assert.equal(noMember.readCalls().length, 0);
    const edit = noMember.runMember(['gh', 'pr', 'edit', '5', '--title-file', 'title.txt']);
    assert.equal(edit.code, 2);
    assert.match(edit.messages.join(''), /need the member input\/output folder/);
    assert.equal(noMember.readCalls().length, 0);
    // 直接指定は従来どおり使える。
    assert.equal(noMember.runMember(['gh', 'pr', 'create', '--head', 'a', '--title', 't', '--body', 'b']).code, 0);
    assert.equal(noMember.readCalls().length, 1);
  } finally {
    noMember.cleanup();
  }

  const linked = createMemberFixture();
  try {
    const realIo = path.join(linked.root, 'real-io');
    fs.mkdirSync(realIo, { mode: 0o700 });
    fs.writeFileSync(path.join(realIo, 'title.txt'), 't');
    fs.writeFileSync(path.join(realIo, 'body.md'), 'b');
    fs.rmSync(linked.io, { recursive: true, force: true });
    fs.symlinkSync(realIo, linked.io);
    const result = linked.runMember(CREATE_WITH_FILES);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /symbolic link/);
    assert.equal(linked.readCalls().length, 0);
  } finally {
    linked.cleanup();
  }
});

// issue #519: gh issue comment / gh pr comment の --body-file と gh issue create の --title-file / --body-file。
test('許可: gh issue comment / gh pr comment は --body-file、gh issue create は --title-file / --body-file を受け、直接指定も残る', () => {
  for (const group of ['issue', 'pr']) {
    const file = parseTaskCommand(['gh', group, 'comment', '7', '--body-file', 'body.md']);
    assert.deepEqual(file, { ok: true, bin: 'gh', args: [group, 'comment', '7'], needsGitHub: true, textFiles: { body: 'body.md' } });
    assert.equal(parseTaskCommand(['gh', group, 'comment', '7', '--body-file=body.md']).ok, true);
    // 従来の --body は textFiles を持たない形のまま。
    assert.deepEqual(parseTaskCommand(['gh', group, 'comment', '7', '--body', 'x']), { ok: true, bin: 'gh', args: [group, 'comment', '7', '--body', 'x'], needsGitHub: true });
  }
  const create = parseTaskCommand(['gh', 'issue', 'create', '--title-file', 't.txt', '--body-file', 'b.md', '--assignee', 'kurudrive', '--label', 'bug']);
  assert.deepEqual(create, { ok: true, bin: 'gh', args: ['issue', 'create', '--assignee', 'kurudrive', '--label', 'bug'], needsGitHub: true, textFiles: { title: 't.txt', body: 'b.md' } });
  assert.equal(parseTaskCommand(['gh', 'issue', 'create', '--title', 't', '--body-file', 'b.md']).ok, true);
  assert.equal(parseTaskCommand(['gh', 'issue', 'create', '--title-file=t.txt', '--body', 'b']).ok, true);
});

test('拒否: コメント・issue 作成のファイル指定の形（併用・どちらも無し・フォルダ外のパス・未許可フラグ）は parse 段階で拒否する', () => {
  const bad = ['/etc/passwd', '../x', './x', 'a/b', '.hidden', '', '..', '~/x', 'a\u0000b', 'a\nb'];
  for (const group of ['issue', 'pr']) {
    for (const name of bad) assert.equal(parseTaskCommand(['gh', group, 'comment', '7', '--body-file', name]).ok, false, `${group} ${JSON.stringify(name)}`);
    for (const command of [
      ['gh', group, 'comment', '7', '--body', 'x', '--body-file', 'a'],
      ['gh', group, 'comment', '7', '--body-file', 'a', '--body', 'x'],
      ['gh', group, 'comment', '7', '--body-file', 'a', '--body-file', 'b'],
      ['gh', group, 'comment', '7', '--body-file'],
      ['gh', group, 'comment', '--body-file', 'a'],
      ['gh', group, 'comment', '7'],
      ['gh', group, 'comment', '7', '--body-file', 'a', '--editor'],
      ['gh', group, 'comment', '7', '--body-file', 'a', '--repo', 'o/r'],
      ['gh', group, 'comment', '7', '-F', 'a'],
    ]) assert.equal(parseTaskCommand(command).ok, false, JSON.stringify(command));
  }
  for (const name of bad) {
    assert.equal(parseTaskCommand(['gh', 'issue', 'create', '--title-file', name, '--body', 'b']).ok, false, `title ${JSON.stringify(name)}`);
    assert.equal(parseTaskCommand(['gh', 'issue', 'create', '--title', 't', '--body-file', name]).ok, false, `body ${JSON.stringify(name)}`);
  }
  for (const command of [
    ['gh', 'issue', 'create', '--title', 't', '--title-file', 'a', '--body', 'b'],
    ['gh', 'issue', 'create', '--title', 't', '--body', 'b', '--body-file', 'a'],
    ['gh', 'issue', 'create', '--title-file', 'a'],
    ['gh', 'issue', 'create', '--body-file', 'a'],
    ['gh', 'issue', 'create', '--title-file', 'a', '--title-file', 'b', '--body-file', 'c'],
    ['gh', 'issue', 'create', '--title-file', 'a', '--body-file', 'b', '--web'],
    ['gh', 'issue', 'create', '--title-file', 'a', '--body-file', 'b', '--repo', 'o/r'],
    ['gh', 'issue', 'create', '--title-file', 'a', '--body-file', 'b', '--assignee', 'bad name'],
    ['gh', 'issue', 'create', '--title-file', 'a', '--body-file', 'b', '--label', '-evil'],
  ]) assert.equal(parseTaskCommand(command).ok, false, JSON.stringify(command));
});

test('実行: gh issue comment / gh pr comment は --body-file の複数行本文を、そのまま gh の argv の値として渡す', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'body.md', PR_BODY);
    for (const group of ['issue', 'pr']) {
      const before = fixture.readCalls().length;
      const result = fixture.runMember(['gh', group, 'comment', '519', '--body-file', 'body.md']);
      assert.equal(result.code, 0, result.messages.join(''));
      assert.deepEqual(fixture.readCalls()[before].args, [group, 'comment', '519', '--body', PR_BODY, '--repo', 'vektor-inc/vk-terminals']);
    }
    // 先頭の BOM は除かれ、別リポジトリの明示でも入出力フォルダから読める。
    writeIo(fixture, 'bom.md', '﻿一行目\n二行目\n');
    const before = fixture.readCalls().length;
    assert.equal(fixture.runMember(['gh', 'vektor-inc/other-repo', 'issue', 'comment', '3', '--body-file', 'bom.md']).code, 0);
    assert.deepEqual(fixture.readCalls()[before].args, ['issue', 'comment', '3', '--body', '一行目\n二行目\n', '--repo', 'vektor-inc/other-repo']);
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh issue create は --title-file / --body-file の内容を渡し、--assignee と --label は従来どおり付く', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'title.txt', PR_TITLE + '\n');
    writeIo(fixture, 'body.md', PR_BODY);
    let before = fixture.readCalls().length;
    const result = fixture.runMember(['gh', 'issue', 'create', '--title-file', 'title.txt', '--body-file', 'body.md', '--assignee', 'kurudrive', '--label', 'bug', '--label', 'working']);
    assert.equal(result.code, 0, result.messages.join(''));
    assert.deepEqual(fixture.readCalls()[before].args, ['issue', 'create', '--title', PR_TITLE, '--body', PR_BODY, '--assignee', 'kurudrive', '--label', 'bug', '--label', 'working', '--repo', 'vektor-inc/vk-terminals']);

    // 直接指定との混在（title は直接、body はファイル）。
    before = fixture.readCalls().length;
    assert.equal(fixture.runMember(['gh', 'issue', 'create', '--title', 'plain', '--body-file', 'body.md']).code, 0);
    assert.deepEqual(fixture.readCalls()[before].args, ['issue', 'create', '--body', PR_BODY, '--title', 'plain', '--repo', 'vektor-inc/vk-terminals']);
  } finally {
    fixture.cleanup();
  }
});

// ファイルの中身が '-' で始まっても、gh のフラグとしては解釈されず値として渡り、対象リポジトリの指定は末尾に付く（issue #519）。
test('実行: ファイルの中身が - で始まる本文・題は、フラグにならず値として gh へ渡る', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'dash.md', '--repo evil/x\n');
    let before = fixture.readCalls().length;
    assert.equal(fixture.runMember(['gh', 'issue', 'comment', '519', '--body-file', 'dash.md']).code, 0);
    assert.deepEqual(fixture.readCalls()[before].args, ['issue', 'comment', '519', '--body', '--repo evil/x\n', '--repo', 'vektor-inc/vk-terminals']);

    writeIo(fixture, 'title.txt', '--');
    writeIo(fixture, 'body.md', 'ok body\n');
    before = fixture.readCalls().length;
    assert.equal(fixture.runMember(['gh', 'issue', 'create', '--title-file', 'title.txt', '--body-file', 'body.md']).code, 0);
    assert.deepEqual(fixture.readCalls()[before].args, ['issue', 'create', '--title', '--', '--body', 'ok body\n', '--repo', 'vektor-inc/vk-terminals']);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: コメント・issue 作成のファイル指定は不正な内容・ファイル・リンク・入出力フォルダ無しのとき、gh を一度も起動しない', () => {
  const fixture = createMemberFixture();
  try {
    const commands = {
      'issue comment': (name) => ['gh', 'issue', 'comment', '5', '--body-file', name],
      'pr comment': (name) => ['gh', 'pr', 'comment', '5', '--body-file', name],
      'issue create body': (name) => ['gh', 'issue', 'create', '--title', 't', '--body-file', name],
    };
    const contents = [
      { label: 'ファイル無し', missing: true, message: /does not exist/ },
      { label: '空', content: '', message: /empty or too large/ },
      { label: '空白だけ', content: ' \n\t\n', message: /blank/ },
      { label: 'NUL', content: 'a\u0000b', message: /control characters/ },
      { label: 'ESC', content: 'a\u001b[31mb', message: /control characters/ },
      { label: '不正な UTF-8', content: Buffer.from([0xc3, 0x28]), message: /not valid UTF-8/ },
      { label: '256 KiB 超', content: Buffer.alloc(256 * 1024 + 1, 'a'), message: /empty or too large/ },
      { label: '65536 文字超', content: 'a'.repeat(65537), message: /longer than 65536/ },
      { label: 'シンボリックリンク', link: true, message: /not a plain file/ },
    ];
    for (const [kind, build] of Object.entries(commands)) {
      for (const { label, content = 'x', missing, link, message } of contents) {
        for (const n of ['body.md', 'real.txt']) fs.rmSync(path.join(fixture.io, n), { force: true });
        if (link) {
          writeIo(fixture, 'real.txt', 'x');
          fs.symlinkSync(path.join(fixture.io, 'real.txt'), path.join(fixture.io, 'body.md'));
        } else if (!missing) writeIo(fixture, 'body.md', content);
        const result = fixture.runMember(build('body.md'));
        assert.equal(result.code, 2, `${kind}: ${label}`);
        assert.match(result.messages.join(''), message, `${kind}: ${label}`);
      }
    }
    // issue create のタイトルファイル（複数行・制御文字・長さ）。
    writeIo(fixture, 'body.md', 'ok\n');
    for (const [label, title, message] of [['複数行', 'a\nb', /single line/], ['制御文字', 'a\u0007b', /single line/], ['256 文字超', 'あ'.repeat(257), /longer than 256/], ['空', '\n', /blank/]]) {
      writeIo(fixture, 'title.txt', title);
      const result = fixture.runMember(['gh', 'issue', 'create', '--title-file', 'title.txt', '--body-file', 'body.md']);
      assert.equal(result.code, 2, label);
      assert.match(result.messages.join(''), message, label);
    }
    // フォルダ外・絶対パス・`../` は parse 段階で拒否。
    for (const name of ['/etc/passwd', '../body.md', 'sub/body.md']) {
      for (const build of Object.values(commands)) assert.equal(fixture.runMember(build(name)).code, 2, name);
    }
    assert.equal(fixture.readCalls().length, 0, 'gh が起動された');
  } finally {
    fixture.cleanup();
  }

  const noMember = createMemberFixture({ withMember: false });
  try {
    for (const command of [
      ['gh', 'issue', 'comment', '5', '--body-file', 'body.md'],
      ['gh', 'pr', 'comment', '5', '--body-file', 'body.md'],
      ['gh', 'issue', 'create', '--title-file', 'title.txt', '--body-file', 'body.md'],
    ]) {
      const result = noMember.runMember(command);
      assert.equal(result.code, 2, JSON.stringify(command));
      assert.match(result.messages.join(''), /need the member input\/output folder/);
    }
    assert.equal(noMember.readCalls().length, 0);
    // 直接指定は従来どおり使える。
    assert.equal(noMember.runMember(['gh', 'issue', 'comment', '5', '--body', 'x']).code, 0);
    assert.equal(noMember.readCalls().length, 1);
  } finally {
    noMember.cleanup();
  }
});

// gh pr edit / pr view だけを差し替える spawnSync。呼び出しを記録し、gh 以外（git）は実物に流す。
// applied は更新後に gh pr view が返す内容。省略時は gh pr edit に渡された値をそのまま返す（正しく反映された gh）。
function prEditHarness(fixture, { applied, editStatus = 0, viewStatus = 0, viewStdout } = {}) {
  const calls = [];
  let last = {};
  const spawnSync = (bin, args, options) => {
    if (bin !== fixture.env.VK_TASK_GH) return childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'edit') {
      last = { title: args[args.indexOf('--title') + 1], body: args[args.indexOf('--body') + 1] };
      return { status: editStatus, stdout: '', stderr: editStatus === 0 ? '' : 'edit failed\n' };
    }
    if (args[0] === 'pr' && args[1] === 'view') return { status: viewStatus, stdout: viewStdout !== undefined ? viewStdout : JSON.stringify(applied || last), stderr: viewStatus === 0 ? '' : 'view failed\n' };
    return { status: 1, stdout: '', stderr: 'unexpected\n' };
  };
  return { calls, spawnSync };
}

test('実行: gh pr edit はファイルの内容を argv の値として渡し、拘束した --repo だけで更新して、読み戻しが一致したときだけ成功する', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'title.txt', `${PR_TITLE}\n`);
    writeIo(fixture, 'body.md', PR_BODY);
    const stdout = [];
    const { calls, spawnSync } = prEditHarness(fixture);
    const result = fixture.runMember(['gh', 'pr', 'edit', '7', '--title-file', 'title.txt', '--body-file', 'body.md'], { spawnSync, writeOut: (m) => stdout.push(m) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.deepEqual(calls, [
      ['pr', 'edit', '7', '--title', PR_TITLE, '--body', PR_BODY, '--repo', 'vektor-inc/vk-terminals'],
      ['pr', 'view', '7', '--json', 'title,body', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    assert.match(stdout.join(''), /updated PR #7: title, body/);

    // 片方だけの更新（ファイル指定と直接指定のどちらでも）は、指定した項目だけを渡して照合する。
    const onlyBody = prEditHarness(fixture, { applied: { title: '変更されない旧タイトル', body: `${PR_BODY}\n` } });
    assert.equal(fixture.runMember(['gh', 'pr', 'edit', '7', '--body-file', 'body.md'], { spawnSync: onlyBody.spawnSync, writeOut: () => {} }).code, 0);
    assert.deepEqual(onlyBody.calls[0], ['pr', 'edit', '7', '--body', PR_BODY, '--repo', 'vektor-inc/vk-terminals']);
    const direct = prEditHarness(fixture);
    assert.equal(fixture.runMember(['gh', 'pr', 'edit', '7', '--title', 'new-title'], { spawnSync: direct.spawnSync, writeOut: () => {} }).code, 0);
    assert.deepEqual(direct.calls[0], ['pr', 'edit', '7', '--title', 'new-title', '--repo', 'vektor-inc/vk-terminals']);
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh pr edit は更新・読み戻しの失敗や、読み戻した題・本文が指定と違うとき（権限不足で何も反映されないとき）に成功を返さない', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'title.txt', 'new title\n');
    writeIo(fixture, 'body.md', 'new body\n');
    const command = ['gh', 'pr', 'edit', '7', '--title-file', 'title.txt', '--body-file', 'body.md'];
    const cases = [
      { label: '更新失敗', options: { editStatus: 1 }, calls: 1, message: /gh pr edit failed/ },
      { label: '読み戻し失敗', options: { viewStatus: 1 }, calls: 2, message: /could not verify/ },
      { label: '読み戻しが不正な JSON', options: { viewStdout: 'not json' }, calls: 2, message: /could not verify/ },
      { label: '何も反映されていない（旧値のまま）', options: { applied: { title: 'old', body: 'old' } }, calls: 2, message: /title of PR #7 does not match/ },
      { label: 'タイトルだけ違う', options: { applied: { title: 'New title', body: 'new body\n' } }, calls: 2, message: /title of PR #7 does not match/ },
      { label: '本文だけ違う', options: { applied: { title: 'new title', body: 'other' } }, calls: 2, message: /body of PR #7 does not match/ },
      { label: '読み戻しに本文が無い', options: { applied: { title: 'new title' } }, calls: 2, message: /body of PR #7 does not match/ },
      { label: '読み戻しが null', options: { viewStdout: 'null' }, calls: 2, message: /does not match/ },
    ];
    for (const { label, options, calls: expectedCalls, message } of cases) {
      const { calls, spawnSync } = prEditHarness(fixture, options);
      const stdout = [];
      const result = fixture.runMember(command, { spawnSync, writeOut: (m) => stdout.push(m) });
      assert.notEqual(result.code, 0, label);
      assert.match(result.messages.join(''), message, label);
      assert.equal(calls.length, expectedCalls, label);
      assert.equal(stdout.join(''), '', label);
    }
    // CRLF → LF と末尾の空白の正規化だけは、本文の一致とみなす。題は完全一致。
    const normalized = prEditHarness(fixture, { applied: { title: 'new title', body: 'new body\r\n\r\n' } });
    assert.equal(fixture.runMember(command, { spawnSync: normalized.spawnSync, writeOut: () => {} }).code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('実行: 拒否された gh pr edit は gh を一度も呼ばない（別リポジトリ指定・未許可フラグ・不正なファイル・併用）', () => {
  const fixture = createMemberFixture();
  try {
    const plain = path.join(fixture.root, 'plain');
    fs.mkdirSync(plain);
    writeIo(fixture, 'ok.txt', 'ok\n');
    writeIo(fixture, 'bad.txt', 'a\nb');
    writeIo(fixture, 'empty.txt', '');
    writeIo(fixture, 'binary.txt', Buffer.from([0xff, 0xfe]));
    writeIo(fixture, 'ctrl.md', 'a\u0000b');
    fs.symlinkSync(path.join(fixture.io, 'ok.txt'), path.join(fixture.io, 'link.txt'));
    for (const command of [
      ['gh', 'vektor-inc/other-repo', 'pr', 'edit', '5', '--title-file', 'ok.txt'],
      ['gh', 'vektor-inc/vk-terminals', 'pr', 'edit', '5', '--title-file', 'ok.txt'],
      ['gh', 'pr', 'edit', '5', '--title-file', 'ok.txt', '--repo', 'o/r'],
      ['gh', 'pr', 'edit', '5', '--title-file', 'ok.txt', '-R', 'o/r'],
      ['gh', 'pr', 'edit', '5', '--add-label', 'bug'],
      ['gh', 'pr', 'edit', '5', '--base', 'develop'],
      ['gh', 'pr', 'edit', '5', '--title-file', '../ok.txt'],
      ['gh', 'pr', 'edit', '5', '--title', 't', '--title-file', 'ok.txt'],
      ['gh', 'pr', 'edit', '5', '--title-file', 'bad.txt'],
      ['gh', 'pr', 'edit', '5', '--title-file', 'empty.txt'],
      ['gh', 'pr', 'edit', '5', '--title-file', 'binary.txt'],
      ['gh', 'pr', 'edit', '5', '--body-file', 'ctrl.md'],
      ['gh', 'pr', 'edit', '5', '--body-file', 'link.txt'],
      ['gh', 'pr', 'edit', '5', '--body-file', 'missing.md'],
      ['gh', 'pr', 'edit', '5', '--title-file', 'ok.txt', '--body-file', 'ctrl.md'],
    ]) {
      const { calls, spawnSync } = prEditHarness(fixture);
      const result = fixture.runMember(command, { spawnSync });
      assert.equal(result.code, 2, JSON.stringify(command));
      assert.equal(calls.length, 0, JSON.stringify(command));
    }
    // 拘束リポジトリの cwd から呼んでも同じ。
    const { calls, spawnSync } = prEditHarness(fixture);
    assert.equal(fixture.runMember(['gh', 'pr', 'edit', '5', '--title-file', 'ok.txt', '--body-file', 'ctrl.md'], { spawnSync }).code, 2);
    assert.equal(calls.length, 0);
    assert.equal(fixture.readCalls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

// gh pr merge の事前読取・checks・実行・事後読取を差し替え、呼び出し順と拒否理由を確認する。
function prMergeHarness(fixture, overrides = {}) {
  const head = overrides.head || 'a'.repeat(40);
  const pr = {
    state: 'OPEN', isDraft: false, headRefOid: head,
    labels: [{ name: 'agent-review-passed' }],
    comments: [{ authorAssociation: 'MEMBER', createdAt: '2026-01-01T00:00:00Z', body: `agent-review-passed-sha: ${head}` }],
    mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ __typename: 'CheckRun' }],
    ...(overrides.pr || {}),
  };
  const checks = overrides.checks === undefined
    ? [{ bucket: 'pass', state: 'SUCCESS' }, { bucket: 'skipping', state: 'SKIPPED' }]
    : overrides.checks;
  const calls = [];
  let viewCount = 0;
  const spawnSync = (bin, args, options) => {
    if (bin !== fixture.env.VK_TASK_GH) return childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'view') {
      viewCount += 1;
      const value = viewCount === 1 ? pr : { state: overrides.afterState || 'MERGED' };
      return { status: 0, stdout: overrides.invalidPrJson && viewCount === 1 ? '{' : JSON.stringify(value), stderr: '' };
    }
    if (args[0] === 'pr' && args[1] === 'checks') {
      const stdout = overrides.checkStdout === undefined
        ? (overrides.invalidChecksJson ? '{' : JSON.stringify(checks))
        : overrides.checkStdout;
      return {
        status: overrides.checkStatus === undefined ? 0 : overrides.checkStatus,
        stdout,
        stderr: overrides.checkStderr || '',
      };
    }
    if (args[0] === 'pr' && args[1] === 'merge') return { status: overrides.mergeStatus === undefined ? 0 : overrides.mergeStatus, stdout: '', stderr: 'merge failed\n' };
    return { status: 1, stdout: '', stderr: 'unexpected\n' };
  };
  return { calls, head, spawnSync };
}

test('許可と実行: gh pr merge は番号だけを受け、事前条件を読み戻して確認済み head の squash マージ後に MERGED を再確認する', () => {
  assert.equal(parseTaskCommand(['gh', 'pr', 'merge', '7']).operation, 'pr-merge');
  const fixture = createFixture();
  try {
    const harness = prMergeHarness(fixture, { checkStatus: 8 });
    const stdout = [];
    const result = run(fixture, ['gh', 'pr', 'merge', '7'], { spawnSync: harness.spawnSync, writeOut: (message) => stdout.push(message) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.deepEqual(harness.calls, [
      ['pr', 'view', '7', '--json', 'state,isDraft,headRefOid,labels,comments,mergeable,mergeStateStatus,statusCheckRollup', '--repo', 'vektor-inc/vk-terminals'],
      ['pr', 'checks', '7', '--json', 'bucket', '--repo', 'vektor-inc/vk-terminals'],
      ['pr', 'merge', '7', '--squash', '--match-head-commit', harness.head, '--repo', 'vektor-inc/vk-terminals'],
      ['pr', 'view', '7', '--json', 'state', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    assert.match(stdout.join(''), /merged PR #7 with squash/);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: gh pr merge は不正番号・別リポジトリ・追加フラグを gh 実行前に拒否する', () => {
  for (const command of [
    ['gh', 'pr', 'merge', '0'], ['gh', 'pr', 'merge', '01'], ['gh', 'pr', 'merge', 'x'], ['gh', 'pr', 'merge'],
    ['gh', 'pr', 'merge', '7', '--admin'], ['gh', 'pr', 'merge', '7', '--auto'], ['gh', 'pr', 'merge', '7', '--delete-branch'],
    ['gh', 'pr', 'merge', '7', '-d'], ['gh', 'pr', 'merge', '7', '--rebase'], ['gh', 'pr', 'merge', '7', '--merge'],
    ['gh', 'pr', 'merge', '7', '--squash'], ['gh', 'pr', 'merge', '7', '-R', 'o/r'], ['gh', 'vektor-inc/other', 'pr', 'merge', '7'],
  ]) {
    const parsed = parseTaskCommand(command);
    assert.equal(parsed.ok, false, command.join(' '));
    assert.match(parsed.error, /^task command rejected:/);
  }
});

test('拒否: gh pr merge はレビュー・CI・マージ可能状態の各条件を満たさない場合、マージを実行しない', () => {
  const head = 'a'.repeat(40);
  const cases = [
    ['closed', { pr: { state: 'CLOSED' } }, /PR state/],
    ['draft', { pr: { isDraft: true } }, /draft/],
    ['head不正', { pr: { headRefOid: 'abc' } }, /head SHA/],
    ['ラベルなし', { pr: { labels: [] } }, /does not have/],
    ['信頼できるマーカーなし', { pr: { comments: [{ authorAssociation: 'NONE', body: `agent-review-passed-sha: ${head}` }] } }, /marker was not found/],
    ['head不一致', { pr: { comments: [{ authorAssociation: 'OWNER', createdAt: '2026-01-01T00:00:00Z', body: `agent-review-passed-sha: ${'b'.repeat(40)}` }] } }, /does not match PR head/],
    ['CI実行中', { checks: [{ bucket: 'pending', state: 'PENDING' }], checkStatus: 8 }, /check bucket is "pending"/],
    ['CI失敗', { checks: [{ bucket: 'fail', state: 'FAILURE' }], checkStatus: 1 }, /check bucket is "fail"/],
    ['CI取消', { checks: [{ bucket: 'cancel', state: 'CANCELLED' }] }, /check bucket is "cancel"/],
    ['stateだけ成功', { checks: [{ state: 'SUCCESS' }] }, /check bucket is undefined/],
    ['rollup不正', { pr: { statusCheckRollup: null } }, /statusCheckRollup/],
    ['CI JSON不正', { invalidChecksJson: true }, /invalid JSON/],
    ['mergeable不可', { pr: { mergeable: 'CONFLICTING' } }, /mergeable is/],
    ['UNSTABLE', { pr: { mergeStateStatus: 'UNSTABLE' } }, /mergeStateStatus is "UNSTABLE"/],
    ['BLOCKED', { pr: { mergeStateStatus: 'BLOCKED' } }, /mergeStateStatus is "BLOCKED"/],
  ];
  for (const [label, options, message] of cases) {
    const fixture = createFixture();
    try {
      const harness = prMergeHarness(fixture, options);
      const result = run(fixture, ['gh', 'pr', 'merge', '7'], { spawnSync: harness.spawnSync });
      assert.equal(result.code, 2, label);
      assert.match(result.messages.join(''), message, label);
      assert.equal(harness.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false, label);
    } finally {
      fixture.cleanup();
    }
  }
});

test('拒否と選択: gh pr merge は信頼できる最新のレビュー完了マーカーだけを採用する', () => {
  const head = 'a'.repeat(40);
  const other = 'b'.repeat(40);
  const cases = [
    ['新しい別SHAを採用', [
      { authorAssociation: 'MEMBER', createdAt: '2026-01-01T00:00:00Z', body: `agent-review-passed-sha: ${head}` },
      { authorAssociation: 'MEMBER', createdAt: '2026-01-02T00:00:00Z', body: `agent-review-passed-sha: ${other}` },
    ], false],
    ['配列順ではなくcreatedAt順', [
      { authorAssociation: 'MEMBER', createdAt: '2026-01-02T00:00:00Z', body: `agent-review-passed-sha: ${head}` },
      { authorAssociation: 'MEMBER', createdAt: '2026-01-01T00:00:00Z', body: `agent-review-passed-sha: ${other}` },
    ], true],
    ['同じコメントの最後の行', [
      { authorAssociation: 'MEMBER', createdAt: '2026-01-02T00:00:00Z', body: `agent-review-passed-sha: ${other}\nagent-review-passed-sha: ${head}` },
    ], true],
    ['信頼できない新しい投稿者を無視', [
      { authorAssociation: 'MEMBER', createdAt: '2026-01-01T00:00:00Z', body: `agent-review-passed-sha: ${head}` },
      { authorAssociation: 'NONE', createdAt: '2026-01-02T00:00:00Z', body: `agent-review-passed-sha: ${other}` },
    ], true],
  ];
  for (const [label, comments, allowed] of cases) {
    const fixture = createFixture();
    try {
      const harness = prMergeHarness(fixture, { pr: { comments } });
      const result = run(fixture, ['gh', 'pr', 'merge', '7'], { spawnSync: harness.spawnSync });
      assert.equal(result.code, allowed ? 0 : 2, label);
      assert.equal(harness.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), allowed, label);
    } finally {
      fixture.cleanup();
    }
  }
});

test('拒否: gh pr merge はマーカーの不正な日時と改行をまたぐ書式を拒否する', () => {
  const head = 'a'.repeat(40);
  const cases = [
    ['createdAt不正', [{ authorAssociation: 'MEMBER', createdAt: 'not-a-date', body: `agent-review-passed-sha: ${head}` }], /createdAt is invalid/],
    ['ラベルとSHAが別行', [{ authorAssociation: 'MEMBER', createdAt: '2026-01-01T00:00:00Z', body: `agent-review-passed-sha:\n${head}` }], /marker was not found/],
  ];
  for (const [label, comments, message] of cases) {
    const fixture = createFixture();
    try {
      const harness = prMergeHarness(fixture, { pr: { comments } });
      const result = run(fixture, ['gh', 'pr', 'merge', '7'], { spawnSync: harness.spawnSync });
      assert.equal(result.code, 2, label);
      assert.match(result.messages.join(''), message, label);
      assert.equal(harness.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false, label);
    } finally {
      fixture.cleanup();
    }
  }
});

test('許可と実行: gh pr merge は checks と statusCheckRollup の両方が 0 件ならマージまで進む', () => {
  for (const options of [
    { pr: { statusCheckRollup: [] }, checks: [] },
    { pr: { statusCheckRollup: [] }, checkStatus: 1, checkStdout: '  ', checkStderr: "no checks reported on the 'feature/test' branch\n" },
  ]) {
    const fixture = createFixture();
    try {
      const harness = prMergeHarness(fixture, options);
      const result = run(fixture, ['gh', 'pr', 'merge', '7'], { spawnSync: harness.spawnSync });
      assert.equal(result.code, 0, result.messages.join(''));
      assert.equal(harness.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), true);
    } finally {
      fixture.cleanup();
    }
  }
});

test('拒否: gh pr merge は checks だけが 0 件の場合と checks の別エラーを拒否する', () => {
  const cases = [
    ['rollupが非空', { checkStatus: 1, checkStdout: '', checkStderr: 'no checks reported on the branch\n' }, /statusCheckRollup is not empty/],
    ['終了0の空配列でrollupが非空', { checkStatus: 0, checks: [] }, /statusCheckRollup is not empty/],
    ['別エラー', { pr: { statusCheckRollup: [] }, checkStatus: 1, checkStdout: '', checkStderr: 'HTTP 500\n' }, /could not be read: HTTP 500/],
  ];
  for (const [label, options, message] of cases) {
    const fixture = createFixture();
    try {
      const harness = prMergeHarness(fixture, options);
      const result = run(fixture, ['gh', 'pr', 'merge', '7'], { spawnSync: harness.spawnSync });
      assert.equal(result.code, 2, label);
      assert.match(result.messages.join(''), message, label);
      assert.equal(harness.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false, label);
    } finally {
      fixture.cleanup();
    }
  }
});

test('拒否: gh pr merge の終了コードが 0 でも、事後 state が MERGED でなければ成功にしない', () => {
  const fixture = createFixture();
  try {
    const harness = prMergeHarness(fixture, { afterState: 'OPEN' });
    const result = run(fixture, ['gh', 'pr', 'merge', '7'], { spawnSync: harness.spawnSync });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /expected MERGED/);
    assert.equal(harness.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);
  } finally {
    fixture.cleanup();
  }
});

// ─── #477 レビュー指摘の補強 ─────────────────────────────────────────────

test('拒否: gh pr create / edit は --title= / --body= のように = 付きで渡された空・空白だけの値を拒否する', () => {
  for (const tokens of [
    ['--title=', '--body=b'],
    ['--title= ', '--body=b'],
    ['--title=t', '--body='],
    ['--title=t', '--body=  '],
    ['--title', 't', '--body', ' '],
  ]) {
    const result = parseTaskCommand(['gh', 'pr', 'create', '--head', 'a', ...tokens]);
    assert.equal(result.ok, false, JSON.stringify(tokens));
    assert.match(result.error, /^task command rejected/);
  }
  assert.equal(parseTaskCommand(['gh', 'pr', 'edit', '5', '--title=']).ok, false);
  assert.equal(parseTaskCommand(['gh', 'pr', 'edit', '5', '--body=\t']).ok, false);
  assert.equal(parseTaskCommand(['gh', 'pr', 'create', '--head', 'a', '--title=t', '--body=b']).ok, true);
});

test('拒否: 名前付きパイプ（FIFO）を --body-file / --title-file / member start に指定しても待たずに拒否する（gh は起動しない）', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'title.txt', 'valid title');
    childProcess.execFileSync('mkfifo', [path.join(fixture.io, 'body.md')]);
    const result = fixture.runMember(CREATE_WITH_FILES);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /not a plain file/);
    assert.equal(fixture.readCalls().length, 0);
    assert.equal(fixture.runMember(['gh', 'pr', 'edit', '5', '--body-file', 'body.md']).code, 2);

    // member start の入力も同じ読み込みを使う。FIFO は拒否され、通常のファイルは従来どおり受理される。
    childProcess.execFileSync('mkfifo', [path.join(fixture.io, 'prompt-fifo.md')]);
    const rejected = fixture.runMember(['member', 'start', '--engine', 'codex', '--prompt', 'prompt-fifo.md', '--schema', 'schema.json', '--out', 'out-fifo.json']);
    assert.equal(rejected.code, 2);
    assert.match(rejected.messages.join(''), /not a plain file/);
    assert.equal(fixture.runMember(MEMBER_START).code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: サイズ確認のあとにファイルが上限を超えて伸びても、上限を超えた分は読まずに拒否する', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'title.txt', 'a'.repeat(2000));
    writeIo(fixture, 'body.md', 'ok\n');
    // fstat は上限内の小さいサイズを返す（確認後に伸びた状況を再現）。
    const shrinking = { ...fs, fstatSync: (fd) => Object.create(fs.fstatSync(fd), { size: { value: 10 } }) };
    const result = fixture.runMember(CREATE_WITH_FILES, { fs: shrinking });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /empty or too large/);
    assert.equal(fixture.readCalls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: タイトル・本文の見えない文字（C1 制御・ゼロ幅・向き制御・行区切り・BOM）を拒否し、先頭 BOM の除去・タイトル前後の空白の除去・絵文字の ZWJ は通す', () => {
  const fixture = createMemberFixture();
  try {
    const forbidden = ['\u0085', '\u009f', '​', '‎', '‏', ' ', ' ', '‪', '‮', '⁦', '⁩', '﻿'];
    for (const char of forbidden) {
      for (const [titleText, bodyText] of [[`a${char}b`, 'ok'], ['ok', `a${char}b`]]) {
        writeIo(fixture, 'title.txt', titleText);
        writeIo(fixture, 'body.md', bodyText);
        const result = fixture.runMember(CREATE_WITH_FILES);
        assert.equal(result.code, 2, JSON.stringify(char));
      }
    }
    // 本文の先頭 BOM だけは除去、ほかの位置は拒否。
    writeIo(fixture, 'title.txt', 'ok');
    writeIo(fixture, 'body.md', '﻿body');
    let before = fixture.readCalls().length;
    assert.equal(fixture.runMember(CREATE_WITH_FILES).code, 0);
    assert.equal(fixture.readCalls()[before].args[fixture.readCalls()[before].args.indexOf('--body') + 1], 'body');
    // タイトルの前後の空白は削って送る。ZWJ を含む絵文字は変えない。
    writeIo(fixture, 'title.txt', '   題名 👨‍👩‍👧 　\n');
    writeIo(fixture, 'body.md', 'b 👨‍👩‍👧');
    before = fixture.readCalls().length;
    assert.equal(fixture.runMember(CREATE_WITH_FILES).code, 0);
    const args = fixture.readCalls()[before].args;
    assert.equal(args[args.indexOf('--title') + 1], '題名 👨‍👩‍👧');
    assert.equal(args[args.indexOf('--body') + 1], 'b 👨‍👩‍👧');

    // gh pr edit の読み戻しも、削ったタイトルで照合する。
    writeIo(fixture, 'title.txt', '  trimmed  \n');
    const { calls, spawnSync } = prEditHarness(fixture);
    assert.equal(fixture.runMember(['gh', 'pr', 'edit', '7', '--title-file', 'title.txt'], { spawnSync, writeOut: () => {} }).code, 0);
    assert.deepEqual(calls[0], ['pr', 'edit', '7', '--title', 'trimmed', '--repo', 'vektor-inc/vk-terminals']);
  } finally {
    fixture.cleanup();
  }
});

test('実行: 本文・タイトルが - や --repo=evil/x で始まっても、--body / --title の直後の値のまま渡り、末尾の --repo は拘束先のまま', () => {
  const fixture = createMemberFixture();
  try {
    for (const text of ['-', '--repo=evil/x', '-R evil/x', '--web']) {
      writeIo(fixture, 'title.txt', text);
      writeIo(fixture, 'body.md', text);
      const before = fixture.readCalls().length;
      assert.equal(fixture.runMember(CREATE_WITH_FILES).code, 0, text);
      assert.deepEqual(fixture.readCalls()[before].args, ['pr', 'create', '--title', text, '--body', text, '--head', 'feature/477-x', '--repo', 'vektor-inc/vk-terminals']);

      const { calls, spawnSync } = prEditHarness(fixture);
      assert.equal(fixture.runMember(['gh', 'pr', 'edit', '7', '--title-file', 'title.txt', '--body-file', 'body.md'], { spawnSync, writeOut: () => {} }).code, 0, text);
      assert.deepEqual(calls[0], ['pr', 'edit', '7', '--title', text, '--body', text, '--repo', 'vektor-inc/vk-terminals']);
      assert.deepEqual(calls[1], ['pr', 'view', '7', '--json', 'title,body', '--repo', 'vektor-inc/vk-terminals']);
    }
  } finally {
    fixture.cleanup();
  }
});

// ─── git fetch / git merge（デフォルトブランチの取り込み。issue #479） ─────────────

// 偽の gh がデフォルトブランチ名（repos/<owner>/<repo> の .default_branch）を返す環境と、リモート側でデフォルトブランチだけを進める道具を用意する。
function defaultBranchFixture({ defaultBranch = 'main', ghStatus = 0 } = {}) {
  const fixture = createFixture();
  const remote = attachRemote(fixture);
  installLabelGh(fixture, { 'repos/vektor-inc/vk-terminals': { stdout: `${defaultBranch}\n`, status: ghStatus } });
  const other = path.join(fixture.root, 'other-clone');
  git(fixture.root, 'clone', '-q', remote.bare, other);
  git(other, 'config', 'user.email', 'other@example.com');
  git(other, 'config', 'user.name', 'Other');
  const advance = (name, content) => {
    commitFile(other, name, content);
    git(other, 'push', '-q', 'origin', 'main');
    return git(other, 'rev-parse', 'HEAD');
  };
  return { fixture, remote, advance };
}

const parents = (cwd, rev = 'HEAD') => git(cwd, 'rev-list', '--parents', '-n', '1', rev).split(' ').slice(1);

test('許可: git fetch / git merge は引数なしの固定形だけで、デフォルトブランチの確認に gh を使う', () => {
  assert.deepEqual(parseTaskCommand(argv('git fetch')), { ok: true, bin: 'git', operation: 'fetch-default-branch', needsGitHub: true, needsGh: true });
  assert.deepEqual(parseTaskCommand(argv('git merge')), { ok: true, bin: 'git', operation: 'merge-default-branch', needsGitHub: true, needsGh: true, guardsDefaultBranch: true, branchAction: 'merge' });
});

test('拒否: git fetch / git merge は URL・refspec・ブランチ名・フラグなど、どんな引数も受け付けない', () => {
  const extras = [
    ['origin'], ['origin', 'main'], ['main'], ['https://example.com/o/r.git'], ['https://github.com/vektor-inc/vk-terminals.git'],
    ['+refs/heads/*:refs/remotes/origin/*'], ['refs/heads/main:refs/heads/work'], ['--all'], ['--tags'], ['--force'], ['-f'], ['--prune'],
    ['--squash'], ['--ff-only'], ['--no-ff'], ['--strategy=ours'], ['-X', 'theirs'], ['-s', 'ours'], ['--allow-unrelated-histories'],
    ['--abort'], ['--continue'], ['-m', 'x'], ['origin/main'], ['develop'], ['HEAD'], [''],
  ];
  for (const subcommand of ['fetch', 'merge']) {
    for (const extra of extras) {
      const result = parseTaskCommand(['git', subcommand, ...extra]);
      assert.equal(result.ok, false, `git ${subcommand} ${extra.join(' ')}`);
      assert.match(result.error, /takes no arguments/);
    }
  }
});

test('実行: git fetch は GitHub から読んだデフォルトブランチだけを、固定の URL・refspec・追跡 ref へ取得する', () => {
  const { fixture, remote, advance } = defaultBranchFixture();
  try {
    const latest = advance('latest.txt');
    // 取得対象以外のブランチがリモートにあっても取得しない。
    git(remote.bare, 'branch', 'other-branch', 'main');
    const rootBefore = { head: git(fixture.repo, 'rev-parse', 'HEAD'), branch: git(fixture.repo, 'symbolic-ref', '--short', 'HEAD') };

    const calls = [];
    const out = [];
    const result = run(fixture, ['git', 'fetch'], { spawnSync: recordingSpawn(calls), writeOut: (message) => out.push(message) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main'), latest);
    assert.equal(out.join(''), `DEFAULT_BRANCH=main\nFETCHED_REF=refs/remotes/origin/main\nFETCHED_SHA=${latest}\n`);
    assert.throws(() => git(fixture.repo, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/other-branch'));
    assert.equal(fs.existsSync(path.join(fixture.repo, '.git', 'FETCH_HEAD')), false);
    // 作業ブランチ・作業ツリーは動かさない。
    assert.deepEqual({ head: git(fixture.repo, 'rev-parse', 'HEAD'), branch: git(fixture.repo, 'symbolic-ref', '--short', 'HEAD') }, rootBefore);

    // デフォルトブランチは GitHub（gh api の固定エンドポイント）から読む。
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [['api', '--jq', '.default_branch', 'repos/vektor-inc/vk-terminals']]);
    // 取得は origin の設定値ではなく、固定の URL・固定の refspec・固定の資格情報の指定（prepare worktree と同じ書き込み制限つき）。
    const fetchCall = calls.find((call) => call.args.includes('fetch'));
    assert.equal(fetchCall.bin, '/usr/bin/sandbox-exec');
    const fetchArgs = fetchCall.args.slice(fetchCall.args.indexOf(GIT_PATH) + 1);
    const fetchIndex = fetchArgs.indexOf('fetch');
    assert.deepEqual(fetchArgs.slice(fetchIndex), ['fetch', '--no-tags', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', remote.url, '+refs/heads/main:refs/remotes/origin/main']);
    assert.deepEqual(fetchArgs.slice(FIXED_GIT_PREFIX.length, fetchIndex), [
      '-c', 'credential.helper=',
      '-c', 'credential.https://github.com.helper=',
      '-c', `credential.https://github.com.helper=!'${fixture.env.VK_TASK_GH}' auth git-credential`,
      '-c', 'core.alternateRefsCommand=',
      `--git-dir=${path.join(fs.realpathSync(fixture.repo), '.git')}`,
    ]);
    assert.equal(fetchCall.env.GIT_ALLOW_PROTOCOL, 'file');
    // 2 回目も通る（追跡 ref の更新）。
    const next = advance('latest2.txt');
    assert.equal(run(fixture, ['git', 'fetch']).code, 0);
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main'), next);
  } finally {
    fixture.cleanup();
  }
});

test('実行: 追跡 ref の親フォルダが無いクローンでも git fetch は取得できる。デフォルトブランチ名が main でなくても追従する', () => {
  const { fixture, remote } = defaultBranchFixture({ defaultBranch: 'release/stable' });
  try {
    git(remote.bare, 'branch', 'release/stable', 'main');
    fs.rmSync(path.join(fixture.repo, '.git', 'refs', 'remotes'), { recursive: true, force: true });
    const result = run(fixture, ['git', 'fetch']);
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/remotes/origin/release/stable'), git(remote.bare, 'rev-parse', 'release/stable'));
    assert.throws(() => git(fixture.repo, 'rev-parse', '--verify', '-q', 'refs/remotes/origin/main'));
  } finally {
    fixture.cleanup();
  }
});

test('拒否: git fetch はデフォルトブランチを GitHub から読めないとき・不正な名前のとき・通信先を書き換える設定があるとき取得しない', () => {
  for (const options of [{ ghStatus: 1 }, { defaultBranch: '--upload-pack=x' }, { defaultBranch: 'refs/heads/main' }, { defaultBranch: 'a..b' }, { defaultBranch: 'HEAD' }, { defaultBranch: '' }]) {
    const { fixture } = defaultBranchFixture(options);
    try {
      const calls = [];
      const result = run(fixture, ['git', 'fetch'], { spawnSync: recordingSpawn(calls) });
      assert.equal(result.code, 2, JSON.stringify(options));
      assert.match(result.messages.join(''), /default branch could not be read from GitHub/);
      assert.equal(calls.some((call) => call.args.includes('fetch')), false);
    } finally {
      fixture.cleanup();
    }
  }

  const { fixture } = defaultBranchFixture();
  try {
    for (const [key, value, pattern] of [
      ['url.https://evil.example/.insteadOf', 'https://github.com/', /redirect network access/],
      ['http.proxy', 'http://evil.example', /redirect network access/],
      ['merge.x.driver', 'touch /tmp/pwned', /can run external commands/],
    ]) {
      git(fixture.repo, 'config', key, value);
      const calls = [];
      const result = run(fixture, ['git', 'fetch'], { spawnSync: recordingSpawn(calls) });
      assert.equal(result.code, 2, key);
      assert.match(result.messages.join(''), pattern);
      assert.equal(calls.some((call) => call.args.includes('fetch')), false, key);
      git(fixture.repo, 'config', '--unset', key);
    }
  } finally {
    fixture.cleanup();
  }
});

test('実行: git merge は取得済みのデフォルトブランチを、早送りで済む場合も merge commit で取り込み、そのまま push できる（親にデフォルトブランチ側が残る）', () => {
  const { fixture, remote, advance } = defaultBranchFixture();
  try {
    const mainTip = advance('latest.txt');
    commitFile(fixture.repo, 'feature.txt');
    const featureTip = git(fixture.repo, 'rev-parse', 'HEAD');
    assert.equal(run(fixture, ['git', 'fetch']).code, 0);

    const calls = [];
    const result = run(fixture, ['git', 'merge'], { spawnSync: recordingSpawn(calls) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.deepEqual(parents(fixture.repo), [featureTip, mainTip]);
    assert.equal(fs.existsSync(path.join(fixture.repo, 'latest.txt')), true);
    // 引数は固定。取り込む元は完全名の追跡 ref だけで、squash・早送りのみ・編集画面は使わない。
    const mergeCall = calls.find((call) => call.args.includes('merge'));
    assert.deepEqual(mergeCall.args.slice(FIXED_GIT_PREFIX.length), ['merge', '--no-ff', '--no-edit', '--no-squash', '--commit', '--strategy=ort', '--no-verify', '--no-verify-signatures', '--no-autostash', '--no-gpg-sign', '--no-rerere-autoupdate', 'refs/remotes/origin/main']);

    // 早送りで済む場合（作業ブランチに独自のコミットが無い）も merge commit を作る。
    git(fixture.repo, 'checkout', '-q', '-b', 'work/ff', 'HEAD~1');
    const behindTip = git(fixture.repo, 'rev-parse', 'HEAD');
    assert.equal(run(fixture, ['git', 'merge']).code, 0);
    assert.equal(parents(fixture.repo).length, 2);
    assert.equal(parents(fixture.repo)[0], behindTip);
    git(fixture.repo, 'checkout', '-q', 'work/test');

    // 元ブランチへ push すると、リモート側の履歴にデフォルトブランチ側の親が残る。
    const pushed = run(fixture, ['git', 'push', 'work/test']);
    assert.equal(pushed.code, 0, pushed.messages.join(''));
    assert.deepEqual(parents(remote.bare, 'work/test'), [featureTip, mainTip]);
    // 既に取り込み済みなら何も変わらない。
    assert.equal(run(fixture, ['git', 'merge']).code, 0);
    assert.deepEqual(parents(fixture.repo), [featureTip, mainTip]);
  } finally {
    fixture.cleanup();
  }
});

test('実行: 競合した git merge は状態を戻さず、ファイルを直して git add・git commit -m で merge commit を完成させて push できる', () => {
  const { fixture, remote, advance } = defaultBranchFixture();
  try {
    const mainTip = advance('a.txt', 'main side\n');
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'work side\n');
    assert.equal(run(fixture, ['git', 'add', '--', 'a.txt']).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'work edit']).code, 0);
    const workTip = git(fixture.repo, 'rev-parse', 'HEAD');
    assert.equal(run(fixture, ['git', 'fetch']).code, 0);

    const conflicted = run(fixture, ['git', 'merge']);
    assert.equal(conflicted.code, 1);
    // 状態は戻さず、競合した作業ツリーのまま残る。
    assert.equal(git(fixture.repo, 'rev-parse', 'MERGE_HEAD'), mainTip);
    assert.match(fs.readFileSync(path.join(fixture.repo, 'a.txt'), 'utf8'), /^<<<<<<< /);
    // merge 中の再実行は拒否する。
    const again = run(fixture, ['git', 'merge']);
    assert.equal(again.code, 2);
    assert.match(again.messages.join(''), /merge is already in progress/);

    // 既存の add / commit が merge 中でも拒否されずに通り、親 2 つの merge commit になる。
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'resolved\n');
    assert.equal(run(fixture, ['git', 'add', '--', 'a.txt']).code, 0);
    const committed = run(fixture, ['git', 'commit', '-m', 'Merge main into work']);
    assert.equal(committed.code, 0, committed.messages.join(''));
    assert.deepEqual(parents(fixture.repo), [workTip, mainTip]);
    assert.equal(git(fixture.repo, 'status', '--porcelain'), '');

    const pushed = run(fixture, ['git', 'push', 'work/test']);
    assert.equal(pushed.code, 0, pushed.messages.join(''));
    assert.deepEqual(parents(remote.bare, 'work/test'), [workTip, mainTip]);
    // デフォルトブランチ自体は動かない。
    assert.equal(git(remote.bare, 'rev-parse', 'main'), mainTip);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: git merge は main / master・デフォルトブランチ・detached HEAD 上と、未コミット変更・未取得・merge 中・GitHub から読めないときに何もしない', () => {
  const { fixture, advance } = defaultBranchFixture();
  try {
    advance('latest.txt');
    assert.equal(run(fixture, ['git', 'fetch']).code, 0);
    const mergeCalls = (calls) => calls.filter((call) => call.args.includes('merge')).length;
    const attempt = (pattern, label) => {
      const calls = [];
      const result = run(fixture, ['git', 'merge'], { spawnSync: recordingSpawn(calls) });
      assert.equal(result.code, 2, label);
      assert.match(result.messages.join(''), pattern, label);
      assert.equal(mergeCalls(calls), 0, label);
    };
    const headBefore = git(fixture.repo, 'rev-parse', 'HEAD');

    // main / master / リモートの既定ブランチ（origin/HEAD の指す先）/ detached HEAD。
    git(fixture.repo, 'checkout', '-q', 'main');
    attempt(/cannot merge on the default branch "main"/, 'main');
    git(fixture.repo, 'checkout', '-q', '-b', 'master');
    attempt(/cannot merge on the default branch "master"/, 'master');
    git(fixture.repo, 'checkout', '-q', '-b', 'develop');
    git(fixture.repo, 'update-ref', 'refs/remotes/origin/develop', 'HEAD');
    git(fixture.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop');
    attempt(/cannot merge on the default branch "develop"/, 'origin/HEAD の指す先');
    git(fixture.repo, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    git(fixture.repo, 'checkout', '-q', '--detach', headBefore);
    attempt(/detached HEAD/, 'detached HEAD');
    git(fixture.repo, 'checkout', '-q', 'work/test');

    // 追跡ファイルの変更（作業ツリー・ステージ済み）。
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'dirty\n');
    attempt(/uncommitted changes exist/, '作業ツリーの変更');
    git(fixture.repo, 'add', 'a.txt');
    attempt(/uncommitted changes exist/, 'ステージ済みの変更');
    git(fixture.repo, 'reset', '-q', '--hard');

    // 取得済みの ref が無い。
    git(fixture.repo, 'update-ref', '-d', 'refs/remotes/origin/main');
    attempt(/has not been fetched/, '未取得');
    assert.equal(run(fixture, ['git', 'fetch']).code, 0);

    // 危険な設定（merge driver）がある。
    git(fixture.repo, 'config', 'merge.x.driver', 'touch /tmp/pwned %A');
    attempt(/can run external commands/, 'merge driver');
    git(fixture.repo, 'config', '--unset', 'merge.x.driver');

    // デフォルトブランチを GitHub から読めない。
    installLabelGh(fixture, { 'repos/vektor-inc/vk-terminals': { status: 1 } });
    attempt(/default branch could not be read from GitHub/, 'gh 失敗');

    assert.equal(git(fixture.repo, 'rev-parse', 'HEAD'), headBefore);
  } finally {
    fixture.cleanup();
  }
});

test('実行: git merge と競合解消の commit では、リポジトリ内のフックが実行されない', () => {
  const { fixture, advance } = defaultBranchFixture();
  try {
    const marker = path.join(fixture.root, 'hook-ran');
    for (const hook of ['pre-merge-commit', 'post-merge', 'commit-msg', 'pre-commit', 'prepare-commit-msg', 'post-commit']) {
      const file = path.join(fixture.repo, '.git', 'hooks', hook);
      fs.writeFileSync(file, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`, { mode: 0o755 });
    }
    advance('a.txt', 'main side\n');
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'work side\n');
    git(fixture.repo, 'add', 'a.txt');
    assert.equal(run(fixture, ['git', 'commit', '-m', 'work edit']).code, 0);
    assert.equal(run(fixture, ['git', 'fetch']).code, 0);
    assert.equal(run(fixture, ['git', 'merge']).code, 1);
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'resolved\n');
    assert.equal(run(fixture, ['git', 'add', '--', 'a.txt']).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'resolve']).code, 0);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: 強制 push・タグ操作などは git fetch / git merge の追加後も許可されない', () => {
  for (const command of [
    ['git', 'push', '--force', 'work/test'], ['git', 'push', '--tags'], ['git', 'push', '--delete', 'work/test'], ['git', 'push', '+work/test'],
    ['git', 'tag', 'v1'], ['git', 'tag', '-d', 'v1'], ['git', 'rebase', 'main'], ['git', 'reset', '--hard'], ['git', 'pull'],
  ]) {
    assert.equal(parseTaskCommand(command).ok, false, command.join(' '));
  }
});

test('拒否: GitHub から読んだデフォルトブランチ上では、ローカルに origin/HEAD が無くても git merge を実行しない', () => {
  const { fixture } = defaultBranchFixture({ defaultBranch: 'develop' });
  try {
    git(fixture.repo, 'checkout', '-q', '-b', 'develop');
    assert.throws(() => git(fixture.repo, 'symbolic-ref', '-q', 'refs/remotes/origin/HEAD'));
    const calls = [];
    const result = run(fixture, ['git', 'merge'], { spawnSync: recordingSpawn(calls) });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /cannot merge on the default branch "develop"/);
    assert.equal(calls.some((call) => call.args.includes('merge')), false);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: merge の戦略・オプション・署名検証を差し替える設定があると git merge は実行せず、他の操作（fetch）には影響しない', () => {
  const { fixture, advance } = defaultBranchFixture();
  try {
    advance('latest.txt');
    for (const [key, value] of [
      ['branch.work/test.mergeoptions', '-s ours'],
      ['pull.twohead', 'ours'],
      ['pull.octopus', 'ours'],
      ['merge.verifySignatures', 'true'],
    ]) {
      git(fixture.repo, 'config', key, value);
      // fetch は通る（merge 専用の検査）。
      assert.equal(run(fixture, ['git', 'fetch']).code, 0, key);
      const calls = [];
      const result = run(fixture, ['git', 'merge'], { spawnSync: recordingSpawn(calls) });
      assert.equal(result.code, 2, key);
      assert.match(result.messages.join(''), /can change how merge works/, key);
      assert.equal(calls.some((call) => call.args.includes('merge')), false, key);
      git(fixture.repo, 'config', '--unset', key);
    }
    // 設定を外せば通る。
    assert.equal(run(fixture, ['git', 'merge']).code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('実行: .gitattributes に merge=evil だけがあり設定側にドライバ定義が無くても、外部コマンドは走らず組み込みの merge になる', () => {
  const { fixture, advance } = defaultBranchFixture();
  try {
    const marker = path.join(fixture.root, 'driver-ran');
    // 設定側に定義が無い名前なので、何も起動されない（定義があれば merge.*.driver として入口が拒否する）。
    fs.writeFileSync(path.join(fixture.repo, '.gitattributes'), '* merge=evil\n');
    git(fixture.repo, 'add', '.gitattributes');
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'work side\n');
    git(fixture.repo, 'add', 'a.txt');
    assert.equal(run(fixture, ['git', 'commit', '-m', 'work edit']).code, 0);
    advance('a.txt', 'main side\n');
    assert.equal(run(fixture, ['git', 'fetch']).code, 0);
    const result = run(fixture, ['git', 'merge']);
    assert.equal(result.code, 1);
    assert.match(fs.readFileSync(path.join(fixture.repo, 'a.txt'), 'utf8'), /^<<<<<<< /);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fixture.cleanup();
  }
});

test('実行: git fetch の書き込み制限は、取得先の追跡 ref とオブジェクトだけを許し、設定・フック・objects/info・他の ref には書かせない', (t) => {
  if (!fs.existsSync('/usr/bin/sandbox-exec')) {
    t.skip('sandbox-exec が無い環境');
    return;
  }
  const { fixture } = defaultBranchFixture();
  try {
    const gitDir = path.join(fixture.repo, '.git');
    fs.mkdirSync(path.join(gitDir, 'objects', 'info'), { recursive: true });
    const targets = {
      config: path.join(gitDir, 'config'),
      hooks: path.join(gitDir, 'hooks', 'post-merge'),
      alternates: path.join(gitDir, 'objects', 'info', 'alternates'),
      attributes: path.join(gitDir, 'info', 'attributes'),
      otherRef: path.join(gitDir, 'refs', 'heads', 'planted'),
      allowedRef: path.join(gitDir, 'refs', 'remotes', 'origin', 'main.lock'),
      allowedObject: path.join(gitDir, 'objects', 'planted-object'),
    };
    const configBefore = fs.readFileSync(targets.config, 'utf8');
    // 実際の fetch の呼び出しから、書き込み制限の包み（sandbox-exec とそのプロファイル）だけを取り出し、中身を書き込みの試行に差し替える。
    const attempts = Object.entries(targets).map(([name, file]) => `if ( : > '${file}' ) 2>/dev/null; then echo "${name}=written"; else echo "${name}=denied"; fi`).join('\n');
    const results = [];
    const interposed = (bin, args, options) => {
      if (args.includes('fetch') && bin === '/usr/bin/sandbox-exec') {
        const wrapped = [...args.slice(0, args.indexOf(GIT_PATH)), '/bin/sh', '-c', attempts];
        const out = childProcess.spawnSync(bin, wrapped, { ...options, stdio: 'pipe' });
        results.push(String(out.stdout));
        return { status: 1, stdout: '', stderr: '' };
      }
      return childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    };
    run(fixture, ['git', 'fetch'], { spawnSync: interposed });
    const outcome = Object.fromEntries(results.join('').trim().split('\n').map((line) => line.split('=')));
    assert.deepEqual(outcome, {
      config: 'denied', hooks: 'denied', alternates: 'denied', attributes: 'denied', otherRef: 'denied', allowedRef: 'written', allowedObject: 'written',
    });
    assert.equal(fs.readFileSync(targets.config, 'utf8'), configBefore);
    assert.equal(fs.existsSync(targets.hooks), false);
    assert.equal(fs.existsSync(targets.alternates), false);
  } finally {
    fixture.cleanup();
  }
});

// ─── prepare adopt-worktree（issue #484） ──────────────────────────────────

const ADOPT_ARGS = ['prepare', 'adopt-worktree', 'main', '484', 'feature/484-adopt', 'codex-484'];

// 起動元が作るのと同じ形（origin/main の detached HEAD）で、許可された置き場所に worktree を作る。
function createLaunchWorktree(fixture, name = 'codex-484', parent = '.codex') {
  git(fixture.repo, 'update-ref', 'refs/remotes/origin/main', 'main');
  const worktree = path.join(fixture.repo, parent, 'worktrees', name);
  git(fixture.repo, 'worktree', 'add', '-q', '--detach', worktree, 'refs/remotes/origin/main');
  return fs.realpathSync(worktree);
}

// リモートの main だけを 1 コミット進める。進んだ後の SHA を返す。
function advanceRemoteMain(fixture, remote, name = 'latest.txt') {
  const other = path.join(fixture.root, `other-${name}`);
  git(fixture.root, 'clone', '-q', remote.bare, other);
  git(other, 'config', 'user.email', 't@example.com');
  git(other, 'config', 'user.name', 'T');
  commitFile(other, name);
  git(other, 'push', '-q', 'origin', 'main');
  return git(other, 'rev-parse', 'HEAD');
}

const adoptSnapshot = (dir) => ({
  head: git(dir, 'rev-parse', 'HEAD'),
  ref: git(dir, 'rev-parse', '--symbolic-full-name', 'HEAD'),
  status: git(dir, 'status', '--porcelain', '--untracked-files=all'),
  branches: git(dir, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'),
});

test('許可: prepare adopt-worktree は prepare worktree と同じ 4 つの引数と規則だけを受け付ける', () => {
  assert.deepEqual(parseTaskCommand(argv('prepare adopt-worktree main 484 feature/484-x codex-484')), {
    ok: true, bin: 'git', operation: 'prepare-adopt-worktree', base: 'main', issue: '484', branch: 'feature/484-x', name: 'codex-484', needsGitHub: true, needsGh: true,
  });
  for (const line of [
    'prepare adopt-worktree', 'prepare adopt-worktree main 484 feature/484-x', 'prepare adopt-worktree main 484 feature/484-x codex-484 extra',
    'prepare adopt-worktree main 0 feature/0-x codex-484', 'prepare adopt-worktree main 484 feature/999-x codex-484', 'prepare adopt-worktree main 484 main codex-484',
    'prepare adopt-worktree main 484 feature/484-x ../escape', 'prepare adopt-worktree ../main 484 feature/484-x codex-484', 'prepare adopt-worktree main 484 refs/heads/feature/484-x codex-484',
  ]) {
    assert.equal(parseTaskCommand(argv(line)).ok, false, line);
  }
});

test('結合: 起動元が作った detached HEAD の worktree から、固定入口だけで最新の origin/main を基点にした作業ブランチを作れる', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const worktree = createLaunchWorktree(fixture);
    const latest = advanceRemoteMain(fixture, remote);
    const rootHead = git(fixture.repo, 'rev-parse', 'HEAD');
    const out = [];
    const calls = [];
    const result = run(fixture, ADOPT_ARGS, { cwd: worktree, writeOut: (message) => out.push(message), spawnSync: recordingSpawn(calls) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(out.join(''), `TARGET_REPO=${worktree}\nWORK_BRANCH=feature/484-adopt\nBASE_SHA=${latest}\n`);
    assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), 'feature/484-adopt');
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), latest);
    assert.equal(fs.readFileSync(path.join(worktree, 'latest.txt'), 'utf8'), 'x\n');
    assert.equal(git(worktree, 'status', '--porcelain'), '');
    assert.throws(() => git(worktree, 'config', '--get', 'branch.feature/484-adopt.remote'));
    // 通常のクローンの HEAD・ブランチ・作業ツリーは変わらない。
    assert.equal(git(fixture.repo, 'rev-parse', 'HEAD'), rootHead);
    assert.equal(git(fixture.repo, 'symbolic-ref', 'HEAD'), 'refs/heads/work/test');
    assert.equal(fs.existsSync(path.join(fixture.repo, 'latest.txt')), false);
    // 取得は固定 URL・固定 refspec で、書き込み制限つきで実行する。
    const fetchCall = calls.find((call) => call.args.includes('fetch'));
    assert.equal(fetchCall.bin, '/usr/bin/sandbox-exec');
    assert.ok(fetchCall.args.includes(remote.url));
    assert.ok(fetchCall.args.includes('+refs/heads/main:refs/remotes/origin/main'));
    // 切り替えも書き込み制限つきで、検査済みの管理ディレクトリ・作業ツリーに固定している。
    const adminDir = path.join(fs.realpathSync(path.join(fixture.repo, '.git')), 'worktrees', 'codex-484');
    const fetchArgs = calls.find((call) => call.args.includes('fetch')).args;
    assert.ok(fetchArgs.includes(`--git-dir=${adminDir}`));
    assert.ok(fetchArgs.includes('core.alternateRefsCommand='));
    const writeCalls = ['branch', 'symbolic-ref', 'read-tree', 'checkout-index'].map((name) => calls.find((call) => call.bin === '/usr/bin/sandbox-exec' && call.args.includes(name)));
    for (const call of writeCalls) {
      assert.ok(call, 'sandboxed step');
      assert.ok(call.args.includes(`--git-dir=${adminDir}`) || call.args.includes('branch'));
      assert.ok(call.args.includes(`--work-tree=${worktree}`) || call.args.includes('branch'));
    }
    // 書き込み許可（-D ALLOW*）の段階分け: ブランチ作成は ref・ログだけ、HEAD の切り替えと index は管理領域だけ、展開は作業フォルダだけ。
    const allowed = (call) => call.args.filter((arg, index) => call.args[index - 1] === '-D' && arg.startsWith('ALLOW')).map((arg) => arg.slice(arg.indexOf('=') + 1));
    const commonDir = fs.realpathSync(path.join(fixture.repo, '.git'));
    assert.ok(allowed(writeCalls[0]).every((target) => target.startsWith(path.join(commonDir, 'refs', 'heads')) || target.startsWith(path.join(commonDir, 'logs', 'refs', 'heads'))));
    assert.deepEqual(allowed(writeCalls[1]), [adminDir]);
    assert.deepEqual(allowed(writeCalls[2]), [adminDir]);
    assert.deepEqual(allowed(writeCalls[3]), [worktree]);
    // 書き込み禁止（-D DENY*）に、この worktree の .git ファイルと管理情報の制御ファイルが入っている。
    const denied = (call) => call.args.filter((arg, index) => call.args[index - 1] === '-D' && arg.startsWith('DENY')).map((arg) => arg.slice(arg.indexOf('=') + 1));
    for (const call of [writeCalls[1], writeCalls[2], writeCalls[3]]) {
      for (const target of [path.join(worktree, '.git'), path.join(adminDir, 'hooks'), path.join(adminDir, 'config.worktree'), path.join(adminDir, 'commondir'), path.join(adminDir, 'gitdir'), path.join(adminDir, 'locked')]) {
        assert.ok(denied(call).includes(target), target);
      }
    }
    // そのまま add・commit・push できる。
    fs.writeFileSync(path.join(worktree, 'feature.txt'), 'feature\n');
    assert.equal(run(fixture, ['git', 'add', '--', 'feature.txt'], { cwd: worktree }).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', '[ 機能追加 ] 例'], { cwd: worktree }).code, 0);
    assert.equal(run(fixture, ['git', 'push', 'feature/484-adopt'], { cwd: worktree }).code, 0);
    assert.equal(remote.remoteRef('refs/heads/feature/484-adopt'), git(worktree, 'rev-parse', 'HEAD'));
  } finally {
    fixture.cleanup();
  }
});

test('移行: prepare adopt-worktree は旧 .claude/worktrees の worktree も同じ検査で引き受ける', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    const worktree = createLaunchWorktree(fixture, 'codex-484', '.claude');
    const result = run(fixture, ADOPT_ARGS, { cwd: worktree });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), 'feature/484-adopt');
  } finally {
    fixture.cleanup();
  }
});

test('回帰: 作成済みの worktree を prepare worktree（新規作成）へ渡すと止まり、内容は変わらない', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    const worktree = createLaunchWorktree(fixture);
    const before = adoptSnapshot(worktree);
    const result = run(fixture, ['prepare', 'worktree', 'main', '484', 'feature/484-adopt', 'codex-484']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /already exists/);
    assert.deepEqual(adoptSnapshot(worktree), before);
    // 作成済み worktree の中から prepare worktree を実行しても、ルート以外として拒否される。
    assert.equal(run(fixture, ['prepare', 'worktree', 'main', '484', 'feature/484-adopt', 'codex-485'], { cwd: worktree }).code, 2);
  } finally {
    fixture.cleanup();
  }
});

test('再開: 同じ作業ブランチで作業コミットが無ければ受け入れ、古ければ最新の origin/main へ早送りする', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const worktree = createLaunchWorktree(fixture);
    assert.equal(run(fixture, ADOPT_ARGS, { cwd: worktree }).code, 0);
    const first = git(worktree, 'rev-parse', 'HEAD');
    // 何も進んでいなければそのまま受け入れる。
    const out = [];
    assert.equal(run(fixture, ADOPT_ARGS, { cwd: worktree, writeOut: (message) => out.push(message) }).code, 0);
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), first);
    assert.equal(out.join(''), `TARGET_REPO=${worktree}\nWORK_BRANCH=feature/484-adopt\nBASE_SHA=${first}\n`);
    // origin/main が進んだら早送りする。
    const latest = advanceRemoteMain(fixture, remote);
    assert.equal(run(fixture, ADOPT_ARGS, { cwd: worktree }).code, 0);
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), latest);
    assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), 'feature/484-adopt');
    assert.equal(fs.existsSync(path.join(worktree, 'latest.txt')), true);
    assert.equal(git(worktree, 'status', '--porcelain'), '');
  } finally {
    fixture.cleanup();
  }
});

test('拒否: prepare adopt-worktree は作業コミット・別ブランチ・同名ブランチ・未コミット変更・別系統を、内容を消さずに拒否する', () => {
  const cases = {
    作業コミットあり: { pattern: /not an ancestor/, setup: (worktree) => { git(worktree, 'switch', '-q', '-c', 'feature/484-adopt'); commitFile(worktree, 'work.txt'); } },
    別ブランチにいる: { pattern: /another branch/, setup: (worktree) => { git(worktree, 'switch', '-q', '-c', 'feature/484-other'); } },
    同名ブランチが別に存在する: { pattern: /already exists/, setup: (worktree, fixture) => { git(fixture.repo, 'branch', 'feature/484-adopt', 'main'); } },
    未追跡ファイルあり: { pattern: /uncommitted changes/, setup: (worktree) => { fs.writeFileSync(path.join(worktree, 'untracked.txt'), 'u\n'); } },
    追跡ファイルの変更あり: { pattern: /uncommitted changes/, setup: (worktree) => { fs.writeFileSync(path.join(worktree, 'a.txt'), 'changed\n'); } },
    別系統のHEAD: {
      pattern: /not an ancestor/,
      setup: (worktree) => {
        git(worktree, 'checkout', '-q', '--orphan', 'tmp-orphan');
        git(worktree, 'rm', '-rfq', '.');
        commitFile(worktree, 'orphan.txt');
        git(worktree, 'checkout', '-q', '--detach');
        git(worktree, 'branch', '-q', '-D', 'tmp-orphan');
      },
    },
  };
  for (const [label, { pattern, setup }] of Object.entries(cases)) {
    const fixture = createFixture();
    try {
      attachRemote(fixture);
      const worktree = createLaunchWorktree(fixture);
      setup(worktree, fixture);
      const before = adoptSnapshot(worktree);
      const files = fs.readdirSync(worktree).sort();
      const result = run(fixture, ADOPT_ARGS, { cwd: worktree });
      assert.equal(result.code, 2, label);
      assert.match(result.messages.join(''), pattern, label);
      assert.deepEqual(adoptSnapshot(worktree), before, label);
      assert.deepEqual(fs.readdirSync(worktree).sort(), files, label);
    } finally {
      fixture.cleanup();
    }
  }
});

test('拒否: prepare adopt-worktree はパス不一致（別名・シンボリックリンク・クローン本体・サブフォルダ）と管理情報の不一致を、固有のメッセージで拒否する', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    const worktree = createLaunchWorktree(fixture);
    const worktreeRoot = path.join(fixture.repo, '.codex', 'worktrees');
    const before = adoptSnapshot(worktree);
    // ownRoot: 起動元がこの worktree を作業フォルダ（拘束ルート）にして起動した形。入口自身の検査まで確実に届く。
    const adopt = (cwd, name = 'codex-484', root = null) => {
      const result = run(fixture, ['prepare', 'adopt-worktree', 'main', '484', 'feature/484-adopt', name], { cwd, ...(root === null ? {} : { env: { ...fixture.env, VK_TASK_ROOT: root } }) });
      return { code: result.code, text: result.messages.join('') };
    };
    const expectRejected = (result, pattern, label) => {
      assert.equal(result.code, 2, label);
      assert.match(result.text, pattern, label);
    };

    // 別名: worktree 名と実パスが一致しない。
    expectRejected(adopt(worktree, 'codex-999', worktree), /does not match \.codex\/worktrees\/codex-999/, 'name');
    // シンボリックリンクの別名: 実パスが名前と一致しない。
    fs.symlinkSync(worktree, path.join(worktreeRoot, 'alias'));
    expectRejected(adopt(path.join(worktreeRoot, 'alias'), 'alias', worktree), /does not match \.codex\/worktrees\/alias/, 'alias');
    fs.unlinkSync(path.join(worktreeRoot, 'alias'));
    // .codex/worktrees 自体がリンク。
    const realRoot = path.join(fixture.root, 'moved-worktrees');
    fs.renameSync(worktreeRoot, realRoot);
    fs.symlinkSync(realRoot, worktreeRoot);
    expectRejected(adopt(path.join(worktreeRoot, 'codex-484'), 'codex-484', path.join(realRoot, 'codex-484')), /\.codex\/worktrees is a symbolic link or not a directory/, 'linked worktrees dir');
    fs.unlinkSync(worktreeRoot);
    fs.renameSync(realRoot, worktreeRoot);
    // クローン本体で実行（拘束ルートもクローン）。
    expectRejected(adopt(fixture.repo), /not a linked worktree/, 'clone root');
    // worktree のサブフォルダで実行。
    fs.mkdirSync(path.join(worktree, 'sub'));
    expectRejected(adopt(path.join(worktree, 'sub'), 'codex-484', worktree), /must run at the root of the prepared worktree/, 'subfolder');
    fs.rmdirSync(path.join(worktree, 'sub'));
    // 別タスクの worktree の管理ディレクトリを指す .git。拘束ルートがクローンなら受け入れ判定で、worktree 自身なら入口自身の検査で止まる。
    const second = createLaunchWorktree(fixture, 'codex-485');
    const dotGit = path.join(worktree, '.git');
    const original = fs.readFileSync(dotGit, 'utf8');
    fs.writeFileSync(dotGit, original.replace('codex-484', 'codex-485'));
    expectRejected(adopt(worktree), /not the bound repository/, 'foreign .git (clone root)');
    expectRejected(adopt(worktree, 'codex-484', worktree), /administrative directory is not "codex-484"/, 'foreign .git (own root)');
    fs.writeFileSync(dotGit, original);
    // gitdir の逆参照が別の場所を指す。
    const backRef = path.join(fs.realpathSync(path.join(fixture.repo, '.git')), 'worktrees', 'codex-484', 'gitdir');
    const backOriginal = fs.readFileSync(backRef, 'utf8');
    fs.writeFileSync(backRef, `${path.join(second, '.git')}\n`);
    expectRejected(adopt(worktree, 'codex-484', worktree), /back reference does not point at the working directory/, 'back reference');
    fs.writeFileSync(backRef, backOriginal);
    // 何も壊れていない。元に戻せば引き受けられる。
    assert.deepEqual(adoptSnapshot(worktree), before);
    assert.equal(run(fixture, ADOPT_ARGS, { cwd: worktree }).code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: prepare adopt-worktree は新旧どちらの置き場所でも別名リンク・親フォルダのリンクを拒否する', () => {
  for (const parent of ['.codex', '.claude']) {
    const fixture = createFixture();
    try {
      attachRemote(fixture);
      const worktree = createLaunchWorktree(fixture, 'codex-484', parent);
      const worktreeRoot = path.join(fixture.repo, parent, 'worktrees');
      const adopt = (cwd, name, root) => run(fixture, ['prepare', 'adopt-worktree', 'main', '484', 'feature/484-adopt', name], {
        cwd,
        env: { ...fixture.env, VK_TASK_ROOT: root },
      });

      fs.symlinkSync(worktree, path.join(worktreeRoot, 'alias'));
      const alias = adopt(path.join(worktreeRoot, 'alias'), 'alias', worktree);
      assert.equal(alias.code, 2, parent);
      assert.match(alias.messages.join(''), new RegExp(`does not match \\${parent}/worktrees/alias`), parent);
      fs.unlinkSync(path.join(worktreeRoot, 'alias'));

      const movedRoot = path.join(fixture.root, `moved-${parent.slice(1)}-worktrees`);
      fs.renameSync(worktreeRoot, movedRoot);
      fs.symlinkSync(movedRoot, worktreeRoot);
      const linkedRoot = adopt(path.join(worktreeRoot, 'codex-484'), 'codex-484', path.join(movedRoot, 'codex-484'));
      assert.equal(linkedRoot.code, 2, parent);
      assert.match(linkedRoot.messages.join(''), /worktrees is a symbolic link or not a directory/, parent);
    } finally {
      fixture.cleanup();
    }
  }
});

test('拒否: prepare adopt-worktree は `.codex` 自体がリンクなら引き受けない', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    createLaunchWorktree(fixture);
    const codexDir = path.join(fixture.repo, '.codex');
    const moved = path.join(fixture.root, 'moved-codex');
    fs.renameSync(codexDir, moved);
    fs.symlinkSync(moved, codexDir);
    const cwd = path.join(codexDir, 'worktrees', 'codex-484');
    const result = run(fixture, ADOPT_ARGS, { cwd, env: { ...fixture.env, VK_TASK_ROOT: path.join(moved, 'worktrees', 'codex-484') } });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /\.codex is a symbolic link or not a directory/);
  } finally {
    fixture.cleanup();
  }
});

test('許可: prepare adopt-worktree は相対パスの gitdir（管理ディレクトリ基準）の逆参照を受け入れる', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    const worktree = createLaunchWorktree(fixture);
    const backRef = path.join(fs.realpathSync(path.join(fixture.repo, '.git')), 'worktrees', 'codex-484', 'gitdir');
    fs.writeFileSync(backRef, `${path.relative(path.dirname(backRef), path.join(worktree, '.git'))}\n`);
    assert.equal(path.isAbsolute(fs.readFileSync(backRef, 'utf8').trim()), false);
    const result = run(fixture, ADOPT_ARGS, { cwd: worktree, env: { ...fixture.env, VK_TASK_ROOT: worktree } });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), 'feature/484-adopt');
  } finally {
    fixture.cleanup();
  }
});

test('拒否: prepare adopt-worktree は接続先を書き換えうる設定を拒否し、fetch が失敗したときも内容を変えない', () => {
  const fixture = createFixture();
  try {
    attachRemote(fixture);
    const worktree = createLaunchWorktree(fixture);
    const before = adoptSnapshot(worktree);
    const originRef = git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main');
    // fetch の失敗（取得元が存在しない）。
    const failed = run(fixture, ADOPT_ARGS, { cwd: worktree, env: { ...fixture.env, VK_TASK_REMOTE_BASE: path.join(fixture.root, 'missing-remote') } });
    assert.notEqual(failed.code, 0);
    assert.deepEqual(adoptSnapshot(worktree), before);
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main'), originRef);
    // 通信の経路を書き換えうる設定。
    git(fixture.repo, 'config', 'url.https://evil.example/.insteadOf', 'https://github.com/');
    const redirected = run(fixture, ADOPT_ARGS, { cwd: worktree });
    assert.equal(redirected.code, 2);
    assert.match(redirected.messages.join(''), /can redirect network access/);
    assert.deepEqual(adoptSnapshot(worktree), before);
  } finally {
    fixture.cleanup();
  }
});

test('実行: prepare adopt-worktree は新しい基点で無くなったファイルを削除し、早送りでも作業ツリーが基点と一致する', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const worktree = createLaunchWorktree(fixture);
    const other = path.join(fixture.root, 'other-delete');
    git(fixture.root, 'clone', '-q', remote.bare, other);
    git(other, 'config', 'user.email', 't@example.com');
    git(other, 'config', 'user.name', 'T');
    git(other, 'rm', '-q', 'a.txt');
    git(other, 'commit', '-q', '-m', 'remove a');
    git(other, 'push', '-q', 'origin', 'main');
    assert.equal(run(fixture, ADOPT_ARGS, { cwd: worktree }).code, 0);
    assert.equal(fs.existsSync(path.join(worktree, 'a.txt')), false);
    assert.equal(git(worktree, 'status', '--porcelain', '--untracked-files=all'), '');
    // 再開後の早送りでも同じ。
    commitFile(other, 'b.txt');
    git(other, 'rm', '-q', 'b.txt');
    git(other, 'commit', '-q', '-m', 'remove b');
    git(other, 'push', '-q', 'origin', 'main');
    assert.equal(run(fixture, ADOPT_ARGS, { cwd: worktree }).code, 0);
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), git(other, 'rev-parse', 'HEAD'));
    assert.equal(git(worktree, 'status', '--porcelain', '--untracked-files=all'), '');
  } finally {
    fixture.cleanup();
  }
});

// ─── 取得は検査済みの管理ディレクトリに固定される ──────────────────────────────

// sandbox 内の fetch を起動する直前に、dotGit（.git ファイルまたはフォルダ）を別のリポジトリを指すものへ差し替える spawnSync。fetch の後に元へ戻す。
function spawnSwappingDotGit(dotGit, fakeGitDir) {
  let swapped = false;
  return (bin, args, options) => {
    let restore = null;
    if (!swapped && bin === '/usr/bin/sandbox-exec' && args.includes('fetch')) {
      swapped = true;
      fs.renameSync(dotGit, `${dotGit}.real`);
      fs.writeFileSync(dotGit, `gitdir: ${fakeGitDir}\n`);
      restore = () => {
        fs.rmSync(dotGit);
        fs.renameSync(`${dotGit}.real`, dotGit);
      };
    }
    try {
      return childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    } finally {
      if (restore !== null) restore();
    }
  };
}

function fakeRepository(fixture) {
  const fake = path.join(fixture.root, 'fake-git');
  git(fixture.root, 'init', '-q', '--bare', fake);
  return fake;
}

const fakeRefs = (fake) => git(fake, 'for-each-ref', '--format=%(refname)');

test('固定: prepare adopt-worktree の取得は、検査後に .git が差し替えられても検査済みの管理ディレクトリで動く', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const worktree = createLaunchWorktree(fixture);
    const latest = advanceRemoteMain(fixture, remote);
    const fake = fakeRepository(fixture);
    const result = run(fixture, ADOPT_ARGS, { cwd: worktree, spawnSync: spawnSwappingDotGit(path.join(worktree, '.git'), fake) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main'), latest);
    assert.equal(git(worktree, 'rev-parse', 'HEAD'), latest);
    assert.equal(git(worktree, 'symbolic-ref', '--short', 'HEAD'), 'feature/484-adopt');
    assert.equal(fakeRefs(fake), '');
  } finally {
    fixture.cleanup();
  }
});

// prepare worktree はクローンのルートでだけ動く（取得の引数に検査済みの管理ディレクトリが入ることは、上の「実行: prepare worktree」の引数照合で確かめている）。
// worktree から実行できる git fetch で、作業フォルダの .git ファイルの差し替えが効かないことを確かめる。
test('固定: git fetch の取得は、検査後に worktree の .git が差し替えられても検査済みの管理ディレクトリで動く', () => {
  const { fixture, advance } = defaultBranchFixture();
  try {
    const worktree = createLaunchWorktree(fixture);
    const latest = advance('latest.txt');
    const fake = fakeRepository(fixture);
    const result = run(fixture, ['git', 'fetch'], { cwd: worktree, spawnSync: spawnSwappingDotGit(path.join(worktree, '.git'), fake) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(git(fixture.repo, 'rev-parse', 'refs/remotes/origin/main'), latest);
    assert.equal(fakeRefs(fake), '');
  } finally {
    fixture.cleanup();
  }
});

// ─── issue #521: gh pr diff / git merge-base / gh issue save-image ───────────────────────

test('許可: gh pr diff は PR 番号と、--name-only か --patch のどちらか 1 つだけを受ける（issue #521）', () => {
  assert.deepEqual(parseTaskCommand(['gh', 'pr', 'diff', '7']), { ok: true, bin: 'gh', args: ['pr', 'diff', '7'], needsGitHub: true });
  assert.deepEqual(parseTaskCommand(['gh', 'pr', 'diff', '7', '--name-only']).args, ['pr', 'diff', '7', '--name-only']);
  assert.deepEqual(parseTaskCommand(['gh', 'pr', 'diff', '--patch', '7']).args, ['pr', 'diff', '7', '--patch']);
  assert.equal(parseTaskCommand(['gh', 'vektor-inc/other-repo', 'pr', 'diff', '7', '--name-only']).targetRepo, 'vektor-inc/other-repo');
});

test('拒否: gh pr diff の --color・--web・--repo・--exclude・両方の形式・番号の欠落や不正・制御文字（issue #521）', () => {
  const rejected = [
    ['gh', 'pr', 'diff'],
    ['gh', 'pr', 'diff', '0'],
    ['gh', 'pr', 'diff', '007'],
    ['gh', 'pr', 'diff', '-1'],
    ['gh', 'pr', 'diff', '1', '2'],
    ['gh', 'pr', 'diff', 'feature/x'],
    ['gh', 'pr', 'diff', 'https://github.com/other/repo/pull/1'],
    ['gh', 'pr', 'diff', '7', '--color', 'always'],
    ['gh', 'pr', 'diff', '7', '--color=never'],
    ['gh', 'pr', 'diff', '7', '--web'],
    ['gh', 'pr', 'diff', '7', '-w'],
    ['gh', 'pr', 'diff', '7', '--exclude', '*.js'],
    ['gh', 'pr', 'diff', '7', '--repo', 'other/repo'],
    ['gh', 'pr', 'diff', '7', '-R', 'other/repo'],
    ['gh', 'pr', 'diff', '7', '--json', 'files'],
    ['gh', 'pr', 'diff', '7', '--name-only', '--patch'],
    ['gh', 'pr', 'diff', '7', '--name-only', '--name-only'],
    ['gh', 'pr', 'diff', '7', '--patch=true'],
    ['gh', 'pr', 'diff', '7\u0000'],
    ['gh', 'pr', 'diff', '7', '--name-only\u0000'],
    ['gh', 'other/repo/extra', 'pr', 'diff', '7'],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, /^task command rejected/);
  }
});

test('許可: git merge-base はリビジョンちょうど 2 つだけを受け、固定の安全設定つきで組み立て直す（issue #521）', () => {
  assert.deepEqual(parseTaskCommand(['git', 'merge-base', 'origin/main', 'HEAD']), {
    ok: true, bin: 'git', args: [...GIT_PREFIX, 'merge-base', 'origin/main', 'HEAD'], needsGitHub: false,
  });
  assert.equal(parseTaskCommand(['git', 'merge-base', 'main', 'feature/521-x']).ok, true);
  assert.equal(parseTaskCommand(['git', 'merge-base', 'HEAD~3', '0123abc']).ok, true);
});

test('拒否: git merge-base のフラグ・オプション注入・--・パス・個数違い・制御文字（issue #521）', () => {
  const rejected = [
    ['git', 'merge-base'],
    ['git', 'merge-base', 'main'],
    ['git', 'merge-base', 'a', 'b', 'c'],
    ['git', 'merge-base', '--fork-point', 'main', 'HEAD'],
    ['git', 'merge-base', '--octopus', 'a', 'b'],
    ['git', 'merge-base', '--is-ancestor', 'a', 'b'],
    ['git', 'merge-base', '--all', 'a', 'b'],
    ['git', 'merge-base', '-a', 'a', 'b'],
    ['git', 'merge-base', '--independent', 'a', 'b'],
    ['git', 'merge-base', '--output=/tmp/x', 'a', 'b'],
    ['git', 'merge-base', '--upload-pack=touch /tmp/x', 'a', 'b'],
    ['git', 'merge-base', '--end-of-options', 'a', 'b'],
    ['git', 'merge-base', '--exec=x', 'a', 'b'],
    ['git', 'merge-base', '-x', 'b'],
    ['git', 'merge-base', 'a', '--'],
    ['git', 'merge-base', 'a', 'b', '--'],
    ['git', 'merge-base', 'a', 'b', '--', 'file'],
    ['git', 'merge-base', 'a', '--b'],
    ['git', 'merge-base', '/etc/passwd', 'b'],
    ['git', 'merge-base', ':/message', 'b'],
    ['git', 'merge-base', 'a b', 'c'],
    ['git', 'merge-base', 'a\nb', 'c'],
    ['git', 'merge-base', 'a\u0000', 'b'],
    ['git', 'merge-base', '$(whoami)', 'b'],
    ['git', 'merge-base', 'a;b', 'c'],
    ['git', 'merge-base', '', 'b'],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, /^task command rejected/);
  }
});

const ATTACHMENT_UUID = '0f1e2d3c-1234-4abc-9def-0123456789ab';
const ATTACHMENT_URL = `https://github.com/user-attachments/assets/${ATTACHMENT_UUID}`;
const PRIVATE_IMAGE_URL = 'https://private-user-images.githubusercontent.com/12345/67890-abcdef.png?jwt=eyJhbGciOi.payload-part_1.sig';
const PNG_BYTES = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('0000000d49484452', 'hex')]);
const JPEG_BYTES = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF_BYTES = Buffer.from('GIF89a\u0001\u0000', 'latin1');
const WEBP_BYTES = Buffer.concat([Buffer.from('RIFF'), Buffer.from([1, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);

test('許可: gh issue save-image は GitHub の添付画像の URL と、入出力フォルダ直下の画像ファイル名を受ける（issue #521）', () => {
  const urls = [
    ATTACHMENT_URL,
    `https://github.com/user-attachments/assets/${ATTACHMENT_UUID.toUpperCase()}`,
    'https://user-images.githubusercontent.com/12345/67890-abcdef.png',
    PRIVATE_IMAGE_URL,
    'https://private-user-images.githubusercontent.com/12345/67890-abcdef.jpg',
  ];
  for (const url of urls) {
    const result = parseTaskCommand(['gh', 'issue', 'save-image', url, '--out', 'shot-1.png']);
    assert.deepEqual(result, { ok: true, bin: 'gh', operation: 'issue-image-save', url, out: 'shot-1.png', needsGitHub: true }, url);
  }
  for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'issue-521_image.1.png']) {
    assert.equal(parseTaskCommand(['gh', 'issue', 'save-image', ATTACHMENT_URL, `--out=${name}`]).ok, true, name);
  }
  assert.equal(parseTaskCommand(['gh', 'issue', 'save-image', '--out', 'a.png', ATTACHMENT_URL]).ok, true);
  assert.equal(parseTaskCommand(['gh', 'vektor-inc/other-repo', 'issue', 'save-image', ATTACHMENT_URL, '--out', 'a.png']).targetRepo, 'vektor-inc/other-repo');
});

test('拒否: gh issue save-image の GitHub 以外のホスト・任意 URL・経路や書式の崩れ・保存名の不正・余計なフラグ（issue #521）', () => {
  const badUrls = [
    'https://example.com/a.png',
    `https://github.com.evil.example/user-attachments/assets/${ATTACHMENT_UUID}`,
    `https://evil.example/github.com/user-attachments/assets/${ATTACHMENT_UUID}`,
    `https://github.com@evil.example/user-attachments/assets/${ATTACHMENT_UUID}`,
    `https://user:pass@github.com/user-attachments/assets/${ATTACHMENT_UUID}`,
    `https://github.com:8443/user-attachments/assets/${ATTACHMENT_UUID}`,
    `https://github.com./user-attachments/assets/${ATTACHMENT_UUID}`,
    `https://GITHUB.com/user-attachments/assets/${ATTACHMENT_UUID}`,
    `http://github.com/user-attachments/assets/${ATTACHMENT_UUID}`,
    `//github.com/user-attachments/assets/${ATTACHMENT_UUID}`,
    `file:///user-attachments/assets/${ATTACHMENT_UUID}`,
    `https:\\\\github.com\\user-attachments\\assets\\${ATTACHMENT_UUID}`,
    `https://github.com/user-attachments/assets/${ATTACHMENT_UUID}?x=1`,
    `https://github.com/user-attachments/assets/${ATTACHMENT_UUID}#frag`,
    `https://github.com/user-attachments/assets/${ATTACHMENT_UUID}/`,
    `https://github.com/user-attachments/assets/${ATTACHMENT_UUID}/../x`,
    'https://github.com/user-attachments/assets/not-a-uuid',
    'https://github.com/user-attachments/files/123/report.pdf',
    'https://github.com/vektor-inc/vk-terminals/raw/main/a.png',
    'https://raw.githubusercontent.com/vektor-inc/vk-terminals/main/a.png',
    'https://objects.githubusercontent.com/github-production-repository-file/a.png',
    'https://github-production-user-asset-6210df.s3.amazonaws.com/1/a.png',
    'https://avatars.githubusercontent.com/u/1',
    'https://user-attachments.githubusercontent.com/a.png',
    'https://user-images.githubusercontent.com/12345/67890-abcdef.png?x=1',
    'https://user-images.githubusercontent.com/12345/../67890.png',
    'https://user-images.githubusercontent.com//12345/a.png',
    'https://user-images.githubusercontent.com/12345/a%2e%2e.png',
    'https://private-user-images.githubusercontent.com/1/a.png?jwt=a&x=b',
    'https://private-user-images.githubusercontent.com/1/a.png?x=b',
    'https://private-user-images.githubusercontent.com/1/a.png?jwt=a b',
    `https://127.0.0.1/user-attachments/assets/${ATTACHMENT_UUID}`,
    'https://[::1]/a.png',
    'https://169.254.169.254/latest/meta-data',
    `https://github.com/user-attachments/assets/${ATTACHMENT_UUID}\n`,
    ` https://github.com/user-attachments/assets/${ATTACHMENT_UUID}`,
    `https://github.com/user-attachments/assets/${ATTACHMENT_UUID}\u0000`,
    `https://github.com/user-attachments/assets/${ATTACHMENT_UUID}\u202e`,
    `https://github.com/user-attachments/assets/${'a'.repeat(3000)}`,
    '',
    'not a url',
  ];
  for (const url of badUrls) {
    const result = parseTaskCommand(['gh', 'issue', 'save-image', url, '--out', 'a.png']);
    assert.equal(result.ok, false, JSON.stringify(url).slice(0, 120));
    assert.match(result.error, /^task command rejected/);
  }
  const badNames = ['../a.png', '/etc/a.png', 'sub/a.png', '.a.png', '..png', 'a..png', 'a.svg', 'a.png.exe', 'a.PNG', 'a', '.png', '', 'a b.png', 'a\n.png', 'a\u0000.png', 'a.png\n', `${'a'.repeat(100)}.png`, '~/a.png', 'a.png/'];
  for (const name of badNames) {
    assert.equal(parseTaskCommand(['gh', 'issue', 'save-image', ATTACHMENT_URL, '--out', name]).ok, false, JSON.stringify(name));
  }
  const badShapes = [
    ['gh', 'issue', 'save-image'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL],
    ['gh', 'issue', 'save-image', '--out', 'a.png'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL, '--out'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL, '--out', 'a.png', '--out', 'b.png'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL, ATTACHMENT_URL, '--out', 'a.png'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL, '--output', 'a.png'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL, '-o', 'a.png'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL, '--out', 'a.png', '--repo', 'other/repo'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL, '--out', 'a.png', '--header', 'X: y'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL, '--out', 'a.png', '--insecure'],
    ['gh', 'issue', 'save-image', ATTACHMENT_URL, '--out', 'a.png', '--force'],
  ];
  for (const command of badShapes) assert.equal(parseTaskCommand(command).ok, false, JSON.stringify(command));
});

test('実行: gh pr diff は拘束した --repo だけを付け、git merge-base は拘束したリポジトリで実際に動く（issue #521）', () => {
  const fixture = createFixture();
  try {
    assert.equal(run(fixture, ['gh', 'pr', 'diff', '7', '--name-only']).code, 0);
    assert.equal(run(fixture, ['gh', 'pr', 'diff', '8', '--patch']).code, 0);
    assert.equal(run(fixture, ['gh', 'pr', 'diff', '9', '--repo', 'other/repo']).code, 2);
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [
      ['pr', 'diff', '7', '--name-only', '--repo', 'vektor-inc/vk-terminals'],
      ['pr', 'diff', '8', '--patch', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    const plain = path.join(fixture.root, 'plain');
    fs.mkdirSync(plain);
    assert.equal(run(fixture, ['gh', 'VEKTOR-INC/other-repo', 'pr', 'diff', '3'], { cwd: plain }).code, 0);
    assert.equal(run(fixture, ['gh', 'evil/other-repo', 'pr', 'diff', '3'], { cwd: plain }).code, 2);
    assert.equal(fixture.readCalls().length, 3);

    // 2 つのブランチの分岐点を、実際の Git が返す。
    const base = git(fixture.repo, 'rev-parse', 'HEAD');
    git(fixture.repo, 'checkout', '-q', '-b', 'work/side');
    fs.writeFileSync(path.join(fixture.repo, 'side.txt'), 'side\n');
    git(fixture.repo, 'add', 'side.txt');
    git(fixture.repo, 'commit', '-q', '-m', 'side');
    const stdout = [];
    const spawnRecording = (bin, args, options) => {
      const spawned = childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
      if (args.includes('merge-base')) stdout.push(String(spawned.stdout));
      return spawned;
    };
    const result = run(fixture, ['git', 'merge-base', 'work/test', 'work/side'], { spawnSync: spawnRecording });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.equal(stdout.join('').trim(), base);
    // 拒否された入力は Git を起動しない（フラグ・--・個数違い）。
    const before = stdout.length;
    for (const command of [['git', 'merge-base', '--fork-point', 'a', 'b'], ['git', 'merge-base', 'a'], ['git', 'merge-base', 'a', 'b', '--']]) {
      assert.equal(run(fixture, command, { spawnSync: spawnRecording }).code, 2, JSON.stringify(command));
    }
    assert.equal(stdout.length, before);
  } finally {
    fixture.cleanup();
  }
});

// 画像の保存を試すフィクスチャ。入出力フォルダを持つ起動で、gh の認証トークンは固定値、画像の取得は呼び出しを記録する差し替えにする。
function createImageFixture(responses) {
  const fixture = createMemberFixture();
  fs.writeFileSync(path.join(fixture.root, 'bin', 'gh'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(path.join(fixture.root, 'gh-calls.jsonl'))}, JSON.stringify({ args: process.argv.slice(2), env: process.env, cwd: process.cwd() }) + '\\n');\nif (process.argv[2] === 'auth' && process.argv[3] === 'token') console.log('ghp_TESTTOKEN_123');\n`, { mode: 0o755 });
  const requests = [];
  const requestAttachmentStub = (url, options) => {
    requests.push({ url: url.href, headers: options.headers });
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected request');
    return Promise.resolve(next);
  };
  const save = async (command, extra = {}) => {
    const result = fixture.runMember(command, { requestAttachment: requestAttachmentStub, ...extra });
    return { ...result, code: await result.code };
  };
  return { ...fixture, requests, save };
}

const saveCommand = (name, url = ATTACHMENT_URL) => ['gh', 'issue', 'save-image', url, '--out', name];

test('実行: gh issue save-image は github.com → 署名付き URL のリダイレクトをたどって画像を保存し、トークンは github.com にだけ送る（issue #521）', async () => {
  const fixture = createImageFixture([
    { status: 302, location: PRIVATE_IMAGE_URL },
    { status: 302, location: 'https://objects.githubusercontent.com/github-production-repository-file/x?X-Amz-Signature=abc&X-Amz-Expires=300' },
    { status: 200, body: PNG_BYTES },
  ]);
  try {
    const result = await fixture.save(saveCommand('shot.png'));
    assert.equal(result.code, 0, result.messages.join(''));
    const saved = path.join(fixture.io, 'shot.png');
    assert.deepEqual(fs.readFileSync(saved), PNG_BYTES);
    assert.equal(fs.statSync(saved).mode & 0o777, 0o600);
    assert.equal(fixture.outputs.join(''), `SAVED=${saved}\nTYPE=png\nBYTES=${PNG_BYTES.length}\n`);
    assert.deepEqual(fixture.requests.map((request) => new URL(request.url).hostname), ['github.com', 'private-user-images.githubusercontent.com', 'objects.githubusercontent.com']);
    // 認証トークンは github.com への最初の要求だけ。署名付き URL のホストには送らない。
    assert.equal(fixture.requests[0].headers.Authorization, 'Bearer ghp_TESTTOKEN_123');
    assert.equal(fixture.requests[1].headers.Authorization, undefined);
    assert.equal(fixture.requests[2].headers.Authorization, undefined);
    assert.deepEqual(fixture.readCalls().map((call) => call.args), [['auth', 'token']]);
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh issue save-image は GitHub の画像ホストへ直接取りに行くときトークンを読まず、4 形式の画像を拡張子と一致させて保存する（issue #521）', async () => {
  const fixture = createImageFixture([
    { status: 200, body: JPEG_BYTES },
    { status: 200, body: JPEG_BYTES },
    { status: 200, body: GIF_BYTES },
    { status: 200, body: WEBP_BYTES },
  ]);
  try {
    assert.equal((await fixture.save(saveCommand('a.jpg', PRIVATE_IMAGE_URL))).code, 0);
    assert.equal((await fixture.save(saveCommand('b.jpeg', 'https://user-images.githubusercontent.com/1/2-3.jpg'))).code, 0);
    assert.equal((await fixture.save(saveCommand('c.gif', 'https://user-images.githubusercontent.com/1/2-4.gif'))).code, 0);
    assert.equal((await fixture.save(saveCommand('d.webp', 'https://user-images.githubusercontent.com/1/2-5.webp'))).code, 0);
    assert.deepEqual(fs.readdirSync(fixture.io).sort(), ['a.jpg', 'b.jpeg', 'c.gif', 'd.webp', 'prompt.md', 'schema.json']);
    assert.equal(fixture.requests.every((request) => request.headers.Authorization === undefined), true);
    assert.equal(fixture.readCalls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: gh issue save-image はリダイレクト先が許可ホスト以外・http・認証情報つき・回数超過のとき、何も保存せず次の要求も送らない（issue #521）', async () => {
  const bad = [
    'https://evil.example/a.png',
    'http://objects.githubusercontent.com/a.png',
    'https://user:pw@objects.githubusercontent.com/a.png',
    'https://objects.githubusercontent.com:8443/a.png',
    'https://objects.githubusercontent.com.evil.example/a.png',
    'https://github.com.evil.example/a.png',
    'https://169.254.169.254/latest',
    'file:///etc/passwd',
    'ftp://github.com/a.png',
    '//evil.example/a.png',
    'https://objects.githubusercontent.com/a.png\r\nX-Injected: 1',
    'https://objects.githubusercontent.com/a b.png',
    undefined,
    '',
  ];
  for (const location of bad) {
    const fixture = createImageFixture([{ status: 302, location }, { status: 200, body: PNG_BYTES }]);
    try {
      const result = await fixture.save(saveCommand('x.png'));
      assert.equal(result.code, 2, String(location));
      assert.match(result.messages.join(''), /redirect target is not an allowed/);
      assert.equal(fixture.requests.length, 1, String(location));
      assert.equal(fs.existsSync(path.join(fixture.io, 'x.png')), false);
      assert.equal(fixture.outputs.length, 0);
    } finally {
      fixture.cleanup();
    }
  }
  const loop = createImageFixture(Array.from({ length: 10 }, () => ({ status: 302, location: ATTACHMENT_URL })));
  try {
    const result = await loop.save(saveCommand('x.png'));
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /too many redirects/);
    assert.equal(loop.requests.length, 6);
    assert.equal(fs.existsSync(path.join(loop.io, 'x.png')), false);
  } finally {
    loop.cleanup();
  }
});

test('拒否: gh issue save-image は画像でない中身・拡張子と形式の不一致・SVG・HTML・空・HTTP エラーを保存しない（issue #521）', async () => {
  const cases = [
    [{ status: 200, body: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>') }, 'a.png', /not a png, jpeg, gif or webp/],
    [{ status: 200, body: Buffer.from('<!doctype html><html></html>') }, 'a.png', /not a png, jpeg, gif or webp/],
    [{ status: 200, body: Buffer.alloc(0) }, 'a.png', /not a png, jpeg, gif or webp/],
    [{ status: 200, body: Buffer.from('RIFF\u0001\u0000\u0000\u0000WAVEfmt ', 'latin1') }, 'a.webp', /not a png, jpeg, gif or webp/],
    [{ status: 200, body: PNG_BYTES }, 'a.jpg', /does not match the image type \(png\)/],
    [{ status: 200, body: JPEG_BYTES }, 'a.png', /does not match the image type \(jpeg\)/],
    [{ status: 200, body: GIF_BYTES }, 'a.webp', /does not match the image type \(gif\)/],
    [{ status: 200, body: WEBP_BYTES }, 'a.gif', /does not match the image type \(webp\)/],
    [{ status: 404 }, 'a.png', /HTTP 404/],
    [{ status: 403 }, 'a.png', /HTTP 403/],
    [{ status: 500 }, 'a.png', /HTTP 500/],
  ];
  for (const [response, name, pattern] of cases) {
    const fixture = createImageFixture([response]);
    try {
      const result = await fixture.save(saveCommand(name));
      assert.equal(result.code, 2, name);
      assert.match(result.messages.join(''), pattern);
      assert.deepEqual(fs.readdirSync(fixture.io).sort(), ['prompt.md', 'schema.json']);
      assert.equal(fixture.outputs.length, 0);
    } finally {
      fixture.cleanup();
    }
  }
});

test('拒否: gh issue save-image は既存ファイル・シンボリックリンク・リンクの入出力フォルダ・入出力フォルダの無い入口に対して、通信せず何も書かない（issue #521）', async () => {
  const fixture = createImageFixture([{ status: 200, body: PNG_BYTES }]);
  try {
    const victim = path.join(fixture.root, 'victim.txt');
    fs.writeFileSync(victim, 'secret');
    fs.writeFileSync(path.join(fixture.io, 'exists.png'), 'old');
    fs.symlinkSync(victim, path.join(fixture.io, 'link.png'));
    fs.symlinkSync(path.join(fixture.root, 'missing-target'), path.join(fixture.io, 'dangling.png'));
    for (const name of ['exists.png', 'link.png', 'dangling.png']) {
      const result = await fixture.save(saveCommand(name));
      assert.equal(result.code, 2, name);
      assert.match(result.messages.join(''), /already exists/);
    }
    assert.equal(fs.readFileSync(path.join(fixture.io, 'exists.png'), 'utf8'), 'old');
    assert.equal(fs.readFileSync(victim, 'utf8'), 'secret');
    assert.equal(fs.existsSync(path.join(fixture.root, 'missing-target')), false);
    assert.equal(fixture.requests.length, 0);
  } finally {
    fixture.cleanup();
  }

  const linked = createImageFixture([{ status: 200, body: PNG_BYTES }]);
  try {
    const realIo = path.join(linked.root, 'real-io');
    fs.mkdirSync(realIo, { mode: 0o700 });
    fs.rmSync(linked.io, { recursive: true, force: true });
    fs.symlinkSync(realIo, linked.io);
    const result = await linked.save(saveCommand('a.png'));
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /symbolic link/);
    assert.deepEqual(fs.readdirSync(realIo), []);
    assert.equal(linked.requests.length, 0);
  } finally {
    linked.cleanup();
  }

  const noMember = createMemberFixture({ withMember: false });
  try {
    const requests = [];
    const stub = () => { requests.push(1); return Promise.resolve({ status: 200, body: PNG_BYTES }); };
    const result = noMember.runMember(saveCommand('a.png'), { requestAttachment: stub });
    assert.equal(await result.code, 2);
    assert.match(result.messages.join(''), /needs the member input\/output folder/);
    assert.equal(requests.length, 0);
  } finally {
    noMember.cleanup();
  }
});

test('拒否: 解析段階で拒否された gh issue save-image は通信も gh の起動もしない。許可 owner の明示先は使える（issue #521）', async () => {
  const fixture = createImageFixture([{ status: 200, body: PNG_BYTES }]);
  try {
    for (const command of [
      saveCommand('a.png', 'https://example.com/a.png'),
      saveCommand('../a.png'),
      saveCommand('a.svg'),
      ['gh', 'evil/other-repo', 'issue', 'save-image', ATTACHMENT_URL, '--out', 'a.png'],
    ]) {
      const result = await fixture.save(command);
      assert.equal(result.code, 2, JSON.stringify(command));
    }
    assert.equal(fixture.requests.length, 0);
    assert.equal(fixture.readCalls().length, 0);
    assert.deepEqual(fs.readdirSync(fixture.io).sort(), ['prompt.md', 'schema.json']);
    // 許可 owner の明示先は、入出力フォルダが対象リポジトリと無関係なので使える。
    const plain = path.join(fixture.root, 'plain');
    fs.mkdirSync(plain);
    const ok = await fixture.save(['gh', 'vektor-inc/other-repo', 'issue', 'save-image', ATTACHMENT_URL, '--out', 'a.png'], { cwd: plain });
    assert.equal(ok.code, 0, ok.messages.join(''));
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh issue save-image のトークンは gh auth token の妥当な値だけを使い、読めなければトークン無しで取得する（issue #521）', async () => {
  const fixture = createImageFixture([{ status: 200, body: PNG_BYTES }, { status: 200, body: PNG_BYTES }]);
  try {
    // gh auth token の呼び出しだけを差し替え、Git の検査などは実物に任せる。
    const real = (bin, args, options) => childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    const badToken = (bin, args, options) => (args[0] === 'auth' ? { status: 0, stdout: 'bad token with spaces\n' } : real(bin, args, options));
    const first = await fixture.save(saveCommand('a.png'), { spawnSync: badToken });
    assert.equal(first.code, 0, first.messages.join(''));
    assert.equal(fixture.requests[0].headers.Authorization, undefined);
    const errored = await fixture.save(saveCommand('b.png'), { spawnSync: (bin, args, options) => (args[0] === 'auth' ? { status: 1, stdout: '', error: new Error('x') } : real(bin, args, options)) });
    assert.equal(errored.code, 0, errored.messages.join(''));
    assert.equal(fixture.requests[1].headers.Authorization, undefined);
  } finally {
    fixture.cleanup();
  }
});

// requestAttachment の本体を、ローカルの HTTP サーバに向けた差し替えの https で確かめる（本物の通信はしない）。
function withAttachmentServer(handler, body) {
  const http = require('node:http');
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', async () => {
      const httpsStub = { request: (url, options, callback) => http.request({ host: '127.0.0.1', port: server.address().port, path: url.pathname + url.search, method: options.method, headers: options.headers }, callback) };
      try {
        await body(httpsStub);
        resolve();
      } catch (error) {
        reject(error);
      } finally {
        server.closeAllConnections();
        server.close();
      }
    });
  });
}

test('通信: requestAttachment はリダイレクトを自動で追わず、上限超過と時間切れを拒否し、ヘッダをそのまま送る（issue #521）', async () => {
  const seen = [];
  await withAttachmentServer((req, res) => {
    seen.push(req.headers);
    if (req.url === '/redirect') { res.writeHead(302, { Location: 'https://evil.example/x.png' }); res.end(); return; }
    if (req.url === '/big-declared') { res.writeHead(200, { 'Content-Length': '2000' }); res.end(Buffer.alloc(2000)); return; }
    if (req.url === '/big-chunked') { res.writeHead(200); res.write(Buffer.alloc(600)); res.end(Buffer.alloc(600)); return; }
    if (req.url === '/slow') { res.writeHead(200); res.write('x'); return; }
    if (req.url === '/missing') { res.writeHead(404); res.end('not found body'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    res.end(PNG_BYTES);
  }, async (httpsStub) => {
    const call = (urlPath) => requestAttachment(new URL(`https://github.com${urlPath}`), { headers: { 'User-Agent': 'vk-task-ops', Authorization: 'Bearer t' }, maxBytes: 1000, timeoutMs: 300 }, { https: httpsStub });
    const ok = await call('/ok.png');
    assert.equal(ok.status, 200);
    assert.deepEqual(ok.body, PNG_BYTES);
    assert.equal(seen[0].authorization, 'Bearer t');
    const redirect = await call('/redirect');
    assert.deepEqual({ status: redirect.status, location: redirect.location, body: redirect.body }, { status: 302, location: 'https://evil.example/x.png', body: undefined });
    assert.equal((await call('/missing')).status, 404);
    await assert.rejects(call('/big-declared'), /image is too large/);
    await assert.rejects(call('/big-chunked'), /image is too large/);
    await assert.rejects(call('/slow'), /timed out/);
  });
});

test('通信: requestAttachment は 200 以外の応答で本文が終わらなくても、状態と Location を返して接続を破棄する（issue #521）', async () => {
  const closed = { redirect: false, missing: false };
  await withAttachmentServer((req, res) => {
    const key = req.url === '/hang-redirect' ? 'redirect' : 'missing';
    res.on('close', () => { closed[key] = true; });
    if (key === 'redirect') res.writeHead(302, { Location: 'https://objects.githubusercontent.com/x' });
    else res.writeHead(404);
    // 本文を終わらせない。
    res.write('x');
  }, async (httpsStub) => {
    const call = (urlPath) => requestAttachment(new URL(`https://github.com${urlPath}`), { headers: {}, maxBytes: 1000, timeoutMs: 2000 }, { https: httpsStub });
    const redirect = await call('/hang-redirect');
    assert.deepEqual({ status: redirect.status, location: redirect.location }, { status: 302, location: 'https://objects.githubusercontent.com/x' });
    assert.equal((await call('/hang-missing')).status, 404);
    // サーバ側から見て接続が閉じられている（本文を読み捨て続けていない）。
    for (let i = 0; i < 50 && !(closed.redirect && closed.missing); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(closed, { redirect: true, missing: true });
  });
});

// 検査と作成の間に入出力フォルダを差し替える競合を、fs の差し込み口で再現する。method の最初の該当呼び出しの直前に swap を実行する。
function racingFs(method, matches, swap) {
  const racing = Object.create(fs);
  let done = false;
  racing[method] = (...args) => {
    if (!done && matches(args)) {
      done = true;
      swap();
    }
    return fs[method](...args);
  };
  return racing;
}

test('拒否: gh issue save-image は検査と作成の間に入出力フォルダがリンクや別のフォルダへ差し替えられても、外に残さず中身を書かない（issue #521）', async () => {
  const toLink = (fixture, outside) => () => { fs.renameSync(fixture.io, `${fixture.io}-moved`); fs.symlinkSync(outside, fixture.io); };
  const toNewDir = (fixture) => () => { fs.renameSync(fixture.io, `${fixture.io}-moved`); fs.mkdirSync(fixture.io, { mode: 0o700 }); };
  const scenarios = [
    { label: 'リンクへ差し替え（作成前）', build: (fixture, outside) => racingFs('openSync', (args) => String(args[0]) === path.join(fixture.io, 'race.png'), toLink(fixture, outside)) },
    { label: '別の実フォルダへ差し替え（作成前）', build: (fixture) => racingFs('openSync', (args) => String(args[0]) === path.join(fixture.io, 'race.png'), toNewDir(fixture)), newIoEmpty: true },
    { label: 'リンクへ差し替え（作成後・確認前）', build: (fixture, outside) => racingFs('fstatSync', () => true, toLink(fixture, outside)), movedHasFile: true },
  ];
  for (const scenario of scenarios) {
    const fixture = createImageFixture([{ status: 200, body: PNG_BYTES }]);
    try {
      const outside = path.join(fixture.root, 'outside');
      fs.mkdirSync(outside);
      const result = await fixture.save(saveCommand('race.png'), { fs: scenario.build(fixture, outside) });
      assert.equal(result.code, 2, scenario.label);
      assert.equal(fixture.outputs.length, 0, scenario.label);
      assert.deepEqual(fs.readdirSync(outside), [], scenario.label);
      if (scenario.newIoEmpty) assert.deepEqual(fs.readdirSync(fixture.io), [], scenario.label);
      // 差し替え前のフォルダに作られたファイルが残っていても、中身は書かれていない。
      const moved = path.join(`${fixture.io}-moved`, 'race.png');
      if (scenario.movedHasFile) assert.equal(fs.existsSync(moved), true, scenario.label);
      if (fs.existsSync(moved)) assert.equal(fs.statSync(moved).size, 0, scenario.label);
    } finally {
      fixture.cleanup();
    }
  }
});

test('実行: gh issue save-image は差し替えが無ければ検証つきの作成でも従来どおり保存できる（issue #521）', async () => {
  const fixture = createImageFixture([{ status: 200, body: PNG_BYTES }]);
  try {
    const result = await fixture.save(saveCommand('race.png'), { fs: Object.create(fs) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.deepEqual(fs.readFileSync(path.join(fixture.io, 'race.png')), PNG_BYTES);
  } finally {
    fixture.cleanup();
  }
});

// ─── issue の本文更新・close・ラベル削除（issue #522） ─────────────────────

test('許可: gh issue edit は --body-file（本文更新）と --remove-label（ラベル削除）を単独で受け、gh issue close は --reason の許可値だけを受ける', () => {
  const edit = (...args) => parseTaskCommand(['gh', 'issue', 'edit', ...args]);
  assert.deepEqual(edit('5', '--body-file', 'body.md'), { ok: true, bin: 'gh', operation: 'issue-edit-body', number: '5', textFiles: { body: 'body.md' }, needsGitHub: true });
  assert.deepEqual(edit('--body-file=body.md', '5').textFiles, { body: 'body.md' });
  assert.deepEqual(edit('5', '--remove-label', 'bug'), { ok: true, bin: 'gh', operation: 'issue-remove-label', number: '5', removeLabels: ['bug'], needsGitHub: true });
  assert.deepEqual(edit('5', '--remove-label', 'good first issue', '--remove-label=不具合').removeLabels, ['good first issue', '不具合']);

  const close = (...args) => parseTaskCommand(['gh', 'issue', 'close', ...args]);
  assert.deepEqual(close('5'), { ok: true, bin: 'gh', operation: 'issue-close', number: '5', reason: undefined, needsGitHub: true });
  assert.equal(close('5', '--reason', 'completed').reason, 'completed');
  assert.equal(close('--reason=completed', '5').reason, 'completed');
  assert.equal(close('5', '--reason', 'not planned').reason, 'not planned');
  assert.equal(close('5', '--reason', 'not_planned').reason, 'not planned');
});

test('拒否: gh issue edit の --body-file / --remove-label と gh issue close は、別リポジトリ指定・許可外のフラグ・値・併用をすべて拒否する', () => {
  const rejected = [
    // 別リポジトリ指定
    ['gh', 'vektor-inc/other', 'issue', 'edit', '5', '--body-file', 'body.md'],
    ['gh', 'vektor-inc/other', 'issue', 'edit', '5', '--remove-label', 'bug'],
    ['gh', 'vektor-inc/other', 'issue', 'close', '5'],
    ['gh', 'VEKTOR-INC/vk-terminals', 'issue', 'close', '5', '--reason', 'completed'],
    // --body-file のファイル名（パス区切り・..・絶対パス・制御文字・空・欠落・重複・--body との併用）
    ...['/etc/passwd', '../body.md', 'sub/body.md', '..', 'a..b.md', '.hidden', 'body.', '', 'a\u0000b', 'a\nb.md', 'a\u001bb.md', '-x', 'a b.md'].map((name) => ['gh', 'issue', 'edit', '5', '--body-file', name]),
    ['gh', 'issue', 'edit', '5', '--body-file'],
    ['gh', 'issue', 'edit', '5', '--body-file', 'a', '--body-file', 'b'],
    ['gh', 'issue', 'edit', '5', '--body-file', 'a', '--body', 'x'],
    ['gh', 'issue', 'edit', '5', '--body-file', 'a', '--title', 'x'],
    ['gh', 'issue', 'edit', '--body-file', 'a'],
    ['gh', 'issue', 'edit', '5', '--body-file', 'a', '--repo', 'o/r'],
    // 3 種類の併用（追加・本文・削除は 1 回の edit に混ぜない）
    ['gh', 'issue', 'edit', '5', '--body-file', 'a', '--add-label', 'bug'],
    ['gh', 'issue', 'edit', '5', '--body-file', 'a', '--add-assignee', 'kurudrive'],
    ['gh', 'issue', 'edit', '5', '--body-file', 'a', '--remove-label', 'bug'],
    ['gh', 'issue', 'edit', '5', '--remove-label', 'bug', '--add-label', 'bug2'],
    ['gh', 'issue', 'edit', '5', '--remove-label', 'bug', '--add-assignee', 'kurudrive'],
    // --remove-label の値
    ...['', ' x', 'a,b', '"bug"', '-bug', 'a\nb', 'a\u0007b', 'a'.repeat(51)].map((label) => ['gh', 'issue', 'edit', '5', '--remove-label', label]),
    ['gh', 'issue', 'edit', '5', '--remove-label'],
    ['gh', 'issue', 'edit', '5', '--remove-label', 'bug', '--remove-assignee', 'kurudrive'],
    ['gh', 'issue', 'edit', '5', '--remove-label', 'bug', '--repo', 'o/r'],
    ['gh', 'issue', 'edit', '5', '--remove-label', 'bug', '--milestone', 'm'],
    // gh issue close
    ['gh', 'issue', 'close'],
    ['gh', 'issue', 'close', 'abc'],
    ['gh', 'issue', 'close', '5', '7'],
    ['gh', 'issue', 'close', 'https://github.com/o/r/issues/5'],
    ['gh', 'issue', 'close', '5', '--comment', 'bye'],
    ['gh', 'issue', 'close', '5', '-c', 'bye'],
    ['gh', 'issue', 'close', '5', '--duplicate-of', '3'],
    ['gh', 'issue', 'close', '5', '--reason', 'duplicate'],
    ['gh', 'issue', 'close', '5', '--reason', 'Completed'],
    ['gh', 'issue', 'close', '5', '--reason', ''],
    ['gh', 'issue', 'close', '5', '--reason', '__proto__'],
    ['gh', 'issue', 'close', '5', '--reason', 'constructor'],
    ['gh', 'issue', 'close', '5', '--reason', 'completed\n'],
    ['gh', 'issue', 'close', '5', '--reason'],
    ['gh', 'issue', 'close', '5', '--reason', 'completed', '--reason', 'completed'],
    ['gh', 'issue', 'close', '5', '--repo', 'o/r'],
    ['gh', 'issue', 'close', '5', '-R', 'o/r'],
    ['gh', 'issue', 'close', '5', '--unknown'],
  ];
  for (const command of rejected) {
    const result = parseTaskCommand(command);
    assert.equal(result.ok, false, JSON.stringify(command));
    assert.match(result.error, /^task command rejected/);
  }
});

// gh issue edit / close / view だけを差し替える spawnSync。applied は更新後に gh issue view が返す内容（省略時は依頼どおり反映された gh）。
function issueUpdateHarness(fixture, { applied, editStatus = 0, closeStatus = 0, viewStatus = 0, viewStdout } = {}) {
  const calls = [];
  let last = {};
  const spawnSync = (bin, args, options) => {
    if (bin !== fixture.env.VK_TASK_GH) return childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    calls.push(args);
    if (args[0] === 'issue' && args[1] === 'edit') {
      last = { body: args.includes('--body') ? args[args.indexOf('--body') + 1] : undefined, labels: [] };
      return { status: editStatus, stdout: '', stderr: editStatus === 0 ? '' : 'edit failed\n' };
    }
    if (args[0] === 'issue' && args[1] === 'close') {
      const reason = args.includes('--reason') ? args[args.indexOf('--reason') + 1] : undefined;
      last = { state: 'CLOSED', stateReason: reason === 'not planned' ? 'NOT_PLANNED' : 'COMPLETED' };
      return { status: closeStatus, stdout: '', stderr: closeStatus === 0 ? '' : 'close failed\n' };
    }
    if (args[0] === 'issue' && args[1] === 'view') return { status: viewStatus, stdout: viewStdout !== undefined ? viewStdout : JSON.stringify(applied || last), stderr: viewStatus === 0 ? '' : 'view failed\n' };
    return { status: 1, stdout: '', stderr: 'unexpected\n' };
  };
  return { calls, spawnSync };
}

test('実行: gh issue edit --body-file はファイルの内容を argv の値として渡し、拘束した --repo だけで更新して、読み戻しが一致したときだけ成功する', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'body.md', PR_BODY);
    const stdout = [];
    const { calls, spawnSync } = issueUpdateHarness(fixture);
    const result = fixture.runMember(['gh', 'issue', 'edit', '7', '--body-file', 'body.md'], { spawnSync, writeOut: (m) => stdout.push(m) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.deepEqual(calls, [
      ['issue', 'edit', '7', '--body', PR_BODY, '--repo', 'vektor-inc/vk-terminals'],
      ['issue', 'view', '7', '--json', 'body', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    assert.match(stdout.join(''), /updated issue #7: body/);

    // CRLF → LF と末尾の空白の正規化だけは一致とみなす。
    writeIo(fixture, 'body.md', 'new body\n');
    const normalized = issueUpdateHarness(fixture, { applied: { body: 'new body\r\n\r\n' } });
    assert.equal(fixture.runMember(['gh', 'issue', 'edit', '7', '--body-file', 'body.md'], { spawnSync: normalized.spawnSync, writeOut: () => {} }).code, 0);
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh issue edit --body-file は更新・読み戻しの失敗や、読み戻した本文が指定と違うとき（権限不足で何も反映されないとき）に成功を返さない', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'body.md', 'new body\n');
    const command = ['gh', 'issue', 'edit', '7', '--body-file', 'body.md'];
    const cases = [
      { label: '更新失敗', options: { editStatus: 1 }, calls: 1, message: /gh issue edit failed/ },
      { label: '読み戻し失敗', options: { viewStatus: 1 }, calls: 2, message: /could not verify/ },
      { label: '読み戻しが不正な JSON', options: { viewStdout: 'not json' }, calls: 2, message: /could not verify/ },
      { label: '何も反映されていない（旧値のまま）', options: { applied: { body: 'old' } }, calls: 2, message: /body of issue #7 does not match/ },
      { label: '読み戻しに本文が無い', options: { applied: {} }, calls: 2, message: /body of issue #7 does not match/ },
      { label: '読み戻しが null', options: { viewStdout: 'null' }, calls: 2, message: /does not match/ },
    ];
    for (const { label, options, calls: expectedCalls, message } of cases) {
      const { calls, spawnSync } = issueUpdateHarness(fixture, options);
      const stdout = [];
      const result = fixture.runMember(command, { spawnSync, writeOut: (m) => stdout.push(m) });
      assert.notEqual(result.code, 0, label);
      assert.match(result.messages.join(''), message, label);
      assert.equal(calls.length, expectedCalls, label);
      assert.equal(stdout.join(''), '', label);
    }
  } finally {
    fixture.cleanup();
  }
});

test('拒否: gh issue edit --body-file は不正な内容・ファイル・リンク・入出力フォルダ無しのとき、gh を一度も起動しない', () => {
  const fixture = createMemberFixture();
  try {
    const contents = [
      { label: 'ファイル無し', missing: true, message: /does not exist/ },
      { label: '空', content: '', message: /empty or too large/ },
      { label: '空白だけ', content: ' \n\t\n', message: /blank/ },
      { label: 'NUL', content: 'a\u0000b', message: /control characters/ },
      { label: 'ESC', content: 'a\u001b[31mb', message: /control characters/ },
      { label: '不正な UTF-8', content: Buffer.from([0xc3, 0x28]), message: /not valid UTF-8/ },
      { label: '256 KiB 超', content: Buffer.alloc(256 * 1024 + 1, 'a'), message: /empty or too large/ },
      { label: '65536 文字超', content: 'a'.repeat(65537), message: /longer than 65536/ },
      { label: 'シンボリックリンク', link: true, message: /not a plain file/ },
      { label: 'ディレクトリ', dir: true, message: /not a plain file/ },
    ];
    for (const { label, content = 'x', missing, link, dir, message } of contents) {
      for (const n of ['body.md', 'real.txt']) fs.rmSync(path.join(fixture.io, n), { recursive: true, force: true });
      if (link) {
        writeIo(fixture, 'real.txt', 'x');
        fs.symlinkSync(path.join(fixture.io, 'real.txt'), path.join(fixture.io, 'body.md'));
      } else if (dir) fs.mkdirSync(path.join(fixture.io, 'body.md'));
      else if (!missing) writeIo(fixture, 'body.md', content);
      const result = fixture.runMember(['gh', 'issue', 'edit', '5', '--body-file', 'body.md']);
      assert.equal(result.code, 2, label);
      assert.match(result.messages.join(''), message, label);
    }
    for (const name of ['/etc/passwd', '../body.md', 'sub/body.md']) {
      assert.equal(fixture.runMember(['gh', 'issue', 'edit', '5', '--body-file', name]).code, 2, name);
    }
    assert.equal(fixture.readCalls().length, 0, 'gh が起動された');
  } finally {
    fixture.cleanup();
  }

  const noMember = createMemberFixture({ withMember: false });
  try {
    const result = noMember.runMember(['gh', 'issue', 'edit', '5', '--body-file', 'body.md']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /need the member input\/output folder/);
    assert.equal(noMember.readCalls().length, 0);
  } finally {
    noMember.cleanup();
  }
});

test('実行: gh issue edit --remove-label は拘束した --repo だけで外し、読み戻しで全ラベルが外れたときだけ成功する', () => {
  const fixture = createFixture();
  try {
    const stdout = [];
    const { calls, spawnSync } = issueUpdateHarness(fixture, { applied: { labels: [{ name: 'keep' }] } });
    const result = run(fixture, ['gh', 'issue', 'edit', '5', '--remove-label', 'bug', '--remove-label', 'good first issue'], { spawnSync, writeOut: (m) => stdout.push(m) });
    assert.equal(result.code, 0, result.messages.join(''));
    assert.deepEqual(calls, [
      ['issue', 'edit', '5', '--remove-label', 'bug', '--remove-label', 'good first issue', '--repo', 'vektor-inc/vk-terminals'],
      ['issue', 'view', '5', '--json', 'labels', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    assert.match(stdout.join(''), /updated issue #5: removed labels/);

    const cases = [
      { label: '更新失敗', options: { editStatus: 1 }, calls: 1, message: /gh issue edit failed/ },
      { label: '読み戻し失敗', options: { viewStatus: 1 }, calls: 2, message: /could not verify/ },
      { label: '読み戻しが不正な JSON', options: { viewStdout: 'not json' }, calls: 2, message: /could not verify/ },
      { label: 'labels が無い', options: { viewStdout: '{}' }, calls: 2, message: /could not verify/ },
      { label: '権限不足で外れていない', options: { applied: { labels: [{ name: 'bug' }, { name: 'keep' }] } }, calls: 2, message: /"bug" is still on issue #5/ },
      { label: '片方だけ外れた', options: { applied: { labels: [{ name: 'good first issue' }] } }, calls: 2, message: /"good first issue" is still on issue #5/ },
    ];
    for (const { label, options, calls: expectedCalls, message } of cases) {
      const harness = issueUpdateHarness(fixture, options);
      const out = [];
      const failedRun = run(fixture, ['gh', 'issue', 'edit', '5', '--remove-label', 'bug', '--remove-label', 'good first issue'], { spawnSync: harness.spawnSync, writeOut: (m) => out.push(m) });
      assert.notEqual(failedRun.code, 0, label);
      assert.match(failedRun.messages.join(''), message, label);
      assert.equal(harness.calls.length, expectedCalls, label);
      assert.equal(out.join(''), '', label);
    }
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh issue close は拘束した --repo だけで close し、読み戻しで CLOSED（--reason 指定時は理由の一致も）を確認できたときだけ成功する', () => {
  const fixture = createFixture();
  try {
    const stdout = [];
    const plain = issueUpdateHarness(fixture);
    assert.equal(run(fixture, ['gh', 'issue', 'close', '5'], { spawnSync: plain.spawnSync, writeOut: (m) => stdout.push(m) }).code, 0);
    assert.deepEqual(plain.calls, [
      ['issue', 'close', '5', '--repo', 'vektor-inc/vk-terminals'],
      ['issue', 'view', '5', '--json', 'state,stateReason', '--repo', 'vektor-inc/vk-terminals'],
    ]);
    assert.match(stdout.join(''), /closed issue #5/);

    for (const [given, passed] of [['completed', 'completed'], ['not planned', 'not planned'], ['not_planned', 'not planned']]) {
      const harness = issueUpdateHarness(fixture);
      assert.equal(run(fixture, ['gh', 'issue', 'close', '5', '--reason', given], { spawnSync: harness.spawnSync, writeOut: () => {} }).code, 0, given);
      assert.deepEqual(harness.calls[0], ['issue', 'close', '5', '--reason', passed, '--repo', 'vektor-inc/vk-terminals']);
    }

    const cases = [
      { label: 'close 失敗', command: ['5'], options: { closeStatus: 1 }, calls: 1, message: /gh issue close failed/ },
      { label: '読み戻し失敗', command: ['5'], options: { viewStatus: 1 }, calls: 2, message: /could not verify/ },
      { label: '読み戻しが不正な JSON', command: ['5'], options: { viewStdout: 'not json' }, calls: 2, message: /could not verify/ },
      { label: 'まだ OPEN（権限不足で何も起きていない）', command: ['5'], options: { applied: { state: 'OPEN', stateReason: '' } }, calls: 2, message: /issue #5 is not closed/ },
      { label: '読み戻しが null', command: ['5'], options: { viewStdout: 'null' }, calls: 2, message: /is not closed/ },
      { label: '理由が食い違う', command: ['5', '--reason', 'completed'], options: { applied: { state: 'CLOSED', stateReason: 'NOT_PLANNED' } }, calls: 2, message: /close reason of issue #5 does not match/ },
    ];
    for (const { label, command, options, calls: expectedCalls, message } of cases) {
      const harness = issueUpdateHarness(fixture, options);
      const out = [];
      const failedRun = run(fixture, ['gh', 'issue', 'close', ...command], { spawnSync: harness.spawnSync, writeOut: (m) => out.push(m) });
      assert.notEqual(failedRun.code, 0, label);
      assert.match(failedRun.messages.join(''), message, label);
      assert.equal(harness.calls.length, expectedCalls, label);
      assert.equal(out.join(''), '', label);
    }
  } finally {
    fixture.cleanup();
  }
});

test('実行: 拒否された gh issue close / edit（本文・ラベル削除）は gh を一度も呼ばない', () => {
  const fixture = createMemberFixture();
  try {
    writeIo(fixture, 'body.md', 'ok\n');
    for (const command of [
      ['gh', 'vektor-inc/other-repo', 'issue', 'close', '5'],
      ['gh', 'issue', 'close', '5', '--comment', 'x'],
      ['gh', 'issue', 'close', '5', '--reason', 'duplicate'],
      ['gh', 'vektor-inc/other-repo', 'issue', 'edit', '5', '--body-file', 'body.md'],
      ['gh', 'vektor-inc/other-repo', 'issue', 'edit', '5', '--remove-label', 'bug'],
      ['gh', 'issue', 'edit', '5', '--body-file', 'body.md', '--remove-label', 'bug'],
      ['gh', 'issue', 'edit', '5', '--remove-label', 'a,b'],
    ]) {
      const { calls, spawnSync } = issueUpdateHarness(fixture);
      assert.equal(fixture.runMember(command, { spawnSync }).code, 2, JSON.stringify(command));
      assert.equal(calls.length, 0, JSON.stringify(command));
    }
    assert.equal(fixture.readCalls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

test('拒否: ラベル名の C1 制御文字（U+0080〜U+009F）は --remove-label / --add-label / issue create --label の通常指定と = 付き指定の両方で拒否し、gh を呼ばない', () => {
  const fixture = createFixture();
  try {
    for (const code of [0x80, 0x85, 0x9b, 0x9f]) {
      const label = `bug${String.fromCharCode(code)}`;
      const commands = [
        ['gh', 'issue', 'edit', '5', '--remove-label', label],
        ['gh', 'issue', 'edit', '5', '--remove-label', `bug`, '--remove-label', label],
        ['gh', 'issue', 'edit', '5', `--remove-label=${label}`],
        ['gh', 'issue', 'edit', '5', '--add-label', label],
        ['gh', 'issue', 'edit', '5', `--add-label=${label}`],
        ['gh', 'issue', 'create', '--title', 't', '--body', 'b', '--label', label],
        ['gh', 'issue', 'create', '--title', 't', '--body', 'b', `--label=${label}`],
      ];
      for (const command of commands) {
        const parsed = parseTaskCommand(command);
        assert.equal(parsed.ok, false, JSON.stringify(command));
        assert.match(parsed.error, /^task command rejected/);
        const { calls, spawnSync } = issueUpdateHarness(fixture);
        assert.equal(run(fixture, command, { spawnSync }).code, 2, JSON.stringify(command));
        assert.equal(calls.length, 0, JSON.stringify(command));
      }
    }
    // 日本語など通常の非 ASCII のラベル名は従来どおり通る。
    assert.equal(parseTaskCommand(['gh', 'issue', 'edit', '5', '--remove-label', '不具合']).ok, true);
    assert.equal(parseTaskCommand(['gh', 'issue', 'edit', '5', '--add-label=機能追加']).ok, true);
    assert.equal(parseTaskCommand(['gh', 'issue', 'create', '--title', 't', '--body', 'b', '--label', '機能追加']).ok, true);
    assert.equal(fixture.readCalls().length, 0);
  } finally {
    fixture.cleanup();
  }
});

// ─── detached HEAD の復帰（issue #544） ──────────────────────────────────
const REATTACH_ARGS = ['prepare', 'reattach-branch', '544', 'feature/544-reattach', 'codex-544'];
function createReattachWorktree(fixture) {
  const dir = createLaunchWorktree(fixture, 'codex-544');
  git(dir, 'branch', 'feature/544-reattach');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
  git(dir, 'add', 'a.txt');
  fs.appendFileSync(path.join(dir, 'a.txt'), 'unstaged\n');
  fs.writeFileSync(path.join(dir, 'untracked.txt'), 'untracked\n');
  return dir;
}
function reattachSnapshot(dir) {
  const admin = git(dir, 'rev-parse', '--absolute-git-dir');
  return { ...adoptSnapshot(dir), index: fs.readFileSync(path.join(admin, 'index')).toString('hex'),
    tracked: fs.readFileSync(path.join(dir, 'a.txt'), 'hex'), untracked: fs.readFileSync(path.join(dir, 'untracked.txt'), 'hex') };
}

test('引数: reattach-branch は base 無しの3引数だけ、issue・保護ブランチ・名前を検証する', () => {
  assert.equal(parseTaskCommand(REATTACH_ARGS).operation, 'prepare-reattach-branch');
  for (const args of [[], ['544'], ['544', 'feature/544-x'], ['544', 'feature/544-x', 'codex-544', 'extra'], ['544', 'feature/545-x', 'codex-544'], ['544', 'main', 'codex-544'], ['544', 'master', 'codex-544'], ['544', 'HEAD', 'codex-544'], ['544', 'feature/544-x', '../bad'], ['0', 'feature/0-x', 'codex-544']]) {
    assert.equal(parseTaskCommand(['prepare', 'reattach-branch', ...args]).ok, false, args.join(' '));
  }
});

test('回帰: reattach-branch はステージ済み・未ステージ・未追跡を保持し固定入口の add → commit → push へ進める', () => {
  const fixture = createFixture();
  try {
    const remote = attachRemote(fixture);
    const dir = createReattachWorktree(fixture);
    const before = reattachSnapshot(dir);
    const calls = [];
    const result = run(fixture, REATTACH_ARGS, { cwd: dir, spawnSync: recordingSpawn(calls), writeOut: () => {} });
    assert.equal(result.code, 0, result.messages.join(''));
    const after = reattachSnapshot(dir);
    assert.deepEqual({ ...after, ref: before.ref }, before);
    assert.equal(after.ref, 'refs/heads/feature/544-reattach');
    assert.equal(calls.some((call) => call.args.includes('fetch') || call.args.includes('checkout') || call.args.includes('switch')), false);
    const write = calls.find((call) => call.bin === '/usr/bin/sandbox-exec');
    assert.ok(write);
    assert.deepEqual(write.args.filter((arg) => arg.startsWith('ALLOW')), [`ALLOW0=${git(dir, 'rev-parse', '--absolute-git-dir')}`]);
    for (const args of [['git', 'add', '-A'], ['git', 'commit', '-m', 'preserved changes'], ['git', 'push', 'feature/544-reattach']]) {
      const result = run(fixture, args, { cwd: dir });
      assert.equal(result.code, 0, result.messages.join(''));
    }
    assert.equal(remote.remoteRef('refs/heads/feature/544-reattach'), git(dir, 'rev-parse', 'HEAD'));
  } finally { fixture.cleanup(); }
});

test('拒否: reattach-branch は条件不成立でも HEAD・ref・index・作業ファイルを変更しない', () => {
  const cases = [
    ['different-commit', /commit does not match/, (f, d) => { commitFile(f.repo, 'other.txt'); git(d, 'branch', '-f', 'feature/544-reattach', git(f.repo, 'rev-parse', 'HEAD')); }],
    ['used', /already used/, (f, d) => git(f.repo, 'worktree', 'add', '-q', path.join(f.root, 'other-worktree'), 'feature/544-reattach')],
    ['missing', /does not exist/, (f, d) => git(d, 'branch', '-D', 'feature/544-reattach')],
    ['another-branch', /HEAD is not detached/, (f, d) => git(d, 'symbolic-ref', 'HEAD', 'refs/heads/work/test')],
    ['same-branch', /HEAD is not detached/, (f, d) => git(d, 'symbolic-ref', 'HEAD', 'refs/heads/feature/544-reattach')],
    ...['MERGE_HEAD', 'rebase-merge', 'rebase-apply', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'sequencer'].map((name) => [name, new RegExp(name), (f, d) => {
      const target = path.join(git(d, 'rev-parse', '--absolute-git-dir'), name);
      if (name.startsWith('rebase') || name === 'sequencer') fs.mkdirSync(target);
      else fs.writeFileSync(target, `${git(d, 'rev-parse', 'HEAD')}\n`);
    }]),
    ['subfolder', /must run at the root/, (f, d) => { fs.mkdirSync(path.join(d, 'sub')); return path.join(d, 'sub'); }],
    ['symlink', /does not match/, (f, d) => { const alias = path.join(f.repo, '.codex', 'worktrees', 'alias'); fs.symlinkSync(d, alias); return alias; }],
    ['clone', /not a linked worktree/, (f) => f.repo],
  ];
  for (const [name, message, setup] of cases) {
    const fixture = createFixture();
    try {
      const dir = createReattachWorktree(fixture);
      const location = setup(fixture, dir);
      const cwd = typeof location === 'string' && path.isAbsolute(location) ? location : dir;
      const before = reattachSnapshot(dir);
      const result = run(fixture, REATTACH_ARGS, { cwd, writeOut: () => {} });
      assert.equal(result.code, 2, name);
      assert.match(result.messages.join(''), message, name);
      assert.deepEqual(reattachSnapshot(dir), before, name);
    } finally { fixture.cleanup(); }
  }
});

// 実際の監督プロセスを起動し、exit 公開の時点で復帰も完了していることを確認する。
test('member: 起動位置の前後を記録し元のブランチへ一度だけ自動復帰、失敗・readonly・detached は復帰しない', async () => {
  for (const mode of ['restore', 'large', 'contents', 'readonly', 'parent-readonly', 'initial-detached', 'mismatch', 'merge', 'missing', 'used', 'attached', 'unreadable']) {
    const fixture = createMemberFixture({ parentSandbox: mode === 'parent-readonly' ? 'read-only' : 'workspace-write' });
    try {
      const dir = createReattachWorktree(fixture);
      if (mode !== 'initial-detached') git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/feature/544-reattach');
      // 親・子・記録と復帰の作業フォルダをそろえる。
      fixture.env.VK_TASK_PARENT_CWD = fs.realpathSync(dir);
      const actions = [
        "process.env.GIT_DIR='/nonexistent-child-git';process.env.GIT_WORK_TREE='/nonexistent-child-worktree';",
        "const fs=require('fs'), cp=require('child_process');",
        `const dir=${JSON.stringify(dir)}, git=${JSON.stringify(GIT_PATH)};`,
        "const run=(...args)=>cp.execFileSync(git,['-C',dir,...args],{env:{PATH:process.env.PATH}});",
        "run('checkout','--detach','-q');",
      ];
      if (mode === 'large') actions.push("fs.writeFileSync(dir+'/a.txt',Buffer.alloc(2*1024*1024,97));");
      if (mode === 'contents') actions.push("fs.writeFileSync(dir+'/untracked.txt','different\\n');");
      if (mode === 'mismatch') actions.push("run('update-ref','refs/heads/feature/544-reattach',run('commit-tree','HEAD^{tree}','-p','HEAD','-m','different').toString().trim());");
      if (mode === 'merge') actions.push("fs.writeFileSync(run('rev-parse','--absolute-git-dir').toString().trim()+'/MERGE_HEAD',run('rev-parse','HEAD'));");
      if (mode === 'missing') actions.push("run('branch','-D','feature/544-reattach');");
      if (mode === 'used') actions.push(`run('worktree','add','-q',${JSON.stringify(path.join(fixture.root, 'used'))},'feature/544-reattach');`);
      if (mode === 'attached') actions.push("run('symbolic-ref','HEAD','refs/heads/feature/544-reattach');");
      if (mode === 'unreadable') actions.push("fs.renameSync(dir+'/.git',dir+'/.git-hidden');");
      actions.push("const i=process.argv.indexOf('-o');fs.writeFileSync(process.argv[i+1],'{}');");
      fs.writeFileSync(fixture.codexPath, `#!${process.execPath}\n${actions.join('\n')}\n`, { mode: 0o755 });
      const id = 'bbbbbbbbbbbbbbbbbbbbbbbb';
      const before = reattachSnapshot(dir);
      const start = run(fixture, [...MEMBER_START, ...(mode === 'readonly' ? ['--readonly'] : [])], { cwd: dir, writeOut: () => {}, randomId: () => id });
      assert.equal(start.code, 0, `${mode}: ${start.messages.join('')}`);
      for (let i = 0; i < 150 && !fs.existsSync(path.join(fixture.runs, id, 'exit')); i++) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.ok(fs.existsSync(path.join(fixture.runs, id, 'exit')), mode);
      const out = [];
      assert.equal(run(fixture, ['member', 'status', id], { writeOut: (text) => out.push(text) }).code, 0);
      const status = out.join('');
      assert.match(status, /^EXIT_CODE=0$/m, mode);
      assert.match(status, /^WORKTREE_BEFORE_STATE=recorded$/m);
      assert.match(status, /^WORKTREE_BEFORE_DIRTY=true$/m);
      assert.equal(status.includes('untracked.txt'), false);
      assert.match(status, new RegExp(`^BRANCH_RESTORE=${['restore', 'large', 'contents'].includes(mode) ? 'restored' : 'not-restored'}$`, 'm'), mode);
      if (['large', 'contents'].includes(mode)) {
        assert.match(status, /^WORKTREE_CHANGED=true$/m);
        assert.equal(git(dir, 'symbolic-ref', 'HEAD'), 'refs/heads/feature/544-reattach');
      } else if (mode === 'restore') {
        assert.deepEqual(reattachSnapshot(dir), before);
        assert.match(status, /^WORKTREE_CHANGED=false$/m);
        assert.match(status, /^WORKTREE_AFTER_CHILD_BRANCH=detached$/m);
        // 再照会は再実行しない。
        git(dir, 'checkout', '--detach', '-q');
        run(fixture, ['member', 'status', id], { writeOut: () => {} });
        assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD'), 'HEAD');
      } else {
        assert.match(status, /^BRANCH_RESTORE_REASON=.+$/m);
        if (mode !== 'unreadable') {
          const after = reattachSnapshot(dir);
          assert.equal(after.index, before.index, mode);
          assert.equal(after.tracked, before.tracked, mode);
          assert.equal(after.untracked, before.untracked, mode);
        }
      }
    } finally { fixture.cleanup(); }
  }
});

test('member: 起動前の作業状態が読めなくても起動し、status は記録不可を表示する', () => {
  const fixture = createMemberFixture();
  try {
    const result = fixture.runMember(MEMBER_START, { spawnSync: (bin, args, options) => {
      // 入口の拘束確認は通す。記録専用のロック無し読み取りだけを失敗させる。
      if (args.includes('--no-optional-locks')) return { status: 128, stdout: '', stderr: 'unreadable' };
      return childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    } });
    assert.equal(result.code, 0, result.messages.join(''));
    const payload = JSON.parse(fixture.calls[0].options.env.VK_TASK_MEMBER_SUPERVISE);
    assert.deepEqual(payload.recovery.before, { state: 'unavailable' });
    const output = [];
    assert.equal(fixture.runMember(['member', 'status', 'aaaaaaaaaaaaaaaaaaaaaaaa'], { writeOut: (text) => output.push(text) }).code, 0);
    assert.match(output.join(''), /^WORKTREE_BEFORE_STATE=unavailable$/m);
  } finally { fixture.cleanup(); }
});

test('拒否: reattach-branch は worktree 使用情報を読めないときも変更せず閉じる', () => {
  const fixture = createFixture();
  try {
    const dir = createReattachWorktree(fixture);
    const before = reattachSnapshot(dir);
    const result = run(fixture, REATTACH_ARGS, { cwd: dir, spawnSync: (bin, args, options) => {
      if (args.includes('list') && args.includes('worktree')) return { status: 1, stdout: '', stderr: 'unreadable' };
      return childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' });
    } });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /worktree branch usage could not be read/);
    assert.deepEqual(reattachSnapshot(dir), before);
  } finally { fixture.cleanup(); }
});


function recordedFixture(fixture, dir) {
  return { binding: readBinding(fixture.env), identity: { root: fs.realpathSync(dir), adminDir: git(dir, 'rev-parse', '--absolute-git-dir'), commonDir: git(dir, 'rev-parse', '--path-format=absolute', '--git-common-dir') } };
}

test('記録: 状態取得の引数と管理情報を固定し、内容とファイル種別を集計する', () => {
  const fixture = createFixture();
  try {
    const dir = createReattachWorktree(fixture);
    const { binding, identity } = recordedFixture(fixture, dir);
    const calls = [];
    const spawn = (bin, args, options) => {
      calls.push(args);
      assert.ok(options.timeout > 0);
      return childProcess.spawnSync(bin, args, options);
    };
    const capture = () => captureMemberWorktree(binding, dir, spawn, identity);
    const before = capture();
    assert.equal(before.state, 'recorded');
    assert.equal(calls.some((args) => args.includes('diff')), false);
    const status = calls.find((args) => args.includes('status'));
    for (const value of ['--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=all', '--no-optional-locks', `--git-dir=${identity.adminDir}`, `--work-tree=${identity.root}`]) assert.ok(status.includes(value));
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'different\n');
    assert.notEqual(capture().changes, before.changes);
    fs.writeFileSync(path.join(dir, 'large.txt'), Buffer.alloc(2 * 1024 * 1024, 97));
    assert.equal(capture().state, 'recorded');
    fs.writeFileSync(path.join(dir, 'large.txt'), Buffer.alloc(17 * 1024 * 1024, 97));
    assert.match(capture().changes, /^limited:/);
    fs.unlinkSync(path.join(dir, 'large.txt'));
    const target = path.join(fixture.root, 'outside.txt');
    fs.writeFileSync(target, 'first');
    fs.symlinkSync(target, path.join(dir, 'link'));
    childProcess.execFileSync('/usr/bin/mkfifo', [path.join(dir, 'pipe')]);
    const types = capture();
    assert.equal(types.state, 'recorded');
    fs.writeFileSync(target, 'second value');
    assert.equal(capture().changes, types.changes);
    fs.unlinkSync(path.join(dir, 'link'));
    fs.symlinkSync(target.replace('outside.txt', 'another.txt'), path.join(dir, 'link'));
    assert.notEqual(capture().changes, types.changes);
    fs.writeFileSync(path.join(dir, '.git'), `gitdir: ${path.join(fixture.repo, '.git')}\n`);
    const count = calls.length;
    assert.equal(capture().state, 'unavailable');
    assert.equal(calls.length, count);
  } finally { fixture.cleanup(); }
});

test('復帰: 別 worktree の進行中ブランチを確認する', () => {
  for (const mode of ['rebase', 'bisect']) {
    const fixture = createFixture();
    try {
      const dir = createReattachWorktree(fixture);
      const other = path.join(fixture.root, 'other');
      git(fixture.repo, 'worktree', 'add', '-q', other, 'feature/544-reattach');
      if (mode === 'rebase') {
        git(other, 'checkout', '-q', '-b', 'side');
        commitFile(other, 'side.txt');
        git(other, 'checkout', '-q', 'feature/544-reattach');
        commitFile(other, 'branch.txt');
        assert.throws(() => git(other, '-c', 'sequence.editor=true', 'rebase', '-i', '--exec', 'false', 'side'));
      } else {
        commitFile(other, 'next.txt');
        git(other, 'bisect', 'start');
        git(other, 'bisect', 'bad');
        git(other, 'bisect', 'good', 'HEAD~1');
      }
      git(dir, 'reset', '--soft', 'feature/544-reattach');
      const result = run(fixture, REATTACH_ARGS, { cwd: dir });
      assert.equal(result.code, 2, mode);
      assert.match(result.messages.join(''), /already used/, mode);
    } finally { fixture.cleanup(); }
  }
});


test('完了: 記録の時間切れでも結果と終了状態を公開する', async () => {
  const fixture = createMemberFixture();
  try {
    const dir = createReattachWorktree(fixture);
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/feature/544-reattach');
    const { binding, identity } = recordedFixture(fixture, dir);
    const before = captureMemberWorktree(binding, dir, childProcess.spawnSync, identity);
    const id = 'cccccccccccccccccccccccc';
    const runDir = path.join(fixture.runs, id);
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'test');
    fs.writeFileSync(path.join(runDir, 'result.txt'), '{}');
    const out = path.join(fixture.io, 'timeout.json');
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ pid: process.pid, out, readonly: false }));
    const code = await superviseMemberRun({ codex: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir, env: {}, runDir,
      recovery: { binding, cwd: dir, identity, before, readonly: false } }, {
      outFd: fs.openSync(out, 'w'),
      spawnSync: (bin, args, options) => {
        assert.ok(options.timeout > 0 && options.timeout <= 1500);
        assert.ok(options.maxBuffer >= 1024 * 1024);
        assert.equal(fs.readFileSync(out, 'utf8'), '{}');
        return { status: null, error: { code: 'ETIMEDOUT' } };
      },
    });
    assert.equal(code, 0);
    const output = [];
    assert.equal(run(fixture, ['member', 'status', id], { writeOut: (text) => output.push(text) }).code, 0);
    assert.match(output.join(''), /^STATE=exited$/m);
    assert.match(output.join(''), /^RESULT_STATE=published$/m);
    assert.match(output.join(''), /^BRANCH_RESTORE_REASON=automatic-restore-failed: timeout$/m);
  } finally { fixture.cleanup(); }
});


test('記録: 共有設定の検査結果に従い状態取得を終了する', () => {
  const fixture = createFixture();
  try {
    const dir = createReattachWorktree(fixture);
    const { binding, identity } = recordedFixture(fixture, dir);
    git(fixture.repo, 'config', 'core.editor', 'false');
    const calls = [];
    const result = captureMemberWorktree(binding, dir, (bin, args, options) => {
      calls.push(args);
      return childProcess.spawnSync(bin, args, options);
    }, identity);
    assert.deepEqual(result, { state: 'unavailable' });
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes(`--git-dir=${identity.adminDir}`));
    assert.ok(calls[0].includes('config'));
    assert.equal(calls.some((args) => args.includes('status')), false);
  } finally { fixture.cleanup(); }
});

test('完了: 復帰後の記録が時間切れでも復帰理由を保持する', async () => {
  const fixture = createMemberFixture();
  try {
    const dir = createReattachWorktree(fixture);
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/feature/544-reattach');
    const { binding, identity } = recordedFixture(fixture, dir);
    const before = captureMemberWorktree(binding, dir, childProcess.spawnSync, identity);
    git(dir, 'checkout', '--detach', '-q');
    const id = 'dddddddddddddddddddddddd';
    const runDir = path.join(fixture.runs, id);
    fs.mkdirSync(runDir);
    fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'test');
    fs.writeFileSync(path.join(runDir, 'result.txt'), '{}');
    const out = path.join(fixture.io, 'restored.json');
    fs.writeFileSync(path.join(runDir, 'meta.json'), JSON.stringify({ pid: process.pid, out, readonly: false }));
    let restored = false;
    const code = await superviseMemberRun({ codex: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir, env: {}, runDir,
      recovery: { binding, cwd: dir, identity, before, readonly: false } }, {
      outFd: fs.openSync(out, 'w'),
      spawnSync: (bin, args, options) => {
        if (restored) return { status: null, error: { code: 'ETIMEDOUT' } };
        const result = childProcess.spawnSync(bin, args, options);
        if (args.includes('symbolic-ref') && args.includes('refs/heads/feature/544-reattach') && result.status === 0) restored = true;
        return result;
      },
    });
    assert.equal(code, 0);
    assert.equal(restored, true);
    const output = [];
    assert.equal(run(fixture, ['member', 'status', id], { writeOut: (text) => output.push(text) }).code, 0);
    assert.match(output.join(''), /^BRANCH_RESTORE=restored$/m);
    assert.match(output.join(''), /^BRANCH_RESTORE_REASON=original-branch$/m);
  } finally { fixture.cleanup(); }
});

test('記録: status は読み取り専用の実行制限を通す', () => {
  const fixture = createFixture();
  try {
    const dir = createReattachWorktree(fixture);
    const { binding, identity } = recordedFixture(fixture, dir);
    for (const gitPath of [GIT_PATH, '/usr/bin/git']) {
      const calls = [];
      const result = captureMemberWorktree({ ...binding, git: gitPath }, dir, (bin, args, options) => {
        calls.push({ bin, args });
        return childProcess.spawnSync(bin, args, options);
      }, identity);
      assert.equal(result.state, 'recorded', gitPath);
      const status = calls.find((call) => call.args.includes('status'));
      assert.equal(status.bin, '/usr/bin/sandbox-exec');
      const profile = status.args[status.args.indexOf('-p') + 1];
      assert.match(profile, /\(deny file-write\*\)/);
      assert.match(profile, /\(deny process-exec\*\)/);
      assert.match(profile, /\(literal \(param "GIT0"\)\)/);
      assert.ok(status.args.includes(`GIT0=${fs.realpathSync(gitPath)}`));
      if (gitPath === '/usr/bin/git') {
        const selected = childProcess.execFileSync('/usr/bin/xcrun', ['--no-cache', '--find', 'git'], { encoding: 'utf8' }).trim();
        assert.ok(status.args.includes(`GIT1=${fs.realpathSync(selected)}`));
      }
    }
  } finally { fixture.cleanup(); }
});

test('記録: 実行制限が利用できない場合は Git を実行しない', () => {
  const fixture = createFixture();
  try {
    const dir = createReattachWorktree(fixture);
    const { binding, identity } = recordedFixture(fixture, dir);
    const missingSandbox = Object.create(fs);
    missingSandbox.lstatSync = (target, ...args) => {
      if (target === '/usr/bin/sandbox-exec') throw new Error('unavailable');
      return fs.lstatSync(target, ...args);
    };
    for (const deps of [{ platform: 'linux' }, { fs: missingSandbox }]) {
      const calls = [];
      const result = captureMemberWorktree(binding, dir, (...args) => { calls.push(args); }, identity, Date.now() + 5000, deps);
      assert.deepEqual(result, { state: 'unavailable' });
      assert.equal(calls.length, 0);
    }
  } finally { fixture.cleanup(); }
});

test('完了: 記録の時間切れでも対象外の復帰理由を保持する', async () => {
  for (const reason of ['read-only', 'initially-detached', 'head-not-detached']) {
    const fixture = createMemberFixture();
    try {
      const dir = createReattachWorktree(fixture);
      if (reason !== 'initially-detached') git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/feature/544-reattach');
      const { binding, identity } = recordedFixture(fixture, dir);
      const before = captureMemberWorktree(binding, dir, childProcess.spawnSync, identity);
      assert.equal(before.state, 'recorded');
      assert.equal(before.branch === '', reason === 'initially-detached');
      const runDir = path.join(fixture.runs, 'eeeeeeeeeeeeeeeeeeeeeeee');
      fs.mkdirSync(runDir);
      fs.writeFileSync(path.join(runDir, 'prompt.txt'), 'test');
      fs.writeFileSync(path.join(runDir, 'result.txt'), '{}');
      const out = path.join(fixture.io, 'reason.json');
      let statuses = 0;
      const code = await superviseMemberRun({ codex: process.execPath, args: ['-e', 'process.exit(0)'], cwd: dir, env: {}, runDir,
        recovery: { binding, cwd: dir, identity, before, readonly: reason === 'read-only' } }, {
        outFd: fs.openSync(out, 'w'),
        spawnSync: (bin, args, options) => {
          if (args.includes('status') && ++statuses === 2) return { status: null, error: { code: 'ETIMEDOUT' } };
          return childProcess.spawnSync(bin, args, options);
        },
      });
      assert.equal(code, 0);
      assert.equal(statuses, 2);
      const worktree = JSON.parse(fs.readFileSync(path.join(runDir, 'worktree-state.json'), 'utf8'));
      assert.equal(worktree.reason, reason);
    } finally { fixture.cleanup(); }
  }
});


test('完了: 作業フォルダの一致を確認できない場合は状態記録と自動復帰を省略する', async () => {
  const fixture = createMemberFixture();
  try {
    const dir = createReattachWorktree(fixture);
    git(dir, 'symbolic-ref', 'HEAD', 'refs/heads/feature/544-reattach');
    const started = fixture.runMember(MEMBER_START, { cwd: dir });
    assert.equal(started.code, 0, started.messages.join(''));
    const payload = JSON.parse(fixture.calls[0].options.env.VK_TASK_MEMBER_SUPERVISE);
    assert.equal(payload.cwd, fixture.repo);
    assert.equal(payload.recovery.identity, null);
    assert.equal(payload.recovery.before.state, 'unavailable');
    // 終了処理を通しても Git による記録・復帰は行わない。
    git(dir, 'checkout', '-q', '--detach');
    fs.writeFileSync(path.join(payload.runDir, 'result.txt'), '{}');
    const calls = [];
    const code = await superviseMemberRun({ ...payload, codex: process.execPath, args: ['-e', 'process.exit(0)'], env: {} }, {
      outFd: fs.openSync(path.join(fixture.io, 'out.json'), 'w'),
      spawnSync: (...args) => { calls.push(args); throw new Error('unexpected Git call'); },
    });
    assert.equal(code, 0);
    assert.equal(calls.length, 0);
    assert.equal(git(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'HEAD');
    const output = [];
    assert.equal(fixture.runMember(['member', 'status', path.basename(payload.runDir)], { writeOut: (text) => output.push(text) }).code, 0);
    for (const stage of ['BEFORE', 'AFTER_CHILD', 'AFTER']) assert.match(output.join(''), new RegExp(`^WORKTREE_${stage}_STATE=unavailable$`, 'm'));
    assert.match(output.join(''), /^BRANCH_RESTORE=not-restored$/m);
    assert.match(output.join(''), /^BRANCH_RESTORE_REASON=automatic-restore-failed: working-directory-mismatch$/m);
  } finally { fixture.cleanup(); }
});
