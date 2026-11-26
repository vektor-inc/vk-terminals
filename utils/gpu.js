'use strict';

const fs = require('fs');
const os = require('os');
const childProcess = require('child_process');

// GUI(Electron) の GPU 起動モード。
//
// VK Terminals は Electron アプリで、Chromium が起動時に GPU を初期化する。
// macOS では HW アクセラがそのまま効くが、WSL 2 以前の WSLg 等の Linux では GPU 初期化に失敗し
// `Exiting GPU process` / `kTransientFailure` などのエラーが多発する（利用可能な
// Vulkan ICD がソフトウェア実装のみで SwiftShader へフォールバックするため）。
// WSL 3 以降（`/dev/dxg` あり）は GPU を使えるため、自動のときは WSL の版を調べて既定を決める。
// 起動モードを環境変数 VK_TERMINALS_GPU で選べるようにし、Chromium スイッチと
// 追加環境変数へ写像する。
//
// 呼び出し側（VK Orchestrator など）が argv で GPU スイッチを明示している場合は、
// そちらを尊重してこのモジュールは介入しない（二重指定による競合を避ける）。

/** GPU 起動モードの取りうる値。 */
const GPU_MODES = ['off', 'default'];

/** `wsl.exe --version` の時間制限（ミリ秒）。起動処理の中で同期的に呼ぶため短く切る。 */
const WSL_VERSION_TIMEOUT_MS = 2000;
/** PATH に wsl.exe が無い（Windows の PATH を引き継がない）場合の呼び出し先。 */
const WSL_EXE_FALLBACK_PATH = '/mnt/c/Windows/System32/wsl.exe';

/**
 * GPU 起動モードのプラットフォーム既定値を返す（WSL の版は見ない単純な既定）。
 * macOS は HW アクセラがそのまま効くためスイッチ不要（'default'）。
 * それ以外（Linux、およびネイティブ Windows を含む darwin 以外の全て）は
 * GPU 初期化失敗によるエラーを抑制するため 'off'。
 * WSL 3 以降を 'default' にする判定は detectAutoGpu() が行う。
 * @param {string} [platform] process.platform 互換の値
 * @returns {'off'|'default'}
 */
function defaultGpuMode(platform = process.platform) {
  return platform === 'darwin' ? 'default' : 'off';
}

/**
 * WSL 上で動いているかを判定する（vk-orchestrator の isWsl と同じ条件）。
 * Linux で、環境変数 WSL_DISTRO_NAME が空でない、または /proc/version に microsoft を含む。
 * @param {object} [deps]
 * @returns {boolean}
 */
function isWsl({ platform = process.platform, env = process.env, readFileSync = fs.readFileSync, osRelease = os.release } = {}) {
  if (platform !== 'linux') return false;
  if (String(env.WSL_DISTRO_NAME || '').trim() !== '') return true;
  try {
    return /microsoft/i.test(String(readFileSync('/proc/version', 'utf8')));
  } catch {
    try {
      return /microsoft/i.test(String(osRelease()));
    } catch {
      return false;
    }
  }
}

/**
 * `wsl.exe --version` の出力（Buffer）を文字列へ戻す。
 * 先頭の BOM を外し、NUL バイトを含めば UTF-16LE、含まなければ UTF-8 として読む
 * （環境変数 WSL_UTF8=1 の利用者は UTF-8 で出力される）。
 * @param {Buffer|Uint8Array|string} output
 * @returns {string}
 */
function decodeWslOutput(output) {
  if (typeof output === 'string') return output.replace(/^﻿/, '');
  let bytes = Buffer.from(output);
  let utf16 = false;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    bytes = bytes.subarray(2);
    utf16 = true;
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    bytes = bytes.subarray(3);
  }
  if (bytes.includes(0)) utf16 = true;
  return bytes.toString(utf16 ? 'utf16le' : 'utf8').replace(/^﻿/, '');
}

