'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  dedupeSettingsFieldsByKey,
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

test('dedupeSettingsFieldsByKey: 同一グループ内の重複キーは最初の 1 つだけ残す', () => {
  const groups = [{
    label: '基本',
    fields: [
      { key: 'host', label: '最初のホスト', type: 'text' },
      { key: 'port', label: 'ポート', type: 'text' },
      { key: 'host', label: '後のホスト', type: 'text' },
    ],
  }];

  assert.deepEqual(dedupeSettingsFieldsByKey(groups, []), [{
    label: '基本',
    fields: [
      { key: 'host', label: '最初のホスト', type: 'text' },
      { key: 'port', label: 'ポート', type: 'text' },
    ],
  }]);
});

test('dedupeSettingsFieldsByKey: 組み込みプロパティ名の重複キーも先勝ちで 1 件残す', () => {
  const prototypeKeys = ['__proto__', 'constructor', 'toString'];
  const fields = prototypeKeys.flatMap((key) => [
    { key, label: `${key} の最初`, type: 'text' },
    { key, label: `${key} の重複`, type: 'text' },
  ]);

  assert.deepEqual(dedupeSettingsFieldsByKey([{ label: '組み込み名', fields }], []), [{
    label: '組み込み名',
    fields: prototypeKeys.map((key) => (
      { key, label: `${key} の最初`, type: 'text' }
    )),
  }]);
});

test('dedupeSettingsFieldsByKey: 別グループの重複キーはタブ順の描画で最初の 1 つを残す', () => {
  const tabs = normalizeSettingsTabs({
    tabs: [
      { id: 'general', label: '基本' },
      { id: 'tokens', label: 'トークン' },
      {
        id: 'guide',
        label: '案内',
        content: [
          { type: 'tabLink', label: '重複キーへ', tab: 'general', field: 'duplicate' },
          { type: 'tabLink', label: '宣言順の欄へ', tab: 'tokens', field: 'duplicate' },
        ],
      },
    ],
    // 宣言では tokens が先だが、描画ではタブ順により general が先になる。
    groups: [
      {
        label: 'トークン',
        tab: 'tokens',
        fields: [
          { key: 'duplicate', label: '宣言順では最初', type: 'text' },
          { key: 'token', label: 'トークン', type: 'text' },
        ],
      },
      {
        label: '基本',
        tab: 'general',
        fields: [{ key: 'duplicate', label: '描画順では最初', type: 'text' }],
      },
    ],
  });
  const groups = [
    {
      label: 'トークン',
      tab: 'tokens',
      fields: [
        { key: 'duplicate', label: '宣言順では最初', type: 'text' },
        { key: 'token', label: 'トークン', type: 'text' },
      ],
    },
    {
      label: '基本',
      tab: 'general',
      fields: [{ key: 'duplicate', label: '描画順では最初', type: 'text' }],
    },
  ];

  const deduped = dedupeSettingsFieldsByKey(groups, tabs);
  assert.deepEqual(deduped, [
    {
      label: '基本',
      tab: 'general',
      fields: [{ key: 'duplicate', label: '描画順では最初', type: 'text' }],
    },
    {
      label: 'トークン',
      tab: 'tokens',
      fields: [{ key: 'token', label: 'トークン', type: 'text' }],
    },
  ]);
  // 所属タブの検証も描画順で先勝ちなので、残った duplicate のタブと tabLink が一致する。
  assert.deepEqual(tabs[2].content, [
    { type: 'tabLink', label: '重複キーへ', tab: 'general', field: 'duplicate' },
    { type: 'tabLink', label: '宣言順の欄へ', tab: 'tokens' },
  ]);
});

