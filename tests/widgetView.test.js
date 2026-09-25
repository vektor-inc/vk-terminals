'use strict';

// 宣言的ウィジェットの共有 DOM レンダラ（renderer/widgetView.js）の単体テスト。
// jsdom を持たないため、renderer が使う DOM API の部分集合だけを実装した最小スタブで検証する。
// 重点: textContent のみで描画（innerHTML 禁止）・tone フォールバック・URL 二段防御・
//       担当者フィルタ適用・staleness による空文言抑止・コマンド発行と確認ダイアログ。

const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../utils/widgetContract');
const { createTaskWidgetView, DEFAULT_STRINGS } = require('../renderer/widgetView');

// ── 最小 DOM スタブ ──────────────────────────────────────────────────────────
class FakeClassList {
  constructor() { this._set = new Set(); }
  add(c) { this._set.add(c); }
  remove(c) { this._set.delete(c); }
  toggle(c, on) { const v = on === undefined ? !this._set.has(c) : on; if (v) this._set.add(c); else this._set.delete(c); return v; }
  contains(c) { return this._set.has(c); }
}

class FakeElement {
  constructor(tag, ownerDocument) {
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = ownerDocument || null;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new FakeClassList();
    this.parentNode = null;
    this._text = '';
    this._className = '';
    this._id = '';
    this.value = undefined;
    this.disabled = false;
    this.selected = false;
    this.href = undefined;
    this.title = undefined;
    this.draggable = undefined;
  }

  // innerHTML は使ってはいけない契約。使われたら即失敗させる。
  set innerHTML(_v) { throw new Error('innerHTML must not be used (security contract violation)'); }
  get innerHTML() { return undefined; }

  // 実 DOM 同様、className と classList を同期させる（レンダラは className 代入で class を付ける）。
  set className(v) {
    this._className = String(v == null ? '' : v);
    this.classList._set = new Set(this._className.split(/\s+/).filter(Boolean));
  }
  get className() { return this._className; }

  set id(v) {
    this._id = String(v == null ? '' : v);
    if (this._id) this.attributes.id = this._id;
    else delete this.attributes.id;
  }
  get id() { return this._id; }

  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }

  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1); return node; }
  replaceChildren() {
    const nodes = Array.prototype.slice.call(arguments);
    this.children = [];
    nodes.forEach((n) => this.appendChild(n));
  }

  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this._id = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  // 実ブラウザ同様、ネイティブ disabled な要素には focus() が効かない（aria-disabled は効く）。
  // これを無視すると、disabled な編集ボタンへのフォーカス復帰が「成功したように見えて実は
  // body へ落ちる」不具合（issue #406 差し戻し: 植草 FAIL／安藤 MEDIUM）をテストで検出できない。
  focus() { if (this.disabled) return; if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  // テスト用: イベントを発火する。extra で key 等の追加プロパティ（Escape 判定など）を渡せる。
  dispatch(type, extra) {
    const ev = Object.assign({ preventDefault() {}, stopPropagation() {} }, extra || {});
    (this.listeners[type] || []).forEach((fn) => fn(ev));
  }

  set textContent(v) {
    // 実 DOM 同様、既存子を消してテキストノード 1 個にする。
    this.children = [];
    if (v !== '' && v !== null && v !== undefined) {
      const tn = new FakeTextNode(String(v));
      tn.parentNode = this;
      this.children.push(tn);
    }
    this._text = String(v == null ? '' : v);
  }
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }

  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }

  // 深さ優先で条件に合う最初の要素を返す簡易 querySelector（tag/class/dataset のみ対応）。
  querySelectorAll(predicate) {
    const out = [];
    const walk = (node) => {
      node.children.forEach((c) => { if (c instanceof FakeElement) { if (predicate(c)) out.push(c); walk(c); } });
    };
    walk(this);
    return out;
  }
}

class FakeTextNode {
  constructor(text) { this.tagName = '#text'; this._text = text; this.children = []; }
  get textContent() { return this._text; }
}

function makeDoc() {
  const doc = { activeElement: null };
  doc.createElement = (tag) => new FakeElement(tag, doc);
  return doc;
}

// テスト用のサニタイズ済みウィジェットを組む（contract.sanitizeWidget を通す）。
function sanitized(rawGroups, extra) {
  return contract.sanitizeWidget(Object.assign({
    schemaVersion: 1,
    kind: 'task-list',
    lang: 'ja',
    updatedAt: '2026-07-21T00:00:00.000Z',
    viewer: 'me',
    staleThresholdMs: 120000,
    emptyText: 'タスクはありません',
    groups: rawGroups,
  }, extra || {}));
}

function makeView(deps) {
  const doc = makeDoc();
  const groupsEl = doc.createElement('div');
  const view = createTaskWidgetView(Object.assign({
    doc,
    groupsEl,
    contract,
    isSafeExternalUrl: () => true,
    openUrl: () => {},
    sendCommand: async () => ({ ok: true }),
    confirm: () => true,
    getFilterMode: () => 'all',
    requestRerender: () => {},
    pendingTimeoutMs: 30000,
  }, deps || {}));
  return { doc, groupsEl, view };
}

// ── テスト ───────────────────────────────────────────────────────────────────

test('render: ステータスバッジを各カードの先頭へ prepend し、グループ見出しは描画しない', () => {
  const widget = sanitized([
    { id: 'in-progress', label: '実行中', tone: 'progress', items: [
      { id: '1', title: 'タスクA', editable: false, badges: [{ label: '高', tone: 'danger' }, { label: '直列', tone: 'zzz' }] },
    ] },
  ]);
  const { groupsEl, view } = makeView();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-list-group')).length, 1);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-list-group-head')).length, 0);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('widget-group-label')).length, 0);

  const badges = groupsEl.querySelectorAll((el) => el.classList.contains('widget-badge'));
  assert.deepEqual(badges.map((badge) => badge.textContent), ['実行中', '高', '直列']);
  assert.deepEqual(badges.map((badge) => badge.dataset.tone), ['progress', 'danger', 'neutral']);
  // 未知 tone は neutral へフォールバック。
  assert.equal(badges[2].dataset.tone, 'neutral');
});

test('render: 文字列は textContent で描画され、HTML として解釈されない（XSS 防御）', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const widget = sanitized([
    { id: 'g', label: 'G', tone: 'info', items: [{ id: '1', title: evil, editable: false }] },
  ]);
  const { groupsEl, view } = makeView();
  // innerHTML を使うと FakeElement が throw する。throw せず描画できることが契約遵守の証左。
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  const titleEl = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-title'))[0];
  // 生文字列がそのままテキストとして入る（要素化されない）。
  assert.equal(titleEl.textContent, evil);
  assert.equal(titleEl.children.length, 1);
  assert.equal(titleEl.children[0].tagName, '#text');
});

