'use strict';

// 設定パネルの openFolder ブロック（issue #525）が指すフォルダを、Finder で開いてよいかの判定と、
// 必要なときの作成を行う。Electron に依存しない（shell.openPath の呼び出しは main.js 側）。
// パスは外部設定ディスクリプタ（VK_TERMINALS_SETTINGS）由来の信頼できない入力として扱う。

const fs = require('fs');
const os = require('os');
const path = require('path');

// renderer/settingsTabs.js の openFolder 正規化と同じ値にそろえる。
const OPEN_PATH_MAX_LENGTH = 4096;

// macOS がフォルダではなくアプリ・部品として扱う拡張子。shell.openPath に渡すと起動されるため拒否する。
// この一覧は代表的なものであり、Finder のパッケージ判定をすべては網羅できない。
// OS の正確な判定にはネイティブ拡張が要るため採らない（許可ルート内に限る前提と合わせて許容する）。
// .lproj は普通のフォルダとして扱われるので入れない。
const PACKAGE_EXTENSIONS = new Set([
  '.app', '.bundle', '.framework', '.plugin', '.kext', '.pkg', '.mpkg', '.prefpane',
  '.xpc', '.appex', '.workflow', '.action', '.saver', '.qlgenerator', '.mdimporter',
  '.rtfd', '.photoslibrary', '.musiclibrary', '.tvlibrary', '.fcpbundle', '.logicx', '.band',
  '.pages', '.numbers', '.key', '.playground', '.xcodeproj', '.xcworkspace', '.scptd',
  '.component', '.vst', '.vst3', '.au', '.dsym',
]);

// ユーザーが作成を許可される場所（ホームフォルダ直下のこのフォルダの中だけ）。
const CREATABLE_DIR_NAME = '.vk-agents';

// 失敗理由の固定値。画面側の文言の分岐に使うため、増減は画面側と合わせる。
const OPEN_PATH_REASONS = Object.freeze([
  'invalid', 'not-allowed', 'not-found', 'not-directory', 'create-failed', 'open-failed',
]);

// 先頭の ~ / ~/ だけをホームフォルダに置き換える。~user 形式や相対パスは null。
function expandHomePath(input, homeDir) {
  if (typeof input !== 'string' || input === '' || input.length > OPEN_PATH_MAX_LENGTH) return null;
  if (input.includes('\0')) return null;
  let expanded = input;
  if (input === '~' || input.startsWith('~/')) {
    expanded = path.join(homeDir, input.slice(1));
  } else if (input.startsWith('~')) {
    return null;
  }
  if (!path.isAbsolute(expanded)) return null;
  return path.resolve(expanded);
}

