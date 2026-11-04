'use strict';
// openFolder ブロック（issue #525）の「開いてよい場所」の判定と、フォルダ作成の範囲を検証する。
// 実際の一時フォルダとシンボリックリンクを使い、realpath 後の判定を確かめる。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  expandHomePath,
  isInsideOrSame,
  buildBundledRoots,
  resolveOpenFolderRequest,
} = require('../utils/openPathPolicy');

// 一時のホームと同梱ルートを作る。macOS の /var → /private/var の差を避けるため realpath を取る。
function makeSandbox(t) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'open-path-policy-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, 'home');
  const bundled = path.join(base, 'bundled');
  const outside = path.join(home, 'Documents');
  fs.mkdirSync(path.join(home, '.vk-agents'), { recursive: true });
  fs.mkdirSync(path.join(bundled, 'rules'), { recursive: true });
  fs.mkdirSync(outside, { recursive: true });
  return { base, home, bundled, outside };
}

const request = (sandbox, rawPath, create = false) => resolveOpenFolderRequest({
  rawPath,
  create,
  homeDir: sandbox.home,
  bundledRoots: [sandbox.bundled],
});

test('expandHomePath: ~ と ~/ だけをホームに置き換え、相対パス・~user・NUL・長すぎるものは拒否する', () => {
  assert.equal(expandHomePath('~/.vk-agents/x', '/h'), '/h/.vk-agents/x');
  assert.equal(expandHomePath('~', '/h'), '/h');
  assert.equal(expandHomePath('/a/b/../c', '/h'), '/a/c');
  assert.equal(expandHomePath('rel/path', '/h'), null);
  assert.equal(expandHomePath('~root/x', '/h'), null);
  assert.equal(expandHomePath('/a\0b', '/h'), null);
  assert.equal(expandHomePath(`/${'a'.repeat(5000)}`, '/h'), null);
  assert.equal(expandHomePath('', '/h'), null);
  assert.equal(expandHomePath(null, '/h'), null);
});

test('isInsideOrSame: 前方一致ではなく階層で判定する', () => {
  assert.equal(isInsideOrSame('/Users/x', '/Users/x'), true);
  assert.equal(isInsideOrSame('/Users/x', '/Users/x/a/b'), true);
  assert.equal(isInsideOrSame('/Users/x', '/Users/xy'), false);
  assert.equal(isInsideOrSame('/Users/x', '/Users'), false);
  assert.equal(isInsideOrSame('/Users/x', '/Users/y'), false);
});

test('buildBundledRoots: アプリ版は resourcesPath を含み、node_modules 配下は 1 つ上も含む', () => {
  assert.deepEqual(
    buildBundledRoots({
      isPackaged: true,
      resourcesPath: '/App/Contents/Resources',
      resourceRoot: '/App/Contents/Resources/orchestrator/node_modules/vk-terminals',
    }),
    [
      '/App/Contents/Resources',
      '/App/Contents/Resources/orchestrator/node_modules/vk-terminals',
      '/App/Contents/Resources/orchestrator',
    ],
  );
  // 開発起動（未パッケージ）では Electron 本体の resourcesPath は含めない。
  assert.deepEqual(
    buildBundledRoots({ isPackaged: false, resourcesPath: '/electron/Resources', resourceRoot: '/dev/vk-terminals' }),
    ['/dev/vk-terminals'],
  );
});

test('~/.vk-agents/ の中の既存フォルダは開ける', async (t) => {
  const sandbox = makeSandbox(t);
  const target = path.join(sandbox.home, '.vk-agents', 'overrides', 'rules');
  fs.mkdirSync(target, { recursive: true });
  assert.deepEqual(await request(sandbox, '~/.vk-agents/overrides/rules'), { ok: true, path: target, created: false });
});

test('同梱ルートの中の既存フォルダは開ける（パスの途中に .app があってもよい）', async (t) => {
  const sandbox = makeSandbox(t);
  const appRoot = path.join(sandbox.bundled, 'X.app');
  const inApp = path.join(appRoot, 'Contents', 'Resources');
  fs.mkdirSync(inApp, { recursive: true });
  const result = await resolveOpenFolderRequest({ rawPath: inApp, homeDir: sandbox.home, bundledRoots: [appRoot] });
  assert.equal(result.ok, true);
  assert.equal((await request(sandbox, path.join(sandbox.bundled, 'rules'))).ok, true);
});

