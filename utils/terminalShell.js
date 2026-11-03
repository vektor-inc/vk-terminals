const path = require('path');

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

/**
 * 新規ターミナルで使うシェルを選ぶ。Linux では相対パスの SHELL は採用しない。
 *
 * @param {object} options 選択に必要な OS 情報と依存関係。
 * @param {string} options.platform Node.js のプラットフォーム名。
 * @param {object} options.env プロセスの環境変数。
 * @param {object|null} options.userInfo OS のユーザー情報。
 * @param {(candidate: string) => boolean} options.isExecutableShell 実行可能なシェルの確認関数。
 * @returns {string} 選択したシェル。
 */
function pickTerminalShell({ platform, env, userInfo, isExecutableShell }) {
  // macOS と Windows は、既存のフォールバック順を維持する。
  if (platform === 'darwin') return env.SHELL || '/bin/zsh';
  if (platform === 'win32') return env.SHELL || env.COMSPEC || 'powershell.exe';

  // Linux 系では、絶対パスかつ制御文字を含まない実行可能な候補だけを採用する。
  const candidates = [env.SHELL, userInfo?.shell, '/bin/bash', '/bin/sh'];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || CONTROL_CHARACTER.test(candidate)) continue;
    if (isExecutableShell(candidate)) return candidate;
  }

  const searched = candidates.map((candidate) => (
    typeof candidate === 'string' && candidate.length > 0 ? candidate : '<unset>'
  ));
  throw new Error(`No executable shell found. Searched: ${searched.join(', ')}`);
}

module.exports = { pickTerminalShell };