test('render: isSafeExternalUrl が false のリンクは描画しない（二段防御）', () => {
  const widget = sanitized([
    { id: 'g', label: 'G', tone: 'info', items: [{ id: '1', title: 't', editable: false, links: [
      { rel: 'queue', url: 'https://blocked.example/issues/1', label: 'queue' },
      { rel: 'pr', url: 'https://ok.example/pr/1', label: 'pr' },
    ] }] },
  ]);
  const { groupsEl, view } = makeView({
    isSafeExternalUrl: (url) => url.indexOf('blocked') === -1,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  const links = groupsEl.querySelectorAll((el) => el.classList.contains('widget-link'));
  assert.equal(links.length, 1);
  assert.equal(links[0].dataset.rel, 'pr');
});

test('render: rel="queue" のリンクチップは非表示にし、rel="pr" は描画する', () => {
  const widget = sanitized([
    { id: 'g', label: 'G', tone: 'info', items: [{ id: '1', title: 't', editable: false, links: [
      { rel: 'queue', url: 'https://example.com/issues/1', label: 'Issue' },
      { rel: 'pr', url: 'https://example.com/pull/1', label: 'PR' },
    ] }] },
  ]);
  const { groupsEl, view } = makeView();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const links = groupsEl.querySelectorAll((el) => el.classList.contains('widget-link'));
  assert.equal(links.length, 1);
  assert.equal(links[0].dataset.rel, 'pr');
  assert.equal(links[0].textContent, 'PR⁠↗');
});

test('render: queue URL があるタイトルは外部リンク化し、クリックで queue URL を openUrl へ渡す', () => {
  const queueUrl = 'https://github.com/vektor-inc/vk-orchestrator/issues/301';
  const opened = [];
  const safeChecked = [];
  const widget = sanitized([
    { id: 'in-progress', label: '実行中', tone: 'progress', items: [{ id: '301', title: '宣言ウィジェットの実行中タスク', editable: false, links: [
      { rel: 'queue', url: queueUrl, label: 'issue #301' },
      { rel: 'pr', url: 'https://github.com/vektor-inc/vk-orchestrator/pull/301', label: 'PR #301' },
    ] }] },
  ]);
  const { groupsEl, view } = makeView({
    isSafeExternalUrl: (url) => { safeChecked.push(url); return true; },
    openUrl: (url) => { opened.push(url); },
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const title = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-title'))[0];
  assert.equal(title.tagName, 'A');
  assert.equal(title.getAttribute('role'), 'link');
  assert.equal(title.getAttribute('aria-label'), '宣言ウィジェットの実行中タスク（外部ブラウザで開く）');
  assert.equal(title.title, `宣言ウィジェットの実行中タスク\n${queueUrl}`);
  assert.equal(title.textContent, '宣言ウィジェットの実行中タスク⁠↗');

  title.dispatch('click');
  assert.equal(opened.length, 1);
  assert.equal(opened[0], queueUrl);
  assert.ok(safeChecked.includes(queueUrl));
});

test('render: queue URL が無いタイトルはプレーンテキストのまま描画する', () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{ id: '401', title: 'ローカルモードのタスク', editable: false, links: [
      { rel: 'pr', url: 'https://example.com/pull/401', label: 'PR #401' },
    ] }] },
  ], { viewer: null });
  const { groupsEl, view } = makeView();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const title = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-title'))[0];
  assert.equal(title.tagName, 'DIV');
  assert.equal(title.getAttribute('role'), null);
  assert.equal(title.textContent, 'ローカルモードのタスク');
});

test('render: 担当者フィルタ（self）は viewer のアイテムだけを描画する', () => {
  const widget = sanitized([
    { id: 'g', label: 'G', tone: 'info', items: [
      { id: '1', title: 'mine', editable: false, assignee: 'me', links: [{ rel: 'queue', url: 'https://x/issues/1', label: 'q' }] },
      { id: '2', title: 'theirs', editable: false, assignee: 'you', links: [{ rel: 'queue', url: 'https://x/issues/2', label: 'q' }] },
    ] },
  ]);
  const { groupsEl, view } = makeView({ getFilterMode: () => 'self' });
  const info = view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  assert.equal(info.githubMode, true);
  assert.equal(info.filterEnabled, true);
  assert.equal(info.filterMode, 'self');
  assert.equal(info.visibleItems, 1);
  const titles = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-title-text')).map((el) => el.textContent);
  assert.deepEqual(titles, ['mine']);
});

test('render: 表示 0 件かつ非 stale は空文言、stale のときは空文言を出さない', () => {
  const widget = sanitized([]);
  // 非 stale。
  const a = makeView();
  const infoFresh = a.view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  assert.equal(infoFresh.stale, false);
  const emptyFresh = a.groupsEl.querySelectorAll((el) => el.classList.contains('task-list-empty'));
  assert.equal(emptyFresh.length, 1);
  assert.equal(emptyFresh[0].textContent, 'タスクはありません');

  // stale（updatedAt から閾値超過）。
  const b = makeView();
  const infoStale = b.view.render(widget, { now: Date.parse('2026-07-21T01:00:00.000Z') });
  assert.equal(infoStale.stale, true);
  assert.equal(b.groupsEl.querySelectorAll((el) => el.classList.contains('task-list-empty')).length, 0);
});

function editableWidgetWithControls(overrides) {
  const item = Object.assign({
    id: '10',
    title: 'T',
    editable: true,
    badges: [{ label: '中', tone: 'neutral' }, { label: '並列', tone: 'info' }],
    controls: [
      { type: 'select', field: 'status', label: 'ステータス', ariaLabel: 'ステータス', current: 'ready', options: [
        { value: 'ready', label: '実行待ち' },
        { value: 'in-progress', label: '実行中', command: { action: 'set-status', taskId: '10', to: 'in-progress', expected: 'ready' } },
        { value: 'awaiting-approval', label: '承認待ち', command: { action: 'set-status', taskId: '10', to: 'awaiting-approval', expected: 'ready' },
          confirm: { title: '承認待ちにしますか？', body: '確認が必要です' } },
      ] },
      { type: 'select', field: 'priority', label: '優先度', current: 'medium', options: [
        { value: 'medium', label: '中' },
        { value: 'high', label: '高', command: { action: 'set-priority', taskId: '10', to: 'high', expected: 'medium' } },
      ] },
      { type: 'select', field: 'sequential', label: '実行方式', current: 'parallel', options: [
        { value: 'parallel', label: '並列' },
        { value: 'sequential', label: '直列', command: { action: 'set-sequential', taskId: '10', to: 'sequential', expected: 'parallel' } },
      ] },
    ],
  }, overrides || {});
  return sanitized([{ id: 'ready', label: '実行待ち', tone: 'info', items: [item] }]);
}

test('render: editable アイテムは既定で select を畳み、編集ボタンだけを描画する', () => {
  const widget = editableWidgetWithControls();
  const { groupsEl, view } = makeView();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  assert.equal(groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').length, 0);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-panel')).length, 0);
  const editButton = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0];
  assert.equal(editButton.tagName, 'BUTTON');
  assert.equal(editButton.textContent, '編集');
  assert.equal(editButton.getAttribute('aria-expanded'), 'false');
  assert.equal(editButton.getAttribute('aria-label'), '「T」を編集');
});

test('render: 編集ボタン click 後の再描画でパネル・キャンセル・保存が現れ、hasOpenEditor が true', () => {
  const widget = editableWidgetWithControls();
  const { groupsEl, view } = makeView();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  assert.equal(view.hasOpenEditor(), true);
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  assert.equal(groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').length, 3);
  const panel = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-panel'))[0];
  const editButton = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0];
  assert.equal(editButton.getAttribute('aria-expanded'), 'true');
  assert.equal(editButton.getAttribute('aria-controls'), panel.getAttribute('id'));
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-cancel'))[0].textContent, 'キャンセル');
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].textContent, '保存');
});

