'use strict';

const { isSafeHttpUrl } = require('./urlSafety');

// tabs[].content で使える読み取り専用コンテンツブロックの種別。
// 保存対象の入力欄を持たない「説明だけのタブ」を、スキーマ駆動のまま表現するための仕組み。
// 描画側（renderer/app.js）は正規化済みのブロックだけを受け取り、描画に専念する。
const SETTINGS_CONTENT_CALLOUT_TONES = new Set(['info', 'warning']);

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value : '';
}

function toStringSet(value) {
  if (value instanceof Set) return value;
  return new Set(Array.isArray(value) ? value : []);
}

// [key, tabId] の配列でも Map でも受け取れるようにする（テストや呼び出し側の都合）。
function toStringMap(value) {
  if (value instanceof Map) return value;
  return new Map(Array.isArray(value) ? value.filter((entry) => Array.isArray(entry)) : []);
}

// tabLink の移動先（tab と field）の整合を見るための「フィールドキー → そのフィールドが
// 属するタブ ID」の対応表。
//
// 走査は desc.groups の宣言順ではなく groupSettingsGroupsByTab の結果（タブ順 →
// タブ内グループ順）で行う。描画側が入力欄を採番する順序がこれで、移動先の解決も
// 「最初に見つかったキー」を拾うため、順序がずれるとキー重複時にどちらを指すかが
// 判定と実際の着地先で食い違う。結果、検証は通るのに押すと別タブへ着地する tabLink が
// 残り、逆に正しく着地するものが落とされる。tab 未指定・未知の tab を持つ group を
// 先頭タブへ寄せる規則も、この関数を通すことで自動的に描画側と揃う。
//
// キーが重複する場合は先に拾われた 1 つを正とする。描画前の重複除去も同じ走査順で
// 最初の欄だけを残すため、所属タブ・移動先・保存対象は同じ欄に揃う。
function collectSettingsFieldTabs(desc, tabs) {
  const fieldTabs = new Map();
  const groups = (desc && Array.isArray(desc.groups)) ? desc.groups : [];
  for (const { tab, groups: tabGroups } of groupSettingsGroupsByTab(groups, tabs)) {
    for (const group of tabGroups) {
      const fields = (group && Array.isArray(group.fields)) ? group.fields : [];
      for (const field of fields) {
        const key = field && typeof field.key === 'string' ? field.key : '';
        if (!key.trim() || fieldTabs.has(key)) continue;
        fieldTabs.set(key, tab.id);
      }
    }
  }
  return fieldTabs;
}

