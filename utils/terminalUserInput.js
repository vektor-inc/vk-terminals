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

// 端末の問い合わせ（DSR・DA・DECRQM・kitty キーボード・OSC 色）への応答だけ。
// フォーカス通知は別判定で採り直し対象にする。マウス通知は対象外。
const TERMINAL_QUERY_REPLY_PATTERN = new RegExp([
  '\\x1b\\[\\??\\d+;\\d+R',
  '\\x1b\\[\\??\\d+;\\d+\\$y',
  '\\x1b\\[0n',
  '\\x1b\\[[?>=][0-9;]*c',
  '\\x1b\\[\\?[0-9;]*u',
  '\\x1b\\](?:10|11);[\\s\\S]*?(?:\\x07|\\x1b\\\\)',
].join('|'), 'g');

/**
 * 入力が端末の問い合わせへの応答だけで構成されているか判定する。
 * 画面出力を伴わない書き込みとして、静止後の画面識別値の採り直しを予約してよいかの判定に使う。
 *
 * @param {*} input - terminal:input で PTY へ渡す入力。
 * @returns {boolean} 空でなく、問い合わせ応答以外が1文字も残らない場合のみ true。
 */
function isTerminalQueryReplyOnly(input) {
  if (typeof input !== 'string' || input.length === 0) return false;
  return input.replace(TERMINAL_QUERY_REPLY_PATTERN, '').length === 0;
}

/**
 * フォーカス通知だけの入力か判定する。通常入力後の出力待ち中は採り直しを予約できない。
 * 予約後に可視出力が届いた場合は取り消す。
 *
 * @param {*} input - terminal:input で PTY へ渡す入力。
 * @returns {boolean} フォーカス通知だけで構成される場合のみ true。
 */
function isTerminalFocusNotificationOnly(input) {
  return typeof input === 'string' && input.length > 0
    && /^(?:\x1b\[[IO])+$/.test(input);
}

/**
 * ペインごとに、利用者（または API）の入力があった回数を数える（issue #621）。
 * 端末の問い合わせへの応答やフォーカス・マウス通知では数を進めない。
 * 自動で起動し直す前に、待っている間に利用者が入力していないかを照合するために使う。
 *
 * @returns {{note: (id: string, data: *) => void, get: (id: string) => number, delete: (id: string) => void}}
 */
function createUserInputRevisions() {
  const revisions = new Map();
  return {
    // 利用者の入力を含む書き込みのときだけ番号を進める。
    note(id, data) {
      if (typeof data === 'string' && data.length > 0 && containsUserTerminalInput(data)) {
        revisions.set(String(id), (revisions.get(String(id)) || 0) + 1);
      }
    },
    get(id) {
      return revisions.get(String(id)) || 0;
    },
    delete(id) {
      revisions.delete(String(id));
    },
  };
}

module.exports = { containsUserTerminalInput, isTerminalQueryReplyOnly, isTerminalFocusNotificationOnly, createUserInputRevisions };
