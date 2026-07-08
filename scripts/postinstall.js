#!/usr/bin/env node
'use strict';

// postinstall: node-pty のネイティブビルドを electron-rebuild で行う。
//
// 以前は package.json に bash 前提のシェル構文（CXXFLAGS のインライン代入 + $(...) の
// コマンド置換）を直書きしていたが、npm は postinstall を Windows では既定で cmd.exe 経由
// で実行するため、bash 構文が解釈されず失敗していた（issue #76）。Node スクリプトに切り出し、
// OS ごとの分岐を JavaScript 側で行うことでどの OS でも同じように動くようにする。

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

/**
 * macOS の Command Line Tools が同梱する libc++ ヘッダを指す CXXFLAGS の追加分（-I<path>）を返す。
 * 見つからない場合は null を返す。
 *
 * macOS では、Xcode Command Line Tools のバージョンによっては libc++ の
 * ヘッダ（/Library/Developer/CommandLineTools/SDKs/MacOSX*.sdk 配下）を明示的に
 * CXXFLAGS へ渡さないと、electron-rebuild（node-gyp 経由のネイティブビルド）が
 * ヘッダ未検出でビルド失敗するケースがあるため、この分岐だけ残す必要がある。
 * Windows（VS Build Tools）・Linux（build-essential）では標準のインクルードパスで
 * 解決できるため、追加フラグは不要。
 */
function getMacCxxFlagsInclude() {
  const sdkDir = '/Library/Developer/CommandLineTools/SDKs';

  let entries;
  try {
    entries = fs.readdirSync(sdkDir);
  } catch (err) {
    // SDK ディレクトリ自体が存在しない環境（CLT 未インストール等）は追加フラグなしで進める。
    return null;
  }

  // 例: MacOSX10.15.sdk, MacOSX14.sdk, MacOSX14.4.sdk, MacOSX26.0.sdk など。
  // 元のシェル実装（`sort -V | tail -1`）に合わせ、バージョン順で新しいものを優先する。
  // メジャーバージョンの桁数は固定しない（macOS 26 以降の MacOSX26.sdk 等も拾う）。
  const sdkPattern = /^MacOSX\d+(?:\.\d+)*\.sdk$/;
  const versionedSdks = entries
    .filter((name) => sdkPattern.test(name))
    .sort((a, b) => compareSdkVersions(b, a)); // 新しい順

  // バージョン付き SDK を新しい順に、最後に MacOSX.sdk シンボリックリンクを候補にする。
  // 最新 SDK に libc++ ヘッダが無くても、古い SDK 側にあればそちらを使えるよう、
  // 存在チェックは候補ごとに行い、最初に見つかった有効なパスを返す。
  const candidates = versionedSdks.slice();
  if (entries.includes('MacOSX.sdk')) {
    candidates.push('MacOSX.sdk');
  }

  for (const sdk of candidates) {
    const includeDir = path.join(sdkDir, sdk, 'usr', 'include', 'c++', 'v1');
    if (fs.existsSync(includeDir)) {
      return `-I${includeDir}`;
    }
  }

  return null;
}

/**
 * "MacOSX10.15.sdk" のようなファイル名からバージョン部分を抜き出し、
 * `sort -V`（バージョン番号順ソート）相当の比較を行う。
 */
function compareSdkVersions(a, b) {
  const extractVersion = (name) => name.replace(/^MacOSX/, '').replace(/\.sdk$/, '');
  const versionA = extractVersion(a).split('.').map(Number);
  const versionB = extractVersion(b).split('.').map(Number);
  const length = Math.max(versionA.length, versionB.length);

  for (let i = 0; i < length; i++) {
    const partA = versionA[i] || 0;
    const partB = versionB[i] || 0;
    if (partA !== partB) {
      return partA - partB;
    }
  }
  return 0;
}

/**
 * node_modules/.bin 配下の electron-rebuild 実行ファイルの絶対パスを返す。
 * Windows では拡張子 .cmd 付きの wrapper が生成されるため、プラットフォームで拡張子を切り替える。
 */
function getElectronRebuildBinName(platform = process.platform) {
  return platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild';
}

/**
 * startDir から親方向へ、electron-rebuild の npm bin が置かれうるパスを列挙する。
 */
function getElectronRebuildBinCandidates(startDir = __dirname, platform = process.platform) {
  const binName = getElectronRebuildBinName(platform);
  const candidates = [];
  const seen = new Set();
  let currentDir = path.resolve(startDir);

  const addCandidate = (candidate) => {
    const normalized = path.normalize(candidate);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      candidates.push(normalized);
    }
  };

  while (true) {
    addCandidate(path.join(currentDir, 'node_modules', '.bin', binName));

    const parentDir = path.dirname(currentDir);
    if (path.basename(currentDir) === 'node_modules') {
      addCandidate(path.join(currentDir, '.bin', binName));
    }
    if (path.basename(parentDir) === 'node_modules') {
      addCandidate(path.join(parentDir, '.bin', binName));
    }

    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return candidates;
}

