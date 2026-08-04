'use strict';

// renderer/mobile.html（HTTP 配信）向け CSP（Content Security Policy）ヘッダーの
// 組み立て（issue #324）。main.js から Electron 依存を切り離してテストしやすくする
// ため、apiAuth.js と同じ方針でここへ切り出している。
//
// renderer/index.html（file:// 直読み込み）側は <meta http-equiv> の静的な文字列を
// そのまま使っており、こちらの関数は使わない。<meta> は frame-ancestors / sandbox /
// report-uri を仕様上無視するため、そもそも index.html 側にそれらのディレクティブを
// 持たせる意味が無い（詳細は renderer/index.html のコメントを参照）。

/**
 * renderer/mobile.html 向けの Content-Security-Policy ヘッダー値を返す。
 *
 * index.html 側の <meta> 指定との違い:
 *   - connect-src が 'self'（index.html は 'none'）。mobile.js が
 *     /api/states・/api/widgets・/api/send 等へ同一オリジン fetch でポーリング・
 *     操作するため、'none' にすると画面が壊れる。
 *   - frame-ancestors 'none' を持つ。<meta> では frame-ancestors が無視されるため
 *     index.html 側には書けないが、mobile.html は HTTP レスポンスヘッダーとして
 *     配信できるのでここに持たせられる。他サイトが本ページを iframe に埋め込んで
 *     利用者の操作を乗っ取る（クリックジャッキング）手口への対策。
 *   - script-src はどちらも 'self' のみで、追加の許可は無い（mobile.js 等の
 *     スクリプトはこのサーバーが同一オリジンの絶対パスで配信するため、xterm 実体の
 *     ような file:// 越しの読み込みが発生しない）。
 *
 * @returns {string} Content-Security-Policy ヘッダーの値
 */
function buildMobileCsp() {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

module.exports = {
  buildMobileCsp,
};
