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

test('normalizeSettingsTabs: 重複する id のタブは最初の 1 つだけ残す', () => {
  // 重複を残すと group.tab / tabLink.tab の参照が後勝ちになり、先に定義したタブが
  // 中身の無い空タブになってしまう。
  assert.deepEqual(normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '設定' },
      { id: 'mobile', label: '外出先から確認' },
      { id: 'general', label: '設定（重複）' },
    ],
  }), [
    { id: 'general', label: '設定', index: 0 },
    { id: 'mobile', label: '外出先から確認', index: 1 },
  ]);
});

test('normalizeSettingsTabs: 重複除去後も group は残ったタブへ正しく振り分けられる', () => {
  const tabs = normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '設定' },
      { id: 'general', label: '設定（重複）' },
      { id: 'mobile', label: '外出先から確認' },
    ],
  });
  const grouped = groupSettingsGroupsByTab([{ label: '基本', tab: 'general' }], tabs);

  assert.equal(grouped.length, 2);
  // 先頭の general タブに group が入る（重複タブに吸い取られない）。
  assert.deepEqual(grouped[0].groups.map((group) => group.label), ['基本']);
  assert.deepEqual(grouped[1].groups, []);
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
    { type: 'heading', text: '見出し', level: 3 },
    { type: 'paragraph', text: '本文' },
    { type: 'list', ordered: false, items: ['A', 'B'] },
    { type: 'list', ordered: true, items: ['1 番目'] },
    { type: 'code', text: 'http://<Tailscale IP>:13847/' },
    { type: 'links', items: [{ label: 'Tailscale', url: 'https://tailscale.com/download' }] },
    { type: 'callout', tone: 'warning', text: '認証はありません' },
    { type: 'tabLink', label: '「設定」タブを開く', tab: 'general' },
  ]);
});

test('normalizeSettingsTabContent: heading の level は 3 / 4 だけ採用し、既定は 3', () => {
  // level は「親セクション（3）／子セクション（4）」の 2 段だけ。不正値でブロックごと
  // 落とすと後続の段落が直前のセクションに吸収されて意味が壊れるため、3 に落着させる。
  // 先頭ブロックには level 4 の繰り上げ規則が働くので、値そのものの判定は
  // 親見出し（level 3）を 1 つ置いた後ろで確かめる。
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'heading', text: '親セクション', level: 3 },
    { type: 'heading', text: '子セクション', level: 4 },
    { type: 'heading', text: '5 以上は 4 に寄せる', level: 5 },
    { type: 'heading', text: '2 以下は 3', level: 2 },
    // 文字列は数値に強制変換しない（全角数字や "4.0" の扱いが曖昧になるだけ）。
    { type: 'heading', text: '文字列は 3', level: '4' },
    { type: 'heading', text: 'null は 3', level: null },
    { type: 'heading', text: '非整数は 3', level: 3.5 },
    { type: 'heading', text: '未指定は 3' },
  ]), [
    { type: 'heading', text: '親セクション', level: 3 },
    { type: 'heading', text: '子セクション', level: 4 },
    { type: 'heading', text: '5 以上は 4 に寄せる', level: 4 },
    { type: 'heading', text: '2 以下は 3', level: 3 },
    { type: 'heading', text: '文字列は 3', level: 3 },
    { type: 'heading', text: 'null は 3', level: 3 },
    { type: 'heading', text: '非整数は 3', level: 3 },
    { type: 'heading', text: '未指定は 3', level: 3 },
  ]);
});

test('normalizeSettingsTabContent: 親の h3 が出る前の level 4 は 3 に繰り上げる', () => {
  // 先頭が level 4 だと、モーダル見出し（h2）の直下が h4 になって見出しレベルが
  // 1 段飛ぶ（WCAG 1.3.1）。並びを見ないと判定できないので、ここで担保する。
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'heading', text: '先頭の子見出し', level: 4 },
    { type: 'paragraph', text: '本文' },
    // 繰り上げで親（level 3）が立つので、これ以降の level 4 はそのまま子扱い。
    { type: 'heading', text: '2 つ目の子見出し', level: 4 },
  ]), [
    { type: 'heading', text: '先頭の子見出し', level: 3 },
    { type: 'paragraph', text: '本文' },
    { type: 'heading', text: '2 つ目の子見出し', level: 4 },
  ]);

  // text 欠落で落ちたブロックは親として数えない（描画されない見出しを親にすると、
  // 実際の画面では h2 の直下に h4 が出てしまう）。
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'heading', level: 3 },
    { type: 'heading', text: '子見出しのつもり', level: 4 },
  ]), [
    { type: 'heading', text: '子見出しのつもり', level: 3 },
  ]);
});

