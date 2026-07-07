'use strict';

// GUI(Electron) の GPU 起動モード。
//
// VK Terminals は Electron アプリで、Chromium が起動時に GPU を初期化する。
// macOS では HW アクセラがそのまま効くが、WSLg 等の Linux では GPU 初期化に失敗し
// `Exiting GPU process` / `kTransientFailure` などのエラーが多発する（利用可能な
// Vulkan ICD がソフトウェア実装のみで SwiftShader へフォールバックするため）。
// 起動モードを環境変数 VK_TERMINALS_GPU で選べるようにし、Chromium スイッチと
// 追加環境変数へ写像する。
//
// 呼び出し側（VK Orchestrator など）が argv で GPU スイッチを明示している場合は、
// そちらを尊重してこのモジュールは介入しない（二重指定による競合を避ける）。

/** GPU 起動モードの取りうる値。 */
const GPU_MODES = ['off', 'default'];

/**
 * GPU 起動モードのプラットフォーム既定値を返す。
 * macOS は HW アクセラがそのまま効くためスイッチ不要（'default'）。
 * それ以外（WSLg 等の Linux、およびネイティブ Windows を含む darwin 以外の全て）は
 * GPU 初期化失敗によるエラーを抑制するため 'off'。
 * @param {string} [platform] process.platform 互換の値
 * @returns {'off'|'default'}
 */
function defaultGpuMode(platform = process.platform) {
  return platform === 'darwin' ? 'default' : 'off';
}

/**
 * GPU 起動モードを解決する。
 * 優先順位: 環境変数 VK_TERMINALS_GPU > config.json の gpu > プラットフォーム既定。
 * いずれも空文字・未知の値の場合は次の候補へフォールバックする。
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [platform]
 * @param {string} [configMode] config.json 由来の gpu 値（任意）
 * @returns {'off'|'default'}
 */
function resolveGpuMode(env = process.env, platform = process.platform, configMode) {
  const fromEnv = String(env.VK_TERMINALS_GPU ?? '').trim().toLowerCase();
  if (GPU_MODES.includes(fromEnv)) return fromEnv;
  const fromConfig = String(configMode ?? '').trim().toLowerCase();
  if (GPU_MODES.includes(fromConfig)) return fromConfig;
  return defaultGpuMode(platform);
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
 *  - 'default'  : スイッチ・env を足さず Chromium 任せ（macOS 既定 / 明示的に素の挙動）。
 *
 * ※ WSLg での HW アクセラ（HW OpenGL / Vulkan）は対応しない。Vulkan は HW ICD
 *    （dzn 等）が WSLg に無く、OpenGL も体感差が無いうえ Mesa/Dawn 由来の警告が出るため。
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

/**
 * 解決した GPU モードに従って Electron の app.commandLine へスイッチを適用し、
 * 追加環境変数を設定する。呼び出し側が argv で GPU スイッチを明示している場合は
 * 何もしない（競合回避）。app が ready になる前に呼ぶこと。
 * @param {import('electron').App} app Electron の app オブジェクト
 * @param {object} [opts]
 * @param {string[]} [opts.argv]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {string} [opts.platform]
 * @param {string} [opts.configMode] config.json 由来の gpu 値（env 未指定時に採用）
 * @returns {string|null} 適用したモード（介入しなかった場合は null）
 */
function applyGpuMode(app, { argv = process.argv, env = process.env, platform = process.platform, configMode } = {}) {
  if (hasExplicitGpuSwitch(argv)) return null;
  const mode = resolveGpuMode(env, platform, configMode);
  const { switches, env: extraEnv } = gpuSwitches(mode);
  // 追加 env は未設定のときだけ入れる（利用者が明示した値を尊重する）。
  for (const [k, v] of Object.entries(extraEnv)) {
    if (env[k] === undefined || env[k] === '') env[k] = v;
  }
  for (const sw of switches) {
    if (sw.length === 1) app.commandLine.appendSwitch(sw[0]);
    else app.commandLine.appendSwitch(sw[0], sw[1]);
  }
  return mode;
}

module.exports = {
  GPU_MODES,
  defaultGpuMode,
  resolveGpuMode,
  hasExplicitGpuSwitch,
  gpuSwitches,
  applyGpuMode,
};
