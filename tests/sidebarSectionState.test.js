'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  LEGACY_TASK_STORAGE_KEY,
  STORAGE_KEY,
  migrateLegacyState,
  parseCollapsedSections,
  readCollapsedSections,
  writeSectionCollapsed,
} = require('../utils/sidebarSectionState');

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
    values,
  };
}

test('JSON オブジェクトから boolean のセクション状態だけを読み取る', () => {
  assert.deepEqual(
    { ...parseCollapsedSections('{"task-list":true,"pane-stash":false,"invalid":"1"}') },
    { 'task-list': true, 'pane-stash': false }
  );
  assert.deepEqual({ ...parseCollapsedSections('invalid json') }, {});
  assert.deepEqual({ ...parseCollapsedSections('[]') }, {});
  const unsafeNames = parseCollapsedSections('{"__proto__":true,"constructor":false,"prototype":true}');
  assert.equal(unsafeNames['__proto__'], true);
  assert.equal(unsafeNames.constructor, false);
  assert.equal(unsafeNames.prototype, true);
  assert.equal(Object.getPrototypeOf(parseCollapsedSections('{}')), null);
});

test('新形式が無い初回だけ旧タスク状態を移行し、旧キーを削除する', () => {
  const storage = createStorage({ [LEGACY_TASK_STORAGE_KEY]: '1' });

  assert.equal(migrateLegacyState(storage), true);
  assert.deepEqual({ ...readCollapsedSections(storage) }, { 'task-list': true });
  assert.equal(storage.getItem(STORAGE_KEY), '{"task-list":true}');
  assert.equal(storage.getItem(LEGACY_TASK_STORAGE_KEY), null);

  storage.setItem(LEGACY_TASK_STORAGE_KEY, '0');
  assert.equal(migrateLegacyState(storage), true);
  assert.deepEqual({ ...readCollapsedSections(storage) }, { 'task-list': true });
});

test('旧タスク状態が開の場合も空オブジェクトで新形式を初期化する', () => {
  const storage = createStorage({ [LEGACY_TASK_STORAGE_KEY]: '0' });

  assert.equal(migrateLegacyState(storage), true);
  assert.deepEqual({ ...readCollapsedSections(storage) }, {});
  assert.equal(storage.getItem(STORAGE_KEY), '{}');
  assert.equal(storage.getItem(LEGACY_TASK_STORAGE_KEY), null);
});

test('read は移行や初回初期化を書き込まない', () => {
  const storage = createStorage({ [LEGACY_TASK_STORAGE_KEY]: '1' });

  assert.deepEqual({ ...readCollapsedSections(storage) }, {});
  assert.equal(storage.getItem(STORAGE_KEY), null);
  assert.equal(storage.getItem(LEGACY_TASK_STORAGE_KEY), '1');

  const freshStorage = createStorage();
  assert.equal(migrateLegacyState(freshStorage), true);
  assert.equal(freshStorage.getItem(STORAGE_KEY), null);
});

test('セクションごとの状態を同じ JSON オブジェクトへ保存する', () => {
  const storage = createStorage({
    [STORAGE_KEY]: '{"task-list":true}',
  });

  assert.equal(writeSectionCollapsed('pane-stash', true, storage), true);
  assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)), {
    'task-list': true,
    'pane-stash': true,
  });
  assert.equal(writeSectionCollapsed('pane-stash', false, storage), true);
  assert.equal(readCollapsedSections(storage)['pane-stash'], false);
  assert.equal(writeSectionCollapsed('__proto__', true, storage), true);
  assert.equal(readCollapsedSections(storage)['__proto__'], true);
  assert.equal(writeSectionCollapsed('', true, storage), false);
});

test('storage が利用できない場合は既定の開状態へフォールバックする', () => {
  const storage = {
    getItem() { throw new Error('unavailable'); },
  };

  assert.deepEqual({ ...readCollapsedSections(storage) }, {});
  assert.equal(migrateLegacyState(storage), false);
  assert.equal(writeSectionCollapsed('task-list', true, storage), false);
});

test('localStorage プロパティの取得自体が失敗しても引数なしで安全に使える', () => {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    get() { throw new Error('blocked'); },
  });
  try {
    assert.deepEqual({ ...readCollapsedSections() }, {});
    assert.equal(migrateLegacyState(), false);
    assert.equal(writeSectionCollapsed('task-list', true), false);
  } finally {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'localStorage', originalDescriptor);
    } else {
      delete globalThis.localStorage;
    }
  }
});
