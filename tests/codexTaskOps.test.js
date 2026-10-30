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
  assert.deepEqual(
    parseTaskCommand(['gh', 'pr', 'create', '--title', '題', '--body', '本文', '--head', 'issue/428-x', '--base', 'main', '--draft']).args,
    ['pr', 'create', '--head', 'issue/428-x', '--title', '題', '--body', '本文', '--base', 'main', '--draft'],
  );
  assert.deepEqual(
    parseTaskCommand(['gh', 'Vektor-Inc/another.repo', 'issue', 'view', '428']),
    { ok: true, bin: 'gh', args: ['issue', 'view', '428'], needsGitHub: true, targetRepo: 'Vektor-Inc/another.repo' },
  );
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
    ['gh', 'pr', 'merge', '1'],
    ['gh', 'pr', 'close', '1'],
    ['gh', 'pr', 'edit', '1'],
    ['gh', 'pr', 'checkout', '1'],
    ['gh', 'issue', 'close', '1'],
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
    ['gh', 'pr', 'comment', '1', '--body-file', 'x'],
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

test('実行: prepare worktree は最新の base から .claude/worktrees/<名前> に作業ブランチ付きの worktree を作り、通常のクローンは切り替えない', () => {
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
    const worktree = path.join(fixture.repo, '.claude', 'worktrees', 'codex-440');
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
    ]);
    assert.equal(fetchCall.env.GIT_ALLOW_PROTOCOL, 'file');
    // worktree の追加は通信しない環境（プロトコル不許可）で行う。
    assert.equal(calls.find((call) => call.args.includes('worktree')).env.GIT_ALLOW_PROTOCOL, '');

    // info/exclude へ 1 行。別の名前で作ると行が増える。
    const exclude = () => fs.readFileSync(path.join(fixture.repo, '.git', 'info', 'exclude'), 'utf8').split('\n').filter((line) => line.startsWith('/.claude/worktrees/'));
    assert.deepEqual(exclude(), ['/.claude/worktrees/codex-440/']);
    assert.equal(run(fixture, ['prepare', 'worktree', 'main', '441', 'issue/441-second', 'codex-441']).code, 0);
    assert.deepEqual(exclude(), ['/.claude/worktrees/codex-440/', '/.claude/worktrees/codex-441/']);
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
    const worktree = fs.realpathSync(path.join(fixture.repo, '.claude', 'worktrees', 'codex-440'));
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

test('拒否: prepare worktree の同名ブランチ・同名パス・.claude のリンク・取得できない base・ルート以外での実行・別クローン', () => {
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
    fs.mkdirSync(path.join(fixture.repo, '.claude', 'worktrees', 'wt-b'), { recursive: true });
    result = prepare(['issue/440-b', 'wt-b']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /worktree path already exists/);
    assert.equal(branchExists('issue/440-b'), false);

    // .claude/worktrees がリンク。
    const elsewhere = path.join(fixture.root, 'elsewhere');
    fs.mkdirSync(elsewhere);
    fs.rmSync(path.join(fixture.repo, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(fixture.repo, '.claude'));
    fs.symlinkSync(elsewhere, path.join(fixture.repo, '.claude', 'worktrees'));
    result = prepare(['issue/440-c', 'wt-c']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /symbolic link/);
    // .claude がリンク。
    fs.rmSync(path.join(fixture.repo, '.claude'), { recursive: true });
    fs.symlinkSync(elsewhere, path.join(fixture.repo, '.claude'));
    result = prepare(['issue/440-d', 'wt-d']);
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /symbolic link/);
    assert.deepEqual(fs.readdirSync(elsewhere), []);
    fs.unlinkSync(path.join(fixture.repo, '.claude'));

    // リモートに無い base（取得に失敗する）。worktree もブランチも作られない。
    result = run(fixture, ['prepare', 'worktree', 'no-such-base', '440', 'issue/440-e', 'wt-e']);
    assert.notEqual(result.code, 0);
    assert.equal(fs.existsSync(path.join(fixture.repo, '.claude', 'worktrees', 'wt-e')), false);
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
      assert.equal(fs.existsSync(path.join(cwd, '.claude')), false, cwd);
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

test('競合: 取得の最中に .claude が外部フォルダへのリンクへ差し替えられても、拘束ルートの外には何も作られない', () => {
  for (const variant of ['claude', 'worktrees']) {
    const fixture = createFixture();
    try {
      attachRemote(fixture);
      const outside = path.join(fixture.root, 'outside-target');
      fs.mkdirSync(outside);
      fs.mkdirSync(path.join(fixture.repo, '.claude', 'worktrees'), { recursive: true });
      const swap = () => {
        if (variant === 'claude') {
          fs.rmSync(path.join(fixture.repo, '.claude'), { recursive: true });
          fs.symlinkSync(outside, path.join(fixture.repo, '.claude'));
        } else {
          fs.rmSync(path.join(fixture.repo, '.claude', 'worktrees'), { recursive: true });
          fs.symlinkSync(outside, path.join(fixture.repo, '.claude', 'worktrees'));
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

test('競合: 最後の検査の後（worktree の追加の直前）に .claude 系のフォルダが外部へのリンクへ差し替えられても、拘束ルートの外には何も作られない', () => {
  for (const variant of ['claude', 'worktrees', 'hooks']) {
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
        const claude = path.join(fixture.repo, '.claude');
        if (variant === 'claude') {
          fs.rmSync(claude, { recursive: true });
          fs.symlinkSync(target, claude);
        } else {
          fs.rmSync(path.join(claude, 'worktrees'), { recursive: true });
          fs.symlinkSync(target, path.join(claude, 'worktrees'));
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
          if (args.includes('/bin/mkdir') && args.includes(path.join(fixture.repo, '.claude', 'worktrees')) && !swapped) {
            swapped = true;
            fs.symlinkSync(outside, path.join(fixture.repo, '.claude'));
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
const worktreeOf = (fixture) => path.join(fixture.repo, '.claude', 'worktrees', 'wt-race');
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

test('競合: 作業フォルダの置き場所が Git 管理領域・.claude 内の別フォルダ・外部へのリンクに差し替えられても、どこにも書かれない（追加の直前・index 作成の直前・展開の直前）', () => {
  const outsideDirs = (fixture) => [
    path.join(fixture.repo, '.git', 'objects', 'info'),
    path.join(fixture.repo, '.git', 'objects', 'pack'),
    path.join(fixture.repo, '.git', 'refs', 'tags'),
    path.join(fixture.repo, '.git', 'hooks'),
    path.join(fixture.repo, '.claude', 'other'),
    path.join(fixture.root, 'outside-target'),
  ];
  const places = {
    'objects/info': (fixture) => path.join(fixture.repo, '.git', 'objects', 'info'),
    'objects/pack': (fixture) => path.join(fixture.repo, '.git', 'objects', 'pack'),
    'refs/tags': (fixture) => path.join(fixture.repo, '.git', 'refs', 'tags'),
    'hooks': (fixture) => path.join(fixture.repo, '.git', 'hooks'),
    '.claude 内の別フォルダ': (fixture) => path.join(fixture.repo, '.claude', 'other'),
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
    const worktree = path.join(fixture.repo, '.claude', 'worktrees', 'codex-440');
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
    // 親をルートで起動した場合: ルート・配下の worktree（prepare worktree が作る .claude/worktrees/ の下）のどちらから呼んでも、-C と cwd は親の起動 cwd。
    const inside = path.join(root.repo, '.claude', 'worktrees', 'inside');
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
