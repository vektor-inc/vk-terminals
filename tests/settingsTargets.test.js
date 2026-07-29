'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  coerceFieldValue,
  deepGet,
  deepSet,
  describeSettingsValues,
  describeTargetPaths,
  groupFieldsByTargetPath,
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
  assert.equal(resolveTargetPath(''), null);
  assert.equal(resolveTargetPath('   '), null);

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

  assert.equal(isValidSettingsDescriptor({
    targetPath: '   ',
    groups: [
      { fields: [{ key: 'a' }] },
    ],
  }), false);

  assert.equal(isValidSettingsDescriptor({
    targetPath: '/descriptor.json',
    groups: [
      { fields: [{ key: 'shared' }] },
      { targetPath: '/group-b.json', fields: [{ key: 'shared' }] },
    ],
  }), false);
});

test('isValidSettingsDescriptor: 危険なキーセグメントを含むフィールドは無効', () => {
  // 外部から差し替えられた設定ディスクリプタを使う前に各汚染経路を拒否できることを確認する。
  for (const key of ['__proto__.x', 'constructor.prototype.x', 'prototype.x']) {
    assert.equal(isValidSettingsDescriptor({
      targetPath: '/descriptor.json',
      groups: [
        { fields: [{ key }] },
      ],
    }), false, key);
  }
});

test('deepSet: 危険なキーセグメントへの書き込みを拒否して Object.prototype を汚染しない', () => {
  // 各危険セグメントへの書き込みが例外になり、共通プロトタイプへ到達しないことを確認する。
  const cases = [
    ['__proto__.settingsTargetsPolluted', 'PWNED'],
    ['constructor.prototype.settingsTargetsPolluted', 'PWNED'],
    ['prototype.settingsTargetsPolluted', 'PWNED'],
  ];

  // 以前の失敗した実行で汚染が残っていても、この検証へ影響させないため事前に掃除する。
  delete Object.prototype.settingsTargetsPolluted;
  try {
    for (const [key, value] of cases) {
      let thrownError;
      try {
        deepSet({}, key, value);
      } catch (error) {
        thrownError = error;
      }
      assert.equal(Object.prototype.settingsTargetsPolluted, undefined, key);
      assert.ok(thrownError instanceof Error, key);
    }
  } finally {
    // 検証途中で例外が発生しても、後続テストへプロトタイプ汚染を持ち越さないため必ず掃除する。
    delete Object.prototype.settingsTargetsPolluted;
  }
});

test('deepGet: 危険なキーセグメントを含むキーは undefined を返す', () => {
  // 自身や継承元に値が存在しても、危険な経路からは読み取れないことを確認する。
  const source = Object.assign(Object.create({ x: 'proto' }), {
    constructor: { prototype: { x: 'constructor' } },
    prototype: { x: 'prototype' },
  });

  assert.equal(deepGet(source, '__proto__.x'), undefined);
  assert.equal(deepGet(source, 'constructor.prototype.x'), undefined);
  assert.equal(deepGet(source, 'prototype.x'), undefined);
});

test('deepGet / deepSet: 通常のドット区切りキーは従来どおり読み書きできる', () => {
  // 防御追加後も安全な階層キーの読み書きには影響がないことを確認する。
  const target = {};

  deepSet(target, 'a.b.c', 'value');

  assert.deepEqual(target, { a: { b: { c: 'value' } } });
  assert.equal(deepGet(target, 'a.b.c'), 'value');
});

test('describeSettingsValues: 異なる保存先から値を集約し default と field override を反映する', () => {
  const dir = makeTempDir();
  const firstPath = path.join(dir, 'first.json');
  const secondPath = path.join(dir, 'second.json');
  const fieldPath = path.join(dir, 'field.json');
  writeJson(firstPath, { name: 'vk' });
  writeJson(secondPath, { nested: { count: 7 } });
  writeJson(fieldPath, { override: 'field-value' });

  const descriptor = {
    targetPath: firstPath,
    groups: [
      {
        fields: [
          { key: 'name', label: '名前', type: 'text' },
          { key: 'missing', label: '未設定', type: 'text', default: 'fallback' },
        ],
      },
      {
        targetPath: secondPath,
        fields: [
          { key: 'nested.count', label: '数', type: 'number', default: 1 },
          { key: 'override', label: '上書き', type: 'text', targetPath: fieldPath },
        ],
      },
    ],
  };

  assert.deepEqual(describeSettingsValues(descriptor), {
    name: 'vk',
    missing: 'fallback',
    'nested.count': 7,
    override: 'field-value',
  });
});