// target が root と同じか、その内側かを path.relative で判定する（前方一致は /a/x と /a/xy を取り違える）。
function isInsideOrSame(root, target) {
  const relative = path.relative(root, target);
  if (relative === '') return true;
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

// node_modules の中に置かれているとき、その 1 つ上（依存として持つパッケージのルート）を返す。
function packageRootAboveNodeModules(dir) {
  const segments = dir.split(path.sep);
  const index = segments.lastIndexOf('node_modules');
  if (index <= 0) return null;
  return segments.slice(0, index).join(path.sep) || path.sep;
}

// アプリに同梱されたフォルダのルート一覧（ホームフォルダは含めない）。
function buildBundledRoots({ isPackaged, resourcesPath, resourceRoot }) {
  const roots = [];
  if (isPackaged && typeof resourcesPath === 'string' && resourcesPath) roots.push(resourcesPath);
  if (typeof resourceRoot === 'string' && resourceRoot) {
    roots.push(resourceRoot);
    const packageRoot = packageRootAboveNodeModules(path.resolve(resourceRoot));
    if (packageRoot) roots.push(packageRoot);
  }
  return roots.map((root) => path.resolve(root));
}

function realpathOrNull(target) {
  return fs.promises.realpath(target).then((real) => real, () => null);
}

// 開いてよいルート（実体のパス）と、作成してよいルートを求める。
async function resolveRoots({ homeDir, bundledRoots }) {
  const realHome = (await realpathOrNull(homeDir)) || path.resolve(homeDir);
  const vkAgentsPath = path.join(homeDir, CREATABLE_DIR_NAME);
  let creatableRoot = (await realpathOrNull(vkAgentsPath)) || path.join(realHome, CREATABLE_DIR_NAME);
  // ~/.vk-agents 自体がホームやその祖先を指すリンクのときは、このルートを使わない（開くのも作るのも不可）。
  if (isInsideOrSame(creatableRoot, realHome)) creatableRoot = null;
  const bundled = [];
  for (const root of bundledRoots) {
    const realRoot = (await realpathOrNull(root)) || root;
    // ホームフォルダそのもの、またはホームを含む祖先（/ や /Users）は許可しない。
    // node_modules が ~ 直下にあるときなどに、ホーム全体が開けるようになるのを防ぐ。
    if (isInsideOrSame(realRoot, realHome)) continue;
    bundled.push(realRoot);
  }
  return { creatableRoot, openRoots: creatableRoot ? [creatableRoot, ...bundled] : bundled };
}

function hasPackageExtension(target) {
  return PACKAGE_EXTENSIONS.has(path.extname(target).toLowerCase());
}

// 存在する一番近い親フォルダの実体に、残りの階層を足した「作ったときの実体パス」を求める。
async function resolveProspectivePath(target) {
  const rest = [];
  let current = target;
  for (;;) {
    const real = await realpathOrNull(current);
    if (real) return path.join(real, ...rest.reverse());
    const parent = path.dirname(current);
    if (parent === current) return null;
    rest.push(path.basename(current));
    current = parent;
  }
}

// 開いてよいフォルダかを判定し、無く create が許されるときは作る。
// 戻り値は { ok: true, path, created } または { ok: false, reason }。
async function resolveOpenFolderRequest({ rawPath, create = false, homeDir = os.homedir(), bundledRoots = [] }) {
  const target = expandHomePath(rawPath, homeDir);
  if (!target) return { ok: false, reason: 'invalid' };

  const { creatableRoot, openRoots } = await resolveRoots({ homeDir, bundledRoots });
  const isOpenable = (candidate) => openRoots.some((root) => isInsideOrSame(root, candidate));

  const realTarget = await realpathOrNull(target);
  if (realTarget) {
    if (!isOpenable(realTarget)) return { ok: false, reason: 'not-allowed' };
    return checkDirectory(target, realTarget, false);
  }

  // 存在しない場合。作る指定が無ければ、許可範囲内かだけ確かめて「まだ無い」と返す。
  const prospective = await resolveProspectivePath(target);
  if (!prospective || !isOpenable(prospective)) return { ok: false, reason: 'not-allowed' };
  if (create !== true) return { ok: false, reason: 'not-found' };
  if (!creatableRoot || !isInsideOrSame(creatableRoot, prospective)) return { ok: false, reason: 'create-failed' };
  // パッケージ拡張子はフォルダとして扱わない。作ってから拒否すると空のフォルダが残るため、作る前に断る。
  if (hasPackageExtension(target) || hasPackageExtension(prospective)) return { ok: false, reason: 'not-directory' };

  try {
    await fs.promises.mkdir(prospective, { recursive: true });
  } catch (_error) {
    return { ok: false, reason: 'create-failed' };
  }
  // 作成後にもう一度実体を確かめる（作成中にリンクへ差し替えられても範囲外へ出さない）。
  const createdReal = await realpathOrNull(prospective);
  if (!createdReal || !isInsideOrSame(creatableRoot, createdReal)) return { ok: false, reason: 'create-failed' };
  const checked = await checkDirectory(target, createdReal, true);
  return checked.ok ? checked : { ok: false, reason: 'create-failed' };
}

// フォルダであること、macOS のパッケージ拡張子でないことを確かめる。
async function checkDirectory(target, realTarget, created) {
  if (hasPackageExtension(target) || hasPackageExtension(realTarget)) {
    return { ok: false, reason: 'not-directory' };
  }
  try {
    const stat = await fs.promises.stat(realTarget);
    if (!stat.isDirectory()) return { ok: false, reason: 'not-directory' };
  } catch (_error) {
    return { ok: false, reason: 'not-found' };
  }
  return { ok: true, path: realTarget, created };
}

module.exports = {
  OPEN_PATH_MAX_LENGTH,
  OPEN_PATH_REASONS,
  PACKAGE_EXTENSIONS,
  expandHomePath,
  isInsideOrSame,
  buildBundledRoots,
  resolveOpenFolderRequest,
};
