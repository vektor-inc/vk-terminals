'use strict';

// アプリ内ブラウザで同時に開けるタブの数（issue #644）。画面側の「＋」の無効化と案内文もこの値を使う。
const MAX_TABS = 10;

/**
 * 「アプリ内で開く」で同じページのタブを探すときの比較用の文字列を作る。
 * `#` 以降と、パスの末尾の `/` を無視する。HTTP(S) 以外・解釈できない値は空文字を返す。
 *
 * @param {string} url 比べる URL
 * @returns {string} 比較用の文字列（比べられない場合は空文字）
 */
function toTabMatchKey(url) {
  if (typeof url !== 'string' || !url) return '';
  let parsed;
  try { parsed = new URL(url); } catch { return ''; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
  parsed.hash = '';
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
}

/**
 * タブを閉じたあとに選ぶタブを決める。閉じたタブの右隣を優先し、右が無ければ左隣にする。
 *
 * @param {number[]} order 閉じる前のタブ番号の並び
 * @param {number} closedId 閉じるタブの番号
 * @returns {number|null} 次に選ぶタブの番号（残るタブが無ければ null）
 */
function pickTabAfterClose(order, closedId) {
  const index = order.indexOf(closedId);
  if (index < 0) return null;
  return order[index + 1] ?? order[index - 1] ?? null;
}

/**
 * ページの新しいタブ要求（target="_blank"・window.open）の開き方を、Electron の disposition から決める。
 * Cmd / Ctrl を押しながらのクリック（background-tab）だけを後ろに開き、それ以外は前に出す。
 *
 * @param {string} disposition Electron の setWindowOpenHandler が渡す disposition
 * @returns {boolean} 前に出すか
 */
function shouldForegroundOpenedTab(disposition) {
  return disposition !== 'background-tab';
}

module.exports = { MAX_TABS, toTabMatchKey, pickTabAfterClose, shouldForegroundOpenedTab };
