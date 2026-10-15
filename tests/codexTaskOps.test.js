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
  parseGitHubRepo,
  parseTaskCommand,
  readBinding,
  resolveTrustedExecutable,
  runTaskCommand,
  verifyTrustedChain,
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
  const binDir = path.join(root, 'bin');
  const record = path.join(root, 'gh-calls.jsonl');
  const home = path.join(root, 'home');
  fs.mkdirSync(binDir);
  fs.mkdirSync(home);
  const ghPath = path.join(binDir, 'gh');
  fs.writeFileSync(ghPath, `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(record)}, JSON.stringify({ args: process.argv.slice(2), env: process.env }) + '\\n');\n`, { mode: 0o755 });
  const gitConfig = path.join(root, 'gitconfig');
  fs.writeFileSync(gitConfig, '[user]\n\tname = "Bound User"\n\temail = "bound@example.com"\n');
  const env = {
    VK_TASK_ROOT: repo,
    VK_TASK_REPO: parseGitHubRepo(origin) || '',
    VK_TASK_GIT: GIT_PATH,
    VK_TASK_GH: ghPath,
    VK_TASK_HOME: home,
    VK_TASK_GITCONFIG: gitConfig,
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
    ];
    for (const env of broken) {
      const rejected = run(fixture, ['git', 'status'], { env });
      assert.equal(rejected.code, 2, JSON.stringify(env));
      assert.match(rejected.messages.join(''), /launcher binding is missing or invalid/);
    }
    assert.equal(readBinding({}), null);
    assert.deepEqual(readBinding(fixture.env), {
      root: fixture.repo, repo: 'vektor-inc/vk-terminals', git: GIT_PATH, gh: fixture.env.VK_TASK_GH, home: fixture.home, gitConfig: fixture.env.VK_TASK_GITCONFIG,
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
    const expected = buildChildEnvironment({ git: GIT_PATH, gh: fixture.env.VK_TASK_GH, home: fixture.home, gitConfig: fixture.env.VK_TASK_GITCONFIG });
    // 子プロセスの環境は、固定値だけ（Node が自分で足す変数を除く）。
    for (const [key, value] of Object.entries(expected)) assert.equal(env[key], value, key);
    for (const key of Object.keys(env)) assert.ok(key in expected || /^(__CF_USER_TEXT_ENCODING|SHLVL|_)$/.test(key), key);
    assert.equal(expected.HOME, fixture.home);
    assert.equal(expected.XDG_CONFIG_HOME, path.join(fixture.home, '.config'));
    assert.equal(expected.GH_CONFIG_DIR, path.join(fixture.home, '.config', 'gh'));
    assert.equal(expected.GIT_CONFIG_SYSTEM, '/dev/null');
    assert.match(expected.PATH, new RegExp(`^${path.dirname(GIT_PATH)}`));
  } finally {
    fixture.cleanup();
  }
});

test('設定の解析: 外部コマンドを起動しうる項目だけを見つけ、origin の生の URL を返す', () => {
  const listing = (...entries) => entries.map(([key, value]) => `${key}\n${value}\0`).join('');
  assert.deepEqual(inspectGitConfigListing(listing(['core.bare', 'false'], ['remote.origin.url', GITHUB_ORIGIN], ['user.name', 'x'])), { unsafeKey: null, originUrl: GITHUB_ORIGIN });
  for (const key of ['filter.lfs.clean', 'filter.a.b.smudge', 'diff.x.textconv', 'diff.external', 'gpg.program', 'gpg.ssh.program', 'core.sshcommand', 'include.path', 'includeif.gitdir:/x.path', 'credential.https://x.helper', 'merge.m.driver']) {
    assert.equal(inspectGitConfigListing(listing([key, 'v'])).unsafeKey, key, key);
  }
  assert.equal(parseGitHubRepo('https://github.com/o/r.git'), 'o/r');
  assert.equal(parseGitHubRepo('git@github.com:o/r'), 'o/r');
  assert.equal(parseGitHubRepo('ssh://git@github.com/o/r.git'), 'o/r');
  for (const url of [null, '', 'https://example.com/o/r', 'https://github.com.evil.example/o/r', 'https://evil.example/https://github.com/o/r', 'https://github.com/o']) {
    assert.equal(parseGitHubRepo(url), null, String(url));
  }
});

// ─── 信頼境界（所有者・権限・リンク） ───────────────────────────────────────

test('信頼境界: 根から末端までの全階層について、リンク・他人の所有・他人が書ける権限を拒否する', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-trust-')));
  try {
    const dir = path.join(root, 'a', 'b');
    fs.mkdirSync(dir, { recursive: true });
    const snapshot = verifyTrustedChain(fs, dir);
    assert.equal(snapshot[snapshot.length - 1].path, dir);

    // 他人（グループ・その他）が書き込める祖先／末端。
    for (const [target, mode] of [[path.join(root, 'a'), 0o777], [path.join(root, 'a'), 0o775], [dir, 0o757]]) {
      const original = fs.statSync(target).mode & 0o777;
      fs.chmodSync(target, mode);
      try {
        assert.throws(() => verifyTrustedChain(fs, dir), /writable by other users/, `${target} ${mode.toString(8)}`);
      } finally {
        fs.chmodSync(target, original);
      }
    }
    // 所有者が違う。
    assert.throws(() => verifyTrustedChain(fs, dir, { uid: process.getuid() + 1 }), /not owned by/);
    // 祖先がリンク。
    fs.symlinkSync(path.join(root, 'a'), path.join(root, 'link'));
    assert.throws(() => verifyTrustedChain(fs, path.join(root, 'link', 'b')), /symbolic link/);
    // 末端が種別違い。
    fs.writeFileSync(path.join(root, 'file'), 'x');
    assert.throws(() => verifyTrustedChain(fs, path.join(root, 'file')), /not a directory/);
    assert.doesNotThrow(() => verifyTrustedChain(fs, path.join(root, 'file'), { finalKind: 'file' }));
    assert.throws(() => verifyTrustedChain(fs, dir, { finalKind: 'file' }), /not a regular file/);

    // 検証後に祖先が別のフォルダへ差し替えられたことを検知する。
    const verified = verifyTrustedChain(fs, dir);
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
    // リンクは実体まで検証し、リンク側のパスを返す（argv[0] で挙動を変えるツールのため）。
    fs.writeFileSync(path.join(real, 'impl'), '#!/bin/sh\n', { mode: 0o755 });
    fs.symlinkSync(path.join(real, 'impl'), path.join(trusted, 'linked'));
    assert.equal(resolveTrustedExecutable(fs, 'linked', [trusted]), path.join(trusted, 'linked'));
    fs.chmodSync(real, 0o777);
    assert.equal(resolveTrustedExecutable(fs, 'linked', [trusted]), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
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