test('describeSettingsValues: 危険なキーを返却値に追加せずプロトタイプを維持する', () => {
  // 画面へ渡す一覧から危険なキーが除外され、一覧自身のプロトタイプが維持されることを確認する。
  const descriptor = {
    targetPath: path.join(makeTempDir(), 'config.json'),
    groups: [
      {
        fields: [
          { key: '__proto__', label: '危険なキー', type: 'json', default: { polluted: true } },
        ],
      },
    ],
  };

  const values = describeSettingsValues(descriptor);

  assert.equal(Object.getPrototypeOf(values), Object.prototype);
  assert.equal(Object.prototype.hasOwnProperty.call(values, '__proto__'), false);
  assert.equal(values.polluted, undefined);
});

test('describeTargetPaths: 単一・group 差異・field override の target 情報を返す', () => {
  const dir = makeTempDir();
  const firstPath = path.join(dir, 'first.json');
  const secondPath = path.join(dir, 'second.json');
  const fieldPath = path.join(dir, 'field.json');

  assert.deepEqual(describeTargetPaths({
    targetPath: firstPath,
    groups: [
      { fields: [{ key: 'a' }] },
      { fields: [{ key: 'b' }] },
    ],
  }), {
    targetPath: firstPath,
    groupTargets: [[firstPath], [firstPath]],
    allTargets: [firstPath],
    hasMultipleTargets: false,
  });

  assert.deepEqual(describeTargetPaths({
    targetPath: firstPath,
    groups: [
      { fields: [{ key: 'a' }] },
      { targetPath: secondPath, fields: [{ key: 'b' }] },
    ],
  }), {
    targetPath: firstPath,
    groupTargets: [[firstPath], [secondPath]],
    allTargets: [firstPath, secondPath],
    hasMultipleTargets: true,
  });

  assert.deepEqual(describeTargetPaths({
    targetPath: firstPath,
    groups: [
      {
        fields: [
          { key: 'a' },
          { key: 'b', targetPath: fieldPath },
        ],
      },
    ],
  }), {
    targetPath: firstPath,
    groupTargets: [[firstPath, fieldPath]],
    allTargets: [firstPath, fieldPath],
    hasMultipleTargets: true,
  });
});

test('coerceFieldValue: lines は改行区切り文字列を文字列配列へ変換する', () => {
  assert.deepEqual(
    coerceFieldValue({ key: 'paths', type: 'lines' }, '/a\n/b\n/c'),
    { ok: true, value: ['/a', '/b', '/c'] },
  );
});

test('coerceFieldValue: lines は前後空白と空行を除去する', () => {
  assert.deepEqual(
    coerceFieldValue({ key: 'paths', type: 'lines' }, '  /a  \n\n /b \n   \n/c\t'),
    { ok: true, value: ['/a', '/b', '/c'] },
  );
});

test('coerceFieldValue: lines は空文字を emptyToNull に応じて null または空配列に変換する', () => {
  assert.deepEqual(
    coerceFieldValue({ key: 'paths', type: 'lines', emptyToNull: true }, ''),
    { ok: true, value: null },
  );
  assert.deepEqual(
    coerceFieldValue({ key: 'paths', type: 'lines' }, ''),
    { ok: true, value: [] },
  );
});