test('ホームフォルダ直下など許可ルートの外は not-allowed（ホーム全体は許可しない）', async (t) => {
  const sandbox = makeSandbox(t);
  assert.deepEqual(await request(sandbox, sandbox.outside), { ok: false, reason: 'not-allowed' });
  assert.deepEqual(await request(sandbox, sandbox.home), { ok: false, reason: 'not-allowed' });
  assert.deepEqual(await request(sandbox, '/'), { ok: false, reason: 'not-allowed' });
});

test('.. で許可ルートの外へ出るパスは not-allowed', async (t) => {
  const sandbox = makeSandbox(t);
  assert.deepEqual(await request(sandbox, '~/.vk-agents/../Documents'), { ok: false, reason: 'not-allowed' });
});

test('名前が前方一致するだけの兄弟フォルダは許可しない', async (t) => {
  const sandbox = makeSandbox(t);
  const sibling = `${sandbox.bundled}-evil`;
  fs.mkdirSync(sibling);
  assert.deepEqual(await request(sandbox, sibling), { ok: false, reason: 'not-allowed' });
});

test('許可ルート内のシンボリックリンクが外を指すと not-allowed', async (t) => {
  const sandbox = makeSandbox(t);
  const link = path.join(sandbox.home, '.vk-agents', 'escape');
  fs.symlinkSync(sandbox.outside, link);
  assert.deepEqual(await request(sandbox, link), { ok: false, reason: 'not-allowed' });
});

test('許可ルートの外に置いたリンクが中を指す場合は、実体で判定して開ける', async (t) => {
  const sandbox = makeSandbox(t);
  const link = path.join(sandbox.outside, 'to-rules');
  fs.symlinkSync(path.join(sandbox.bundled, 'rules'), link);
  const result = await request(sandbox, link);
  assert.equal(result.ok, true);
  assert.equal(result.path, path.join(sandbox.bundled, 'rules'));
});

test('ファイルは not-directory、macOS パッケージ拡張子のフォルダも not-directory', async (t) => {
  const sandbox = makeSandbox(t);
  const file = path.join(sandbox.home, '.vk-agents', 'a.txt');
  fs.writeFileSync(file, 'x');
  assert.deepEqual(await request(sandbox, file), { ok: false, reason: 'not-directory' });
  const app = path.join(sandbox.home, '.vk-agents', 'Tool.App');
  fs.mkdirSync(app);
  assert.deepEqual(await request(sandbox, app), { ok: false, reason: 'not-directory' });
});

test('create: true でも macOS パッケージ拡張子の新規パスは not-directory で、フォルダも親も作らない', async (t) => {
  const sandbox = makeSandbox(t);
  const app = path.join(sandbox.home, '.vk-agents', 'foo.app');
  assert.deepEqual(await request(sandbox, app, true), { ok: false, reason: 'not-directory' });
  assert.equal(fs.existsSync(app), false);
  const nested = path.join(sandbox.home, '.vk-agents', 'newdir', 'Bar.APP');
  assert.deepEqual(await request(sandbox, nested, true), { ok: false, reason: 'not-directory' });
  assert.equal(fs.existsSync(path.join(sandbox.home, '.vk-agents', 'newdir')), false);
});

test('フォルダが無く create 指定も無ければ not-found（作らない）', async (t) => {
  const sandbox = makeSandbox(t);
  const missing = path.join(sandbox.home, '.vk-agents', 'overrides', 'rules');
  assert.deepEqual(await request(sandbox, missing), { ok: false, reason: 'not-found' });
  assert.equal(fs.existsSync(missing), false);
});

test('create: true のとき ~/.vk-agents/ の中だけ作って開ける', async (t) => {
  const sandbox = makeSandbox(t);
  const target = path.join(sandbox.home, '.vk-agents', 'overrides', 'rules');
  assert.deepEqual(await request(sandbox, '~/.vk-agents/overrides/rules', true), { ok: true, path: target, created: true });
  assert.equal(fs.statSync(target).isDirectory(), true);
});

test('~/.vk-agents/ 自体がまだ無くても create: true で作れる', async (t) => {
  const sandbox = makeSandbox(t);
  fs.rmSync(path.join(sandbox.home, '.vk-agents'), { recursive: true });
  const result = await request(sandbox, '~/.vk-agents/overrides', true);
  assert.equal(result.ok, true);
  assert.equal(result.created, true);
});

