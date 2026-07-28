'use strict';

const fs = require('fs');
const path = require('path');
const { hasUnsafeKeySegment } = require('./settingsTargets');

const SETTINGS_SCHEMA_PATH = path.join(__dirname, 'settings-schema.json');
const DEFAULT_SCHEMA_TITLE = 'VK Terminals 設定';
const DEFAULT_SCHEMA_NOTE = '保存後、次回の起動から反映されます。';

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function validateSettingsSchema(schema) {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return false;
  if (!Array.isArray(schema.groups)) return false;

  for (const group of schema.groups) {
    if (!group || typeof group !== 'object' || Array.isArray(group)) return false;
    if (!Array.isArray(group.fields)) return false;

    for (const field of group.fields) {
      if (!field || typeof field !== 'object' || Array.isArray(field)) return false;
      if (
        typeof field.key !== 'string'
        || field.key.trim() === ''
        || hasUnsafeKeySegment(field.key)
      ) return false;
      if (typeof field.label !== 'string' || field.label.trim() === '') return false;
      if (typeof field.type !== 'string' || field.type.trim() === '') return false;
      if (field.options !== undefined && !Array.isArray(field.options)) return false;
    }
  }

  return true;
}

function fallbackSettingsSchema() {
  return {
    title: DEFAULT_SCHEMA_TITLE,
    note: DEFAULT_SCHEMA_NOTE,
    groups: [],
  };
}

function loadSettingsSchema(options = {}) {
  const schemaPath = options.schemaPath || SETTINGS_SCHEMA_PATH;
  const onError = typeof options.onError === 'function' ? options.onError : null;

  try {
    const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf8'));
    if (!validateSettingsSchema(schema)) {
      throw new Error('Invalid settings schema structure');
    }
    const loaded = cloneJson(schema);
    // tabs（任意）が配列でない場合は、その定義だけ落としてタブ無し表示に degrade させる。
    // 検証エラー扱いにすると schema 全体が fallback（groups: []）に落ち、タブの型ミス 1 つで
    // 設定パネルの項目が全部消えてしまうため。タブの中身の妥当性は renderer 側の
    // normalizeSettingsTabs / normalizeSettingsTabContent が不正要素を落として吸収する。
    if (loaded.tabs !== undefined && !Array.isArray(loaded.tabs)) {
      delete loaded.tabs;
    }
    return loaded;
  } catch (error) {
    if (onError) onError(error, schemaPath);
    return fallbackSettingsSchema();
  }
}

function buildBuiltinSettingsDescriptor(options = {}) {
  const schema = loadSettingsSchema(options);
  return {
    ...schema,
    title: typeof schema.title === 'string' && schema.title.trim() ? schema.title : DEFAULT_SCHEMA_TITLE,
    note: typeof schema.note === 'string' ? schema.note : DEFAULT_SCHEMA_NOTE,
    targetPath: options.targetPath,
    groups: Array.isArray(schema.groups) ? schema.groups : [],
  };
}

module.exports = {
  SETTINGS_SCHEMA_PATH,
  buildBuiltinSettingsDescriptor,
  loadSettingsSchema,
  validateSettingsSchema,
};