test('coerceFieldValue: lines は空白のみの入力を emptyToNull に応じて null または空配列に変換する', () => {
  assert.deepEqual(
    coerceFieldValue({ key: 'paths', type: 'lines', emptyToNull: true }, '   \n  \n'),
    { ok: true, value: null },
  );
  assert.deepEqual(
    coerceFieldValue({ key: 'paths', type: 'lines' }, '   \n  \n'),
    { ok: true, value: [] },
  );
});

test('coerceFieldValue: lines は配列を String 化して trim と空要素除去を行う', () => {
  assert.deepEqual(
    coerceFieldValue({ key: 'paths', type: 'lines' }, [' /a ', 42, '', null, '  ', '/c']),
    { ok: true, value: ['/a', '42', 'null', '/c'] },
  );
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

test('groupFieldsByTargetPath: incoming にない Object.prototype 由来のキーを保存対象に含めない', () => {
  // 画面側が値を送っていない組み込みプロパティを、保存対象と誤判定しないことを確認する。
  const targetPath = path.join(makeTempDir(), 'config.json');
  const descriptor = {
    targetPath,
    groups: [
      {
        fields: [
          { key: 'toString', label: '文字列化', type: 'text' },
          { key: 'hasOwnProperty', label: '所有判定', type: 'text' },
        ],
      },
    ],
  };

  const result = groupFieldsByTargetPath(descriptor, {});

  assert.equal(result.ok, true);
  assert.equal(result.grouped.size, 0);
});

test('saveSettingsToTargets: 危険なキーの保存を拒否して汚染もファイル作成もしない', () => {
  // 保存処理全体でも危険なキーを拒否し、プロトタイプ汚染とファイル作成を防ぐことを確認する。
  const targetPath = path.join(makeTempDir(), 'config.json');
  const pollutedKey = 'settingsTargetsSavePolluted';
  const descriptor = {
    targetPath,
    groups: [
      {
        fields: [
          { key: `__proto__.${pollutedKey}`, label: '危険なキー', type: 'text' },
        ],
      },
    ],
  };

  // 以前の失敗した実行で汚染が残っていても、この検証へ影響させないため事前に掃除する。
  delete Object.prototype[pollutedKey];
  try {
    const result = saveSettingsToTargets(descriptor, {
      [`__proto__.${pollutedKey}`]: 'PWNED',
    });

    assert.equal(result.ok, false);
    assert.equal(Object.prototype[pollutedKey], undefined);
    assert.equal(fs.existsSync(targetPath), false);
  } finally {
    // 検証途中で例外が発生しても、後続テストへプロトタイプ汚染を持ち越さないため必ず掃除する。
    delete Object.prototype[pollutedKey];
  }
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

test('saveSettingsToTargets: nested の中間値が配列ならオブジェクトへ置換して保存する', () => {
  const dir = makeTempDir();
  const targetPath = path.join(dir, 'config.json');
  writeJson(targetPath, { nested: [] });
  const descriptor = {
    targetPath,
    groups: [
      { fields: [{ key: 'nested.count', label: '数', type: 'number' }] },
    ],
  };

  const result = saveSettingsToTargets(descriptor, { 'nested.count': '5' });

  assert.equal(result.ok, true);
  assert.deepEqual(readJson(targetPath), { nested: { count: 5 } });
});

test('saveSettingsToTargets: 新規ファイルは 0600 で作成し既存ファイルの権限は維持する', () => {
  const dir = makeTempDir();
  const newPath = path.join(dir, 'new.json');
  const existingPath = path.join(dir, 'existing.json');
  writeJson(existingPath, { value: 'before' });
  fs.chmodSync(existingPath, 0o640);

  assert.equal(saveSettingsToTargets({
    targetPath: newPath,
    groups: [
      { fields: [{ key: 'value', label: '値', type: 'text' }] },
    ],
  }, { value: 'new' }).ok, true);

  assert.equal(saveSettingsToTargets({
    targetPath: existingPath,
    groups: [
      { fields: [{ key: 'value', label: '値', type: 'text' }] },
    ],
  }, { value: 'after' }).ok, true);

  assert.equal(fs.statSync(newPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(existingPath).mode & 0o777, 0o640);
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