test('create: true でも同梱ルートの中には作らず、ホーム直下は許可外', async (t) => {
  const sandbox = makeSandbox(t);
  const inBundled = path.join(sandbox.bundled, 'new');
  assert.deepEqual(await request(sandbox, inBundled, true), { ok: false, reason: 'create-failed' });
  assert.equal(fs.existsSync(inBundled), false);
  const inHome = path.join(sandbox.home, 'new');
  assert.deepEqual(await request(sandbox, inHome, true), { ok: false, reason: 'not-allowed' });
  assert.equal(fs.existsSync(inHome), false);
});

test('create: true でもシンボリックリンク経由で許可外には作らない', async (t) => {
  const sandbox = makeSandbox(t);
  const link = path.join(sandbox.home, '.vk-agents', 'escape');
  fs.symlinkSync(sandbox.outside, link);
  assert.deepEqual(await request(sandbox, path.join(link, 'child'), true), { ok: false, reason: 'not-allowed' });
  assert.equal(fs.existsSync(path.join(sandbox.outside, 'child')), false);
});

test('作成先の親がファイルだと create-failed', async (t) => {
  const sandbox = makeSandbox(t);
  fs.writeFileSync(path.join(sandbox.home, '.vk-agents', 'file'), 'x');
  assert.deepEqual(await request(sandbox, '~/.vk-agents/file/child', true), { ok: false, reason: 'create-failed' });
});

test('同梱ルートがホーム自体・ホームの祖先になるときは許可ルートから外す', async (t) => {
  const sandbox = makeSandbox(t);
  const probe = path.join(sandbox.outside, 'child');
  fs.mkdirSync(probe);
  for (const root of [sandbox.home, sandbox.base, path.parse(sandbox.base).root]) {
    const result = await resolveOpenFolderRequest({ rawPath: probe, homeDir: sandbox.home, bundledRoots: [root] });
    assert.deepEqual(result, { ok: false, reason: 'not-allowed' }, `root=${root}`);
  }
});

test('同梱ルートがホームの内側にあるときは従来どおり許可する', async (t) => {
  const sandbox = makeSandbox(t);
  const inner = path.join(sandbox.outside, 'git', 'vk-terminals');
  fs.mkdirSync(path.join(inner, 'rules'), { recursive: true });
  const result = await resolveOpenFolderRequest({ rawPath: path.join(inner, 'rules'), homeDir: sandbox.home, bundledRoots: [inner] });
  assert.equal(result.ok, true);
});

test('~/.vk-agents がホームやホームの親を指すリンクのときは、開くのも作るのも不可', async (t) => {
  for (const linkTarget of ['home', 'base']) {
    const sandbox = makeSandbox(t);
    fs.rmSync(path.join(sandbox.home, '.vk-agents'), { recursive: true });
    fs.symlinkSync(linkTarget === 'home' ? sandbox.home : sandbox.base, path.join(sandbox.home, '.vk-agents'));
    const inside = path.join(sandbox.outside, 'child');
    fs.mkdirSync(inside);
    assert.deepEqual(await request(sandbox, inside), { ok: false, reason: 'not-allowed' }, linkTarget);
    assert.deepEqual(await request(sandbox, '~/.vk-agents/Documents/child'), { ok: false, reason: 'not-allowed' }, linkTarget);
    assert.deepEqual(await request(sandbox, '~/.vk-agents/new', true), { ok: false, reason: 'not-allowed' }, linkTarget);
    assert.equal(fs.existsSync(path.join(sandbox.home, 'new')), false);
    // 同梱ルートは引き続き開ける。
    assert.equal((await request(sandbox, path.join(sandbox.bundled, 'rules'))).ok, true);
  }
});

test('追加したパッケージ拡張子のフォルダは開かない', async (t) => {
  const sandbox = makeSandbox(t);
  for (const ext of ['.rtfd', '.photoslibrary', '.logicx', '.pages', '.xcodeproj', '.vst3', '.dSYM']) {
    const dir = path.join(sandbox.home, '.vk-agents', `x${ext}`);
    fs.mkdirSync(dir);
    assert.deepEqual(await request(sandbox, dir), { ok: false, reason: 'not-directory' }, ext);
  }
});

test('相対パス・~user・NUL・空は invalid', async (t) => {
  const sandbox = makeSandbox(t);
  for (const raw of ['rules', '~root/x', '/a\0b', '', undefined]) {
    assert.deepEqual(await request(sandbox, raw), { ok: false, reason: 'invalid' });
  }
});