// 1 ブロックを正規化する。不正なブロック（未知の type / text 欠落 / 非 http(s) URL など）は
// null を返して黙って落とす。外部ディスクリプタ（VK_TERMINALS_SETTINGS）由来の壊れた
// 定義でアプリ全体が壊れないようにするための方針。
function normalizeSettingsContentBlock(block, tabIds, fieldTabs) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) return null;
  const type = typeof block.type === 'string' ? block.type : '';

  if (type === 'heading') {
    const text = nonEmptyString(block.text);
    if (!text) return null;
    // 3 / 4 のみ。5 以上は 4 に寄せ、それ以外（2 以下 / 非整数 / "4" / 未指定）は 3。
    // 不正値でブロック自体を落とさないのは、見出しが消えると後続の段落が
    // 直前のセクションに吸収されて意味が壊れるため（callout の tone と同じ方針）。
    const level = (Number.isInteger(block.level) && block.level >= 4) ? 4 : 3;
    return { type, text, level };
  }

  // text だけを持つ唯一のブロック（heading は level、code は copy を併せて持つ）。
  if (type === 'paragraph') {
    const text = nonEmptyString(block.text);
    return text ? { type, text } : null;
  }

  if (type === 'code') {
    const text = nonEmptyString(block.text);
    if (!text) return null;
    // copy はコピーボタンを出すかどうか。既定（省略時）はコピーできる方に寄せる。
    // 外部ディスクリプタ（VK_TERMINALS_SETTINGS）由来の不正値でコピー機能が黙って
    // 死なないよう、明示的な false 以外はすべて true に寄せる（既定＝コピーできる）。
    return { type, text, copy: block.copy !== false };
  }

  if (type === 'list') {
    const items = (Array.isArray(block.items) ? block.items : [])
      .map((item) => nonEmptyString(item))
      .filter((item) => item !== '');
    if (!items.length) return null;
    return { type, ordered: block.ordered === true, items };
  }

  if (type === 'links') {
    const items = [];
    for (const item of Array.isArray(block.items) ? block.items : []) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const url = typeof item.url === 'string' ? item.url : '';
      // http(s) 以外（file: / javascript: など）はここで落とす。
      if (!isSafeHttpUrl(url)) continue;
      items.push({ label: nonEmptyString(item.label) || url, url });
    }
    if (!items.length) return null;
    return { type, items };
  }

  if (type === 'callout') {
    const text = nonEmptyString(block.text);
    if (!text) return null;
    const tone = SETTINGS_CONTENT_CALLOUT_TONES.has(block.tone) ? block.tone : 'info';
    return { type, tone, text };
  }

  if (type === 'tabLink') {
    // 同じモーダル内の別タブへ移動するボタン。存在しないタブ ID を指すものは落とす。
    const label = nonEmptyString(block.label);
    const tab = nonEmptyString(block.tab);
    if (!label || !tab || !tabIds.has(tab)) return null;
    const normalized = { type, label, tab };
    // field（任意）は「移動先タブの入力欄」。実在し、かつ宣言された tab に属するときだけ
    // 採用する。所属タブが食い違う field をそのまま採用すると、着地に成功したときは field の
    // 実タブへ、失敗したとき（非表示など）は宣言どおりの tab へと、経路によって別のタブへ
    // 飛ぶボタンになってしまう。不一致なら field の指定だけを落とし、タブ移動は効かせる。
    const field = nonEmptyString(block.field);
    if (field && fieldTabs.get(field) === tab) normalized.field = field;
    return normalized;
  }

  return null;
}

function normalizeSettingsTabContent(rawContent, options = {}) {
  const tabIds = toStringSet(options.tabIds);
  const fieldTabs = toStringMap(options.fieldTabs);
  const normalized = [];
  // そのタブで level 3 の heading がまだ出ていないかどうか。
  // 外部ディスクリプタ（VK_TERMINALS_SETTINGS）が content の 1 個目に level: 4 を書くと、
  // モーダル見出し（h2）の直下が h4 になり、見出しレベルが 1 段飛ぶ（WCAG 1.3.1 違反）。
  // これは前のブロックを見ないと判定できないため、単体ブロックを見る
  // normalizeSettingsContentBlock では防げず、並び全体を見るここでしか担保できない。
  let seenTopLevelHeading = false;
  for (const block of Array.isArray(rawContent) ? rawContent : []) {
    const normalizedBlock = normalizeSettingsContentBlock(block, tabIds, fieldTabs);
    if (!normalizedBlock) continue;
    if (normalizedBlock.type === 'heading') {
      // 親となる h3 が先に出ていない level 4 は 3 へ繰り上げる。繰り上げた見出し自身が
      // その親になるので、以降の level 4 は子見出しとしてそのまま通す。
      // 書き換えるのは normalizeSettingsContentBlock が返した新しいオブジェクトで、
      // 呼び出し側が渡した rawContent のブロックには触らない。
      if (!seenTopLevelHeading) {
        normalizedBlock.level = 3;
        seenTopLevelHeading = true;
      }
    }
    normalized.push(normalizedBlock);
  }
  return normalized;
}

function normalizeSettingsTabs(desc) {
  // id は「タブの同一性」を決めるキーで、group.tab / tabLink.tab の参照先にもなる。
  // 重複を残すと参照が後勝ちになり、先に定義したタブが中身の無い空タブになってしまうため、
  // ここで最初の 1 つだけを採用する。
  const seenTabIds = new Set();
  const rawTabs = (desc && Array.isArray(desc.tabs) ? desc.tabs : [])
    .filter((tab) => {
      if (!tab || typeof tab.id !== 'string' || !tab.id.trim()) return false;
      if (seenTabIds.has(tab.id)) return false;
      seenTabIds.add(tab.id);
      return true;
    });
  // tabLink の参照先検証に使う（tabs / groups 全体を見てからでないと判定できない）。
  const tabIds = new Set(rawTabs.map((tab) => tab.id));
  const fieldTabs = collectSettingsFieldTabs(desc, rawTabs);

  return rawTabs
    .map((tab, index) => {
      const normalizedTab = {
        id: tab.id,
        label: (typeof tab.label === 'string' && tab.label.trim()) ? tab.label : tab.id,
        index,
      };
      if (typeof tab.note === 'string' && tab.note.trim()) {
        normalizedTab.note = tab.note;
      }
      const content = normalizeSettingsTabContent(tab.content, { tabIds, fieldTabs });
      if (content.length) {
        normalizedTab.content = content;
      }
      return normalizedTab;
    });
}

