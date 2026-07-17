'use strict';

const fs = require('fs');
const path = require('path');

const SETTINGS_SCHEMA_PATH = path.join(__dirname, 'settings-schema.json');
const DEFAULT_SCHEMA_TITLE = 'VK Terminals 設定';
const DEFAULT_SCHEMA_NOTE = '保存後、VK Terminals を再起動すると反映されます。';

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
      if (typeof field.key !== 'string' || field.key.trim() === '') return false;
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
    return cloneJson(schema);
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