/**
 * `wsl.exe --version` の出力から WSL の版を取り出す。
 * 項目名は Windows の言語で変わるため見ない。空でない最初の行の末尾にある 4 つ区切りの番号
 * （例 3.0.5.0）を取り、先頭の数字が 1〜9 の範囲でなければ「分からない」とする
 * （Windows の版 10.0.x を誤って拾うのを防ぐ）。
 * @param {Buffer|Uint8Array|string} output
 * @returns {{ ok: true, version: string, major: number } | { ok: false, reason: string }}
 */
function parseWslVersionOutput(output) {
  const lines = decodeWslOutput(output).split(/\r?\n/);
  const firstLine = lines.find((line) => line.trim() !== '');
  if (firstLine === undefined) return { ok: false, reason: 'empty output' };
  const match = /(?:^|[^\d.])(\d+\.\d+\.\d+\.\d+)\s*$/.exec(firstLine);
  if (!match) return { ok: false, reason: 'unparseable output' };
  const major = Number(match[1].split('.')[0]);
  if (!(major >= 1 && major <= 9)) return { ok: false, reason: 'unparseable output' };
  return { ok: true, version: match[1], major };
}

/**
 * wsl.exe --version を同期的に呼び、WSL の版を返す（失敗はすべて「分からない」）。
 * PATH 上の wsl.exe、失敗したら /mnt/c/Windows/System32/wsl.exe の順に試す。
 * 時間切れのときは待ち時間が延びないよう、次の候補は試さない。
 * @param {object} [deps]
 * @param {Function} [deps.spawnSync] child_process.spawnSync 互換
 * @returns {{ ok: true, version: string, major: number } | { ok: false, reason: string }}
 */
function readWslVersion({ spawnSync = childProcess.spawnSync } = {}) {
  let failure = { ok: false, reason: 'wsl.exe not found' };
  for (const command of ['wsl.exe', WSL_EXE_FALLBACK_PATH]) {
    const result = spawnSync(command, ['--version'], {
      timeout: WSL_VERSION_TIMEOUT_MS,
      windowsHide: true,
      encoding: 'buffer',
    });
    if (result?.error) {
      if (result.error.code === 'ETIMEDOUT') return { ok: false, reason: 'timeout' };
      if (result.error.code !== 'ENOENT') {
        failure = { ok: false, reason: `wsl.exe failed: ${result.error.code || result.error.message}` };
      }
      continue;
    }
    if (result?.status !== 0) {
      failure = { ok: false, reason: `wsl.exe exit code ${result?.status ?? result?.signal}` };
      continue;
    }
    const parsed = parseWslVersionOutput(result.stdout ?? Buffer.alloc(0));
    if (parsed.ok) return parsed;
    failure = parsed;
  }
  return failure;
}

/**
 * 利用者の指定が無いときの GPU モード（自動）を、環境から決める。
 *  - macOS: default
 *  - WSL: /dev/dxg があり WSL 3 以降なら default。WSL 2 以前・版が分からない・/dev/dxg 無しは off
 *  - それ以外（ネイティブ Windows、WSL 以外の Linux）: off
 * @param {string} platform process.platform 互換の値
 * @param {object} [deps] テスト用の差し替え（env / readFileSync / isWsl / hasDxg / readWslVersion / spawnSync）
 * @returns {{ mode: 'off'|'default', reason: string, wsl: boolean, versionUnknown: boolean }}
 */
function detectAutoGpu(platform, deps = {}) {
  const decide = (mode, reason, extra = {}) => ({ mode, reason, wsl: false, versionUnknown: false, ...extra });
  if (platform === 'darwin') return decide('default', 'macOS');
  const wsl = (deps.isWsl ?? isWsl)({ platform, env: deps.env, readFileSync: deps.readFileSync });
  if (!wsl) return decide('off', platform === 'linux' ? 'Linux' : platform);

  const hasDxg = (deps.hasDxg ?? (() => fs.existsSync('/dev/dxg')))();
  if (!hasDxg) return decide('off', 'WSL without /dev/dxg', { wsl: true });

  const version = (deps.readWslVersion ?? readWslVersion)({ spawnSync: deps.spawnSync });
  if (!version.ok) return decide('off', `WSL version unknown: ${version.reason}`, { wsl: true, versionUnknown: true });
  if (version.major >= 3) return decide('default', `WSL ${version.version}`, { wsl: true });
  return decide('off', `WSL ${version.version}`, { wsl: true });
}

