'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  SETTINGS_SCHEMA_PATH,
  addBrowserHomeSettings,
  buildBuiltinSettingsDescriptor,
  loadSettingsSchema,
  validateSettingsSchema,
} = require('../settingsSchema');
const { SETTINGS_CONTENT_BLOCK_TYPES } = require('../renderer/settingsTabs');
const { isValidSettingsDescriptor, resolveFieldTargetPath } = require('../settingsTargets');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-schema-'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

test('外部設定のホームキーを組み込みの定義と保存先で置き換える', () => {
  const builtin = buildBuiltinSettingsDescriptor({ targetPath: '/app/config.json' });
  const external = {
    targetPath: '/external/config.json',
    tabs: [{ id: 'vk-terminals-browser', label: '外部設定' }],
    groups: [{
      tab: 'vk-terminals-browser',
      fields: [
        { key: 'github.owner', type: 'lines' },
        { key: 'internalBrowserHomeUrl', type: 'text', targetPath: '/wrong/config.json' },
        { key: 'internalBrowserHomeUrl.extra', type: 'text' },
        null,
      ],
    }],
  };
  const combined = addBrowserHomeSettings(external, builtin);
  assert.equal(isValidSettingsDescriptor(combined), true);
  assert.deepEqual(combined.groups[0].fields, [external.groups[0].fields[0], null]);
  const homeGroup = combined.groups[1];
  assert.equal(combined.tabs[0], external.tabs[0]);
  assert.notEqual(homeGroup.tab, combined.tabs[0].id);
  assert.equal(homeGroup.tab, combined.tabs[1].id);
  assert.deepEqual(homeGroup.fields, [{ ...builtin.groups[1].fields[0], targetPath: builtin.targetPath }]);
  assert.equal(resolveFieldTargetPath(combined, homeGroup, homeGroup.fields[0]), builtin.targetPath);
  assert.equal(external.groups[0].fields.length, 4);
});

test('settings-schema.json: valid JSON で必須構造を持つ', () => {
  const schema = JSON.parse(fs.readFileSync(SETTINGS_SCHEMA_PATH, 'utf8'));

  assert.equal(validateSettingsSchema(schema), true);
  assert.equal(schema.title, 'VK Terminals 設定');
  assert.equal(schema.note, '保存後、すぐに反映される設定と、次回の起動から反映される設定があります。反映の状況は、保存後に表示される案内で確認できます。');
  assert.ok(Array.isArray(schema.groups));
  assert.deepEqual(schema.groups.map(group => group.label), ['基本', 'アプリ内ブラウザ']);

  for (const group of schema.groups) {
    assert.ok(Array.isArray(group.fields));
    for (const field of group.fields) {
      assert.equal(typeof field.key, 'string');
      assert.equal(typeof field.label, 'string');
      assert.equal(typeof field.type, 'string');
    }
  }
});

test('settings-schema.json: 全タブの content が描画側の対応種別だけを使う', () => {
  const schema = JSON.parse(fs.readFileSync(SETTINGS_SCHEMA_PATH, 'utf8'));

  assert.equal(Object.isFrozen(SETTINGS_CONTENT_BLOCK_TYPES), true);
  assert.ok(Array.isArray(schema.tabs), 'settings-schema.json に tabs がありません');
  for (const tab of schema.tabs) {
    const content = Array.isArray(tab.content) ? tab.content : [];
    content.forEach((block, index) => {
      const type = block && block.type;
      assert.ok(
        SETTINGS_CONTENT_BLOCK_TYPES.includes(type),
        `タブ "${tab.id}" の content の ${index + 1} 番目に未対応の種別 "${String(type)}" があります。`
      );
    });
  }
});