test('dedupeSettingsFieldsByKey: tab 未指定と未知 tab のグループは宣言順より描画順を優先する', () => {
  const tabs = [
    { id: 'general', label: '基本', index: 0 },
    { id: 'tokens', label: 'トークン', index: 1 },
  ];
  const groups = [
    {
      label: '宣言順では最初',
      tab: 'tokens',
      fields: [{ key: 'duplicate', label: '後から描画', type: 'text' }],
    },
    {
      label: 'tab 未指定',
      fields: [{ key: 'duplicate', label: '最初に描画', type: 'text' }],
    },
    {
      label: '未知 tab',
      tab: 'missing',
      fields: [
        { key: 'duplicate', label: '先頭タブ内で後から描画', type: 'text' },
        { key: 'unknown-only', label: '未知 tab の固有欄', type: 'text' },
      ],
    },
  ];

  assert.deepEqual(dedupeSettingsFieldsByKey(groups, tabs), [
    {
      label: 'tab 未指定',
      fields: [{ key: 'duplicate', label: '最初に描画', type: 'text' }],
    },
    {
      label: '未知 tab',
      tab: 'missing',
      fields: [{ key: 'unknown-only', label: '未知 tab の固有欄', type: 'text' }],
    },
  ]);
});

test('dedupeSettingsFieldsByKey: タブ無しではグループの宣言順で最初のキーを残す', () => {
  const groups = [
    {
      label: '先',
      fields: [{ key: 'duplicate', label: '宣言順で最初', type: 'text' }],
    },
    {
      label: '後',
      fields: [
        { key: 'duplicate', label: '宣言順で後', type: 'text' },
        { key: 'unique', label: '固有', type: 'text' },
      ],
    },
  ];

  assert.deepEqual(dedupeSettingsFieldsByKey(groups, []), [
    {
      label: '先',
      fields: [{ key: 'duplicate', label: '宣言順で最初', type: 'text' }],
    },
    {
      label: '後',
      fields: [{ key: 'unique', label: '固有', type: 'text' }],
    },
  ]);
});

test('dedupeSettingsFieldsByKey: 重複が無い場合は内容を変えず入力も破壊しない', () => {
  const firstFields = [{ key: 'host', label: 'ホスト', type: 'text' }];
  const secondFields = [{ key: 'token', label: 'トークン', type: 'password' }];
  const groups = [
    { label: '基本', tab: 'general', fields: firstFields },
    { label: '認証', tab: 'tokens', fields: secondFields },
  ];
  const before = structuredClone(groups);
  const tabs = [
    { id: 'general', label: '基本', index: 0 },
    { id: 'tokens', label: 'トークン', index: 1 },
  ];

  const deduped = dedupeSettingsFieldsByKey(groups, tabs);
  assert.deepEqual(deduped, before);
  assert.deepEqual(groups, before);
  // 戻り値側の fields を後から変更しても、設定ディスクリプタの配列には波及しない。
  assert.notEqual(deduped[0], groups[0]);
  assert.notEqual(deduped[0].fields, firstFields);
  assert.notEqual(deduped[1].fields, secondFields);
});

test('dedupeSettingsFieldsByKey: 不正な key のフィールド同士は重複扱いで落とさない', () => {
  const fields = [
    { label: 'key 無し', type: 'text' },
    { key: null, label: 'null', type: 'text' },
    { key: 0, label: '数値', type: 'text' },
    { key: '', label: '空文字', type: 'text' },
    { key: '   ', label: '空白のみ', type: 'text' },
    { key: '', label: '空文字 2', type: 'text' },
    { key: 'valid', label: '有効', type: 'text' },
    { key: 'valid', label: '有効な重複', type: 'text' },
  ];

  assert.deepEqual(dedupeSettingsFieldsByKey([{ label: '不正キー', fields }], []), [{
    label: '不正キー',
    fields: fields.slice(0, 7),
  }]);
});

test('dedupeSettingsFieldsByKey: 非配列の groups・group・fields は例外なくそのまま通す', () => {
  assert.deepEqual(dedupeSettingsFieldsByKey(null, []), []);
  assert.deepEqual(dedupeSettingsFieldsByKey({ fields: [] }, []), []);
  assert.deepEqual(dedupeSettingsFieldsByKey([
    null,
    42,
    { label: 'fields 未指定' },
    { label: 'fields が非配列', fields: 'not-array' },
  ], []), [
    null,
    42,
    { label: 'fields 未指定' },
    { label: 'fields が非配列', fields: 'not-array' },
  ]);
});