test('render: 編集ボタンの aria-label は、保存中だけ「保存中のため操作できません」を付記する', async () => {
  const widget = editableWidgetWithControls({ title: 'サンプルタスク' });
  const { groupsEl, view } = makeView({ sendCommand: async () => ({ ok: true }) });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  // 保存前: 通常のラベルのまま。
  let editButton = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0];
  assert.equal(editButton.getAttribute('aria-label'), '「サンプルタスク」を編集');

  editButton.dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  // 保存中: 操作できないことを aria-label にも明記する（issue #406 差し戻し: 植草 低）。
  editButton = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0];
  assert.equal(editButton.getAttribute('aria-label'), '「サンプルタスク」を編集（保存中のため操作できません）');
  assert.equal(editButton.getAttribute('aria-disabled'), 'true');

  // 反映が確認され保存が終わると、通常のラベルへ戻る。
  const updatedWidget = editableWidgetWithControls({
    title: 'サンプルタスク',
    controls: [
      { type: 'select', field: 'status', label: 'ステータス', current: 'in-progress', options: [
        { value: 'ready', label: '実行待ち', command: { action: 'set-status', taskId: '10', to: 'ready', expected: 'in-progress' } },
        { value: 'in-progress', label: '実行中' },
      ] },
    ],
  });
  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });
  editButton = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0];
  assert.equal(editButton.getAttribute('aria-label'), '「サンプルタスク」を編集');
  assert.equal(editButton.getAttribute('aria-disabled'), null);
});

test('render: select 変更は下書きだけ更新し、保存時に apply-batch を 1 回だけ送る', async () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [
        { type: 'select', field: 'status', label: 'ステータス', ariaLabel: 'ステータス', current: 'ready', options: [
          { value: 'ready', label: '実行待ち' },
          { value: 'in-progress', label: '実行中', command: { action: 'set-status', taskId: '10', to: 'in-progress', expected: 'ready' } },
        ] },
        { type: 'select', field: 'priority', label: '優先度', current: 'medium', options: [
          { value: 'medium', label: '中' },
          { value: 'high', label: '高', command: { action: 'set-priority', taskId: '10', to: 'high', expected: 'medium' } },
        ] },
      ],
    }] },
  ]);
  const sent = [];
  let rerenders = 0;
  const { groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
    requestRerender: () => { rerenders += 1; },
    // 反映待ちタイマー（1段目・2段目とも）がテストプロセスを長く生かさないよう短くする。
    pendingTimeoutMs: 40,
    pendingErrorTimeoutMs: 40,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const save = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0];
  assert.equal(save.disabled, true);

  const selects = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT');
  selects.find((el) => el.dataset.field === 'status').value = 'in-progress';
  selects.find((el) => el.dataset.field === 'status').dispatch('change');
  assert.equal(sent.length, 0);
  assert.equal(save.disabled, false);

  save.dispatch('click');
  await Promise.resolve();

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    action: 'apply-batch',
    taskId: '10',
    ops: [{ action: 'set-status', to: 'in-progress', expected: 'ready' }],
  });
  assert.equal(view.hasPending(), true);
  assert.ok(rerenders >= 1);

  // 反映待ちのタイムアウトを発火させてタイマーを片付ける（プロセスを 30 秒生かさない）。
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(view.hasPending(), false);
});

test('render: 保存後の widget 更新で current が追いつくと pending を消してパネルを畳む', async () => {
  const widget = editableWidgetWithControls();
  const updatedWidget = editableWidgetWithControls({
    controls: [
      { type: 'select', field: 'status', label: 'ステータス', current: 'in-progress', options: [
        { value: 'ready', label: '実行待ち', command: { action: 'set-status', taskId: '10', to: 'ready', expected: 'in-progress' } },
        { value: 'in-progress', label: '実行中' },
      ] },
    ],
  });
  const { doc, groupsEl, view } = makeView({
    sendCommand: async () => ({ ok: true }),
    pendingTimeoutMs: 30000,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  assert.equal(view.hasPending(), true);

  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });
  assert.equal(view.hasPending(), false);
  assert.equal(view.hasOpenEditor(), false);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-panel')).length, 0);
  const editButton = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0];
  assert.equal(doc.activeElement, editButton);
});

// ── 反映待ちの2段階タイムアウト（issue #406）───────────────────────────────
// vk-orchestrator 側の反映は 30〜55 秒かかることがあり、旧実装は 1 段のタイムアウト
// （既定 30 秒）で pending・savingTasks を消して timeoutError を出していたため、再試行で
// apply-batch が二重送信されていた。1段目は表示切り替えのみに留め、2段目（既定 5 分）で
// 初めて pending・savingTasks を消してエラーにする。

test('render: 1段目のタイムアウトを過ぎてから widget の current が追いついた場合、エラーにならず保存完了になる', async () => {
  const widget = editableWidgetWithControls();
  const updatedWidget = editableWidgetWithControls({
    controls: [
      { type: 'select', field: 'status', label: 'ステータス', current: 'in-progress', options: [
        { value: 'ready', label: '実行待ち', command: { action: 'set-status', taskId: '10', to: 'ready', expected: 'in-progress' } },
        { value: 'in-progress', label: '実行中' },
      ] },
    ],
  });
  const { doc, groupsEl, view } = makeView({
    sendCommand: async () => ({ ok: true }),
    // 1段目（警告）だけ短くし、2段目（エラー）は既定のまま長く保つ。反映が追いつく前に
    // 2段目が誤って発火しないことを確認する意図。
    pendingTimeoutMs: 40,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  assert.equal(view.hasPending(), true);

  // 1段目のタイムアウト（pendingTimeoutMs）を過ぎるまで待つ。
  await new Promise((resolve) => setTimeout(resolve, 60));

  // widget の current が追いついた状態で再描画する。従来はここまでに timeoutError が出て
  // pending・savingTasks が消え、再試行できる状態になっていた（issue #406 の不具合）。
  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });
  assert.equal(view.hasPending(), false);
  assert.equal(view.hasOpenEditor(), false);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-panel')).length, 0);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error')).length, 0);
  const editButton = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0];
  assert.equal(doc.activeElement, editButton);
});

