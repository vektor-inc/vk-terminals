'use strict';

// main プロセス側（main.js）の HTTP API 受け口専用のパーサ。
// POST /api/set-title の prMerged / prWaitingMerge（issue #44 / #363）など、
// 「厳密な true のときだけ true。それ以外（false・未指定・文字列 "true" 等）は
// すべて false に倒す」という同一規約を持つ真偽値フラグの共通パーサ。
// 未指定が false に倒れることが後方互換の担保になる（Orchestrator 経由でない
// リクエスト・古い Orchestrator からのリクエストで安全側の表示になる）。
// renderer 側（app.js / mobile.js）は CommonJS の require が使えないため、
// この module は main プロセス以外からは読み込まない。renderer 側は同じ
// 「厳密な true のみ true」の規約を各所で個別に実装している（それ自体は妥当。
// 安藤レビュー・LOW・issue #363）。
//
// @param {*} value - リクエストボディ由来の値（型は不定）。
// @returns {boolean} value が厳密に true のときだけ true。
function parseStrictBoolFlag(value) {
  return value === true;
}

module.exports = { parseStrictBoolFlag };
