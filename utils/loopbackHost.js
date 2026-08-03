'use strict';

// ─── 待ち受けアドレスのループバック判定（issue #313 レビュー対応）─────────────
// 「同一マシンからしか到達できないアドレスかどうか」の判定を 1 か所に集約する。
// 元々は utils/apiAuth.js（Node 側の認証要否判定）だけが持っていたが、
// renderer/app.js（設定パネルの `apiHost` 入力欄が出す即時案内）が
// `value === '127.0.0.1'` の完全一致だけで同じ意味の判定を独自に行っており、
// `::1` や `::ffff:127.0.0.1` を入力すると実際には認証不要なのに「認証が
// 必須になります」という誤った警告が出ていた。判定ロジックを 2 か所に
// 持たないよう、ここへ切り出して両側から参照する。
//
// main（apiAuth.js 経由の require）と renderer（<script> でのグローバル）の
// 両方から使うため utils/closeConfirm.js と同じ UMD 形式にしている。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKLoopbackHost = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

// `apiHost` に `localhost` を指定した場合、Node の名前解決順によっては
// `::1`（IPv6 ループバック）で bind されることがあり、`127.0.0.1` との完全一致だけで
// 判定すると誤って認証必須になってしまう（issue #313 レビュー対応・中-3）。
// `127.0.0.0/8` 全体・`::1`・IPv4 射影アドレス（`::ffff:127.0.0.1` 形式）も同一視する。
// `0.0.0.0` / `::`（全 I/F 待受）はいずれのパターンにも一致せず、引き続き
// 「認証必須」のまま扱われる。
const IPV4_LOOPBACK_PATTERN = /^127(?:\.\d{1,3}){3}$/;
const IPV4_MAPPED_IPV6_PATTERN = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

/**
 * 待ち受けアドレス（または入力途中の文字列）がループバック（同一マシンからしか
 * 到達できないアドレス）かどうかを判定する。
 * @param {string} host
 * @returns {boolean}
 */
function isLoopbackHost(host) {
  const value = typeof host === 'string' ? host.trim() : '';
  if (!value) return false;
  if (value === '::1') return true;
  if (IPV4_LOOPBACK_PATTERN.test(value)) return true;
  const mapped = value.match(IPV4_MAPPED_IPV6_PATTERN);
  return !!(mapped && IPV4_LOOPBACK_PATTERN.test(mapped[1]));
}

// renderer/app.js の apiHost 入力欄が出す即時案内だけで使う判定（PR #315 安藤の
// セキュリティレビュー指摘）。'localhost' は IP リテラルではないため isLoopbackHost()
// では拾えないが、'127.0.0.1' より自然に入力されやすい文字列でもある。画面側が
// 「認証が必須になります」と誤案内すると、利用者が「もう保護されている」と誤認した
// まま tailscale serve 公開時に apiRequireAuthAlways を有効化し忘れる実害につながる
// （画面は必須と言うが実際は不要、という危険な方向にだけ倒れるズレ）。
//
// isLoopbackHost() 自体には 'localhost' を足さない。あちらは main.js が実際に bind
// したアドレス（IP リテラル）だけを受け取る前提で、shouldRequireAuth() の判定に
// 直結する。名前を loopback 扱いする条件を isLoopbackHost() に混ぜると、認証ゲート
// 側の判定まで緩んでしまう。
/**
 * apiHost 入力欄の即時案内用に、`value` が「実質的にループバック」とみなせるかを判定する。
 * 認証要否の判定（shouldRequireAuth）には使わないこと。
 * @param {string} value
 * @returns {boolean}
 */
function isLoopbackDisplayValue(value) {
  // 'localhost.'（末尾ドット付きの FQDN 形式）は実際には 'localhost' と同じ扱いで
  // ループバックへ bind されるが、末尾ドットが付いたままだと下の完全一致から漏れて
  // 「認証が必須になります」と誤案内していた（PR #315 再レビュー指摘・修正-3）。
  const trimmed = (typeof value === 'string' ? value.trim() : '').replace(/\.$/, '');
  if (!trimmed) return false;
  if (trimmed.toLowerCase() === 'localhost') return true;
  return isLoopbackHost(trimmed);
}

return {
  isLoopbackHost,
  isLoopbackDisplayValue,
};
});
