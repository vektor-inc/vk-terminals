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

  // 例: MacOSX10.15.sdk, MacOSX14.sdk, MacOSX14.4.sdk など。
  // 元のシェル実装（`sort -V | tail -1`）に合わせ、バージョン順で最大のものを選ぶ。
  const sdkPattern = /^MacOSX1[0-9][0-9.]*\.sdk$/;
  const sdkNames = entries.filter((name) => sdkPattern.test(name));

  if (sdkNames.length === 0) {
    return null;
  }

  sdkNames.sort((a, b) => compareSdkVersions(a, b));
  const latestSdk = sdkNames[sdkNames.length - 1];

  const includeDir = path.join(sdkDir, latestSdk, 'usr', 'include', 'c++', 'v1');

  if (!fs.existsSync(includeDir)) {
    return null;
  }

  return `-I${includeDir}`;
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
function resolveElectronRebuildBin() {
  const binName = process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild';
  return path.join(__dirname, '..', 'node_modules', '.bin', binName);
}

/**
 * electron-rebuild を実行する。CXXFLAGS を追加指定したい場合は cxxflags を渡す。
 * 戻り値は spawnSync の結果（status に終了コードが入る）。
 */
function runElectronRebuild(cxxflags) {
  const bin = resolveElectronRebuildBin();
  const env = Object.assign({}, process.env);

  if (cxxflags) {
    // 既存の CXXFLAGS があれば前置きして温存する（元のシェル実装と同じ挙動）。
    env.CXXFLAGS = env.CXXFLAGS ? `${cxxflags} ${env.CXXFLAGS}` : cxxflags;
  }

  return spawnSync(bin, ['-f', '-w', 'node-pty'], {
    stdio: 'inherit',
    env,
    // Windows の .cmd は shell 経由でないと直接実行できないため必要。
    shell: process.platform === 'win32',
  });
}

function main() {
  // macOS のみ、Command Line Tools の libc++ ヘッダを CXXFLAGS に付与して試す。
  // Windows / Linux では最初から追加フラグなしでビルドする。
  const cxxflags = process.platform === 'darwin' ? getMacCxxFlagsInclude() : null;

  let result = runElectronRebuild(cxxflags);

  // CXXFLAGS 付きでの実行が失敗した場合（未検出時含む）、CXXFLAGS なしで再試行する。
  // 元のシェル実装（`... || electron-rebuild -f -w node-pty`）のフォールバックを踏襲。
  if (result.status !== 0 && cxxflags) {
    result = runElectronRebuild(null);
  }

  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

main();