/**
 * electron-rebuild の解決結果と探索したパスを返す。
 * 見つからない場合は PATH 解決に委ねるため、binName のみを返す。
 */
function resolveElectronRebuildBinDetails(startDir = __dirname, platform = process.platform) {
  const binName = getElectronRebuildBinName(platform);
  const searchedPaths = getElectronRebuildBinCandidates(startDir, platform);
  const foundPath = searchedPaths.find((candidate) => fs.existsSync(candidate));

  if (foundPath) {
    return {
      bin: foundPath,
      found: true,
      searchedPaths,
    };
  }

  return {
    bin: binName,
    found: false,
    searchedPaths,
  };
}

function resolveElectronRebuildBin(startDir = __dirname) {
  return resolveElectronRebuildBinDetails(startDir).bin;
}

function logMissingElectronRebuildBin(searchedPaths) {
  console.error('[postinstall] electron-rebuild の npm bin が見つかりませんでした。PATH 上の electron-rebuild にフォールバックします。');
  console.error('[postinstall] 探索したパス:');
  for (const searchedPath of searchedPaths) {
    console.error(`[postinstall] - ${searchedPath}`);
  }
}

const loggedMissingElectronRebuildBins = new WeakSet();

function logMissingElectronRebuildBinOnce(resolvedBin) {
  if (resolvedBin.found || loggedMissingElectronRebuildBins.has(resolvedBin)) {
    return;
  }

  loggedMissingElectronRebuildBins.add(resolvedBin);
  logMissingElectronRebuildBin(resolvedBin.searchedPaths);
}

/**
 * electron-rebuild を実行する。CXXFLAGS を追加指定したい場合は cxxflags を渡す。
 * 戻り値は spawnSync の結果（status に終了コードが入る）。
 */
function runElectronRebuild(cxxflags, resolvedBin = resolveElectronRebuildBinDetails()) {
  const bin = resolvedBin.bin;
  const env = Object.assign({}, process.env);

  logMissingElectronRebuildBinOnce(resolvedBin);

  if (cxxflags) {
    // 既存の CXXFLAGS があれば前置きして温存する（元のシェル実装と同じ挙動）。
    env.CXXFLAGS = env.CXXFLAGS ? `${cxxflags} ${env.CXXFLAGS}` : cxxflags;
  }

  // Windows の .cmd は shell 経由でないと直接実行できないため shell:true が必要。
  const useShell = process.platform === 'win32';
  const args = ['-f', '-w', 'node-pty'];

  if (useShell) {
    // shell:true と args 配列の併用は Node v22+ で DEP0190 警告の対象になるため、
    // shell 経由のときはコマンド全体を 1 本の文字列として渡す。
    // Windows の spawnSync は shell:true 時に file/args を単純に空白連結するだけで
    // クォートしないため、パスにスペースを含みうる実行ファイル側（C:\Users\John Doe\... や
    // OneDrive 配下など）は自前でダブルクォートで囲む。引数（-f / -w / node-pty）は
    // スペースを含まないためクォート不要。
    const command = `"${bin}" ${args.join(' ')}`;
    return spawnSync(command, {
      stdio: 'inherit',
      env,
      shell: true,
    });
  }

  return spawnSync(bin, args, {
    stdio: 'inherit',
    env,
  });
}

/**
 * spawnSync の結果に spawn 自体の失敗（例: 実行ファイル未検出の ENOENT）が含まれていれば
 * その内容を出力する。stdio:'inherit' では子プロセスを起動できなかった理由は標準出力に
 * 現れないため、これを出さないと失敗原因が全く分からないまま再試行・終了に進んでしまう。
 */
function logSpawnError(result) {
  if (result && result.error) {
    console.error('[postinstall] electron-rebuild の起動に失敗しました:', result.error);
  }
}

function main() {
  // macOS のみ、Command Line Tools の libc++ ヘッダを CXXFLAGS に付与して試す。
  // Windows / Linux では最初から追加フラグなしでビルドする。
  const cxxflags = process.platform === 'darwin' ? getMacCxxFlagsInclude() : null;
  const resolvedBin = resolveElectronRebuildBinDetails();

  let result = runElectronRebuild(cxxflags, resolvedBin);
  logSpawnError(result);

  // CXXFLAGS 付きでの実行が失敗した場合（未検出時含む）、CXXFLAGS なしで再試行する。
  // 元のシェル実装（`... || electron-rebuild -f -w node-pty`）のフォールバックを踏襲。
  if (result.status !== 0 && cxxflags) {
    result = runElectronRebuild(null, resolvedBin);
    logSpawnError(result);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  compareSdkVersions,
  getElectronRebuildBinCandidates,
  getElectronRebuildBinName,
  getMacCxxFlagsInclude,
  logMissingElectronRebuildBin,
  logSpawnError,
  main,
  resolveElectronRebuildBin,
  resolveElectronRebuildBinDetails,
  runElectronRebuild,
};
