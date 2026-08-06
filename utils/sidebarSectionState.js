'use strict';

// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #337）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSidebarSectionState = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

const STORAGE_KEY = 'vkt.sidebarSectionsCollapsed';
const LEGACY_TASK_STORAGE_KEY = 'vkt.taskListCollapsed';
const TASK_SECTION_ID = 'task-list';

function normalizeCollapsedSections(value) {
  const normalized = {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  for (const [sectionId, collapsed] of Object.entries(value)) {
    if (sectionId === '__proto__' || sectionId === 'constructor' || sectionId === 'prototype') continue;
    if (typeof collapsed === 'boolean') normalized[sectionId] = collapsed;
  }
  return normalized;
}

function parseCollapsedSections(value) {
  if (typeof value !== 'string' || !value) return {};
  try {
    return normalizeCollapsedSections(JSON.parse(value));
  } catch (_e) {
    return {};
  }
}

function readCollapsedSections(storage) {
  try {
    const stored = storage.getItem(STORAGE_KEY);
    if (stored !== null) return parseCollapsedSections(stored);

    const migrated = {};
    if (storage.getItem(LEGACY_TASK_STORAGE_KEY) === '1') {
      migrated[TASK_SECTION_ID] = true;
    }
    storage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    // 新形式を先に保存してから旧キーを消し、以後の起動で再移行や二重管理を起こさない。
    try { storage.removeItem(LEGACY_TASK_STORAGE_KEY); }
    catch (_e) { /* 新形式の保存が済んでいるため、旧キーの削除失敗は読み込みを妨げない */ }
    return migrated;
  } catch (_e) {
    return {};
  }
}

function writeSectionCollapsed(storage, sectionId, collapsed) {
  if (
    typeof sectionId !== 'string'
    || !sectionId
    || sectionId === '__proto__'
    || sectionId === 'constructor'
    || sectionId === 'prototype'
  ) return false;
  try {
    const sections = readCollapsedSections(storage);
    sections[sectionId] = collapsed === true;
    storage.setItem(STORAGE_KEY, JSON.stringify(sections));
    return true;
  } catch (_e) {
    return false;
  }
}

return {
  LEGACY_TASK_STORAGE_KEY,
  STORAGE_KEY,
  parseCollapsedSections,
  readCollapsedSections,
  writeSectionCollapsed,
};
});