test('normalizeSettingsTabContent: h3 が先に出ていれば後続の level 4 は 4 のまま', () => {
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'heading', text: '外出先から開く 2 つの方法' },
    { type: 'heading', text: '方法 1', level: 4 },
    { type: 'heading', text: '方法 2', level: 4 },
    // h4 → h3 と戻るのは正常（子セクションを抜けたことを伝える）。
    { type: 'heading', text: 'セキュリティ上の注意' },
  ]), [
    { type: 'heading', text: '外出先から開く 2 つの方法', level: 3 },
    { type: 'heading', text: '方法 1', level: 4 },
    { type: 'heading', text: '方法 2', level: 4 },
    { type: 'heading', text: 'セキュリティ上の注意', level: 3 },
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

test('normalizeSettingsTabContent: tabLink の field は実在するキーだけ採用する', () => {
  const options = {
    tabIds: ['general'],
    fieldTabs: [['apiHost', 'general'], ['initialCommand', 'general']],
  };
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'tabLink', label: 'API ホストへ', tab: 'general', field: 'apiHost' },
    // 未知のキーは field だけ落とし、タブ移動は効かせる（ブロックごと落とさない）。
    { type: 'tabLink', label: '未知のキー', tab: 'general', field: 'nope' },
    { type: 'tabLink', label: 'field 空', tab: 'general', field: '  ' },
    { type: 'tabLink', label: 'field 非文字列', tab: 'general', field: 1 },
    { type: 'tabLink', label: 'field 無し', tab: 'general' },
  ], options), [
    { type: 'tabLink', label: 'API ホストへ', tab: 'general', field: 'apiHost' },
    { type: 'tabLink', label: '未知のキー', tab: 'general' },
    { type: 'tabLink', label: 'field 空', tab: 'general' },
    { type: 'tabLink', label: 'field 非文字列', tab: 'general' },
    { type: 'tabLink', label: 'field 無し', tab: 'general' },
  ]);
});

test('normalizeSettingsTabs: field の検証には desc.groups のフィールドキーを使う', () => {
  const [, mobileTab] = normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '設定' },
      {
        id: 'mobile',
        label: '外出先から確認',
        content: [
          { type: 'tabLink', label: 'API ホストへ', tab: 'general', field: 'apiHost' },
          { type: 'tabLink', label: '存在しない欄へ', tab: 'general', field: 'ghost' },
        ],
      },
    ],
    groups: [
      { label: '基本', tab: 'general', fields: [{ key: 'apiHost', label: 'API ホスト', type: 'text' }] },
    ],
  });

  assert.deepEqual(mobileTab.content, [
    { type: 'tabLink', label: 'API ホストへ', tab: 'general', field: 'apiHost' },
    { type: 'tabLink', label: '存在しない欄へ', tab: 'general' },
  ]);
});

test('normalizeSettingsTabContent: field の所属タブが tab と食い違う場合は field だけ落とす', () => {
  // 採用してしまうと、着地に成功したときは field の実タブ（tokens）へ、失敗したときは
  // 宣言どおりの tab（general）へと、同じボタンが経路によって別のタブに着地する。
  const options = {
    tabIds: ['general', 'tokens'],
    fieldTabs: [['apiHost', 'general'], ['githubToken', 'tokens']],
  };
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'tabLink', label: '一致', tab: 'general', field: 'apiHost' },
    { type: 'tabLink', label: '不一致', tab: 'general', field: 'githubToken' },
  ], options), [
    { type: 'tabLink', label: '一致', tab: 'general', field: 'apiHost' },
    { type: 'tabLink', label: '不一致', tab: 'general' },
  ]);
});

