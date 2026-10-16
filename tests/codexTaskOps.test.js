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
  fs.writeFileSync(ghPath, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n');\nif (process.argv[2] === 'issue' && process.argv[3] === 'create') console.log('https://github.com/vektor-inc/vk-terminals/issues/999');\n`, { mode: 0o755 });
  const gitConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n\tname = "Bound User"\n\temail = "bound@example.com"\n');
  const env = {
    VK_TASK_ROOT: repo,
    VK_TASK_REPO: parseGitHubRepo(origin) || '',
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
      root: fixture.repo, repo: 'vektor-inc/vk-terminals', git: GIT_PATH, gh: fixture.env.VK_TASK_GH, home: fixture.home, gitConfig: fixture.env.VK_TASK_GITCONFIG, ghConfig: fixture.env.VK_TASK_GHCONFIG, remoteBase: 'https://github.com',
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
    assert.deepEqual(fetchArgs.slice(fetchIndex), ['fetch', '--no-tags', '--no-recurse-submodules', '--refmap=', remote.url, '+refs/heads/main:refs/remotes/origin/main']);
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
        spawnSync: interposeSpawn({ before: (_bin, args) => { if (involves(args, 'worktree') && involves(args, '--no-track') && !swapped) { swapped = true; swap(); } } }),
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
          if (args.includes('/bin/mkdir') && !swapped) {
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
