'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  isValidSettingsDescriptor,
  resolveFieldTargetPath,
  resolveTargetPath,
  saveSettingsToTargets,
} = require('../settingsTargets');

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-settings-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n');
}

test('resolveTargetPath: ~ をホームディレクトリへ展開する', () => {
  assert.equal(resolveTargetPath('~'), os.homedir());
  assert.equal(resolveTargetPath('~/vk-terminals/config.json'), path.join(os.homedir(), 'vk-terminals/config.json'));

  const absolutePath = path.join(os.tmpdir(), 'vk-terminals-config.json');
  assert.equal(resolveTargetPath(absolutePath), absolutePath);
});

test('resolveFieldTargetPath: field > group > descriptor の優先順位で解決する', () => {
  const descriptor = { targetPath: '/descriptor.json' };
  const group = { targetPath: '/group.json' };

  assert.equal(
    resolveFieldTargetPath(descriptor, group, { key: 'value', targetPath: '/field.json' }),
    '/field.json',
  );
  assert.equal(
    resolveFieldTargetPath(descriptor, group, { key: 'value' }),
    '/group.json',
  );
  assert.equal(
    resolveFieldTargetPath(descriptor, {}, { key: 'value' }),
    '/descriptor.json',
  );
});

test('isValidSettingsDescriptor: 全フィールドの保存先が解決できれば有効', () => {
  assert.equal(isValidSettingsDescriptor({
    groups: [
      { targetPath: '/group-a.json', fields: [{ key: 'a' }] },
      { fields: [{ key: 'b', targetPath: '/field-b.json' }] },
    ],
  }), true);

  assert.equal(isValidSettingsDescriptor({
    targetPath: '/descriptor.json',
    groups: [
      { fields: [{ key: 'a' }] },
      { targetPath: '/group-b.json', fields: [{ key: 'b' }] },
    ],
  }), true);

  assert.equal(isValidSettingsDescriptor({
    groups: [
      { targetPath: '/group-a.json', fields: [{ key: 'a' }] },
      { fields: [{ key: 'b' }] },
    ],
  }), false);
});

test('saveSettingsToTargets: group ごとに別ファイルへ保存し未知キーを保持する', () => {
  const dir = makeTempDir();
  const firstPath = path.join(dir, 'first.json');
  const secondPath = path.join(dir, 'second.json');
  writeJson(firstPath, { keep: 'first', nested: { old: true } });
  writeJson(secondPath, { keep: 'second' });

  const descriptor = {
    groups: [
      {
        targetPath: firstPath,
        fields: [
          { key: 'name', label: '名前', type: 'text' },
          { key: 'nested.count', label: '数', type: 'number' },
        ],
      },
      {
        targetPath: secondPath,
        fields: [
          { key: 'enabled', label: '有効', type: 'boolean', default: true },
          { key: 'items', label: '配列', type: 'json' },
        ],
      },
    ],
  };

  const result = saveSettingsToTargets(descriptor, {
    name: 'vk',
    'nested.count': '3',
    enabled: false,
    items: '[{"id":1}]',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.writtenPaths.sort(), [firstPath, secondPath].sort());
  assert.deepEqual(readJson(firstPath), {
    keep: 'first',
    name: 'vk',
    nested: { old: true, count: 3 },
  });
  assert.deepEqual(readJson(secondPath), {
    keep: 'second',
    enabled: false,
    items: [{ id: 1 }],
  });
});

test('saveSettingsToTargets: 原子的書き込み後に一時ファイルを残さない', () => {
  const dir = makeTempDir();
  const targetPath = path.join(dir, 'config.json');
  const descriptor = {
    targetPath,
    groups: [
      { fields: [{ key: 'value', label: '値', type: 'text' }] },
    ],
  };

  const result = saveSettingsToTargets(descriptor, { value: 'saved' });

  assert.equal(result.ok, true);
  assert.equal(readJson(targetPath).value, 'saved');
  const leftovers = fs.readdirSync(dir).filter((name) => name.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('saveSettingsToTargets: トップレベル targetPath のみなら単一ファイルへ保存する', () => {
  const dir = makeTempDir();
  const targetPath = path.join(dir, 'config.json');
  writeJson(targetPath, { keep: true });

  const descriptor = {
    targetPath,
    groups: [
      {
        fields: [
          { key: 'apiHost', label: 'API ホスト', type: 'text' },
          { key: 'showUsage', label: '使用量表示', type: 'boolean', default: true },
        ],
      },
    ],
  };

  const result = saveSettingsToTargets(descriptor, {
    apiHost: '127.0.0.1',
    showUsage: null,
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.writtenPaths, [targetPath]);
  assert.deepEqual(readJson(targetPath), {
    keep: true,
    apiHost: '127.0.0.1',
    showUsage: true,
  });
});

test('saveSettingsToTargets: 型変換バリデーションエラー時はどのファイルにも書かない', () => {
  const dir = makeTempDir();
  const firstPath = path.join(dir, 'first.json');
  const secondPath = path.join(dir, 'second.json');
  writeJson(firstPath, { name: 'before' });
  writeJson(secondPath, { count: 1 });

  const descriptor = {
    groups: [
      {
        targetPath: firstPath,
        fields: [{ key: 'name', label: '名前', type: 'text' }],
      },
      {
        targetPath: secondPath,
        fields: [{ key: 'count', label: '数', type: 'number' }],
      },
    ],
  };

  const result = saveSettingsToTargets(descriptor, {
    name: 'after',
    count: 'not-a-number',
  });

  assert.equal(result.ok, false);
  assert.match(result.error, /数値として不正/);
  assert.deepEqual(readJson(firstPath), { name: 'before' });
  assert.deepEqual(readJson(secondPath), { count: 1 });
});