test('dedupeSettingsFieldsByKey: 落とした重複キーを 1 行の警告にまとめる', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    dedupeSettingsFieldsByKey([{
      fields: [
        { key: 'host' },
        { key: 'host' },
        { key: 'token' },
        { key: 'token' },
        { key: 'host' },
      ],
    }], []);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [[
    '[settings] 重複した key のため設定欄をスキップしました:',
    'host, token',
  ]]);
});

test('dedupeSettingsFieldsByKey: 重複キーが無いときは警告しない', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    dedupeSettingsFieldsByKey([{
      fields: [
        { key: 'host' },
        { key: 'token' },
      ],
    }], []);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
});

test('dedupeSettingsFieldsByKey: 重複除去で空になったグループだけを描画対象から外す', () => {
  const groups = [
    {
      label: '採用されるグループ',
      fields: [{ key: 'duplicate', label: '最初', type: 'text' }],
    },
    {
      label: '重複だけのグループ',
      fields: [{ key: 'duplicate', label: '後', type: 'text' }],
    },
    // 元から空のグループは既存の表示仕様を変えないため残す。
    { label: '元から空', fields: [] },
  ];

  assert.deepEqual(dedupeSettingsFieldsByKey(groups, []), [
    {
      label: '採用されるグループ',
      fields: [{ key: 'duplicate', label: '最初', type: 'text' }],
    },
    { label: '元から空', fields: [] },
  ]);
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
    { type: 'code', text: 'http://<Tailscale IP>:13847/', copy: true },
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

test('normalizeSettingsTabContent: 呼び出し側が渡したブロックを書き換えない', () => {
  // 繰り上げ（level 4 → 3）は正規化後のコピーに対して行い、rawContent は無傷に保つ。
  // 「正規化は必ず新しいオブジェクトを返す」という前提が崩れると、スキーマ定義そのものを
  // 書き換えてしまう（同じ定義を使い回す呼び出し側で 2 回目の描画結果が変わる）。
  const raw = [{ type: 'heading', text: '先頭の子見出し', level: 4 }];
  const out = normalizeSettingsTabContent(raw);
  assert.equal(raw[0].level, 4);        // 入力の定義は変わらない
  assert.notEqual(out[0], raw[0]);      // 参照を共有していない
  assert.equal(out[0].level, 3);
  // 凍結されたブロックを渡しても例外にならない（副作用の有無をもう一段で担保）。
  assert.doesNotThrow(() => normalizeSettingsTabContent([
    Object.freeze({ type: 'heading', text: 'a', level: 4 }),
    Object.freeze({ type: 'heading', text: 'b', level: 4 }),
  ]));
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

// code ブロックの copy（コピーボタンの有無）。既定はコピーできる方に寄せ、
// 明示的な false だけをボタン無しとして扱う。外部ディスクリプタ
// （VK_TERMINALS_SETTINGS）に壊れた値が入っていても、コピー機能が黙って
// 消えないことを保証する。
test('normalizeSettingsTabContent: code の copy は明示的な false のみ無効化する', () => {
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'code', text: 'copy 省略' },
    { type: 'code', text: 'copy true', copy: true },
    { type: 'code', text: 'copy false', copy: false },
    { type: 'code', text: 'copy 文字列 no', copy: 'no' },
    { type: 'code', text: 'copy 文字列 false', copy: 'false' },
    { type: 'code', text: 'copy 数値 0', copy: 0 },
    { type: 'code', text: 'copy null', copy: null },
  ]), [
    { type: 'code', text: 'copy 省略', copy: true },
    { type: 'code', text: 'copy true', copy: true },
    { type: 'code', text: 'copy false', copy: false },
    { type: 'code', text: 'copy 文字列 no', copy: true },
    { type: 'code', text: 'copy 文字列 false', copy: true },
    { type: 'code', text: 'copy 数値 0', copy: true },
    { type: 'code', text: 'copy null', copy: true },
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

test('normalizeSettingsTabContent: status は既知の apiServer source だけを採用する', () => {
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'status', source: 'apiServer' },
    { type: 'status', source: 'unknown' },
    { type: 'status' },
  ]), [
    { type: 'status', source: 'apiServer' },
  ]);
});

