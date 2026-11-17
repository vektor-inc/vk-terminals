'use strict';

// Codex の起動直後に、利用者が求めていない端末通知を PTY へ流さないための時間窓（issue #621）。
//
// Codex は起動時に端末へ問い合わせを送り、保護画面（作業フォルダの信頼確認など）を出す前に
// 端末の入力を読み捨てる。読み捨ては入力が途切れず届き続けると 1 秒で時間切れになり、
// `timed out discarding buffered terminal input` で終了する。xterm.js は Codex がフォーカス通知・
// マウス通知を有効にした直後から、利用者の操作と無関係に通知を返すため、この時間だけ落とす。
// 問い合わせへの応答（DA・カーソル位置・色）は Codex が待っているため落とさない。

const LAUNCH_INPUT_QUIET_MS = 3000;

// フォーカス通知（CSI I / CSI O）と、マウス通知（SGR 形式・X10 形式）だけで構成される入力。
const UNSOLICITED_NOTIFICATION_PATTERN = /^(?:\x1b\[[IO]|\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3})+$/;

/**
 * 入力がフォーカス・マウス通知だけで構成されているか判定する。
 *
 * @param {*} data - terminal:input で PTY へ渡す入力。
 * @returns {boolean} 空でなく、通知以外が 1 文字も含まれない場合のみ true。
 */
function isUnsolicitedTerminalNotification(data) {
  return typeof data === 'string' && data.length > 0 && UNSOLICITED_NOTIFICATION_PATTERN.test(data);
}

/**
 * ペインごとの「起動直後の入力を抑える時間窓」を管理する。
 *
 * @param {object} [options]
 * @param {() => number} [options.now] 単調増加の現在時刻（ミリ秒）。
 * @param {number} [options.windowMs] 起動コマンドを書いてから抑える時間。
 * @returns {{begin: (id: string) => void, shouldDrop: (id: string, data: *) => boolean, delete: (id: string) => void}}
 */
function createLaunchInputQuietWindow({ now = () => performance.now(), windowMs = LAUNCH_INPUT_QUIET_MS } = {}) {
  const quietUntil = new Map();
  return {
    // 起動コマンドを書き込んだ直後に呼ぶ。
    begin(id) {
      quietUntil.set(String(id), now() + windowMs);
    },
    // 時間窓の中で、通知だけの入力なら true（PTY へ書き込まない）。
    shouldDrop(id, data) {
      const key = String(id);
      const until = quietUntil.get(key);
      if (until === undefined) return false;
      if (now() >= until) {
        quietUntil.delete(key);
        return false;
      }
      return isUnsolicitedTerminalNotification(data);
    },
    delete(id) {
      quietUntil.delete(String(id));
    },
  };
}

module.exports = { LAUNCH_INPUT_QUIET_MS, isUnsolicitedTerminalNotification, createLaunchInputQuietWindow };
