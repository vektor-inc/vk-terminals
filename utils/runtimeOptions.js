'use strict';

// 組み込み用の入口（embedded.js の start(options)）から渡される起動オプションの
// 検証と、main.js が使う各種の解決（表示名・資源の置き場所・更新方針・設定の置き場所）。
// Electron に依存しない純粋な関数だけを置き、tests/runtimeOptions.test.js で検証する。

const path = require('path');

const DEFAULT_APP_TITLE = 'VK Terminals';
const APP_TITLE_ENV_KEY = 'VK_TERMINALS_APP_TITLE';
const SETTINGS_DESCRIPTOR_ENV_KEY = 'VK_TERMINALS_SETTINGS';

// embedded.js の start() が main.js を require する直前に 1 度だけ書き込む。
// electron . で起動した場合は null のまま（従来どおりの挙動）。
let storedEmbeddedOptions = null;

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 組み込み用の入口に渡されたオプションを検証して正規化する。
 * 不明なキーは捨てる。型が違うものは黙って無視せず例外にする（呼び出し側の設定ミスを早く知らせるため）。
 * @param {object} [raw] { appTitle, resourceRoot, selfUpdate, settingsDescriptorPath, singleInstance }
 * @returns {{ appTitle: string|null, resourceRoot: string|null, selfUpdate: boolean|null, settingsDescriptorPath: string|null, singleInstance: boolean }}
 */
function normalizeEmbeddedOptions(raw) {
  const options = raw == null ? {} : raw;
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('embedded options must be an object');
  }

  if (options.appTitle != null && nonEmptyString(options.appTitle) === null) {
    throw new TypeError('embedded options: appTitle must be a non-empty string');
  }
  if (options.resourceRoot != null) {
    const root = nonEmptyString(options.resourceRoot);
    if (root === null || !path.isAbsolute(root)) {
      throw new TypeError('embedded options: resourceRoot must be an absolute path');
    }
  }
  if (options.settingsDescriptorPath != null) {
    const p = nonEmptyString(options.settingsDescriptorPath);
    if (p === null || !path.isAbsolute(p)) {
      throw new TypeError('embedded options: settingsDescriptorPath must be an absolute path');
    }
  }
  for (const key of ['selfUpdate', 'singleInstance']) {
    if (options[key] != null && typeof options[key] !== 'boolean') {
      throw new TypeError(`embedded options: ${key} must be a boolean`);
    }
  }

  return {
    appTitle: nonEmptyString(options.appTitle),
    resourceRoot: nonEmptyString(options.resourceRoot),
    // null は「未指定」。未指定のときの既定は shouldSelfUpdate() が決める。
    selfUpdate: typeof options.selfUpdate === 'boolean' ? options.selfUpdate : null,
    settingsDescriptorPath: nonEmptyString(options.settingsDescriptorPath),
    // 組み込み用の入口から起動したときは既定で二重起動を防ぐ。
    singleInstance: options.singleInstance !== false,
  };
}

function setEmbeddedOptions(raw) {
  storedEmbeddedOptions = normalizeEmbeddedOptions(raw);
  return storedEmbeddedOptions;
}

function getEmbeddedOptions() {
  return storedEmbeddedOptions;
}

/** テスト用。保存済みのオプションを消す。 */
function resetEmbeddedOptions() {
  storedEmbeddedOptions = null;
}

/** ウィンドウタイトル・ヘッダーの表示名。組み込みの指定 > 環境変数 > 既定。 */
function resolveAppTitle({ embedded = null, env = {} } = {}) {
  return (embedded && embedded.appTitle)
    || nonEmptyString(env[APP_TITLE_ENV_KEY])
    || DEFAULT_APP_TITLE;
}

/** renderer・アイコン・スプライト・設定スキーマ等の置き場所。未指定ならリポジトリ直下（main.js のあるフォルダ）。 */
function resolveResourceRoot({ embedded = null, defaultRoot } = {}) {
  return (embedded && embedded.resourceRoot) || defaultRoot;
}

/** アプリにまとめられて動いているか（読み取り専用の置き場所で動いている前提）。 */
function isBundledRun({ isPackaged = false, embedded = null } = {}) {
  return isPackaged === true || embedded !== null;
}

/**
 * git fetch / pull による自己更新を行うか。
 * パッケージ化されている場合は、組み込み側が selfUpdate: true と言っても行わない
 * （読み取り専用のアプリ内で git pull を走らせて署名を壊さないため）。
 */
function shouldSelfUpdate({ isPackaged = false, embedded = null } = {}) {
  if (isPackaged === true) return false;
  if (embedded && embedded.selfUpdate !== null) return embedded.selfUpdate;
  // 組み込み用の入口から更新方針を明示されなかった場合も、アプリの一部として動くので更新しない。
  if (embedded) return false;
  return true;
}

/** 二重起動を検知して知らせるか。electron . （開発・zip 版）は従来どおり検知しない。 */
function shouldGuardAlreadyRunning({ isPackaged = false, embedded = null } = {}) {
  if (embedded) return embedded.singleInstance;
  return isPackaged === true;
}

/** 設定ディスクリプタのパス。組み込みの指定 > 環境変数。無ければ null。 */
function resolveSettingsDescriptorPath({ embedded = null, env = {} } = {}) {
  return (embedded && embedded.settingsDescriptorPath)
    || nonEmptyString(env[SETTINGS_DESCRIPTOR_ENV_KEY])
    || null;
}

/**
 * config.json の探索候補（優先順）。loadUserConfig と API トークンの保存先解決が共有する。
 * アプリにまとめられた起動では、同梱の資源側 config.json（配布物の一部）を設定として読まない。
 */
function listUserConfigCandidatePaths({ dataDir, resourceRoot, homeDir, bundled }) {
  const candidates = [path.join(dataDir, 'config.json')];
  if (!bundled) candidates.push(path.join(resourceRoot, 'config.json'));
  candidates.push(path.join(homeDir, '.claude', 'terminals-config.json')); // 後方互換
  return candidates;
}

/**
 * VK Terminals 自身の config.json の保存先。
 * 既存の候補があればそれを使う。無いときの新規作成先は、資源の置き場所が読み取り専用なら
 * 書き込める dataDir 側にする（ASAR 内・署名済みアプリ内へは書けないため）。
 */
function pickOwnConfigTargetPath({ existsSync, dataDir, resourceRoot, resourceRootWritable }) {
  const dataDirConfig = path.join(dataDir, 'config.json');
  const resourceRootConfig = path.join(resourceRoot, 'config.json');
  if (existsSync(dataDirConfig)) return dataDirConfig;
  // 読み取り専用の置き場所にある config.json は読むだけで、保存先にはしない。
  if (resourceRootWritable && existsSync(resourceRootConfig)) return resourceRootConfig;
  return resourceRootWritable ? resourceRootConfig : dataDirConfig;
}

module.exports = {
  DEFAULT_APP_TITLE,
  APP_TITLE_ENV_KEY,
  SETTINGS_DESCRIPTOR_ENV_KEY,
  normalizeEmbeddedOptions,
  setEmbeddedOptions,
  getEmbeddedOptions,
  resetEmbeddedOptions,
  resolveAppTitle,
  resolveResourceRoot,
  isBundledRun,
  shouldSelfUpdate,
  shouldGuardAlreadyRunning,
  resolveSettingsDescriptorPath,
  pickOwnConfigTargetPath,
  listUserConfigCandidatePaths,
};