test('normalizeSettingsTabContent: apiTokenPanel はプロパティを持たず素通しする（issue #313）', () => {
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'apiTokenPanel' },
    // トークン本体等の秘密情報をディスクリプタに紛れ込ませても無視する。
    { type: 'apiTokenPanel', token: 'leaked-should-be-ignored' },
  ]), [
    { type: 'apiTokenPanel' },
    { type: 'apiTokenPanel' },
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
    // tokens 側には重複しない欄も置き、重複除去でタブごと空にならないようにする
    // （空になると issue #275 の判定で tabLink ごと落ち、field だけを落とす挙動が見えない）。
    groups: [
      {
        label: 'トークン',
        tab: 'tokens',
        fields: [
          { key: 'dup', label: '重複キー', type: 'text' },
          { key: 'githubToken', label: 'GitHub トークン', type: 'password' },
        ],
      },
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
    // general に入力欄を持たせて、mobile の tabLink が issue #275 の空タブ判定で
    // 落ちないようにする（ここで見たいのは content の正規化と非空判定のみ）。
    groups: [
      { label: '基本', tab: 'general', fields: [{ key: 'apiHost', label: 'API ホスト', type: 'text' }] },
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

// ─── 移動先に表示できる内容が無い tabLink（issue #275） ─────────────────────────
//
// 「開いても『このタブに表示できる設定項目はありません。』だけが出るタブ」への移動ボタンは、
// 押した先が行き止まりになるため表示しない。判定条件（説明コンテンツ・グループ・note の
// どれも無い）は renderer/app.js の案内文の条件と対であり、片方だけ変えると「見えている
// のにボタンが出ない」または「ボタンは出るのに行き止まり」が残る。

test('normalizeSettingsTabs: 入力欄も説明も note も無いタブを指す tabLink はブロックごと落とす', () => {
  const [, guideTab] = normalizeSettingsTabs({
    tabs: [
      { id: 'empty', label: '中身なし' },
      {
        id: 'guide',
        label: '案内',
        content: [
          { type: 'paragraph', text: '説明本文' },
          { type: 'tabLink', label: '中身なしへ移動', tab: 'empty' },
        ],
      },
    ],
    groups: [],
  });

  // 移動ボタンだけが消え、同じ content の他のブロックは残る。
  assert.deepEqual(guideTab.content, [{ type: 'paragraph', text: '説明本文' }]);
});

test('normalizeSettingsTabs: 表示できる内容があるタブを指す tabLink は残す', () => {
  // 説明あり / 入力欄あり / 項目 0 件のグループだけ / note だけ の 4 パターンはいずれも
  // 案内文が出ない（＝行き止まりではない）ため、移動ボタンを落としてはいけない。
  const tabs = normalizeSettingsTabs({
    tabs: [
      { id: 'fields', label: '実欄あり' },
      { id: 'desc', label: '説明だけ', content: [{ type: 'paragraph', text: '読むものがある' }] },
      { id: 'emptyGroup', label: '空グループ' },
      { id: 'noteOnly', label: 'note だけ', note: 'この機能は環境変数で設定します' },
      {
        id: 'guide',
        label: '案内',
        content: [
          { type: 'tabLink', label: '実欄ありへ', tab: 'fields' },
          { type: 'tabLink', label: '説明だけへ', tab: 'desc' },
          { type: 'tabLink', label: '空グループへ', tab: 'emptyGroup' },
          { type: 'tabLink', label: 'note だけへ', tab: 'noteOnly' },
        ],
      },
    ],
    groups: [
      { label: '基本', tab: 'fields', fields: [{ key: 'host', label: '接続先', type: 'text' }] },
      // 元から fields が空のグループ。描画側はこのグループの legend（グループ名）を
      // 残すため、開いた人には読めるものがある。よって空タブ扱いにしない。
      { label: '未実装の設定', tab: 'emptyGroup', fields: [] },
    ],
  });

  assert.deepEqual(tabs[4].content, [
    { type: 'tabLink', label: '実欄ありへ', tab: 'fields' },
    { type: 'tabLink', label: '説明だけへ', tab: 'desc' },
    { type: 'tabLink', label: '空グループへ', tab: 'emptyGroup' },
    { type: 'tabLink', label: 'note だけへ', tab: 'noteOnly' },
  ]);
});

test('normalizeSettingsTabs: キー重複でグループごと消えて空になるタブを指す tabLink も落とす', () => {
  // 素の desc.groups で数えると「グループが 1 つある」ことになり、行き止まりが残る。
  // 案内文と同じく、重複キーを取り除いた後の状態で数える必要がある。
  const [, , guideTab] = normalizeSettingsTabs({
    tabs: [
      { id: 'fields', label: '実欄あり' },
      { id: 'deduped', label: '重複' },
      {
        id: 'guide',
        label: '案内',
        content: [{ type: 'tabLink', label: '重複タブへ移動', tab: 'deduped' }],
      },
    ],
    groups: [
      { label: '基本', tab: 'fields', fields: [{ key: 'host', label: '接続先', type: 'text' }] },
      // host は fields タブ側が先に描画されるため、こちらはグループごと消える。
      { label: '重複した設定', tab: 'deduped', fields: [{ key: 'host', label: '後の接続先', type: 'text' }] },
    ],
  });

  // content が空になったタブは content プロパティ自体を持たない（既存仕様）。
  assert.equal(guideTab.content, undefined);
});

test('normalizeSettingsTabs: 移動ボタンを落として空になったタブを指す tabLink も連鎖して落とす', () => {
  // 1 回だけの判定では、原因がアプリ側に変わっただけの行き止まりを新しく作ってしまう。
  const [, viaEmpty, viaViaEmpty, guideTab] = normalizeSettingsTabs({
    tabs: [
      { id: 'empty', label: '中身なし' },
      // 中身なしタブへの移動ボタンだけを持つタブ。ボタンが落ちると自身も空になる。
      { id: 'hop1', label: '経由 1', content: [{ type: 'tabLink', label: '中身なしへ', tab: 'empty' }] },
      // さらに 1 段深い連鎖。
      { id: 'hop2', label: '経由 2', content: [{ type: 'tabLink', label: '経由 1 へ', tab: 'hop1' }] },
      {
        id: 'guide',
        label: '案内',
        content: [
          { type: 'paragraph', text: '残る本文' },
          { type: 'tabLink', label: '経由 2 へ', tab: 'hop2' },
        ],
      },
    ],
    groups: [],
  });

  assert.equal(viaEmpty.content, undefined);
  assert.equal(viaViaEmpty.content, undefined);
  assert.deepEqual(guideTab.content, [{ type: 'paragraph', text: '残る本文' }]);
});

test('normalizeSettingsTabs: 空タブへの移動ボタンを落としても同じ content の他ブロックは残す', () => {
  const [, , guideTab] = normalizeSettingsTabs({
    tabs: [
      { id: 'fields', label: '実欄あり' },
      { id: 'empty', label: '中身なし' },
      {
        id: 'guide',
        label: '案内',
        content: [
          { type: 'heading', text: '見出し' },
          { type: 'paragraph', text: '本文' },
          { type: 'tabLink', label: '中身なしへ', tab: 'empty' },
          { type: 'tabLink', label: '実欄ありへ', tab: 'fields' },
        ],
      },
    ],
    groups: [
      { label: '基本', tab: 'fields', fields: [{ key: 'host', label: '接続先', type: 'text' }] },
    ],
  });

  assert.deepEqual(guideTab.content, [
    { type: 'heading', text: '見出し', level: 3 },
    { type: 'paragraph', text: '本文' },
    { type: 'tabLink', label: '実欄ありへ', tab: 'fields' },
  ]);
});

test('normalizeSettingsTabs: 落とした tabLink を 1 行の警告にまとめる', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    normalizeSettingsTabs({
      tabs: [
        { id: 'empty', label: '中身なし' },
        { id: 'hop', label: '経由', content: [{ type: 'tabLink', label: '中身なしへ', tab: 'empty' }] },
        {
          id: 'guide',
          label: '案内',
          content: [
            { type: 'tabLink', label: '中身なしへ移動', tab: 'empty' },
            { type: 'tabLink', label: '経由タブへ移動', tab: 'hop' },
          ],
        },
      ],
      groups: [],
    });
  } finally {
    console.warn = originalWarn;
  }

  // 連鎖で落ちた分（hop → empty / guide → hop）も同じ 1 行にまとめる。
  // 各件は「起点タブ・ボタンのラベル・移動先」の順。ラベルを括弧に入れると移動先タブの
  // ラベルと読み違えられ、設定ファイル内の該当箇所を探せなくなるため、この順を固定する。
  assert.deepEqual(warnings, [[
    '[settings] 移動先のタブに表示できる内容が無いため tabLink を表示しませんでした:',
    'hop タブの「中身なしへ」→ empty, guide タブの「中身なしへ移動」→ empty, guide タブの「経由タブへ移動」→ hop',
  ]]);
});

test('normalizeSettingsTabs: 落とす tabLink が無いときは警告しない', () => {
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    normalizeSettingsTabs({
      tabs: [
        { id: 'fields', label: '実欄あり' },
        { id: 'guide', label: '案内', content: [{ type: 'tabLink', label: '実欄ありへ', tab: 'fields' }] },
      ],
      groups: [
        { label: '基本', tab: 'fields', fields: [{ key: 'host', label: '接続先', type: 'text' }] },
      ],
    });
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, []);
});

