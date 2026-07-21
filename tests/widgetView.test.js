'use strict';

// 宣言的ウィジェットの共有 DOM レンダラ（renderer/widgetView.js）の単体テスト。
// jsdom を持たないため、renderer が使う DOM API の部分集合だけを実装した最小スタブで検証する。
// 重点: textContent のみで描画（innerHTML 禁止）・tone フォールバック・URL 二段防御・
//       担当者フィルタ適用・staleness による空文言抑止・コマンド発行と確認ダイアログ。

const test = require('node:test');
const assert = require('node:assert/strict');

const contract = require('../utils/widgetContract');
const { createTaskWidgetView } = require('../renderer/widgetView');

// ── 最小 DOM スタブ ──────────────────────────────────────────────────────────
class FakeClassList {
  constructor() { this._set = new Set(); }
  add(c) { this._set.add(c); }
  remove(c) { this._set.delete(c); }
  toggle(c, on) { const v = on === undefined ? !this._set.has(c) : on; if (v) this._set.add(c); else this._set.delete(c); return v; }
  contains(c) { return this._set.has(c); }
}

class FakeElement {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.classList = new FakeClassList();
    this.parentNode = null;
    this._text = '';
    this._className = '';
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

  get childNodes() { return this.children; }
  get firstChild() { return this.children[0] || null; }

  appendChild(node) { node.parentNode = this; this.children.push(node); return node; }
  removeChild(node) { const i = this.children.indexOf(node); if (i >= 0) this.children.splice(i, 1); return node; }
  replaceChildren() {
    const nodes = Array.prototype.slice.call(arguments);
    this.children = [];
    nodes.forEach((n) => this.appendChild(n));
  }

  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }

  addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); }
  // テスト用: イベントを発火する。
  dispatch(type) {
    const ev = { preventDefault() {}, stopPropagation() {} };
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
  return { createElement: (tag) => new FakeElement(tag) };
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

test('render: グループ見出し・アイテムに tone を data 属性で付与し、未知 tone は neutral', () => {
  const widget = sanitized([
    { id: 'in-progress', label: '実行中', tone: 'progress', items: [
      { id: '1', title: 'タスクA', editable: false, badges: [{ label: '高', tone: 'danger' }, { label: '直列', tone: 'zzz' }] },
    ] },
  ]);
  const { groupsEl, view } = makeView();
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const groupLabel = groupsEl.querySelectorAll((el) => el.classList.contains('widget-group-label'))[0];
  assert.equal(groupLabel.dataset.tone, 'progress');
  const badges = groupsEl.querySelectorAll((el) => el.classList.contains('widget-badge'));
  assert.equal(badges[0].dataset.tone, 'danger');
  // 未知 tone は neutral へフォールバック。
  assert.equal(badges[1].dataset.tone, 'neutral');
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
  const titles = groupsEl.querySelectorAll((el) => el.classList.contains('task-item-title')).map((el) => el.textContent);
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

test('render: コントロールの変更でコマンド断片を sendCommand へ渡し、反映待ちを表示する', async () => {
  const widget = sanitized([
    { id: 'ready', label: '実行待ち', tone: 'info', items: [{
      id: '10', title: 'T', editable: true,
      controls: [{ type: 'select', field: 'status', label: 'ステータス', ariaLabel: 'ステータス', current: 'ready', options: [
        { value: 'ready', label: '実行待ち' },
        { value: 'in-progress', label: '実行中', command: { action: 'set-status', taskId: '10', to: 'in-progress', expected: 'ready' } },
      ] }],
    }] },
  ]);
  const sent = [];
  let rerenders = 0;
  const { groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
    requestRerender: () => { rerenders += 1; },
    // 反映待ちタイマーがテストプロセスを長く生かさないよう短くする。
    pendingTimeoutMs: 40,
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });

  const select = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT')[0];
  select.value = 'in-progress';
  select.dispatch('change');
  // change ハンドラは async。マイクロタスクを 1 回流す。
  await Promise.resolve();

  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0], { action: 'set-status', taskId: '10', to: 'in-progress', expected: 'ready' });
  assert.equal(view.hasPending(), true);
  assert.ok(rerenders >= 1);

  // 反映待ちのタイムアウトを発火させてタイマーを片付ける（プロセスを 30 秒生かさない）。
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(view.hasPending(), false);
});

test('render: 確認ダイアログで拒否するとコマンドを送らず現在値へ戻す', async () => {
  const widget = sanitized([
    { id: 'waiting-merge', label: 'マージ待ち', tone: 'info', items: [{
      id: '11', title: 'T', editable: true,
      controls: [{ type: 'select', field: 'status', label: 'ステータス', current: 'waiting-merge', options: [
        { value: 'waiting-merge', label: 'マージ待ち' },
        { value: 'done', label: '完了',
          command: { action: 'set-status', taskId: '11', to: 'done', expected: 'waiting-merge' },
          confirm: { title: '完了にしますか？', body: 'PR は残ります' } },
      ] }],
    }] },
  ]);
  const sent = [];
  const { groupsEl, view } = makeView({
    sendCommand: async (cmd) => { sent.push(cmd); return { ok: true }; },
    confirm: () => false, // 拒否
  });
  view.render(widget, { now: Date.parse('2026-07-21T00:00:10.000Z') });
  const select = groupsEl.querySelectorAll((el) => el.tagName === 'SELECT')[0];
  select.value = 'done';
  select.dispatch('change');
  await Promise.resolve();

  assert.equal(sent.length, 0);
  assert.equal(view.hasPending(), false);
  // 現在値へ戻る。
  assert.equal(select.value, 'waiting-merge');
});
