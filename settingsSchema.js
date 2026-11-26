'use strict';

const fs = require('fs');
const path = require('path');
const { hasUnsafeKeySegment } = require('./settingsTargets');
const { INTERNAL_BROWSER_HOME_KEY } = require('./utils/internalBrowserHome');

const SETTINGS_SCHEMA_PATH = path.join(__dirname, 'settings-schema.json');
const DEFAULT_SCHEMA_TITLE = 'VK Terminals 設定';
const DEFAULT_SCHEMA_NOTE = '保存後、すぐに反映される設定と、次回の起動から反映される設定があります。反映の状況は、保存後に表示される案内で確認できます。';

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
      // 危険なキーの判定を settingsTargets.js と共用し、判定ロジックの二重管理を避ける。
      // hasUnsafeKeySegment は内部で split を呼ぶため、短絡評価を利用して文字列かどうかを
      // 先に確認する評価順を崩してはならない。
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

function addBrowserHomeSettings(descriptor, builtin) {
  // 外部定義からホームのキーとその配下を外し、組み込み定義の型と保存先を使う。
  const groups = descriptor.groups.flatMap((group) => {
    if (!Array.isArray(group?.fields)) return [group];
    const fields = group.fields.filter(field => {
      const key = field?.key;
      return typeof key !== 'string' || (key !== INTERNAL_BROWSER_HOME_KEY && !key.startsWith(INTERNAL_BROWSER_HOME_KEY + '.'));
    });
    return fields.length || !group.fields.length ? [{ ...group, fields }] : [];
  });
  const homeGroup = builtin.groups.find(group => group.fields.some(field => field.key === INTERNAL_BROWSER_HOME_KEY));
  if (!homeGroup) return { ...descriptor, groups };
  const homeField = homeGroup.fields.find(field => field.key === INTERNAL_BROWSER_HOME_KEY);
  const tabs = Array.isArray(descriptor.tabs) ? descriptor.tabs : [];
  const tabIds = new Set(tabs.map(tab => tab?.id));
  const hasTabs = tabs.some(tab => typeof tab?.id === 'string' && tab.id.trim());
  let tabId = 'vk-terminals-browser';
  while (tabIds.has(tabId)) tabId += '-';
  groups.push({
    label: homeGroup.label,
    tab: hasTabs ? tabId : undefined,
    fields: [{ ...homeField, targetPath: builtin.targetPath }],
  });
  return {
    ...descriptor,
    groups,
    tabs: hasTabs ? [...tabs, { id: tabId, label: homeGroup.label }] : tabs,
  };
}

// 「自動」の選択肢に、今回の起動で解決した結果を添える文言。受け取れない場合は JSON の文言のまま。
const GPU_AUTO_LABELS = {
  on: '自動（この環境では GPU を使う）',
  off: '自動（この環境では GPU を使わない）',
  'wsl-unknown': '自動（WSL の版を確認できないため GPU を使わない）',
  switch: '自動（起動元の指定に従う）',
};

/**
 * descriptor の GPU 起動モード（key: gpu）の空（自動）の選択肢の文言を、起動時の解決結果で差し替える。
 * 元の descriptor は変更せず、差し替えた複製を返す。
 * @param {object} descriptor 設定パネルの定義
 * @param {string|null|undefined} autoState 'on' / 'off' / 'wsl-unknown' / 'switch'。それ以外は差し替えない
 * @returns {object}
 */
function applyGpuAutoLabel(descriptor, autoState) {
  const label = GPU_AUTO_LABELS[autoState];
  if (!label || !descriptor || !Array.isArray(descriptor.groups)) return descriptor;
  const replaceField = (field) => {
    if (field?.key !== 'gpu' || !Array.isArray(field.options)) return field;
    return {
      ...field,
      options: field.options.map((option) => (option?.value === '' ? { ...option, label } : option)),
    };
  };
  return {
    ...descriptor,
    groups: descriptor.groups.map((group) => (
      Array.isArray(group?.fields) ? { ...group, fields: group.fields.map(replaceField) } : group
    )),
  };
}

module.exports = {
  applyGpuAutoLabel,
  SETTINGS_SCHEMA_PATH,
  addBrowserHomeSettings,
  buildBuiltinSettingsDescriptor,
  loadSettingsSchema,
  validateSettingsSchema,
};