test('normalizeSettingsTabs: 重複キーの警告は描画側の 1 回だけで二重に出さない', () => {
  // 空タブ判定のために normalizeSettingsTabs の中でも重複除去が必要になるが、警告は
  // 描画側（renderer/app.js の dedupeSettingsFieldsByKey）の 1 回だけに保つ。
  const desc = {
    tabs: [
      { id: 'fields', label: '実欄あり' },
      { id: 'deduped', label: '重複' },
    ],
    groups: [
      { label: '基本', tab: 'fields', fields: [{ key: 'host', label: '接続先', type: 'text' }] },
      { label: '重複した設定', tab: 'deduped', fields: [{ key: 'host', label: '後の接続先', type: 'text' }] },
    ],
  };
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args);
  try {
    // renderer/app.js と同じ呼び出し順（正規化 → 重複除去）。
    const tabs = normalizeSettingsTabs(desc);
    dedupeSettingsFieldsByKey(desc.groups, tabs);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(warnings, [[
    '[settings] 重複した key のため設定欄をスキップしました:',
    'host',
  ]]);
});

test('normalizeSettingsTabs: 組み込みプロパティ名のタブ ID でも空タブ判定が誤らず汚染も起きない', () => {
  // 空タブの集計（空タブ集合・タブ別グループ数・note）を素のオブジェクトで持つ実装に戻すと、
  // '__proto__' の代入で Object.prototype が書き換わり、'toString' / 'constructor' は
  // 代入前から truthy に見えて判定が壊れる。Map / Set のままであることを固定する（#273）。
  const [protoTab, toStringTab, constructorTab, prototypeTab] = normalizeSettingsTabs({
    tabs: [
      { id: '__proto__', label: 'proto' },
      { id: 'toString', content: [{ type: 'paragraph', text: 'hello' }] },
      // 空タブ（__proto__）を指すので落ちる。
      { id: 'constructor', content: [{ type: 'tabLink', tab: '__proto__', label: 'go' }] },
      // 内容のあるタブ（toString）を指すので残る。
      { id: 'prototype', content: [{ type: 'tabLink', tab: 'toString', label: 'go2' }] },
    ],
    groups: [],
  });

  assert.deepEqual(protoTab, { id: '__proto__', label: 'proto', index: 0 });
  assert.deepEqual(toStringTab, {
    id: 'toString',
    label: 'toString',
    index: 1,
    content: [{ type: 'paragraph', text: 'hello' }],
  });
  assert.equal(constructorTab.content, undefined);
  assert.deepEqual(prototypeTab.content, [{ type: 'tabLink', label: 'go2', tab: 'toString' }]);

  // 無関係なオブジェクトへ正規化結果が漏れていない（プロトタイプ汚染が起きていない）。
  assert.deepEqual(Object.keys({}), []);
  assert.equal({}.index, undefined);
  assert.equal({}.content, undefined);
});

