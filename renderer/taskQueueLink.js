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

// タスクの queueIssueUrl（個別 issue の実 URL）から、task-queue の issue 一覧ページ URL を
// 導出する純粋ヘルパー（issue #233）。サイドバーのタスク見出しを GitHub モード時に一覧 URL への
// リンクにするために使う。
//
//   https://github.com/<owner>/<repo>/issues/480  →  https://github.com/<owner>/<repo>/issues
//
// resolveQueueIssueUrl と同じく http(s) のみ許可し、不正入力は undefined を返す（安全側）。
// パスが `.../issues/<番号>` 形式でないもの（`/pull/<番号>` など）は一覧化せず undefined にする。
// 末尾スラッシュ（`.../issues/480/`）は許容し、クエリ・ハッシュは一覧 URL からは落とす。
function resolveQueueIssuesListUrl(url) {
  if (typeof url !== 'string') return undefined;
  const trimmed = url.trim();
  if (!trimmed || trimmed.length > 2048) return undefined;
  let u;
  try {
    u = new URL(trimmed);
  } catch (_e) {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  // パスが `.../issues/<番号>`（末尾スラッシュ可）のときだけ末尾の `/<番号>` を落として一覧にする。
  const match = /^(.*\/issues)\/\d+\/?$/.exec(u.pathname);
  if (!match) return undefined;
  return `${u.origin}${match[1]}`;
}

module.exports = {
  resolveQueueIssueUrl,
  resolveQueueIssuesListUrl,
};
