// タイトル行（.pane-task-title / 格納カードのタイトル行）を作り直すかどうかの判定（issue #614）。
//
// renderTaskTitleContent()（renderer/app.js）はタイトルリンクと PR ラベルを全消去して
// 作り直す。Codex はスピナーで OSC タイトルを高頻度に書き換えるため、表示が API タイトルで
// 変わっていなくても作り直しが走り、押した要素と離した要素が入れ替わって click が成立しなかった
// （ツールチップも出ず、PR ラベルが点滅して見えた）。
// 描画に使う 5 つの値（title・url・prUrl・prMerged・waitingMerge）を要素ごとに覚えておき、
// すべて同じで中身も描画済みなら作り直さない。
//
// Node（require）とブラウザ（index.html の <script>）の両方から使える UMD 形式。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKTaskTitleRenderState = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 比較用に値を揃える。真偽値は getPrBadgePresentation と同じく boolean の true だけを true とする。
  function normalizeTaskTitleRenderState(state) {
    const s = state || {};
    return {
      title: s.title == null ? '' : String(s.title),
      url: s.url == null ? '' : String(s.url),
      prUrl: s.prUrl == null ? '' : String(s.prUrl),
      prMerged: s.prMerged === true,
      waitingMerge: s.waitingMerge === true,
    };
  }

  function isSameTaskTitleRenderState(a, b) {
    if (!a || !b) return false;
    return a.title === b.title
      && a.url === b.url
      && a.prUrl === b.prUrl
      && a.prMerged === b.prMerged
      && a.waitingMerge === b.waitingMerge;
  }

  // 前回描画した値は要素をキーにした WeakMap に持つ（ペイン・格納カードごとに区別され、
  // 要素が破棄されれば一緒に消える）。新しく作った要素は前回値を持たないので必ず描画される。
  function createTaskTitleRenderTracker() {
    const lastRendered = new WeakMap();
    return {
      // 作り直す必要があれば true を返し、今回の値を前回値として記録する。
      shouldRender(el, state) {
        const next = normalizeTaskTitleRenderState(state);
        const prev = lastRendered.get(el);
        if (prev && isSameTaskTitleRenderState(prev, next) && el.firstChild) return false;
        lastRendered.set(el, next);
        return true;
      },
    };
  }

  return {
    createTaskTitleRenderTracker,
    isSameTaskTitleRenderState,
    normalizeTaskTitleRenderState,
  };
});