test('normalizeSettingsTabs: 相互参照・自己参照の tabLink は落とさずカスケードが停止する', () => {
  // 移動ボタン自体がそのタブの content なので、どのタブも空タブにはならない。1 巡目で
  // 新しい空タブが見つからず収束する（ここで落とすと、参照が循環しているだけの正常な
  // 定義から導線が消える）。自己参照を落とさないことも #275 の定義どおりの仕様。
  const tabs = normalizeSettingsTabs({
    tabs: [
      { id: 'a', label: 'A', content: [{ type: 'tabLink', label: 'B へ', tab: 'b' }] },
      { id: 'b', label: 'B', content: [{ type: 'tabLink', label: 'A へ', tab: 'a' }] },
      { id: 'c', label: 'C', content: [{ type: 'tabLink', label: '自分へ', tab: 'c' }] },
    ],
    groups: [],
  });

  assert.deepEqual(tabs.map((tab) => tab.content), [
    [{ type: 'tabLink', label: 'B へ', tab: 'b' }],
    [{ type: 'tabLink', label: 'A へ', tab: 'a' }],
    [{ type: 'tabLink', label: '自分へ', tab: 'c' }],
  ]);
});

test('normalizeSettingsTabs: 10 段の直鎖でも連鎖を最後まで潰しきる', () => {
  // 巡回上限を固定回数などタブ数より小さい値にすると、鎖の奥のタブに content が残る。
  // chain0（中身なし）← chain1 ← … ← chain10 と、1 巡で 1 段ずつ空タブが増える形。
  const CHAIN_LENGTH = 10;
  const tabs = [{ id: 'chain0', label: '中身なし' }];
  for (let i = 1; i <= CHAIN_LENGTH; i += 1) {
    tabs.push({
      id: `chain${i}`,
      label: `連鎖 ${i}`,
      content: [{ type: 'tabLink', label: `chain${i - 1} へ`, tab: `chain${i - 1}` }],
    });
  }

  const normalized = normalizeSettingsTabs({ tabs, groups: [] });

  assert.equal(normalized.length, CHAIN_LENGTH + 1);
  // 全段の移動ボタンが落ち、どのタブにも content が残らない。
  assert.deepEqual(normalized.map((tab) => tab.content), new Array(CHAIN_LENGTH + 1).fill(undefined));
});