// 未知の GPU モードを警告済みか（プロセス内で一度だけ通知するためのフラグ）。
let warnedUnknownGpuMode = false;

/**
 * 非空の未知値（例: 撤去した旧 'hardware'）が来た場合、挙動変更に気づけるよう
 * 一度だけ警告する（起動は止めない）。
 * @param {string} value 未知の値
 */
function warnUnknownGpuMode(value) {
  if (warnedUnknownGpuMode) return;
  warnedUnknownGpuMode = true;
  console.warn(
    `[vk-terminals] 未知の GPU モード "${value}" は無視します` +
    `（有効値: ${GPU_MODES.join(' / ')}、空=自動）。`,
  );
}

/**
 * GPU 起動モードを解決し、理由も返す。
 * 優先順位: 環境変数 VK_TERMINALS_GPU > config.json の gpu > 自動（プラットフォーム・WSL の版で決まる既定）。
 * いずれも空文字・未知の値の場合は次の候補へフォールバックする。環境変数が非空の未知値
 * （例: 旧 'hardware'）の場合は、config に有効な値があって上書き解決されても気づけるよう
 * その場で警告する（config 側が未知値の場合も同様）。
 * WSL の版の確認（wsl.exe の呼び出し）は、自動へ到達したときだけ 1 回行う。結果は config へ書かない。
 * @param {object} [options]
 * @param {NodeJS.ProcessEnv} [options.env]
 * @param {string} [options.platform]
 * @param {string} [options.configMode] config.json 由来の gpu 値（任意）
 * @param {object} [options.deps] 自動判定の差し替え（detectAutoGpu の deps）
 * @returns {{ mode: 'off'|'default', source: 'env'|'config'|'auto', reason: string, autoState: 'on'|'off'|'wsl-unknown'|null }}
 */
function resolveGpuDecision({ env = process.env, platform = process.platform, configMode, deps = {} } = {}) {
  const fromEnv = String(env.VK_TERMINALS_GPU ?? '').trim().toLowerCase();
  if (fromEnv !== '' && !GPU_MODES.includes(fromEnv)) warnUnknownGpuMode(fromEnv);
  const fromConfig = String(configMode ?? '').trim().toLowerCase();
  if (fromConfig !== '' && !GPU_MODES.includes(fromConfig)) warnUnknownGpuMode(fromConfig);

  const specified = GPU_MODES.includes(fromEnv) ? { mode: fromEnv, source: 'env', reason: 'VK_TERMINALS_GPU' }
    : GPU_MODES.includes(fromConfig) ? { mode: fromConfig, source: 'config', reason: 'config gpu' }
      : null;
  if (specified) {
    // 利用者の指定がある間は wsl.exe を呼ばない。WSL 以外なら自動の結果は環境だけで決まる。
    const known = platform === 'darwin' || !(deps.isWsl ?? isWsl)({ platform, env, readFileSync: deps.readFileSync });
    return { ...specified, autoState: known ? (defaultGpuMode(platform) === 'default' ? 'on' : 'off') : null };
  }

  const auto = detectAutoGpu(platform, { env, ...deps });
  const autoState = auto.versionUnknown ? 'wsl-unknown' : (auto.mode === 'default' ? 'on' : 'off');
  return { mode: auto.mode, source: 'auto', reason: auto.reason, autoState };
}

/**
 * GPU 起動モードを解決する（モードだけを返す）。詳細は resolveGpuDecision を参照。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @param {string} [configMode] config.json 由来の gpu 値（任意）
 * @param {object} [deps] 自動判定の差し替え
 * @returns {'off'|'default'}
 */
function resolveGpuMode(env = process.env, platform = process.platform, configMode, deps = {}) {
  return resolveGpuDecision({ env, platform, configMode, deps }).mode;
}

/**
 * argv に GPU 関連スイッチが既に含まれているか判定する。
 * 含まれていれば呼び出し側（orchestrator 等）が明示指定しているとみなし、
 * このモジュールは介入しない。
 * @param {string[]} [argv]
 * @returns {boolean}
 */