test('render: 1段目のタイムアウトを過ぎると「時間がかかっています」表示に切り替わり、エラーは出ず、保存・編集ボタンは無効のまま（二重送信されない）', async () => {
  const widget = editableWidgetWithControls();
  const sent = [];
  const { groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
    pendingTimeoutMs: 40,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  assert.equal(sent.length, 1);

  // 1段目のタイムアウトを過ぎるまで待つ。
  await new Promise((resolve) => setTimeout(resolve, 60));
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  assert.equal(view.hasPending(), true);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error')).length, 0);
  const pendingEl = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-pending'))[0];
  assert.equal(pendingEl.textContent, DEFAULT_STRINGS.savingPendingSlow);
  assert.equal(pendingEl.dataset.state, 'slow');

  const save = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0];
  assert.equal(save.disabled, true);
  const editButton = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0];
  // ネイティブ disabled ではなく aria-disabled にする（フォーカス復帰を効かせるため。
  // issue #406 差し戻し: 植草 FAIL／安藤 MEDIUM）。見た目は無効のまま、操作はクリック
  // ハンドラ側の savingTasks チェックで止める。
  assert.equal(editButton.disabled, false);
  assert.equal(editButton.getAttribute('aria-disabled'), 'true');

  // 保存ボタンを再度押しても savingTasks による無効化で二重送信されない。
  save.dispatch('click');
  await Promise.resolve();
  assert.equal(sent.length, 1);

  // 編集ボタンは aria-disabled のみで実際にはクリックできてしまうが、クリックハンドラと
  // openEditor 側の savingTasks ガードで無視される（issue #406 差し戻し: 安藤 LOW）。
  editButton.dispatch('click');
  assert.equal(view.hasOpenEditor(), true);

  // widget の current を追いつかせて後始末する（2段目タイマーを残したままにしない）。
  const updatedWidget = editableWidgetWithControls({
    controls: [
      { type: 'select', field: 'status', label: 'ステータス', current: 'in-progress', options: [
        { value: 'ready', label: '実行待ち', command: { action: 'set-status', taskId: '10', to: 'ready', expected: 'in-progress' } },
        { value: 'in-progress', label: '実行中' },
      ] },
    ],
  });
  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });
  assert.equal(view.hasPending(), false);
});

test('render: 2段目のタイムアウトを過ぎると timeoutError が表示され、保存ボタンが再び押せる', async () => {
  const widget = editableWidgetWithControls();
  const sent = [];
  const { groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
    pendingTimeoutMs: 20,
    pendingErrorTimeoutMs: 50,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  assert.equal(sent.length, 1);

  // 2段目のタイムアウト（pendingErrorTimeoutMs）を過ぎるまで待つ。
  await new Promise((resolve) => setTimeout(resolve, 90));
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  assert.equal(view.hasPending(), false);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-item-pending')).length, 0);
  const error = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error'))[0];
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(error.textContent, DEFAULT_STRINGS.timeoutError);
  assert.equal(view.hasOpenEditor(), true);

  const save = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0];
  assert.equal(save.disabled, false);

  // 保存ボタンが再び押せる（再試行できる）ことを確認する。
  save.dispatch('click');
  await Promise.resolve();
  assert.equal(sent.length, 2);

  // 再試行分の反映待ちタイマーを片付ける（widget の current を追いつかせて自然に消す）。
  const updatedWidget = editableWidgetWithControls({
    controls: [
      { type: 'select', field: 'status', label: 'ステータス', current: 'in-progress', options: [
        { value: 'ready', label: '実行待ち', command: { action: 'set-status', taskId: '10', to: 'ready', expected: 'in-progress' } },
        { value: 'in-progress', label: '実行中' },
      ] },
    ],
  });
  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });
  assert.equal(view.hasPending(), false);
});

// ── 保存中にパネルを閉じられる（issue #406 植草 UX レビュー指摘）─────────────
// 送信成功後も savingTasks が反映確認（または2段目のエラー）まで残り続けるため、旧実装は
// パネルを閉じられず、キャンセルも他タスクの編集ボタンも押せず「アプリが固まったように見える」
// 状態が最大5分続いた。保存中はキャンセルボタンを「閉じる」として働かせ、確認なしでパネルだけ
// 閉じられるようにする。pending・savingTasks・タイマーは維持し、自タスクの編集ボタンだけ無効の
// ままにして二重送信を防ぐ。他タスクの編集ボタンは押せるようにする。

function twoEditableTasksWidget(overrides) {
  const aCurrent = (overrides && overrides.a && overrides.a.current) || 'ready';
  const aOptions = aCurrent === 'ready'
    ? [
      { value: 'ready', label: '実行待ち' },
      { value: 'in-progress', label: '実行中', command: { action: 'set-status', taskId: '10', to: 'in-progress', expected: 'ready' } },
    ]
    : [
      { value: 'ready', label: '実行待ち', command: { action: 'set-status', taskId: '10', to: 'ready', expected: 'in-progress' } },
      { value: 'in-progress', label: '実行中' },
    ];
  return sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [
      { id: '10', title: 'タスクA', editable: true,
        controls: [{ type: 'select', field: 'status', label: 'ステータス', current: aCurrent, options: aOptions }] },
      { id: '20', title: 'タスクB', editable: true,
        controls: [{ type: 'select', field: 'status', label: 'ステータス', current: 'ready', options: [
          { value: 'ready', label: '実行待ち' },
          { value: 'in-progress', label: '実行中', command: { action: 'set-status', taskId: '20', to: 'in-progress', expected: 'ready' } },
        ] }] },
    ] },
  ]);
}

// タスクA（id '10'）の編集を開き、status を in-progress にして保存する（送信のみ。await は呼び出し側）。
function openAndSaveTaskA(groupsEl, view, widget) {
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
}

test('render: 保存中はキャンセルが「閉じる」として働き、確認なしでパネルだけ閉じる。pending・savingTasks は維持し、他タスクの編集ボタンは押せる', async () => {
  const widget = twoEditableTasksWidget();
  const sent = [];
  const confirms = [];
  const { doc, groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
    confirm: (text) => { confirms.push(text); return true; },
  });
  openAndSaveTaskA(groupsEl, view, widget);
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(view.hasPending(), true);
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const cancel = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-cancel'))[0];
  assert.equal(cancel.textContent, '閉じる');
  assert.equal(cancel.disabled, false);
  cancel.dispatch('click');

  // 下書き破棄の確認ダイアログは出ない（変更は送信済みのため）。
  assert.equal(confirms.length, 0);
  assert.equal(view.hasOpenEditor(), false);
  // pending・savingTasks は維持されている（表示はパネル外のカード下に出続ける）。
  assert.equal(view.hasPending(), true);

  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-panel')).length, 0);
  const pendingEl = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-pending'))[0];
  assert.equal(pendingEl.textContent, DEFAULT_STRINGS.savingPending);

  const editButtons = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'));
  // タスクA（保存中）自身は見た目のみ無効（aria-disabled）。ネイティブ disabled にすると
  // pendingFocus によるフォーカス復帰が実ブラウザでは効かず body へ落ちる
  // （issue #406 差し戻し: 植草 FAIL／安藤 MEDIUM）。
  assert.equal(editButtons[0].disabled, false);
  assert.equal(editButtons[0].getAttribute('aria-disabled'), 'true');
  assert.equal(editButtons[1].disabled, false); // タスクB は押せる。
  assert.equal(editButtons[1].getAttribute('aria-disabled'), null);

  // 「閉じる」で閉じたあと、フォーカスはタスクA の編集ボタンに戻る（body へ落ちない）。
  assert.equal(doc.activeElement, editButtons[0]);

  // タスクA の編集ボタンは見た目こそクリックできるが、クリックハンドラと openEditor 側の
  // savingTasks ガードで無視され、二重送信・二重オープンにはならない（安藤 LOW）。
  editButtons[0].dispatch('click');
  assert.equal(view.hasOpenEditor(), false);
  assert.equal(sent.length, 1);

  // 後始末: widget の current を追いつかせて pending を解消する。
  const updatedWidget = twoEditableTasksWidget({ a: { current: 'in-progress' } });
  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });
  assert.equal(view.hasPending(), false);
});

