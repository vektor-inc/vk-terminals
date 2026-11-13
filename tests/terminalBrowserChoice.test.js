'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createTerminalLinkHandlers } = require('../utils/terminalLinkPolicy');
const { createTaskTitleRenderTracker } = require('../renderer/taskTitleRenderState');

const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');

test('Claude Code と Codex の通常 URL・OSC 8 は同じ開き先メニューへ進む', async () => {
  // 端末生成時の配線を実行し、エンジンに依存せず両プロバイダが同じハンドラを使うか確かめる。
  const terminalSetup = source.slice(source.indexOf('async function createTerminal('), source.indexOf('  // OSC 0 / OSC 2 のタイトル変更を購読して')) + '  return term;\n}';
  assert.match(terminalSetup, /linkHandler: terminalLinkHandlers/);
  for (const engine of ['claude', 'codex']) {
    let options;
    const opened = [];
    class Terminal {
      constructor(value) { options = value; }
      loadAddon() {}
      registerLinkProvider(provider) { this.provider = provider; }
    }
    const context = {
      Terminal,
      FitAddon: class {},
      createTerminalLinkHandlers,
      createTerminalLinkProvider: (_term, handlers) => ({ handlers }),
      openTerminalLinkUrl: (url, event) => opened.push({ url, event }),
      showTermLinkTooltip() {}, hideTermLinkTooltip() {},
      IS_MAC_PLATFORM: true,
      terminalLinkClickModePref: 'click',
      lastClickWasDrag: false,
      TERM_THEME: {},
    };
    const term = await vm.runInNewContext(`${terminalSetup}\ncreateTerminal('pane-1', null, {}, { id: '1', cwd: '.', engine: '${engine}' })`, context);
    assert.equal(options.linkHandler, term.provider.handlers);
    const event = { button: 0, detail: 1, preventDefault() { this.prevented = true; } };
    options.linkHandler.activate(event, 'https://example.com/osc8');
    term.provider.handlers.activate(event, 'https://example.com/plain');
    assert.deepEqual(opened.map(call => call.url), ['https://example.com/osc8', 'https://example.com/plain']);
    assert.ok(opened.every(call => call.event === event));
    assert.equal(event.prevented, true);
    options.linkHandler.activate({ button: 2 }, 'https://example.com/blocked');
    assert.equal(opened.length, 2);
  }
});

test('issue タイトルと PR ボタンもペイン内 URL と同じ開き先メニューを使う', () => {
  // 実際のタイトル描画を動かし、両リンクのクリック先を調べる。
  const titleRenderer = source.slice(source.indexOf('function renderTaskTitleContent('), source.indexOf('function updatePaneTitle('));
  const calls = [];
  const makeElement = () => ({
    children: [],
    setAttribute() {},
    addEventListener(type, handler) { if (type === 'click') this.click = handler; },
    appendChild(child) { this.children.push(child); },
    removeChild(child) { this.children.splice(this.children.indexOf(child), 1); },
    get firstChild() { return this.children[0]; },
  });
  const root = makeElement();
  const context = {
    document: { createElement: makeElement },
    getPrBadgePresentation: () => ({ className: 'pane-task-title-pr', ariaLabel: 'PR（外部ブラウザ）', titleLabel: 'PR', icon: '↗' }),
    showInternalBrowserChoice: (url, event, origin) => calls.push({ url, event, origin }),
    taskTitleRenderTracker: createTaskTitleRenderTracker(),
  };
  vm.runInNewContext(`${titleRenderer}\nrenderTaskTitleContent(root, 'Issue', 'https://example.com/issue', 'https://example.com/pr')`, { ...context, root });
  const [issueLink, prLink] = root.children;
  const event = { preventDefault() {}, stopPropagation() {} };
  issueLink.click(event);
  prLink.click(event);
  assert.deepEqual(calls.map(call => call.url), ['https://example.com/issue', 'https://example.com/pr']);
  assert.equal(calls[0].origin, issueLink);
  assert.equal(calls[1].origin, prLink);
});

test('共通メニューの選択肢がアプリ内ブラウザと OS のブラウザを開く', async () => {
  // 3 種のリンクが到達するメニューから、選択後の実際の行き先まで確かめる。
  const showChoice = source.slice(source.indexOf('function showInternalBrowserChoice('), source.indexOf("document.addEventListener('keydown', event => {"));
  const buttons = [];
  const makeElement = () => ({
    children: [], style: {}, offsetWidth: 200, offsetHeight: 90,
    setAttribute() {},
    addEventListener(type, handler) { if (type === 'click') this.click = handler; },
    appendChild(child) { this.children.push(child); },
    querySelector() { return this.children.find(child => child.click); },
    focus() {},
  });
  const sidebar = { querySelector: () => ({ contains: () => false, hidden: true }), getBoundingClientRect: () => ({ left: 800 }) };
  const calls = [];
  const context = {
    URL,
    isSafeHttpUrl: () => true,
    window: { innerWidth: 1200, innerHeight: 800, VKInternalBrowserChoicePolicy: { shouldShowBrowserChoice: () => true } },
    document: { createElement() { const element = makeElement(); buttons.push(element); return element; }, body: { appendChild() {} } },
    closeInternalBrowserChoice() {}, hideTermLinkTooltip() {},
    internalBrowserChoice: null, internalBrowserOpen: false, internalBrowserSidebar: sidebar,
    lastClickWasDrag: false, escapeLayers: { register: () => () => {} },
    hideInternalBrowserContent() {}, setInternalBrowserOpen: value => calls.push(['sidebar', value]),
    VKIpc: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } },
    openExternalUrlSafe: (url, options) => { calls.push(['external', url]); options?.onSuccess?.(); },
    showTerminalLinkOpenedToast: url => calls.push(['toast', url]),
  };
  vm.runInNewContext(showChoice, context);
  const url = 'https://example.com/issue';
  vm.runInNewContext(`showInternalBrowserChoice('${url}', { clientX: 20, clientY: 20 })`, context);
  buttons.find(button => button.textContent === 'アプリ内で開く').click({ detail: 1 });
  assert.deepEqual(calls, [['sidebar', true], ['internal-browser:open', url]]);
  calls.length = 0;
  vm.runInNewContext(`showInternalBrowserChoice('${url}', { clientX: 20, clientY: 20 })`, context);
  buttons.filter(button => button.textContent === '外部ブラウザで開く ↗').at(-1).click({ detail: 1 });
  assert.deepEqual(calls, [['external', url], ['toast', url]]);

  calls.length = 0;
  context.origin = { getBoundingClientRect: () => ({ left: 10, bottom: 20 }) };
  vm.runInNewContext(`showInternalBrowserChoice('${url}', { clientX: 20, clientY: 20 }, origin)`, context);
  buttons.filter(button => button.textContent === '外部ブラウザで開く ↗').at(-1).click({ detail: 1 });
  assert.deepEqual(calls, [['external', url]]);
});
