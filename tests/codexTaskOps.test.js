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
      root: fixture.repo, repo: 'vektor-inc/vk-terminals', git: GIT_PATH, gh: fixture.env.VK_TASK_GH, home: fixture.home, gitConfig: fixture.env.VK_TASK_GITCONFIG, ghConfig: fixture.env.VK_TASK_GHCONFIG,
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
