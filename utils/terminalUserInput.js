'use strict';

// xterm.js が端末からの問い合わせへ自動で返す応答と、フォーカス・マウス通知。
// これらは onData に利用者のキー入力と同じ形で届くため、信頼確認の自動応答を止める
// 判定から除外する。矢印キー等の一般的な CSI はここへ含めない。
// Shift+F3 と Ctrl+F3 はカーソル位置応答と同じ形のため、安全側で自動応答として除外する。
const TERMINAL_AUTOMATIC_INPUT_PATTERN = new RegExp([
  '\\x1b\\[\\??\\d+;\\d+R',
  '\\x1b\\[\\??\\d+;\\d+\\$y',
  '\\x1b\\[0n',
  '\\x1b\\[[?>=][0-9;]*c',
  '\\x1b\\[\\?[0-9;]*u',
  '\\x1b\\[[IO]',
  '\\x1b\\[<[0-9]+;[0-9]+;[0-9]+[Mm]',
  '\\x1b\\[M[\\s\\S]{3}',
  '\\x1b\\](?:10|11);[\\s\\S]*?(?:\\x07|\\x1b\\\\)',
].join('|'), 'g');

/**
 * xterm.js の自動応答・通知を除いたあとに、利用者または外部 API 由来の入力が残るか判定する。
 *
 * @param {string} input - terminal:input または POST /api/send から PTY へ渡す入力。
 * @returns {boolean} 利用者操作として扱う入力が1文字でも残る場合は true。
 */
function containsUserTerminalInput(input) {
  if (typeof input !== 'string') return input !== undefined && input !== null;
  return input.replace(TERMINAL_AUTOMATIC_INPUT_PATTERN, '').length > 0;
}

module.exports = { containsUserTerminalInput };
