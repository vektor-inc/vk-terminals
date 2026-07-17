'use strict';

// ─── ペインを閉じる際の確認要否判定（issue #184）─────────────────────────────
// config.json の `confirmClose` で挙動を切り替える。
//   - 'never'  … 確認なしで閉じる
//   - 'busy'   … status が running / waiting のときだけ確認する（既定）
//   - 'always' … 常に確認する
// main（app:get-config / 設定ディスクリプタ）と renderer（closePane ガード）の
// 双方から使うため utils に置く。

const CONFIRM_CLOSE_MODES = ['never', 'busy', 'always'];
const DEFAULT_CONFIRM_CLOSE = 'busy';

// config の値を正規化する。未指定・不正値は既定の 'busy' に落とす。
function normalizeConfirmClose(value) {
  return CONFIRM_CLOSE_MODES.includes(value) ? value : DEFAULT_CONFIRM_CLOSE;
}

// ペインを閉じる前に確認ダイアログを挟むべきかを判定する。
// mode は正規化前の値でも受け付ける（不正値は 'busy' 扱い）。
function shouldConfirmClose(mode, status) {
  const normalized = normalizeConfirmClose(mode);
  if (normalized === 'never') return false;
  if (normalized === 'always') return true;
  return status === 'running' || status === 'waiting';
}

module.exports = {
  CONFIRM_CLOSE_MODES,
  DEFAULT_CONFIRM_CLOSE,
  normalizeConfirmClose,
  shouldConfirmClose,
};