function groupSettingsGroupsByTab(groups, tabs) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  if (!Array.isArray(tabs) || tabs.length === 0) return [];

  const tabIds = new Set(tabs.map((tab) => tab.id));
  const firstTabId = tabs[0].id;
  const grouped = tabs.map((tab) => ({ tab, groups: [] }));
  const groupByTabId = new Map(grouped.map((entry) => [entry.tab.id, entry]));

  for (const group of safeGroups) {
    const groupTab = group && typeof group.tab === 'string' && tabIds.has(group.tab)
      ? group.tab
      : firstTabId;
    groupByTabId.get(groupTab).groups.push(group);
  }

  return grouped;
}

function dedupeSettingsFieldsByKey(groups, tabs) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  const orderedGroups = Array.isArray(tabs) && tabs.length > 0
    ? groupSettingsGroupsByTab(safeGroups, tabs).flatMap(({ groups: tabGroups }) => tabGroups)
    : safeGroups;
  // 素の {} では seen['__proto__'] が常に truthy になって全フィールドが消えるため、
  // 組み込みプロパティ名も安全にキーとして扱える Set を使う。
  const seenKeys = new Set();
  const duplicateKeys = new Set();
  const dedupedGroups = [];

  for (const group of orderedGroups) {
    if (!group || !Array.isArray(group.fields)) {
      dedupedGroups.push(group);
      continue;
    }
    const fields = group.fields.filter((field) => {
      const key = field && typeof field.key === 'string' ? field.key : '';
      // key が無い欄同士を重複扱いすると既存の不正定義まで消えるため、判定対象にしない。
      if (!key.trim()) return true;
      // タブ ID・所属タブ・移動先の既存解決はすべて先勝ち。保存対象も同じ欄へ揃えるため、
      // 描画順で最初の 1 件を残し、後から現れる同一 key の欄を落とす。
      if (seenKeys.has(key)) {
        duplicateKeys.add(key);
        return false;
      }
      seenKeys.add(key);
      return true;
    });

    // 元から fields が空のグループは既存どおり残す。一方、重複除去で初めて空になった
    // グループは legend だけの fieldset を生むため、描画対象からグループごと外す。
    if (group.fields.length > 0 && fields.length === 0) continue;
    // Object.assign({}, group) は JSON 由来の own __proto__ でプロトタイプ汚染されるため、
    // own プロパティとして安全にコピーできるオブジェクトスプレッドを使う。
    dedupedGroups.push({ ...group, fields });
  }

  if (duplicateKeys.size > 0 && typeof console !== 'undefined' && console.warn) {
    console.warn(
      '[settings] 重複した key のため設定欄をスキップしました:',
      [...duplicateKeys].join(', ')
    );
  }

  return dedupedGroups;
}

function deriveSettingsTargetPathsForGroups(groups) {
  const paths = [];
  const seen = new Set();

  for (const group of Array.isArray(groups) ? groups : []) {
    const targetPaths = group && Array.isArray(group.targetPaths) ? group.targetPaths : [];
    for (const targetPath of targetPaths) {
      if (typeof targetPath !== 'string' || !targetPath || seen.has(targetPath)) continue;
      seen.add(targetPath);
      paths.push(targetPath);
    }
  }

  return paths;
}

module.exports = {
  dedupeSettingsFieldsByKey,
  deriveSettingsTargetPathsForGroups,
  groupSettingsGroupsByTab,
  normalizeSettingsTabContent,
  normalizeSettingsTabs,
};