function hasExplicitGpuSwitch(argv = process.argv) {
  return argv.some((a) =>
    /^--(disable-gpu|disable-gpu-sandbox|disable-software-rasterizer|use-gl|use-angle|ignore-gpu-blocklist|enable-gpu|in-process-gpu)(=|$)/.test(a),
  );
}

/**
 * GPU モードから、Chromium スイッチと追加環境変数を組み立てる。
 * switches は [name] または [name, value] の配列で返す（appendSwitch にそのまま渡せる形）。
 *  - 'off'      : GPU を無効化してエラーログを抑制する（描画はソフトウェア。
 *                 ターミナル用途では実害なし）。
 *  - 'default'  : スイッチ・env を足さず Chromium 任せ（macOS・WSL 3 以降の既定 / 明示的に素の挙動）。
 *
 * ※ WSL 2 の WSLg での HW アクセラ（HW OpenGL / Vulkan）は対応しない。Vulkan は HW ICD
 *    （dzn 等）が WSL 2 の WSLg に無く、OpenGL も体感差が無いうえ Mesa/Dawn 由来の警告が出るため。
 *    env フィールドは将来のモード拡張用に残してある（現状はどのモードも空）。
 * @param {string} mode 'off'|'default'
 * @returns {{ switches: string[][], env: Record<string,string> }}
 */
function gpuSwitches(mode) {
  switch (mode) {
    case 'off':
      return { switches: [['disable-gpu'], ['disable-software-rasterizer']], env: {} };
    case 'default':
    default:
      return { switches: [], env: {} };
  }
}

// 直近の applyGpuMode の結果（起動ログと設定パネルの表示に使う。起動処理で 1 回だけ解決する）。
let lastGpuStartup = null;

/**
 * 解決した GPU モードに従って Electron の app.commandLine へスイッチを適用し、
 * 追加環境変数を設定する。呼び出し側が argv で GPU スイッチを明示している場合は
 * 何もしない（競合回避。この場合は WSL の版も調べない）。app が ready になる前に呼ぶこと。
 * @param {import('electron').App} app Electron の app オブジェクト
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.platform]
 * @param {string} [opts.configMode] config.json 由来の gpu 値（env 未指定時に採用）
 * @param {object} [opts.deps] 自動判定の差し替え（テスト用）
 * @returns {string|null} 適用したモード（介入しなかった場合は null）
 */
function applyGpuMode(app, { argv = process.argv, env = process.env, platform = process.platform, configMode, deps } = {}) {
  if (hasExplicitGpuSwitch(argv)) {
    lastGpuStartup = { mode: null, source: 'switch', reason: 'explicit GPU switch', autoState: 'switch' };
    return null;
  }
  const decision = resolveGpuDecision({ env, platform, configMode, deps });
  lastGpuStartup = decision;
  const { switches, env: extraEnv } = gpuSwitches(decision.mode);
  // 追加 env は未設定のときだけ入れる（利用者が明示した値を尊重する）。
  for (const [k, v] of Object.entries(extraEnv)) {
    if (env[k] === undefined || env[k] === '') env[k] = v;
  }
  for (const sw of switches) {
    if (sw.length === 1) app.commandLine.appendSwitch(sw[0]);
    else app.commandLine.appendSwitch(sw[0], sw[1]);
  }
  return decision.mode;
}

/**
 * 今回の起動で解決した GPU モードの情報を返す（applyGpuMode 実行前は null）。
 * 設定パネルは、ここの autoState（'on' / 'off' / 'wsl-unknown' / 'switch' / null）で
 * 「自動」の選択肢の文言を変える。パネルを開くたびに wsl.exe を呼ばないための保持。
 * @returns {{ mode: string|null, source: string, reason: string, autoState: string|null }|null}
 */
function getGpuStartup() {
  return lastGpuStartup;
}

module.exports = {
  GPU_MODES,
  WSL_VERSION_TIMEOUT_MS,
  defaultGpuMode,
  isWsl,
  parseWslVersionOutput,
  readWslVersion,
  detectAutoGpu,
  resolveGpuDecision,
  resolveGpuMode,
  hasExplicitGpuSwitch,
  gpuSwitches,
  applyGpuMode,
  getGpuStartup,
};
