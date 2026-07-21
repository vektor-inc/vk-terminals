'use strict';

// サイドバーのタスク一覧で、タスクの queueIssueUrl を「リンク化してよい URL」か
// どうか判定する純粋ヘルパー（issue #177 / 元 vk-orchestrator#177）。
//
// vk-orchestrator が書き出すスナップショット（~/.task-queue/tasks-view.json）の各タスクには
// queueIssueUrl が入る。
//   - GitHub モード: https://github.com/.../issues/N（実 URL） → リンク化する
//   - ローカルモード: local://queue/<id> → リンク化しない（プレーンテキストのまま）
//
// http(s) 以外（local:// など）を弾くことで、GitHub モードのときだけ実 URL を返す。
// app.js 側の isSafeExternalUrl / openExternalUrlSafe と同じ「http(s) のみ許可」方針に揃える。
function resolveQueueIssueUrl(url) {
  if (typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 2048) return undefined;
  try {
    const u = new URL(trimmed);
    if (u.protocol === 'http:' || u.protocol === 'https:') return trimmed;
  } catch (_e) {
    return undefined;
  }
  return undefined;
}

module.exports = {
  resolveQueueIssueUrl,
};