test('render: 保存中のパネルを開いたまま他タスクの編集ボタンを押すと、保存中パネルを閉じてから新しいパネルを開く', async () => {
  const widget = twoEditableTasksWidget();
  const sent = [];
  const { groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
  });
  openAndSaveTaskA(groupsEl, view, widget);
  await Promise.resolve();
  assert.equal(view.hasPending(), true);
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  // タスクB の編集ボタンを押す（タスクA は保存中のまま）。
  const editButtons = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'));
  editButtons[1].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  // タスクA のパネルは畳まれ、タスクB のパネルだけが開いている。
  const panels = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-panel'));
  assert.equal(panels.length, 1);
  assert.equal(panels[0].getAttribute('id'), 'task-edit-panel-20');
  assert.equal(view.hasOpenEditor(), true);

  // タスクA の pending・savingTasks は維持されたまま（二重送信されない）。
  assert.equal(view.hasPending(), true);
  assert.equal(sent.length, 1);

  const updatedWidget = twoEditableTasksWidget({ a: { current: 'in-progress' } });
  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });
  assert.equal(view.hasPending(), false);
});

test('render: 保存中に Escape を押しても確認なしでパネルだけ閉じ、フォーカスは編集ボタンに戻る（body へ落ちない）', async () => {
  const widget = twoEditableTasksWidget();
  const { doc, groupsEl, view } = makeView({
    sendCommand: async () => ({ ok: true }),
    confirm: () => { throw new Error('保存中の Escape で confirm は呼ばれないはず'); },
  });
  openAndSaveTaskA(groupsEl, view, widget);
  await Promise.resolve();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const panel = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-panel'))[0];
  panel.dispatch('keydown', { key: 'Escape' });

  assert.equal(view.hasOpenEditor(), false);
  assert.equal(view.hasPending(), true);

  // 保存中のまま（編集ボタンが aria-disabled の状態のまま）再描画し、フォーカスが
  // タスクA の編集ボタンへ戻ることを確認する。ネイティブ disabled のままだと実ブラウザでは
  // focus() が効かず body へ落ちる（issue #406 差し戻し: 植草 FAIL／安藤 MEDIUM）。
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  const editButtons = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'));
  assert.equal(doc.activeElement, editButtons[0]);

  const updatedWidget = twoEditableTasksWidget({ a: { current: 'in-progress' } });
  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });
  assert.equal(view.hasPending(), false);
});

test('render: 保存中に閉じたタスクの反映が確認されても、別タスクを編集中ならそのパネル・フォーカスを奪わない', async () => {
  const widget = twoEditableTasksWidget();
  const { groupsEl, view } = makeView({
    sendCommand: async () => ({ ok: true }),
  });
  openAndSaveTaskA(groupsEl, view, widget);
  await Promise.resolve();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  // タスクA を保存中のまま閉じる。
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-cancel'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  // タスクB の編集を開く。
  const editButtons = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'));
  editButtons[1].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  assert.equal(view.hasOpenEditor(), true);
  const panelBBefore = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-panel'))[0];
  assert.equal(panelBBefore.getAttribute('id'), 'task-edit-panel-20');

  // タスクA の反映が確認された状態で再描画する。
  const updatedWidget = twoEditableTasksWidget({ a: { current: 'in-progress' } });
  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });

  assert.equal(view.hasPending(), false);
  // タスクB のパネルはそのまま開いたまま（フォーカス・パネルを奪われていない）。
  assert.equal(view.hasOpenEditor(), true);
  const panels = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-panel'));
  assert.equal(panels.length, 1);
  assert.equal(panels[0].getAttribute('id'), 'task-edit-panel-20');
});

// ── 安藤レビュー指摘（LOW）: slow 表示の固定と2段目タイマーの再検証 ──────────