test('buildBuiltinSettingsDescriptor: JSON から targetPath 付きの組み込み descriptor を生成する', () => {
  const targetPath = path.join(makeTempDir(), 'config.json');
  const descriptor = buildBuiltinSettingsDescriptor({ targetPath });

  assert.equal(descriptor.title, 'VK Terminals 設定');
  assert.equal(descriptor.note, '保存後、すぐに反映される設定と、次回の起動から反映される設定があります。反映の状況は、保存後に表示される案内で確認できます。');
  assert.equal(descriptor.targetPath, targetPath);
  assert.deepEqual(descriptor.groups.map((group) => group.label), ['基本', 'アプリ内ブラウザ']);

  const fields = descriptor.groups.flatMap((group) => group.fields);
  // apiRequireAuthAlways は末尾に置く（issue #313 レビュー対応）。apiHost の直後に
  // 挿入すると、組み込みスキーマの描画順（apiHost=0 / newPaneStartupDir=1 / ...）に
  // 依存する既存 e2e（tests/e2e/new-pane-startup.smoke.spec.js）の欄インデックスが
  // ずれてしまうため。
  assert.deepEqual(fields.map((field) => field.key), [
    'apiHost',
    'newPaneStartupDir',
    'newPaneAutoLaunchClaude',
    'initialCommand',
    'confirmClose',
    'terminalLinkClickMode',
    'showUsage',
    'showCodexUsage',
    'notifyOnWaiting',
    'notifyOnWaitingMerge',
    'gpu',
    'menuItems',
    'additionalPanes',
    'apiRequireAuthAlways',
    'codexCollapseTurnDetails',
    'openInitialPane',
    'initialEngine',
    'initialCodexModel',
    'internalBrowserHomeUrl',
  ]);
  const [homeUrl] = descriptor.groups[1].fields;
  assert.equal(homeUrl.type, 'http-url');
  assert.equal(homeUrl.default, '');

  // codexCollapseTurnDetails（issue #627）は既定オンの真偽値。対象が自動処理の作業ペインだけであることを冒頭で示し、途中の発言も畳まれること・オフの表示内容・次に起動する作業ペインから反映されることを示す。
  // 常に表示する項目のため、条件付きで表示する initialCodexModel より上（openInitialPane の直前）に置く。
  const collapseField = fields.find((field) => field.key === 'codexCollapseTurnDetails');
  assert.equal(collapseField.type, 'boolean');
  assert.equal(collapseField.default, true);
  assert.equal(collapseField.label, '自動処理の Codex で途中経過の表示を畳む');
  assert.match(collapseField.help, /^VK Orchestrator の自動処理で開く Codex の作業ペインだけが対象です/);
  assert.match(collapseField.help, /作業途中の Codex の発言も一緒に畳まれ/);
  assert.match(collapseField.help, /最終回答だけが残ります/);
  assert.match(collapseField.help, /次に起動する作業ペインから反映/);
  assert.match(collapseField.help, /手動で開いた Codex のペインの表示は変わりません/);
  assert.match(collapseField.help, /オフにすると、実行したコマンドとその出力、作業途中の発言をすべて表示します/);
  assert.equal(collapseField.help.includes('これまでどおり'), false);

  // 追加・分割ペインの AI 自動起動は Claude Code / Codex 共通のため、ラベルとヘルプで両方を示す。
  const autoLaunchField = fields.find((field) => field.key === 'newPaneAutoLaunchClaude');
  assert.equal(autoLaunchField.label, 'AI（Claude Code / Codex）を自動的に起動する');
  assert.match(autoLaunchField.help, /Codex/);

  // 自動処理用ペインから手動追加する場合は既定 AI、通常ペインからは元の AI を使うことを設定文言でも示す。
  const engineField = fields.find((field) => field.key === 'initialEngine');
  assert.equal(engineField.label, '通常ペインの既定 AI エンジン');
  assert.match(engineField.help, /起動時の最初のペイン/);
  assert.match(engineField.help, /ペインが 0 枚のときに追加するペイン/);
  assert.match(engineField.help, /自動処理用ペインから手動で追加・分割する通常ペイン/);
  assert.match(engineField.help, /通常ペインから追加・分割するときは元のペインの AI を引き継ぎます/);
  assert.match(engineField.help, /再起動後に反映/);
  assert.match(engineField.help, /自動的に起動する」がオンの場合だけ/);
  assert.match(engineField.help, /additionalPanes.*対象外/);

  // Codex モデルにも同じ適用範囲を示し、許可文字の pattern 検証を持たせる。
  const codexModelField = fields.find((field) => field.key === 'initialCodexModel');
  assert.equal(codexModelField.label, '通常ペインの既定 Codex モデル');
  assert.match(codexModelField.help, /起動時の最初のペイン/);
  assert.match(codexModelField.help, /ペインが 0 枚のときに追加するペイン/);
  assert.match(codexModelField.help, /自動処理用ペインから手動で追加・分割する通常ペイン/);
  assert.match(codexModelField.help, /通常ペインから追加・分割するときは元のペインの AI を引き継ぎます/);
  assert.match(codexModelField.help, /再起動後に反映/);
  assert.equal(typeof codexModelField.invalidMessage, 'string');
  const codexModelRe = new RegExp(codexModelField.pattern);
  for (const ok of ['gpt-5.5', 'o3', 'gpt-5[1m]', 'a_b.c-d']) assert.ok(codexModelRe.test(ok), ok);
  for (const ng of ['-bad', 'a b', 'a;b', "a'b", '$(x)', 'a'.repeat(65)]) assert.ok(!codexModelRe.test(ng), ng);

  assert.deepEqual(fields.find((field) => field.key === 'newPaneStartupDir'), {
    key: 'newPaneStartupDir',
    label: '新規ペインを開く時の初期ディレクトリ',
    type: 'text',
    placeholder: '/path/to/project',
    help: '新規ペインを開く時の作業ディレクトリを絶対パスで指定します。起動時の初回ペインにも適用されます。「AI（Claude Code / Codex）を自動的に起動する」設定が有効な場合は AI もこのディレクトリで起動します。未入力の場合、または存在しないパスの場合はホームディレクトリで起動します。',
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
  const linkMode = fields.find((field) => field.key === 'terminalLinkClickMode');
  assert.equal(linkMode.type, 'select');
  assert.equal(linkMode.default, 'click');
  assert.deepEqual(linkMode.options.map(option => option.value), ['click', 'modifier']);
  assert.ok(linkMode.label && linkMode.help && linkMode.options.every(option => option.label));
  assert.deepEqual(fields.find((field) => field.key === 'showUsage'), {
    key: 'showUsage',
    label: 'トークン使用量を表示',
    type: 'boolean',
    default: true,
    help: 'Claude の利用状況（セッション% / 週間制限%）をサイドバーの「Claude使用量」・モバイルページに表示します。',
  });
  assert.deepEqual(fields.find((field) => field.key === 'showCodexUsage'), {
    key: 'showCodexUsage',
    label: 'Codex 使用量を表示',
    type: 'boolean',
    default: true,
    help: 'Codex CLI の利用状況（セッション% / 週間制限% / トークン数）をサイドバーの「Codex使用量」に表示します。',
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

test('validateSettingsSchema: combo 型と候補配列を reject しない', () => {
  assert.equal(validateSettingsSchema({
    groups: [{
      fields: [{
        key: 'model',
        label: 'モデル',
        type: 'combo',
        placeholder: '例: gpt-5.6-sol',
        options: [
          { value: 'gpt-5.6-sol', label: 'GPT-5.6 Sol' },
          { value: 'gpt-5.5', label: 'GPT-5.5' },
        ],
      }],
    }],
  }), true);
});

test('validateSettingsSchema: 危険なキーセグメントを含むフィールドは無効', () => {
  // 汚染経路になる各セグメントが schema 検証の段階ですべて拒否されることを確認する。
  for (const key of ['__proto__.x', 'constructor.prototype.x', 'prototype.x']) {
    assert.equal(validateSettingsSchema({
      groups: [
        {
          fields: [
            { key, label: '危険なキー', type: 'text' },
          ],
        },
      ],
    }), false, key);
  }
});

test('validateSettingsSchema: tabs の型ミスでは schema 全体を reject しない', () => {
  // ここで false を返すと fallback schema（groups: []）に落ち、タブの型ミス 1 つで
  // 設定パネルの項目が全部消えてしまう。tabs の扱いは loadSettingsSchema 側で degrade する。
  assert.equal(validateSettingsSchema({
    tabs: 'general',
    groups: [{ fields: [{ key: 'apiHost', label: 'API ホスト', type: 'text' }] }],
  }), true);
});

test('loadSettingsSchema: tabs が配列でなければ tabs だけ落とし、groups は保持する', () => {
  const schemaPath = path.join(makeTempDir(), 'settings-schema.json');
  const errors = [];
  writeJson(schemaPath, {
    title: 'テスト設定',
    tabs: { general: '設定' }, // 配列でない不正な tabs
    groups: [{ label: '基本', fields: [{ key: 'apiHost', label: 'API ホスト', type: 'text' }] }],
  });

  const schema = loadSettingsSchema({
    schemaPath,
    onError: (error, failedPath) => errors.push({ error, failedPath }),
  });

  // 設定項目は消えず、タブ定義だけが落ちてタブ無し表示に degrade する。
  assert.equal(schema.title, 'テスト設定');
  assert.equal('tabs' in schema, false);
  assert.deepEqual(schema.groups.map((group) => group.label), ['基本']);
  assert.equal(errors.length, 0);
});

test('loadSettingsSchema: 正しい tabs はそのまま保持する', () => {
  const schemaPath = path.join(makeTempDir(), 'settings-schema.json');
  writeJson(schemaPath, {
    tabs: [{ id: 'general', label: '設定' }],
    groups: [{ label: '基本', tab: 'general', fields: [{ key: 'apiHost', label: 'API ホスト', type: 'text' }] }],
  });

  const schema = loadSettingsSchema({ schemaPath });

  assert.deepEqual(schema.tabs, [{ id: 'general', label: '設定' }]);
  assert.equal(schema.groups[0].tab, 'general');
});

test('loadSettingsSchema: 読み込み失敗時は起動を落とさない fallback schema を返す', () => {
  const errors = [];
  const schema = loadSettingsSchema({
    schemaPath: path.join(makeTempDir(), 'missing.json'),
    onError: (error, schemaPath) => errors.push({ error, schemaPath }),
  });

  assert.equal(schema.title, 'VK Terminals 設定');
  assert.equal(schema.note, '保存後、すぐに反映される設定と、次回の起動から反映される設定があります。反映の状況は、保存後に表示される案内で確認できます。');
  assert.deepEqual(schema.groups, []);
  assert.equal(errors.length, 1);
  assert.match(errors[0].schemaPath, /missing\.json$/);
});
