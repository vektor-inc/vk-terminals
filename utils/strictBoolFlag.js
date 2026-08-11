'use strict';

// POST /api/set-title の prMerged / prWaitingMerge（issue #44 / #363）など、
// 「厳密な true のときだけ true。それ以外（false・未指定・文字列 "true" 等）は
// すべて false に倒す」という同一規約を持つ真偽値フラグの共通パーサ。
// 未指定が false に倒れることが後方互換の担保になる（Orchestrator 経由でない
// リクエスト・古い Orchestrator からのリクエストで安全側の表示になる）。
//
// @param {*} value - リクエストボディ由来の値（型は不定）。
// @returns {boolean} value が厳密に true のときだけ true。
function parseStrictBoolFlag(value) {
  return value === true;
}

module.exports = { parseStrictBoolFlag };
