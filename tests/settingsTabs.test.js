'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveSettingsTargetPathsForGroups,
  groupSettingsGroupsByTab,
  normalizeSettingsTabs,
} = require('../renderer/settingsTabs');

test('normalizeSettingsTabs: 有効な tabs だけを描画用に正規化する', () => {
  assert.deepEqual(normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '基本', note: '保存後に反映' },
      { id: 'advanced' },
      { id: '' },
      null,
    ],
  }), [
    { id: 'general', label: '基本', index: 0, note: '保存後に反映' },
    { id: 'advanced', label: 'advanced', index: 1 },
  ]);
  assert.deepEqual(normalizeSettingsTabs({}), []);
});

test('normalizeSettingsTabs: note は非空文字列だけを引き継ぐ', () => {
  assert.deepEqual(normalizeSettingsTabs({
    tabs: [
      { id: 'general', note: '  保存後に反映  ' },
      { id: 'empty', note: '' },
      { id: 'blank', note: '   ' },
      { id: 'number', note: 1 },
      { id: 'missing' },
    ],
  }), [
    { id: 'general', label: 'general', index: 0, note: '  保存後に反映  ' },
    { id: 'empty', label: 'empty', index: 1 },
    { id: 'blank', label: 'blank', index: 2 },
    { id: 'number', label: 'number', index: 3 },
    { id: 'missing', label: 'missing', index: 4 },
  ]);
});

test('groupSettingsGroupsByTab: tab 未指定または未知の group は先頭タブへ振り分ける', () => {
  const tabs = normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '基本' },
      { id: 'tokens', label: 'トークン' },
    ],
  });
  const groups = [
    { label: 'A', tab: 'tokens' },
    { label: 'B' },
    { label: 'C', tab: 'missing' },
  ];

  const grouped = groupSettingsGroupsByTab(groups, tabs);
  assert.equal(grouped.length, 2);
  assert.deepEqual(grouped[0].groups.map((group) => group.label), ['B', 'C']);
  assert.deepEqual(grouped[1].groups.map((group) => group.label), ['A']);
});

test('deriveSettingsTargetPathsForGroups: tab 内 group の保存先を重複なしで導出する', () => {
  assert.deepEqual(deriveSettingsTargetPathsForGroups([
    { targetPaths: ['/tmp/a.json', '/tmp/b.json'] },
    { targetPaths: ['/tmp/a.json', '/tmp/c.json'] },
    { targetPaths: [null, '', '/tmp/b.json'] },
  ]), ['/tmp/a.json', '/tmp/b.json', '/tmp/c.json']);
});
