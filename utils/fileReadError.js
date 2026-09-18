'use strict';

// ファイル読み込みエラーをログへ渡す前に、例外オブジェクトをそのまま出さないよう変換する
// （安藤の指摘・A-7）。main.js の VAPID 鍵ファイル読み込み（tryLoadExistingVapidKeys /
// logInvalidVapidKeyFile）と購読情報ファイル読み込み（loadPushSubscriptions）の両方から
// 使う、Electron に依存しない純粋関数のため、main.js から Electron 依存を切り離して
// テストしやすくする他の utils/*（apiAuth.js・webPushKeys.js・notificationTrigger.js 等）と
// 同じ方針でここへ切り出している（司の指摘・B-2）。main.js 内に残したままだと自動テストで
// 固定できず、A-7 の修正（丸める処理そのもの・2か所の呼び出しの両方）が回帰していないかを
// レビューのたびに人手で確認する必要があった。

/**
 * @param {unknown} e
 * @returns {unknown}
 */
function sanitizeFileReadErrorForLog(e) {
  return e instanceof SyntaxError ? `${e.name} while parsing the file` : e;
}

module.exports = {
  sanitizeFileReadErrorForLog,
};