test('normalizeSettingsTabContent: オプション未指定なら空タブ判定を行わず従来どおり動く', () => {
  // 単体ブロックの検証だけを期待して呼ぶ既存の呼び出し（テスト含む）を壊さない。
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'paragraph', text: '本文' },
    // tabIds を渡していないので参照先を検証できず、従来どおり tabLink は残らない。
    { type: 'tabLink', label: '設定へ', tab: 'general' },
  ]), [{ type: 'paragraph', text: '本文' }]);

  // tabIds だけを渡した場合は、移動先の中身を知らないまま tabLink を残す（従来の挙動）。
  assert.deepEqual(normalizeSettingsTabContent([
    { type: 'tabLink', label: '設定へ', tab: 'general' },
  ], { tabIds: ['general'] }), [
    { type: 'tabLink', label: '設定へ', tab: 'general' },
  ]);
});

test('deriveSettingsTargetPathsForGroups: tab 内 group の保存先を重複なしで導出する', () => {
  assert.deepEqual(deriveSettingsTargetPathsForGroups([
    { targetPaths: ['/tmp/a.json', '/tmp/b.json'] },
    { targetPaths: ['/tmp/a.json', '/tmp/c.json'] },
    { targetPaths: [null, '', '/tmp/b.json'] },
  ]), ['/tmp/a.json', '/tmp/b.json', '/tmp/c.json']);
});
