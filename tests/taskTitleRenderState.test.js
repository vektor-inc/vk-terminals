'use strict';

// issue #614: タイトル行（.pane-task-title）の中身を、表示に使う値が前回と同じときは
// 作り直さないための判定（renderer/taskTitleRenderState.js）の単体テスト。
// Codex はスピナーで OSC タイトルを高頻度に書き換えるため、表示が API タイトルで
// 変わらなくても毎回作り直すと、押した要素と離した要素が入れ替わって click が成立しなかった。

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createTaskTitleRenderTracker,
  isSameTaskTitleRenderState,
  normalizeTaskTitleRenderState,
} = require('../renderer/taskTitleRenderState');

// DOM の代わりに、判定が見る firstChild だけを持つ最小の要素を使う。
function fakeElement(hasContent) {
  return { firstChild: hasContent ? {} : null };
}

const BASE = {
  title: 'Issue のタイトル',
  url: 'https://github.com/vektor-inc/vk-terminals/issues/614',
  prUrl: 'https://github.com/vektor-inc/vk-terminals/pull/1',
  prMerged: false,
  waitingMerge: false,
};

test('normalizeTaskTitleRenderState: 文字列は空文字へ、真偽値は === true へ揃える', () => {
  assert.deepEqual(normalizeTaskTitleRenderState({}), {
    title: '',
    url: '',
    prUrl: '',
    prMerged: false,
    waitingMerge: false,
  });
  // getPrBadgePresentation と同じく、boolean の true 以外は false 扱いにする。
  assert.equal(normalizeTaskTitleRenderState({ prMerged: 'true' }).prMerged, false);
  assert.equal(normalizeTaskTitleRenderState({ waitingMerge: 1 }).waitingMerge, false);
});

test('isSameTaskTitleRenderState: 5 つの値がすべて同じときだけ true', () => {
  assert.equal(isSameTaskTitleRenderState(BASE, { ...BASE }), true);
  for (const key of ['title', 'url', 'prUrl']) {
    assert.equal(isSameTaskTitleRenderState(BASE, { ...BASE, [key]: `${BASE[key]}x` }), false, key);
  }
  assert.equal(isSameTaskTitleRenderState(BASE, { ...BASE, prMerged: true }), false);
  assert.equal(isSameTaskTitleRenderState(BASE, { ...BASE, waitingMerge: true }), false);
  assert.equal(isSameTaskTitleRenderState(null, BASE), false);
});

test('shouldRender: 新しい要素は必ず描画する', () => {
  const tracker = createTaskTitleRenderTracker();
  assert.equal(tracker.shouldRender(fakeElement(false), BASE), true);
});

test('shouldRender: 同じ値で描画済みの要素は作り直さない（OSC タイトルだけが変わった場合）', () => {
  const tracker = createTaskTitleRenderTracker();
  const el = fakeElement(false);
  assert.equal(tracker.shouldRender(el, BASE), true);
  el.firstChild = {}; // 描画済みになった
  // スピナーで OSC タイトルが変わっても、表示に使う値は API タイトルのまま変わらない。
  for (let i = 0; i < 5; i += 1) {
    assert.equal(tracker.shouldRender(el, { ...BASE }), false);
  }
});

test('shouldRender: 値が変わったら描画し直す（API のタイトル・URL・PR・マージ状態の更新）', () => {
  const tracker = createTaskTitleRenderTracker();
  const el = fakeElement(true);
  assert.equal(tracker.shouldRender(el, BASE), true);
  assert.equal(tracker.shouldRender(el, { ...BASE, title: '新しいタイトル' }), true);
  assert.equal(tracker.shouldRender(el, { ...BASE, title: '新しいタイトル' }), false);
  assert.equal(tracker.shouldRender(el, { ...BASE, title: '新しいタイトル', waitingMerge: true }), true);
  assert.equal(tracker.shouldRender(el, { ...BASE, title: '新しいタイトル', prMerged: true }), true);
  assert.equal(tracker.shouldRender(el, { ...BASE, title: '新しいタイトル', prMerged: true, prUrl: '' }), true);
});

test('shouldRender: 前回値と同じでも中身が空なら描画する', () => {
  const tracker = createTaskTitleRenderTracker();
  const el = fakeElement(true);
  assert.equal(tracker.shouldRender(el, BASE), true);
  el.firstChild = null;
  assert.equal(tracker.shouldRender(el, BASE), true);
});

test('shouldRender: 前回値は要素ごとに持つ（別ペイン・格納カードの判定が混ざらない）', () => {
  const tracker = createTaskTitleRenderTracker();
  const paneEl = fakeElement(true);
  const stashEl = fakeElement(true);
  assert.equal(tracker.shouldRender(paneEl, BASE), true);
  // 別の要素は、同じ値でも初回なので描画する。
  assert.equal(tracker.shouldRender(stashEl, BASE), true);
  assert.equal(tracker.shouldRender(paneEl, BASE), false);
  assert.equal(tracker.shouldRender(stashEl, BASE), false);
});

// app.js の renderTaskTitleContent を実際に動かし、同じ値での再描画で要素が入れ替わらないことを確かめる
// （tests/terminalBrowserChoice.test.js と同じく、関数のソースを切り出して vm で実行する）。
test('renderTaskTitleContent: 同じ値で呼び直してもタイトルリンクと PR ラベルを作り直さない', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const vm = require('node:vm');
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const titleRenderer = source.slice(source.indexOf('function renderTaskTitleContent('), source.indexOf('function updatePaneTitle('));
  const makeElement = () => ({
    children: [],
    setAttribute() {},
    addEventListener() {},
    appendChild(child) { this.children.push(child); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    get firstChild() { return this.children[0]; },
  });
  const root = makeElement();
  const context = {
    root,
    document: { createElement: makeElement },
    getPrBadgePresentation: (merged) => ({
      className: merged ? 'pane-task-title-pr merged' : 'pane-task-title-pr',
      ariaLabel: 'PR',
      titleLabel: 'PR',
      icon: merged ? '✓' : '↗',
    }),
    showInternalBrowserChoice() {},
    taskTitleRenderTracker: createTaskTitleRenderTracker(),
  };
  vm.runInNewContext(titleRenderer, context);
  const render = (title, prMerged) => vm.runInNewContext(
    `renderTaskTitleContent(root, ${JSON.stringify(title)}, 'https://example.com/issue', 'https://example.com/pr', ${prMerged})`,
    context,
  );

  render('Issue', false);
  const [issueLink, prLink] = root.children;
  // OSC タイトルの更新（Codex のスピナー）で、同じ値のまま何度も呼ばれる。
  render('Issue', false);
  render('Issue', false);
  assert.equal(root.children.length, 2);
  assert.equal(root.children[0], issueLink);
  assert.equal(root.children[1], prLink);

  // PR がマージされたなど、値が変わったときは作り直す。
  render('Issue', true);
  assert.notEqual(root.children[1], prLink);
  assert.equal(root.children[1].className, 'pane-task-title-pr merged');
});