test('render: 1段目通過後に一部の項目だけ反映されても「時間がかかっています」表示のままで、2段目のタイムアウトだけが延長される', async () => {
  const widget = editableWidgetWithControls();
  const { groupsEl, view } = makeView({
    sendCommand: async () => ({ ok: true }),
    pendingTimeoutMs: 30,
    pendingErrorTimeoutMs: 80,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  const priority = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'priority');
  priority.value = 'high';
  priority.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();

  // 1段目（30ms）を過ぎるまで待ち、slow 表示になることを確認する。
  await new Promise((resolve) => setTimeout(resolve, 50));
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  let pendingEl = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-pending'))[0];
  assert.equal(pendingEl.dataset.state, 'slow');

  // status だけ反映された状態（priority は未反映）で再描画する＝部分反映。
  const partialWidget = editableWidgetWithControls({
    controls: [
      { type: 'select', field: 'status', label: 'ステータス', current: 'in-progress', options: [
        { value: 'ready', label: '実行待ち', command: { action: 'set-status', taskId: '10', to: 'ready', expected: 'in-progress' } },
        { value: 'in-progress', label: '実行中' },
      ] },
      { type: 'select', field: 'priority', label: '優先度', current: 'medium', options: [
        { value: 'medium', label: '中' },
        { value: 'high', label: '高', command: { action: 'set-priority', taskId: '10', to: 'high', expected: 'medium' } },
      ] },
    ],
  });
  view.render(partialWidget, { now: Date.parse('2026-07-21T00:00:10.500Z') });

  // 部分反映のあとも slow 表示のままで、pending は継続している（priority が残っている）。
  assert.equal(view.hasPending(), true);
  pendingEl = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-pending'))[0];
  assert.equal(pendingEl.dataset.state, 'slow');
  assert.equal(pendingEl.textContent, DEFAULT_STRINGS.savingPendingSlow);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error')).length, 0);

  // 元の2段目タイムアウト（保存から80ms後）を過ぎても、部分反映で延長されているためまだエラーにならない。
  await new Promise((resolve) => setTimeout(resolve, 50));
  view.render(partialWidget, { now: Date.parse('2026-07-21T00:00:10.500Z') });
  assert.equal(view.hasPending(), true);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error')).length, 0);

  // 延長後の2段目タイムアウトを過ぎるとエラーになる。
  await new Promise((resolve) => setTimeout(resolve, 60));
  view.render(partialWidget, { now: Date.parse('2026-07-21T00:00:10.500Z') });
  assert.equal(view.hasPending(), false);
  const error = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error'))[0];
  assert.equal(error.textContent, DEFAULT_STRINGS.timeoutError);
});

test('render: 保存中に閉じたタスクが完全に消えても savingTasks・drafts を後片付けし、古いタイマーで誤って timeoutError を出さない', async () => {
  const widget = editableWidgetWithControls();
  const { groupsEl, view } = makeView({
    sendCommand: async () => ({ ok: true }),
    pendingTimeoutMs: 20,
    pendingErrorTimeoutMs: 40,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  assert.equal(view.hasPending(), true);

  // 保存中のまま閉じる（editingTaskId が null になり、cleanupEditorForWidget の対象外になる）。
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-cancel'))[0].dispatch('click');
  assert.equal(view.hasOpenEditor(), false);

  // 閉じたタスクが、反映確認を待たずにウィジェットから完全に消える（完了・削除等）。
  const emptyWidget = sanitized([]);
  view.render(emptyWidget, { now: Date.parse('2026-07-21T00:00:10.010Z') });
  assert.equal(view.hasPending(), false);

  // 同じ id で、まったく別の（保存していない）タスクが再度現れる。
  const freshWidget = editableWidgetWithControls();
  view.render(freshWidget, { now: Date.parse('2026-07-21T00:00:10.020Z') });

  // 元のタイマー（20ms・40ms）が過ぎても、後片付け済みのため誤って timeoutError にならない。
  await new Promise((resolve) => setTimeout(resolve, 60));
  view.render(freshWidget, { now: Date.parse('2026-07-21T00:00:10.020Z') });
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error')).length, 0);
  assert.equal(groupsEl.querySelectorAll((el) => el.classList.contains('task-item-pending')).length, 0);
  assert.equal(view.hasPending(), false);

  // savingTasks が引き継がれておらず、編集ボタンが無効なまま固まっていないことも確認する。
  const editButton = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0];
  assert.equal(editButton.disabled, false);
  assert.equal(editButton.getAttribute('aria-disabled'), null);
});

test('render: 保存中に閉じたあと2段目のタイムアウトでエラーになっても、再度開くと下書きの値が残っている（反映前の値に戻らない）', async () => {
  const widget = editableWidgetWithControls();
  const { groupsEl, view } = makeView({
    sendCommand: async () => ({ ok: true }),
    pendingTimeoutMs: 20,
    pendingErrorTimeoutMs: 40,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  assert.equal(view.hasPending(), true);

  // 保存中のまま「閉じる」で閉じる（下書き・pending・savingTasks は維持される）。
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-cancel'))[0].dispatch('click');
  assert.equal(view.hasOpenEditor(), false);

  // 2段目のタイムアウトを過ぎ、timeoutError が表示される（「内容は保持しています。
  // 再試行できます」という文言）。
  await new Promise((resolve) => setTimeout(resolve, 60));
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.010Z') });
  assert.equal(view.hasPending(), false);
  const error = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error'))[0];
  assert.equal(error.textContent, DEFAULT_STRINGS.timeoutError);

  // 再試行のため編集を開き直す。旧実装は openEditor が buildDraftFromItem で下書きを
  // 反映前の値へ作り直しており、「内容は保持しています」という文言と食い違っていた
  // （issue #406 差し戻し: 安藤 MEDIUM）。
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.010Z') });

  const reopenedStatus = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  assert.equal(reopenedStatus.value, 'in-progress');
});

test('render: エラー後に開き直すと、保存した項目だけ古い値を残し、外部で変わった項目は最新値になる（触っていない項目まで古い値で送らない）', async () => {
  const widget = editableWidgetWithControls();
  const sent = [];
  const { groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
    pendingTimeoutMs: 20,
    pendingErrorTimeoutMs: 40,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  // status だけ変更して保存する（savedFields には 'status' だけが記録される）。
  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  assert.equal(sent.length, 1);
  assert.equal(view.hasPending(), true);

  // 保存中のまま「閉じる」で閉じる。
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-cancel'))[0].dispatch('click');
  assert.equal(view.hasOpenEditor(), false);

  // 保存待ちの間に、priority が外部（vk-orchestrator 等の別操作）で medium → high へ変わる。
  // status はまだ反映されていない（旧仕様どおり ready のまま）。
  const externalChangeWidget = editableWidgetWithControls({
    controls: [
      { type: 'select', field: 'status', label: 'ステータス', current: 'ready', options: [
        { value: 'ready', label: '実行待ち' },
        { value: 'in-progress', label: '実行中', command: { action: 'set-status', taskId: '10', to: 'in-progress', expected: 'ready' } },
      ] },
      { type: 'select', field: 'priority', label: '優先度', current: 'high', options: [
        { value: 'medium', label: '中', command: { action: 'set-priority', taskId: '10', to: 'medium', expected: 'high' } },
        { value: 'high', label: '高' },
      ] },
      { type: 'select', field: 'sequential', label: '実行方式', current: 'parallel', options: [
        { value: 'parallel', label: '並列' },
        { value: 'sequential', label: '直列', command: { action: 'set-sequential', taskId: '10', to: 'sequential', expected: 'parallel' } },
      ] },
    ],
  });
  view.render(externalChangeWidget, { now: Date.parse('2026-07-21T00:00:10.005Z') });
  assert.equal(view.hasPending(), true); // status はまだ反映されていないので pending は継続。

  // 2段目のタイムアウトを過ぎ、timeoutError になる。
  await new Promise((resolve) => setTimeout(resolve, 60));
  view.render(externalChangeWidget, { now: Date.parse('2026-07-21T00:00:10.010Z') });
  assert.equal(view.hasPending(), false);
  const error = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error'))[0];
  assert.equal(error.textContent, DEFAULT_STRINGS.timeoutError);

  // 再試行のため開き直す。status（保存した項目）は古い値のまま、priority（触っていない項目）は
  // 外部で変わった最新値になる（旧実装は全項目を buildDraftFromItem で作り直すため priority が
  // 古い medium のまま残り、再保存で priority まで送ってしまっていた。issue #406 差し戻し: 安藤 LOW）。
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(externalChangeWidget, { now: Date.parse('2026-07-21T00:00:10.010Z') });

  const reopenedStatus = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  const reopenedPriority = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'priority');
  assert.equal(reopenedStatus.value, 'in-progress'); // 保存した項目は古い値のまま残る。
  assert.equal(reopenedPriority.value, 'high'); // 触っていない項目は最新値になる（medium に戻らない）。

  // 再保存しても、送る ops に priority は含まれない（priority の下書きは既に最新値と一致するため）。
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[1].ops, [{ action: 'set-status', to: 'in-progress', expected: 'ready' }]);

  // 後始末: widget の current を追いつかせて pending を解消する。
  const updatedWidget = editableWidgetWithControls({
    controls: [
      { type: 'select', field: 'status', label: 'ステータス', current: 'in-progress', options: [
        { value: 'ready', label: '実行待ち', command: { action: 'set-status', taskId: '10', to: 'ready', expected: 'in-progress' } },
        { value: 'in-progress', label: '実行中' },
      ] },
      { type: 'select', field: 'priority', label: '優先度', current: 'high', options: [
        { value: 'medium', label: '中', command: { action: 'set-priority', taskId: '10', to: 'medium', expected: 'high' } },
        { value: 'high', label: '高' },
      ] },
      { type: 'select', field: 'sequential', label: '実行方式', current: 'parallel', options: [
        { value: 'parallel', label: '並列' },
        { value: 'sequential', label: '直列', command: { action: 'set-sequential', taskId: '10', to: 'sequential', expected: 'parallel' } },
      ] },
    ],
  });
  view.render(updatedWidget, { now: Date.parse('2026-07-21T00:00:11.000Z') });
  assert.equal(view.hasPending(), false);
});

test('render: キャンセルで下書きを破棄し畳みに戻る', () => {
  const widget = editableWidgetWithControls();
  const { groupsEl, view } = makeView();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');

  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-cancel'))[0].dispatch('click');
  assert.equal(view.hasOpenEditor(), false);
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  assert.equal(groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').length, 0);
});

test('render: confirm 付き option は保存前に確認し、拒否なら送信しない', async () => {
  const widget = editableWidgetWithControls();
  const sent = [];
  const confirms = [];
  const { groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
    confirm: (text) => { confirms.push(text); return false; },
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const select = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  select.value = 'awaiting-approval';
  select.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();

  assert.equal(confirms.length, 1);
  assert.match(confirms[0], /承認待ちにしますか？/);
  assert.equal(sent.length, 0);
  assert.equal(view.hasPending(), false);
  assert.equal(view.hasOpenEditor(), true);
  assert.equal(select.value, 'awaiting-approval');
});

test('render: 送信失敗時は下書きを保持し、パネルを開いたまま error を表示する', async () => {
  const widget = editableWidgetWithControls();
  const { groupsEl, view } = makeView({
    sendCommand: async () => ({ ok: false, error: 'boom' }),
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const status = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  status.value = 'in-progress';
  status.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  assert.equal(view.hasOpenEditor(), true);
  const kept = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  assert.equal(kept.value, 'in-progress');
  const error = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-action-error'))[0];
  assert.equal(error.getAttribute('role'), 'alert');
  assert.equal(error.textContent, DEFAULT_STRINGS.sendError);
});

test('render: 無効な選択肢は disabledReason を末尾ラベルと title に反映する', () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '12', title: 'T', editable: true,
      controls: [{ type: 'select', field: 'status', label: 'ステータス', current: 'ready', options: [
        { value: 'ready', label: '実行待ち' },
        { value: 'done', label: '完了', disabled: true, disabledReason: '直接完了にはできません' },
      ] }],
    }] },
  ]);
  const { groupsEl, view } = makeView();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  const options = groupsEl.querySelectorAll((el) => el.tagName === 'OPTION');
  const doneOption = options.find((o) => o.value === 'done');
  assert.equal(doneOption.disabled, true);
  assert.equal(doneOption.textContent, '完了（直接完了にはできません）');
  assert.equal(doneOption.title, '直接完了にはできません');
  // 無効理由の無い選択肢はラベルそのまま。
  const readyOption = options.find((o) => o.value === 'ready');
  assert.equal(readyOption.textContent, '実行待ち');
});

// ── section によるグループ化（issue #389）─────────────────────────────────

function openEditPanel(widget) {
  const { doc, groupsEl, view } = makeView();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  return { doc, groupsEl, view };
}

test('render: 連続する同じ section.id は 1 つの <fieldset> にまとまり、見出しは 1 回だけ描かれる', () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [
        { type: 'select', field: 'reviewCoderabbit', label: 'CodeRabbit', current: 'disabled',
          section: { id: 'review', label: 'レビュー' },
          options: [{ value: 'disabled', label: 'しない' }] },
        { type: 'select', field: 'reviewCodeReview', label: 'コードレビュー', current: 'disabled',
          section: { id: 'review', label: 'レビュー' },
          options: [{ value: 'disabled', label: 'しない' }] },
      ],
    }] },
  ]);
  const { groupsEl } = openEditPanel(widget);

  const fieldsets = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-section'));
  assert.equal(fieldsets.length, 1);
  assert.equal(fieldsets[0].tagName, 'FIELDSET');
  assert.equal(fieldsets[0].getAttribute('disabled'), null);
  const legends = groupsEl.querySelectorAll((el) => el.tagName === 'LEGEND');
  assert.equal(legends.length, 1);
  assert.equal(legends[0].textContent, 'レビュー');
  // 2 個の select が同じ fieldset の配下に入っている。
  const selectsInFieldset = fieldsets[0].querySelectorAll((el) => el.tagName === 'SELECT');
  assert.equal(selectsInFieldset.length, 2);
});

