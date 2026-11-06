// ペイン status の表示ラベル・aria・並び順を共有する。
//
// Node（require）とブラウザ（mobile.html の <script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKStatusPresentation = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const BACKGROUND_WORK_REASON = '裏で作業が動いています';

  // バッジの解決済みラベルを使い、各画面の閉じる確認をそろえる。
  function getCloseConfirmation(label, backgroundWorkRunning) {
    if (!label) return 'このペインを閉じますか？';
    const state = `このペインは「${label}」`;
    const detail = backgroundWorkRunning
      ? (label === '完了' || label === '見守り中' ? `ですが、${BACKGROUND_WORK_REASON}。` : `です（${BACKGROUND_WORK_REASON}）。`)
      : 'です。';
    return `${state}${detail}閉じるとセッションは失われます。閉じますか？`;
  }

  const STATUS_ORDER = Object.freeze(['waiting', 'running', 'idle']);
  const STATUS_RANK = Object.freeze({
    waiting: 0,
    running: 1,
    idle: 2,
  });

  // paneNote（issue #536）。POST /api/set-title で受け取る「見守り中」「完了」の注記。
  const PANE_NOTE_PRESENTATION = Object.freeze({
    done: { label: '完了', ariaLabel: 'ステータス: 完了' },
    watching: { label: '見守り中', ariaLabel: 'ステータス: 見守り中' },
  });

  // ペインのバッジの文言・色（visualStatus）を返す。
  // 優先順位: 入力待ち ＞ 完了 ＞ 見守り中 ＞ 実行中 ＞ 表示なし。
  // 計算上の状態（displayStatus）は変えず、ここで文言と色だけを差し替える。
  // visualStatus はバッジの data-status に使う値で、paneNote が効いているときだけ 'done' / 'watching' になる。
  function getStatusPresentation(status, paneNote) {
    if (status === 'waiting') {
      return { label: '入力待ち', ariaLabel: 'ステータス: 入力待ち', visualStatus: 'waiting' };
    }
    if (typeof paneNote === 'string' && Object.prototype.hasOwnProperty.call(PANE_NOTE_PRESENTATION, paneNote)) {
      return Object.assign({ visualStatus: paneNote }, PANE_NOTE_PRESENTATION[paneNote]);
    }
    if (status === 'running') {
      return { label: '実行中', ariaLabel: 'ステータス: 実行中', visualStatus: 'running' };
    }
    return { label: '', ariaLabel: '', visualStatus: typeof status === 'string' ? status : 'idle' };
  }

  // POST /api/set-title 1 回分の更新を、ペインが持つ paneNote へ反映した新しい値を返す。
  //   - update.provided が true → update.value（'watching' / 'done' / null）
  //   - 送られていない場合は、title が変わったとき（別のタスクに移った）だけ null に戻し、
  //     変わらないときは現在値を保つ
  //   - update が不正（古い呼び出し元など）なら現在値を保つ
  function resolvePaneNote(current, update, prevTitle, nextTitle) {
    const currentNote = (current === 'watching' || current === 'done') ? current : null;
    if (update && update.provided === true) {
      return (update.value === 'watching' || update.value === 'done') ? update.value : null;
    }
    if (!update || typeof update !== 'object') return currentNote;
    return (prevTitle || '') !== (nextTitle || '') ? null : currentNote;
  }

  function getStatusRank(status) {
    return STATUS_RANK[status] != null ? STATUS_RANK[status] : STATUS_ORDER.length;
  }

  function compareStatus(a, b) {
    return getStatusRank(a) - getStatusRank(b);
  }

  return {
    BACKGROUND_WORK_REASON,
    getCloseConfirmation,
    STATUS_ORDER,
    STATUS_RANK,
    compareStatus,
    getStatusPresentation,
    getStatusRank,
    resolvePaneNote,
  };
});