test('normalizeSettingsTabs: 別タブのフィールドを指す tabLink は field を落としてタブ移動だけ残す', () => {
  const [, , mobileTab] = normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '設定' },
      { id: 'tokens', label: 'トークン' },
      {
        id: 'mobile',
        label: '外出先から確認',
        content: [
          // 「設定」タブへ移動するボタンなのに、指している欄は「トークン」タブにある。
          { type: 'tabLink', label: '設定タブへ', tab: 'general', field: 'githubToken' },
          { type: 'tabLink', label: 'トークンタブへ', tab: 'tokens', field: 'githubToken' },
        ],
      },
    ],
    groups: [
      { label: '基本', tab: 'general', fields: [{ key: 'apiHost', label: 'API ホスト', type: 'text' }] },
      { label: 'トークン', tab: 'tokens', fields: [{ key: 'githubToken', label: 'GitHub トークン', type: 'password' }] },
    ],
  });

  assert.deepEqual(mobileTab.content, [
    { type: 'tabLink', label: '設定タブへ', tab: 'general' },
    { type: 'tabLink', label: 'トークンタブへ', tab: 'tokens', field: 'githubToken' },
  ]);
});

test('normalizeSettingsTabs: キー重複時の所属タブは宣言順ではなく描画順（タブ順）で決まる', () => {
  // 描画側は groupSettingsGroupsByTab の順（タブ順 → タブ内グループ順）で入力欄を採番し、
  // 移動先の解決も最初に見つかったキーを拾う。desc.groups の宣言順で判定すると両者がずれ、
  // 検証を通るのに押すと別タブへ着地する tabLink が残る（逆に正しく着地する方が落とされる）。
  const [, , mobileTab] = normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '設定' },
      { id: 'tokens', label: 'トークン' },
      {
        id: 'mobile',
        label: '外出先から確認',
        content: [
          // dup は general / tokens の両方にあるが、先に描画されるのは general 側。
          { type: 'tabLink', label: '実際の着地先', tab: 'general', field: 'dup' },
          { type: 'tabLink', label: '宣言順だと通ってしまう方', tab: 'tokens', field: 'dup' },
        ],
      },
    ],
    // 宣言順は tokens が先だが、タブ順では general が先に描画される。
    groups: [
      { label: 'トークン', tab: 'tokens', fields: [{ key: 'dup', label: '重複キー', type: 'text' }] },
      { label: '基本', tab: 'general', fields: [{ key: 'dup', label: '重複キー', type: 'text' }] },
    ],
  });

  assert.deepEqual(mobileTab.content, [
    { type: 'tabLink', label: '実際の着地先', tab: 'general', field: 'dup' },
    { type: 'tabLink', label: '宣言順だと通ってしまう方', tab: 'tokens' },
  ]);
});

test('normalizeSettingsTabs: tab 未指定の group のフィールドは先頭タブ扱いで照合する', () => {
  // 描画側（groupSettingsGroupsByTab）が tab 未指定・未知の group を先頭タブへ寄せるので、
  // field の所属タブ判定も同じ規則に揃える。ずれると表示と判定が食い違う。
  const [, mobileTab] = normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '設定' },
      {
        id: 'mobile',
        label: '外出先から確認',
        content: [
          { type: 'tabLink', label: 'tab 未指定の group', tab: 'general', field: 'apiHost' },
          { type: 'tabLink', label: '未知の tab を持つ group', tab: 'general', field: 'initialCommand' },
        ],
      },
    ],
    groups: [
      { label: '基本', fields: [{ key: 'apiHost', label: 'API ホスト', type: 'text' }] },
      { label: '起動', tab: 'nope', fields: [{ key: 'initialCommand', label: '起動コマンド', type: 'text' }] },
    ],
  });

  assert.deepEqual(mobileTab.content, [
    { type: 'tabLink', label: 'tab 未指定の group', tab: 'general', field: 'apiHost' },
    { type: 'tabLink', label: '未知の tab を持つ group', tab: 'general', field: 'initialCommand' },
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
        { type: 'heading', text: 'スマートフォンから確認できます', level: 3 },
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