test('render: specModel の宣言は編集パネルに select として描画される', () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [
        { type: 'select', field: 'specModel', label: '仕様検討モデル', ariaLabel: '仕様検討モデルを選択', current: 'inherit',
          options: [
            { value: 'inherit', label: '継承' },
            { value: 'high', label: '高', command: { action: 'set-spec-model', taskId: '10', to: 'high', expected: 'inherit' } },
          ] },
      ],
    }] },
  ]);
  const { groupsEl } = openEditPanel(widget);

  const select = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'specModel');
  assert.ok(select);
  assert.equal(select.value, 'inherit');
  assert.equal(select.options.length, 2);
});

test('render: specModel の変更は保存時に set-spec-model のコマンドを送る', async () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [
        { type: 'select', field: 'specModel', label: '仕様検討モデル', current: 'inherit',
          options: [
            { value: 'inherit', label: '継承' },
            { value: 'high', label: '高', command: { action: 'set-spec-model', taskId: '10', to: 'high', expected: 'inherit' } },
          ] },
      ],
    }] },
  ]);
  const sent = [];
  const { groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
    // 反映待ちタイマー（1段目・2段目とも）がテストプロセスを長く生かさないよう短くする。
    pendingTimeoutMs: 40,
    pendingErrorTimeoutMs: 40,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  groupsEl.querySelectorAll((el) => el.classList.contains('task-item-edit'))[0].dispatch('click');
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const select = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'specModel');
  select.value = 'high';
  select.dispatch('change');
  groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-save'))[0].dispatch('click');
  await Promise.resolve();

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], {
    action: 'apply-batch',
    taskId: '10',
    ops: [{ action: 'set-spec-model', to: 'high', expected: 'inherit' }],
  });

  // 反映待ちのタイムアウトを発火させてタイマーを片付ける（プロセスを 30 秒生かさない）。
  await new Promise((resolve) => setTimeout(resolve, 60));
});

test('render: 同じ section.id でも間に別項目を挟んで再登場した場合は別グループになる', () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [
        { type: 'select', field: 'reviewCoderabbit', label: 'CodeRabbit', current: 'disabled',
          section: { id: 'review', label: 'レビュー' },
          options: [{ value: 'disabled', label: 'しない' }] },
        { type: 'select', field: 'automerge', label: '自動マージ', current: 'disabled',
          section: { id: 'automerge', label: '自動マージ' },
          options: [{ value: 'disabled', label: 'しない' }] },
        { type: 'select', field: 'reviewCodeReview', label: 'コードレビュー', current: 'disabled',
          section: { id: 'review', label: 'レビュー' },
          options: [{ value: 'disabled', label: 'しない' }] },
      ],
    }] },
  ]);
  const { groupsEl } = openEditPanel(widget);

  const fieldsets = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-section'));
  // review → automerge → review は 3 グループ（id が同じでも連続していないため統合しない）。
  assert.equal(fieldsets.length, 3);
  const legends = groupsEl.querySelectorAll((el) => el.tagName === 'LEGEND');
  assert.deepEqual(legends.map((l) => l.textContent), ['レビュー', '自動マージ', 'レビュー']);
  assert.equal(fieldsets[0].querySelectorAll((el) => el.tagName === 'SELECT').length, 1);
  assert.equal(fieldsets[2].querySelectorAll((el) => el.tagName === 'SELECT').length, 1);
});

