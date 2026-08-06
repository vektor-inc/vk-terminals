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

function createCollapsedSections() {
  return Object.create(null);
}

function getStorage(storage) {
  if (storage) return storage;
  try {
    return typeof globalThis !== 'undefined' ? globalThis.localStorage : null;
  } catch (_e) {
    return null;
  }
}

function normalizeCollapsedSections(value) {
  // null プロトタイプなら、外部由来のセクション名も組み込みプロパティと衝突しない。
  const normalized = createCollapsedSections();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return normalized;
  for (const [sectionId, collapsed] of Object.entries(value)) {
    if (typeof collapsed === 'boolean') normalized[sectionId] = collapsed;
  }
  return normalized;
}

function parseCollapsedSections(value) {
  if (typeof value !== 'string' || !value) return createCollapsedSections();
  try {
    return normalizeCollapsedSections(JSON.parse(value));
  } catch (_e) {
    return createCollapsedSections();
  }
}

function readCollapsedSections(storage) {
  const resolvedStorage = getStorage(storage);
  if (!resolvedStorage) return createCollapsedSections();
  try {
    return parseCollapsedSections(resolvedStorage.getItem(STORAGE_KEY));
  } catch (_e) {
    return createCollapsedSections();
  }
}

function migrateLegacyState(storage) {
  // true は実際に移行したかではなく、移行不要の場合も含めてエラー無く完了したことを表す。
  const resolvedStorage = getStorage(storage);
  if (!resolvedStorage) return false;
  try {
    if (resolvedStorage.getItem(STORAGE_KEY) !== null) return true;
    const legacyValue = resolvedStorage.getItem(LEGACY_TASK_STORAGE_KEY);
    if (legacyValue === null) return true;

    const migrated = createCollapsedSections();
    if (legacyValue === '1') migrated[TASK_SECTION_ID] = true;
    resolvedStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    // 移行は片道。旧版へ戻すと新キーを読めず、タスク一覧は開いた状態へ戻る。
    try { resolvedStorage.removeItem(LEGACY_TASK_STORAGE_KEY); }
    catch (_e) { /* 新形式の保存が済んでいるため、旧キーの削除失敗は起動を妨げない */ }
    return true;
  } catch (_e) {
    return false;
  }
}

function writeSectionCollapsed(sectionId, collapsed, storage) {
  if (typeof sectionId !== 'string' || !sectionId) return false;
  const resolvedStorage = getStorage(storage);
  if (!resolvedStorage) return false;
  try {
    const sections = readCollapsedSections(resolvedStorage);
    sections[sectionId] = collapsed === true;
    resolvedStorage.setItem(STORAGE_KEY, JSON.stringify(sections));
    return true;
  } catch (_e) {
    return false;
  }
}

return {
  LEGACY_TASK_STORAGE_KEY,
  STORAGE_KEY,
  migrateLegacyState,
  parseCollapsedSections,
  readCollapsedSections,
  writeSectionCollapsed,
};
});
