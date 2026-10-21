'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const {
  fetchLoginShellPath,
  applyLoginShellPath,
  extractMarkedPath,
  sanitizePath,
  pickShell,
  defaultRunShell,
} = require('../utils/loginShellPath');

const posixOnly = { skip: process.platform === 'win32' };
const MARKER = '__TEST_MARKER__';
const wrap = (value) => `${MARKER}S${value}${MARKER}E`;
const base = (runShell, extra = {}) => ({
  env: { SHELL: '/bin/zsh', PATH: '/usr/bin' },
  platform: 'darwin',
  marker: MARKER,
  shellExists: () => true,
  runShell,
  ...extra,
});

test('マーカーの外の出力（.zprofile の echo など）を除去して PATH だけ取り出す', posixOnly, async () => {
  const run = async () => `welcome!\nnvm loaded\n${wrap('/opt/homebrew/bin:/usr/bin')}\nlogout noise`;
  assert.equal(await fetchLoginShellPath(base(run)), '/opt/homebrew/bin:/usr/bin');
});

test('入力行のエコーで目印が先に現れても、最後の本物の出力を採る', posixOnly, async () => {
  const run = async () => `printf '${MARKER}S' "$PATH" '${MARKER}E'\n${wrap('/opt/bin')}`;
  assert.equal(await fetchLoginShellPath(base(run)), '/opt/bin');
});

test('シェルは -l -i -c で起動し、タイムアウトを渡す', posixOnly, async () => {
  let seen;
  const run = async (shell, args, opts) => { seen = { shell, args, opts }; return wrap('/a'); };
  await fetchLoginShellPath(base(run, { timeoutMs: 1234 }));
  assert.equal(seen.shell, '/bin/zsh');
  assert.deepEqual(seen.args.slice(0, 3), ['-l', '-i', '-c']);
  assert.equal(seen.opts.timeoutMs, 1234);
});

test('失敗（reject）・目印なしでは null を返す', posixOnly, async () => {
  assert.equal(await fetchLoginShellPath(base(async () => { throw new Error('boom'); })), null);
  assert.equal(await fetchLoginShellPath(base(async () => 'no marker here')), null);
  assert.equal(await fetchLoginShellPath(base(async () => `${MARKER}S/usr/bin`)), null);
});

test('不正値（空・制御文字入り・相対パスのみ）を拒否する', posixOnly, async () => {
  assert.equal(await fetchLoginShellPath(base(async () => wrap(''))), null);
  assert.equal(await fetchLoginShellPath(base(async () => wrap('/usr/bin:\u0007/bin'))), null);
  assert.equal(await fetchLoginShellPath(base(async () => wrap('bin:.:relative/dir'))), null);
  assert.equal(await fetchLoginShellPath(base(async () => wrap(`/${'a'.repeat(40000)}`))), null);
});

test('sanitizePath は相対パス・空要素・重複を落とす', posixOnly, () => {
  assert.equal(sanitizePath('/a::.:rel:/b:/a'), '/a:/b');
  assert.equal(sanitizePath(undefined), null);
});

test('Windows では取得しない（子プロセスも起動しない）', async () => {
  let called = false;
  const result = await fetchLoginShellPath(base(async () => { called = true; return wrap('/a'); }, { platform: 'win32' }));
  assert.equal(result, null);
  assert.equal(called, false);
});

test('pickShell: $SHELL が無効なら /bin/zsh（macOS）へ戻す', () => {
  assert.equal(pickShell({ SHELL: '/bin/fish' }, () => true, 'darwin'), '/bin/fish');
  assert.equal(pickShell({ SHELL: '/nope/zsh' }, () => false, 'darwin'), '/bin/zsh');
  assert.equal(pickShell({ SHELL: 'zsh' }, () => true, 'darwin'), '/bin/zsh');
  assert.equal(pickShell({}, () => true, 'linux'), '/bin/bash');
});

test('extractMarkedPath: 終了目印が無ければ null', () => {
  assert.equal(extractMarkedPath(`${MARKER}S/a`, MARKER), null);
});

