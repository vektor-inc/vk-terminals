'use strict';

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

module.exports = {
  DEFAULT_TASKS_ORCHESTRATOR_STALE_MS,
  computeTaskSectionVisibility,
  isTaskViewStale,
  parseTaskUpdatedAt,
};
