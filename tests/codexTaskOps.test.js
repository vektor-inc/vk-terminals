// 自動処理用 Codex の固定入口（utils/codexTaskOps.js。issue #428）の検証。
// 許可する操作の組み立て結果、許可リスト外（出力先指定・ファイル読み込み・リポジトリ指定・暗黙の push など）の拒否、
// 実際の Git リポジトリと偽の gh を使った実行時の検証を確認する。
const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseTaskCommand, runTaskCommand, sanitizeEnvironment } = require('../utils/codexTaskOps');

const GIT_PREFIX = ['--no-pager', '-c', 'core.fsmonitor=false'];
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

test('許可: gh は番号・本文・head を検証し、対象リポジトリは作業フォルダの origin に任せる', () => {
  assert.deepEqual(parseTaskCommand(argv('gh issue view 428 --comments --json title,body')), { ok: true, bin: 'gh', args: ['issue', 'view', '428', '--comments', '--json', 'title,body'], needsGitHub: true });
  assert.deepEqual(parseTaskCommand(['gh', 'issue', 'comment', '428', '--body', '完了']).args, ['issue', 'comment', '428', '--body', '完了']);
  assert.deepEqual(parseTaskCommand(argv('gh pr view 429')).args, ['pr', 'view', '429']);
  assert.deepEqual(parseTaskCommand(argv('gh pr checks')).args, ['pr', 'checks']);
  assert.deepEqual(parseTaskCommand(['gh', 'pr', 'comment', '429', '-b', 'ok']).args, ['pr', 'comment', '429', '--body', 'ok']);
  assert.deepEqual(
    parseTaskCommand(['gh', 'pr', 'create', '--title', '題', '--body', '本文', '--head', 'issue/428-x', '--base', 'main', '--draft']).args,
    ['pr', 'create', '--head', 'issue/428-x', '--title', '題', '--body', '本文', '--base', 'main', '--draft'],
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
    ['gh', 'pr', 'merge', '1'],
    ['gh', 'pr', 'close', '1'],
    ['gh', 'pr', 'edit', '1'],
    ['gh', 'pr', 'checkout', '1'],
    ['gh', 'issue', 'create'],
    ['gh', 'issue', 'close', '1'],
    ['gh', 'repo', 'delete', 'x/y'],
    ['gh', 'auth', 'token'],
    ['gh', 'secret', 'list'],
    ['gh', 'issue', 'view', '1', '--repo', 'other/repo'],
    ['gh', 'issue', 'view', '1', '-R', 'other/repo'],
    ['gh', 'issue', 'view', 'https://github.com/other/repo/issues/1'],
    ['gh', 'issue', 'view', '1', '--web'],
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

function createRepo({ origin } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-task-ops-')));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 'test@example.com');
  git(repo, 'config', 'user.name', 'Test');
  git(repo, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git(repo, 'add', 'a.txt');
  git(repo, 'commit', '-q', '-m', 'init');
  if (origin) git(repo, 'remote', 'add', 'origin', origin);
  // 偽の gh: 受け取った引数を記録するだけ。
  const binDir = path.join(root, 'bin');
  const record = path.join(root, 'gh-calls.jsonl');
  fs.mkdirSync(binDir);
  fs.writeFileSync(path.join(binDir, 'gh'), `#!/usr/bin/env node\nrequire('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`, { mode: 0o755 });
  const env = { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` };
  const readCalls = () => (fs.existsSync(record) ? fs.readFileSync(record, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : []);
  return { root, repo, env, readCalls, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function run(fixture, command, extra = {}) {
  const messages = [];
  const code = runTaskCommand(command, {
    cwd: fixture.repo,
    env: fixture.env,
    homeDir: path.join(fixture.root, 'home'),
    write: (message) => messages.push(message),
    spawnSync: (bin, args, options) => childProcess.spawnSync(bin, args, { ...options, stdio: 'pipe' }),
    ...extra,
  });
  return { code, messages };
}

test('実行: 許可された Git 操作は実際に動き、--output は拒否されてファイルが作られない', () => {
  const fixture = createRepo();
  try {
    fs.writeFileSync(path.join(fixture.repo, 'b.txt'), 'two\n');
    assert.equal(run(fixture, ['git', 'status', '--short']).code, 0);
    assert.equal(run(fixture, ['git', 'add', '--', 'b.txt']).code, 0);
    assert.equal(run(fixture, ['git', 'commit', '-m', 'add b']).code, 0);
    assert.equal(git(fixture.repo, 'log', '-1', '--format=%s'), 'add b');

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

test('実行: リポジトリの設定にある外部 diff / textconv は呼ばれない', () => {
  const fixture = createRepo();
  try {
    const marker = path.join(fixture.root, 'external-ran');
    const script = path.join(fixture.root, 'ext.sh');
    fs.writeFileSync(script, `#!/bin/sh\ntouch ${marker}\n`, { mode: 0o755 });
    git(fixture.repo, 'config', 'diff.external', script);
    git(fixture.repo, 'config', 'diff.evil.textconv', script);
    fs.writeFileSync(path.join(fixture.repo, '.gitattributes'), '*.txt diff=evil\n');
    fs.writeFileSync(path.join(fixture.repo, 'a.txt'), 'changed\n');
    assert.equal(run(fixture, ['git', 'diff']).code, 0);
    assert.equal(fs.existsSync(marker), false);
  } finally {
    fixture.cleanup();
  }
});

test('実行: gh は origin が github.com のリポジトリでだけ、検証済みの引数で呼ばれる', () => {
  const fixture = createRepo({ origin: 'https://github.com/vektor-inc/vk-terminals.git' });
  try {
    assert.equal(run(fixture, ['gh', 'pr', 'create', '--title', 't', '--body', 'b', '--head', 'issue/428-x']).code, 0);
    assert.equal(run(fixture, ['gh', 'issue', 'view', '428']).code, 0);
    assert.deepEqual(fixture.readCalls(), [
      ['pr', 'create', '--head', 'issue/428-x', '--title', 't', '--body', 'b'],
      ['issue', 'view', '428'],
    ]);
    // 拒否された操作は gh を一度も呼ばない。
    const before = fixture.readCalls().length;
    assert.equal(run(fixture, ['gh', 'pr', 'create', '--title', 't', '--body', 'b']).code, 2);
    assert.equal(run(fixture, ['gh', 'issue', 'comment', '1', '--body-file', '/etc/passwd']).code, 2);
    assert.equal(fixture.readCalls().length, before);
  } finally {
    fixture.cleanup();
  }
});

test('実行: origin が無い・github.com 以外・Git 管理外・ホームそのものでは何も実行しない', () => {
  for (const origin of [undefined, 'https://example.com/o/r.git', 'https://github.com.evil.example/o/r.git', 'https://evil.example/https://github.com/o/r']) {
    const fixture = createRepo({ origin });
    try {
      const result = run(fixture, ['gh', 'issue', 'view', '1']);
      assert.equal(result.code, 2, String(origin));
      assert.match(result.messages.join(''), /origin is not a github\.com repository/);
      assert.deepEqual(fixture.readCalls(), []);
    } finally {
      fixture.cleanup();
    }
  }

  const fixture = createRepo({ origin: 'https://github.com/o/r.git' });
  try {
    const outside = path.join(fixture.root, 'plain');
    fs.mkdirSync(outside);
    assert.match(run(fixture, ['git', 'status'], { cwd: outside }).messages.join(''), /not inside a git repository/);
    // リポジトリのルートがホームそのもの（ホーム全体が Git 管理）なら拒否する。
    const result = run(fixture, ['git', 'status'], { homeDir: fixture.repo });
    assert.equal(result.code, 2);
    assert.match(result.messages.join(''), /not a project directory/);
  } finally {
    fixture.cleanup();
  }
});

test('環境変数: 外部コマンド・出力先・対象リポジトリを変えるものを取り除く', () => {
  const cleaned = sanitizeEnvironment({
    PATH: '/usr/bin', HOME: '/home/u', GH_TOKEN: 't',
    GIT_DIR: '/x', GIT_WORK_TREE: '/x', GIT_EXTERNAL_DIFF: 'x', GIT_PAGER: 'x', GIT_SSH_COMMAND: 'x', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'k',
    GIT_AUTHOR_NAME: 'a', GIT_COMMITTER_EMAIL: 'c@example.com',
    GH_REPO: 'o/r', GH_HOST: 'h', GH_PAGER: 'p', GH_EDITOR: 'e', BROWSER: 'b', PAGER: 'p', EDITOR: 'e', VISUAL: 'v',
  });
  assert.deepEqual(Object.keys(cleaned).sort(), ['GH_PROMPT_DISABLED', 'GH_TOKEN', 'GIT_AUTHOR_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_TERMINAL_PROMPT', 'HOME', 'PATH']);
});

test('入口の複製: 専用 CODEX_HOME へ複製した入口も同じ検証で動く', () => {
  const { prepareCodexTaskPolicyHome } = require('../utils/codexTaskPolicy');
  const fixture = createRepo();
  try {
    const personal = path.join(fixture.root, 'personal');
    fs.mkdirSync(personal);
    const prepared = prepareCodexTaskPolicyHome({
      preset: 'orchestrated-task', dataDir: path.join(fixture.root, 'data'), handoffDir: path.join(fixture.root, 'handoff'), personalCodexHome: personal,
    });
    assert.equal(prepared.ok, true);
    const entry = path.join(prepared.home, 'vk-task-ops.js');
    const ok = childProcess.spawnSync(process.execPath, [entry, 'git', 'status', '--short'], { cwd: fixture.repo, env: fixture.env, encoding: 'utf8' });
    assert.equal(ok.status, 0, ok.stderr);
    const target = path.join(fixture.root, 'written.txt');
    const rejected = childProcess.spawnSync(process.execPath, [entry, 'git', 'diff', `--output=${target}`], { cwd: fixture.repo, env: fixture.env, encoding: 'utf8' });
    assert.equal(rejected.status, 2);
    assert.equal(fs.existsSync(target), false);
  } finally {
    fixture.cleanup();
  }
});
