'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeTaskSectionVisibility,
  isTaskViewStale,
  parseTaskUpdatedAt,
} = require('../utils/taskSectionVisibility');

const NOW = Date.parse('2026-07-19T00:00:00.000Z');
const STALE_MS = 120000;

function viewAt(ageMs, overrides = {}) {
  return {
    updatedAt: new Date(NOW - ageMs).toISOString(),
    tasks: overrides.tasks || [],
    ...overrides,
  };
}

test('updatedAt の時刻を parse し、不正値は null にする', () => {
  assert.equal(parseTaskUpdatedAt('2026-07-19T00:00:00.000Z'), NOW);
  assert.equal(parseTaskUpdatedAt(''), null);
  assert.equal(parseTaskUpdatedAt(null), null);
  assert.equal(parseTaskUpdatedAt('not-a-date'), null);
});

test('view が無い場合は stale 扱いだが、ラッチ前はタスクセクションを表示しない', () => {
  assert.deepEqual(
    computeTaskSectionVisibility(null, { hasSeenFresh: false, staleMs: STALE_MS, now: NOW }),
    {
      shouldShow: false,
      stale: true,
      hasFreshView: false,
      hasSeenFresh: false,
    }
  );
});

test('fresh な view を観測したら表示し、ラッチを立てる', () => {
  assert.deepEqual(
    computeTaskSectionVisibility(viewAt(60_000), { hasSeenFresh: false, staleMs: STALE_MS, now: NOW }),
    {
      shouldShow: true,
      stale: false,
      hasFreshView: true,
      hasSeenFresh: true,
    }
  );
});

test('ラッチ前の stale view はタスク残骸があっても表示しない', () => {
  assert.deepEqual(
    computeTaskSectionVisibility(
      viewAt(180_000, { tasks: [{ id: 1, title: '古いタスク' }] }),
      { hasSeenFresh: false, staleMs: STALE_MS, now: NOW }
    ),
    {
      shouldShow: false,
      stale: true,
      hasFreshView: false,
      hasSeenFresh: false,
    }
  );
});

test('ラッチ後の stale view は表示を維持する', () => {
  assert.deepEqual(
    computeTaskSectionVisibility(viewAt(180_000), { hasSeenFresh: true, staleMs: STALE_MS, now: NOW }),
    {
      shouldShow: true,
      stale: true,
      hasFreshView: false,
      hasSeenFresh: true,
    }
  );
});

test('stale 閾値は超過時のみ stale とする', () => {
  assert.equal(isTaskViewStale(viewAt(STALE_MS), { staleMs: STALE_MS, now: NOW }), false);
  assert.equal(isTaskViewStale(viewAt(STALE_MS + 1), { staleMs: STALE_MS, now: NOW }), true);
});
