'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SETTINGS_SCHEMA_PATH,
  buildBuiltinSettingsDescriptor,
  loadSettingsSchema,
  validateSettingsSchema,
} = require('../settingsSchema');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-schema-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

test('settings-schema.json: valid JSON で必須構造を持つ', () => {
  const schema = JSON.parse(fs.readFileSync(SETTINGS_SCHEMA_PATH, 'utf8'));

  assert.equal(validateSettingsSchema(schema), true);
  assert.equal(schema.title, 'VK Terminals 設定');
  assert.equal(schema.note, '保存後、VK Terminals を再起動すると反映されます。');
  assert.ok(Array.isArray(schema.groups));
  assert.equal(schema.groups.length, 1);
  assert.equal(schema.groups[0].label, '基本');

  for (const group of schema.groups) {
    assert.ok(Array.isArray(group.fields));
    for (const field of group.fields) {
      assert.equal(typeof field.key, 'string');
      assert.equal(typeof field.label, 'string');
      assert.equal(typeof field.type, 'string');
    }
  }
});

test('buildBuiltinSettingsDescriptor: JSON から targetPath 付きの組み込み descriptor を生成する', () => {
  const targetPath = path.join(makeTempDir(), 'config.json');
  const descriptor = buildBuiltinSettingsDescriptor({ targetPath });

  assert.equal(descriptor.title, 'VK Terminals 設定');
  assert.equal(descriptor.note, '保存後、VK Terminals を再起動すると反映されます。');
  assert.equal(descriptor.targetPath, targetPath);
  assert.deepEqual(descriptor.groups.map((group) => group.label), ['基本']);

  const fields = descriptor.groups.flatMap((group) => group.fields);
  assert.deepEqual(fields.map((field) => field.key), [
    'apiHost',
    'newPaneStartupDir',
    'newPaneAutoLaunchClaude',
    'initialCommand',
    'confirmClose',
    'showUsage',
    'gpu',
    'menuItems',
    'additionalPanes',
  ]);

  assert.deepEqual(fields.find((field) => field.key === 'newPaneStartupDir'), {
    key: 'newPaneStartupDir',
    label: '新規ペインを開く時の初期ディレクトリ',
    type: 'text',
    placeholder: '/path/to/project',
    help: '新規ペインを開く時の作業ディレクトリを絶対パスで指定します。起動時の初回ペインにも適用されます。「Claude Code を自動起動する」設定が有効な場合は Claude もこのディレクトリで起動します。未入力の場合、または存在しないパスの場合はホームディレクトリで起動します。',
  });
  assert.deepEqual(fields.find((field) => field.key === 'confirmClose'), {
    key: 'confirmClose',
    label: 'ペインを閉じる時の確認ダイアログ',
    type: 'select',
    default: 'busy',
    help: 'ペインの ✕ ボタンで閉じる時に確認ダイアログを表示する条件。HTTP API 経由の自動クローズには適用されません。',
    options: [
      { value: 'busy', label: '実行中・入力待ちの場合は表示（既定）' },
      { value: 'always', label: '常に表示' },
      { value: 'never', label: '確認なし' },
    ],
  });
  assert.deepEqual(fields.find((field) => field.key === 'showUsage'), {
    key: 'showUsage',
    label: 'トークン使用量を表示',
    type: 'boolean',
    default: true,
    help: 'Claude の利用状況（セッション% / 週間制限%）をサイドバーの「Claude使用量」・モバイルページに表示します。',
  });
  assert.deepEqual(fields.find((field) => field.key === 'gpu'), {
    key: 'gpu',
    label: 'GPU 起動モード',
    type: 'select',
    emptyToNull: true,
    default: '',
    help: 'GUI(Electron) の GPU 初期化方法。WSLg 等ではエラー抑制のため既定で無効化されます。環境変数 VK_TERMINALS_GPU 指定時はそちらが優先されます。',
    options: [
      { value: '', label: '自動（プラットフォーム既定）' },
      { value: 'off', label: 'GPU 無効（エラー抑制・推奨）' },
      { value: 'default', label: 'Chromium 任せ' },
    ],
  });
  assert.equal(fields.some((field) => field.key === 'agentroom'), false);
});

test('buildBuiltinSettingsDescriptor: schemaPath を差し替えて文言上書き・キー選択ができる', () => {
  const dir = makeTempDir();
  const schemaPath = path.join(dir, 'settings-schema.json');
  const targetPath = path.join(dir, 'config.json');
  writeJson(schemaPath, {
    title: 'Custom 設定',
    note: 'Custom note',
    groups: [
      {
        label: '表示',
        fields: [
          { key: 'showUsage', label: '使用量', type: 'boolean', default: true },
        ],
      },
    ],
  });

  const descriptor = buildBuiltinSettingsDescriptor({ schemaPath, targetPath });

  assert.equal(descriptor.title, 'Custom 設定');
  assert.equal(descriptor.note, 'Custom note');
  assert.equal(descriptor.targetPath, targetPath);
  assert.deepEqual(descriptor.groups, [
    {
      label: '表示',
      fields: [
        { key: 'showUsage', label: '使用量', type: 'boolean', default: true },
      ],
    },
  ]);
});

test('validateSettingsSchema: visibleWhen 付きフィールドを reject しない', () => {
  assert.equal(validateSettingsSchema({
    groups: [
      {
        fields: [
          { key: 'mode', label: 'モード', type: 'select', options: [] },
          { key: 'advanced', label: '詳細', type: 'text', visibleWhen: { key: 'mode', value: 'advanced' } },
          { key: 'legacy', label: '旧設定', type: 'text', visibleWhen: [{ key: 'mode', value: 'legacy', hide: true }] },
        ],
      },
    ],
  }), true);
});

test('loadSettingsSchema: 読み込み失敗時は起動を落とさない fallback schema を返す', () => {
  const errors = [];
  const schema = loadSettingsSchema({
    schemaPath: path.join(makeTempDir(), 'missing.json'),
    onError: (error, schemaPath) => errors.push({ error, schemaPath }),
  });

  assert.equal(schema.title, 'VK Terminals 設定');
  assert.equal(schema.note, '保存後、VK Terminals を再起動すると反映されます。');
  assert.deepEqual(schema.groups, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].schemaPath, /missing\.json$/);
});