test('applyLoginShellPath: 成功時は取得値を先頭に、元の PATH にしかない要素を後ろに残す', posixOnly, async () => {
  const env = { SHELL: '/bin/zsh', PATH: '/usr/bin:/only/original' };
  const ok = await applyLoginShellPath({ ...base(async () => wrap('/opt/homebrew/bin:/usr/bin')), env });
  assert.equal(ok, true);
  assert.equal(env.PATH, ['/opt/homebrew/bin', '/usr/bin', '/only/original'].join(path.delimiter));
});

test('applyLoginShellPath: 失敗時は PATH を変えない', posixOnly, async () => {
  const env = { SHELL: '/bin/zsh', PATH: '/usr/bin' };
  const ok = await applyLoginShellPath({ ...base(async () => { throw new Error('x'); }), env });
  assert.equal(ok, false);
  assert.equal(env.PATH, '/usr/bin');
});

test('既定の実行: 入力待ちで固まるシェルはタイムアウトで打ち切る', posixOnly, async () => {
  const started = Date.now();
  await assert.rejects(defaultRunShell('/bin/sh', ['-c', 'read x; sleep 30'], { timeoutMs: 300, env: process.env }), /timed out/);
  assert.ok(Date.now() - started < 5000);
});

test('main.js: Codex 側へは起動時の PATH を渡し、PATH の反映は createWindow より前に行う', () => {
  const source = require('node:fs').readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.match(source, /const APP_ORIGINAL_PATH = typeof process\.env\.PATH === 'string' \? process\.env\.PATH : '';/);
  assert.match(source, /pathEnv: APP_ORIGINAL_PATH,/);
  const apply = source.indexOf('await applyLoginShellPath();');
  assert.ok(apply !== -1);
  assert.ok(apply < source.indexOf('  createWindow();\n  startWidgetWatcher();'));
});

test('既定の実行: 背景プロセスがパイプを握っていても、目印が揃えばタイムアウトせず PATH が返る', posixOnly, async () => {
  const started = Date.now();
  const script = `sleep 10 & printf '%s%s%s' '${MARKER}S' '/opt/bin' '${MARKER}E'`;
  const out = await defaultRunShell('/bin/sh', ['-c', script], { timeoutMs: 3000, env: process.env, marker: MARKER });
  assert.equal(extractMarkedPath(out, MARKER), '/opt/bin');
  assert.ok(Date.now() - started < 2000);
});

test('既定の実行: 目印が揃っていれば終了コードが 0 以外でも成功にする', posixOnly, async () => {
  const script = `printf '%s%s%s' '${MARKER}S' '/opt/bin' '${MARKER}E'; exit 3`;
  const out = await defaultRunShell('/bin/sh', ['-c', script], { timeoutMs: 3000, env: process.env, marker: MARKER });
  assert.equal(extractMarkedPath(out, MARKER), '/opt/bin');
});

test('既定の実行: タイムアウト時は孫プロセスまで終了する', posixOnly, async () => {
  const pidFile = path.join(require('os').tmpdir(), `vkt-grandchild-${process.pid}-${Date.now()}`);
  const script = `sleep 30 & echo $! > '${pidFile}'; wait`;
  await assert.rejects(defaultRunShell('/bin/sh', ['-c', script], { timeoutMs: 400, env: process.env }), /timed out/);
  const fs = require('node:fs');
  const grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
  fs.unlinkSync(pidFile);
  assert.ok(grandchild > 0);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.throws(() => process.kill(grandchild, 0));
});

test('既定の実行: exit 1 は reject、正常終了は stdout を返す', posixOnly, async () => {
  await assert.rejects(defaultRunShell('/bin/sh', ['-c', 'echo hi; exit 1'], { timeoutMs: 3000, env: process.env }), /exited with 1/);
  assert.equal(await defaultRunShell('/bin/sh', ['-c', 'printf ok'], { timeoutMs: 3000, env: process.env }), 'ok');
});
