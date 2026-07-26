'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveSettingsTargetPathsForGroups,
  groupSettingsGroupsByTab,
  normalizeSettingsTabContent,
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

// ─── tabs[].content（読み取り専用の説明ブロック / issue #245） ───────────────────

test('normalizeSettingsTabContent: 各ブロック種別を正規化する', () => {
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'heading', text: '見出し' },
    { type: 'paragraph', text: '本文' },
    { type: 'list', items: ['A', 'B'] },
    { type: 'list', ordered: true, items: ['1 番目'] },
    { type: 'code', text: 'http://<Tailscale IP>:13847/' },
    { type: 'links', items: [{ label: 'Tailscale', url: 'https://tailscale.com/download' }] },
    { type: 'callout', tone: 'warning', text: '認証はありません' },
    { type: 'tabLink', label: '「設定」タブを開く', tab: 'general' },
  ], { tabIds: ['general', 'mobile'] }), [
    { type: 'heading', text: '見出し' },
    { type: 'paragraph', text: '本文' },
    { type: 'list', ordered: false, items: ['A', 'B'] },
    { type: 'list', ordered: true, items: ['1 番目'] },
    { type: 'code', text: 'http://<Tailscale IP>:13847/' },
    { type: 'links', items: [{ label: 'Tailscale', url: 'https://tailscale.com/download' }] },
    { type: 'callout', tone: 'warning', text: '認証はありません' },
    { type: 'tabLink', label: '「設定」タブを開く', tab: 'general' },
  ]);
});

test('normalizeSettingsTabContent: 不正なブロックは黙って落とす', () => {
  assert.deepEqual(normalizeSettingsTabContent([
    null,
    'paragraph',
    ['heading'],
    {},
    { type: 'unknown', text: '未知の種別' },
    { type: 'heading' },
    { type: 'paragraph', text: '   ' },
    { type: 'paragraph', text: 42 },
    { type: 'code', text: '' },
    { type: 'list', items: [] },
    { type: 'list', items: ['', '   ', 7] },
    { type: 'list' },
    { type: 'links', items: [] },
    { type: 'callout' },
  ], { tabIds: ['general'] }), []);
  assert.deepEqual(normalizeSettingsTabContent(undefined), []);
  assert.deepEqual(normalizeSettingsTabContent('not-an-array'), []);
});

test('normalizeSettingsTabContent: links は http(s) 以外の URL を除去する', () => {
  assert.deepEqual(normalizeSettingsTabContent([
    {
      type: 'links',
      items: [
        { label: 'javascript', url: 'javascript:alert(1)' },
        { label: 'file', url: 'file:///etc/passwd' },
        { label: 'data', url: 'data:text/html,<script>alert(1)</script>' },
        { label: '相対', url: '/docs/quickstart' },
        { label: 'url なし' },
        null,
        { label: 'https OK', url: 'https://tailscale.com/docs/how-to/quickstart' },
        { url: 'http://127.0.0.1:13847/' },
      ],
    },
  ]), [
    {
      type: 'links',
      items: [
        { label: 'https OK', url: 'https://tailscale.com/docs/how-to/quickstart' },
        // label 未指定のときは URL 自体をラベルに使う。
        { label: 'http://127.0.0.1:13847/', url: 'http://127.0.0.1:13847/' },
      ],
    },
  ]);
  // 有効な URL が 1 つも残らなければ links ブロックごと落とす。
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'links', items: [{ label: 'NG', url: 'javascript:alert(1)' }] },
  ]), []);
});

test('normalizeSettingsTabContent: callout の tone は既知の値だけ採用し、既定は info', () => {
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'callout', text: 'A' },
    { type: 'callout', tone: 'danger', text: 'B' },
    { type: 'callout', tone: 'info', text: 'C' },
    { type: 'callout', tone: 'warning', text: 'D' },
  ]), [
    { type: 'callout', tone: 'info', text: 'A' },
    { type: 'callout', tone: 'info', text: 'B' },
    { type: 'callout', tone: 'info', text: 'C' },
    { type: 'callout', tone: 'warning', text: 'D' },
  ]);
});

test('normalizeSettingsTabContent: tabLink は存在するタブ ID だけ残す', () => {
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'tabLink', label: '設定へ', tab: 'general' },
    { type: 'tabLink', label: '存在しないタブへ', tab: 'nope' },
    { type: 'tabLink', label: 'tab なし' },
    { type: 'tabLink', tab: 'general' },
  ], { tabIds: new Set(['general']) }), [
    { type: 'tabLink', label: '設定へ', tab: 'general' },
  ]);
  // tabIds を渡さない場合は参照先を検証できないため tabLink は残さない。
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'tabLink', label: '設定へ', tab: 'general' },
  ]), []);
});

test('normalizeSettingsTabs: content は正規化して非空のときだけ持たせる', () => {
  assert.deepEqual(normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '設定' },
      {
        id: 'mobile',
        label: '外出先から確認',
        content: [
          { type: 'heading', text: 'スマートフォンから確認できます' },
          { type: 'bogus', text: '落ちる' },
          { type: 'tabLink', label: '「設定」タブを開く', tab: 'general' },
        ],
      },
      { id: 'empty', label: '空', content: [{ type: 'unknown' }] },
      { id: 'notarray', label: '配列でない', content: 'text' },
    ],
  }), [
    { id: 'general', label: '設定', index: 0 },
    {
      id: 'mobile',
      label: '外出先から確認',
      index: 1,
      content: [
        { type: 'heading', text: 'スマートフォンから確認できます' },
        { type: 'tabLink', label: '「設定」タブを開く', tab: 'general' },
      ],
    },
    { id: 'empty', label: '空', index: 2 },
    { id: 'notarray', label: '配列でない', index: 3 },
  ]);
});

test('deriveSettingsTargetPathsForGroups: tab 内 group の保存先を重複なしで導出する', () => {
  assert.deepEqual(deriveSettingsTargetPathsForGroups([
    { targetPaths: ['/tmp/a.json', '/tmp/b.json'] },
    { targetPaths: ['/tmp/a.json', '/tmp/c.json'] },
    { targetPaths: [null, '', '/tmp/b.json'] },
  ]), ['/tmp/a.json', '/tmp/b.json', '/tmp/c.json']);
});