test('render: 実際の並び（ステータス/優先度/実行方式/自動マージ → 仕様検討 → レビュー）で、レビュー 5 項目の見出しは保たれる（issue #404）', () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [
        { type: 'select', field: 'status', label: 'ステータス', current: 'ready',
          options: [{ value: 'ready', label: '実行待ち' }] },
        { type: 'select', field: 'priority', label: '優先度', current: 'medium',
          options: [{ value: 'medium', label: '中' }] },
        { type: 'select', field: 'sequential', label: '実行方式', current: 'parallel',
          options: [{ value: 'parallel', label: '並列' }] },
        { type: 'select', field: 'automerge', label: '自動マージ', current: 'disabled',
          options: [{ value: 'disabled', label: 'しない' }] },
        { type: 'select', field: 'specModel', label: 'モデル', current: 'inherit',
          section: { id: 'spec-model', label: '仕様検討' },
          options: [{ value: 'inherit', label: '継承' }] },
        { type: 'select', field: 'reviewUx', label: 'UX', current: 'auto',
          section: { id: 'review', label: 'レビュー' },
          options: [{ value: 'auto', label: '自動' }] },
        { type: 'select', field: 'reviewSecurity', label: 'セキュリティー', current: 'auto',
          section: { id: 'review', label: 'レビュー' },
          options: [{ value: 'auto', label: '自動' }] },
        { type: 'select', field: 'reviewE2e', label: 'e2e', current: 'auto',
          section: { id: 'review', label: 'レビュー' },
          options: [{ value: 'auto', label: '自動' }] },
        { type: 'select', field: 'reviewCodeReview', label: 'コードレビュー', current: 'disabled',
          section: { id: 'review', label: 'レビュー' },
          options: [{ value: 'disabled', label: 'しない' }] },
        { type: 'select', field: 'reviewCoderabbit', label: 'CodeRabbit', current: 'disabled',
          section: { id: 'review', label: 'レビュー' },
          options: [{ value: 'disabled', label: 'しない' }] },
      ],
    }] },
  ]);
  const { groupsEl } = openEditPanel(widget);

  const fieldsets = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-section'));
  // 仕様検討・レビューの 2 グループ（section 無しの 4 項目は fieldset を作らない）。
  assert.equal(fieldsets.length, 2);
  const legends = groupsEl.querySelectorAll((el) => el.tagName === 'LEGEND');
  assert.deepEqual(legends.map((l) => l.textContent), ['仕様検討', 'レビュー']);

  // 仕様検討の fieldset には specModel の select が 1 個入る。
  assert.equal(fieldsets[0].querySelectorAll((el) => el.tagName === 'SELECT').length, 1);
  // レビューの fieldset には UX → セキュリティー → e2e → /code-review → CodeRabbit の 5 個が入る。
  const reviewSelects = fieldsets[1].querySelectorAll((el) => el.tagName === 'SELECT');
  assert.deepEqual(reviewSelects.map((select) => select.dataset.field), [
    'reviewUx', 'reviewSecurity', 'reviewE2e', 'reviewCodeReview', 'reviewCoderabbit',
  ]);

  // section 無しの 4 項目（ステータス/優先度/実行方式/自動マージ）は fieldset の外に平坦に並ぶ。
  const controlsContainer = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-controls'))[0];
  assert.deepEqual(
    controlsContainer.children.map((c) => c.tagName),
    ['LABEL', 'LABEL', 'LABEL', 'LABEL', 'FIELDSET', 'FIELDSET'],
  );
  assert.equal(groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').length, 10);
});

test('render: section 付きと section 無しの項目が混在する場合、無し項目を挟むと前後の同じ section.id は別グループになる', () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [
        { type: 'select', field: 'reviewCoderabbit', label: 'CodeRabbit', current: 'disabled',
          section: { id: 'A', label: 'Aラベル' },
          options: [{ value: 'disabled', label: 'しない' }] },
        { type: 'select', field: 'automerge', label: '自動マージ', current: 'disabled',
          options: [{ value: 'disabled', label: 'しない' }] },
        { type: 'select', field: 'reviewCodeReview', label: 'コードレビュー', current: 'disabled',
          section: { id: 'A', label: 'Aラベル' },
          options: [{ value: 'disabled', label: 'しない' }] },
      ],
    }] },
  ]);
  const { groupsEl } = openEditPanel(widget);

  const fieldsets = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-section'));
  // A → 無し → A は 2 グループ（同じ section.id でも間に無し項目を挟むと統合しない）。
  assert.equal(fieldsets.length, 2);

  const controlsContainer = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-controls'))[0];
  // DOM 上の並び順は宣言順（A → 無し → A）のまま保たれる。無し項目は <fieldset> の外に平坦なまま置かれる。
  assert.deepEqual(controlsContainer.children.map((c) => c.tagName), ['FIELDSET', 'LABEL', 'FIELDSET']);
  assert.equal(controlsContainer.children[1].classList.contains('widget-control'), true);
  assert.equal(controlsContainer.children[1].parentNode, controlsContainer);

  assert.equal(fieldsets[0].querySelectorAll((el) => el.tagName === 'SELECT').length, 1);
  assert.equal(fieldsets[1].querySelectorAll((el) => el.tagName === 'SELECT').length, 1);
  assert.equal(groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').length, 3);
});

test('render: section を 1 つも持たない宣言では <fieldset> を作らず従来どおり平坦に並ぶ', () => {
  const widget = editableWidgetWithControls();
  const { groupsEl } = openEditPanel(widget);

  const fieldsets = groupsEl.querySelectorAll((el) => el.tagName === 'FIELDSET');
  assert.equal(fieldsets.length, 0);
  assert.equal(groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').length, 3);
});

test('render: section.label が空文字のときは <fieldset> だけ作り <legend> は描かない', () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [
        { type: 'select', field: 'status', label: 'ステータス', current: 'ready',
          section: { id: 'grp', label: '' },
          options: [{ value: 'ready', label: '実行待ち' }] },
      ],
    }] },
  ]);
  const { groupsEl } = openEditPanel(widget);

  const fieldsets = groupsEl.querySelectorAll((el) => el.classList.contains('task-edit-section'));
  assert.equal(fieldsets.length, 1);
  const legends = groupsEl.querySelectorAll((el) => el.tagName === 'LEGEND');
  assert.equal(legends.length, 0);
});

test('render: firstControl はグループ化しても、パネル全体で最初の 1 個のまま', () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [
        { type: 'select', field: 'status', label: 'ステータス', current: 'ready',
          section: { id: 'a', label: 'A' },
          options: [{ value: 'ready', label: '実行待ち' }] },
        { type: 'select', field: 'priority', label: '優先度', current: 'medium',
          section: { id: 'b', label: 'B' },
          options: [{ value: 'medium', label: '中' }] },
      ],
    }] },
  ]);
  const { doc, groupsEl } = openEditPanel(widget);
  // 開いた直後のフォーカスは「パネル全体で最初の 1 個」（= status の select）でなければならない。
  // グループごとにループを組み直すと各グループ先頭で毎回上書きしてしまうため、
  // 2 つ目のグループ（priority）が最終的に残っていないことを確認する。
  const statusSelect = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT').find((el) => el.dataset.field === 'status');
  assert.equal(doc.activeElement, statusSelect);
});
