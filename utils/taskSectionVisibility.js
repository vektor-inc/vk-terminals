'use strict';

// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKTaskSectionVisibility = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

const DEFAULT_TASKS_ORCHESTRATOR_STALE_MS = 120000;

function parseTaskUpdatedAt(value) {
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function isTaskViewStale(view, options = {}) {
  if (!view || view.unavailable === true) return true;
  const updatedAtMs = parseTaskUpdatedAt(view.updatedAt);
  if (!updatedAtMs) return true;
  const staleMs = Number.isFinite(options.staleMs)
    ? options.staleMs
    : DEFAULT_TASKS_ORCHESTRATOR_STALE_MS;
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  return now - updatedAtMs > staleMs;
}

function computeTaskSectionVisibility(view, options = {}) {
  const hasSeenFresh = options.hasSeenFresh === true;
  const stale = isTaskViewStale(view, options);
  const hasFreshView = !!view && !stale;
  const nextHasSeenFresh = hasSeenFresh || hasFreshView;
  return Object.freeze({
    shouldShow: nextHasSeenFresh,
    stale,
    hasFreshView,
    hasSeenFresh: nextHasSeenFresh,
  });
}

return {
  DEFAULT_TASKS_ORCHESTRATOR_STALE_MS,
  computeTaskSectionVisibility,
  isTaskViewStale,
  parseTaskUpdatedAt,
};
});
