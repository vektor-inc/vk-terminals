'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('幅キーは表示中の幅を起点にし、開き先メニューはツールチップを隠す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const keyHandler = source.match(/internalBrowserResizer\.addEventListener\('keydown', event => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(keyHandler);
  const handlers = {};
  const saved = [];
  const context = { internalBrowserResizer: { addEventListener: (_event, handler) => { handlers.keydown = handler; } },
    preferredInternalBrowserWidth: 0, displayedInternalBrowserWidth: 482,
    syncInternalBrowserLayout() { context.displayedInternalBrowserWidth = context.preferredInternalBrowserWidth; },
    localStorage: { setItem: (_key, value) => saved.push(value) } };
  vm.runInNewContext(keyHandler, context);
  handlers.keydown({ key: 'ArrowLeft', preventDefault() {} });
  assert.equal(context.preferredInternalBrowserWidth, 498);
  handlers.keydown({ key: 'ArrowRight', preventDefault() {} });
  assert.equal(context.preferredInternalBrowserWidth, 482);
  assert.deepEqual(saved, ['498', '482']);
  const choice = source.match(/function showInternalBrowserChoice\([\s\S]*?\n\}/)?.[0];
  assert.match(choice, /closeInternalBrowserChoice\(\);\s*hideTermLinkTooltip\(\);/);
});

test('失敗表示は失敗 URL、操作列は確定 URL を安全な外部オープン経路へ渡す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const clickHandler = source.match(/internalBrowserSidebar\.addEventListener\('click', event => \{[\s\S]*?\n\}\);/)?.[0];
  const stateHandler = source.match(/VKIpc\.on\('internal-browser:state', state => \{[\s\S]*?\n\}\);/)?.[0];
  const focusHelpers = source.match(/function focusInternalBrowserToolbar\(\) \{[\s\S]*?\n\}\n\nfunction hideInternalBrowserContent\(element\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(clickHandler);
  assert.ok(stateHandler);
  assert.ok(focusHelpers);
  const handlers = {};
  const buttons = [];
  let layoutSyncs = 0;
  const opened = [];
  let messageWrites = 0;
  let messageText = '';
  const message = {
    get textContent() { return messageText; },
    set textContent(value) { messageWrites++; messageText = value; },
  };
  let activeElement = null;
  const focus = element => { activeElement = element; };
  const errorReload = {};
  const errorButtons = [{ disabled: true }, { disabled: true }];
  const errorView = { hidden: true, contains: element => element === errorReload, querySelector: () => message, querySelectorAll: () => errorButtons };
  const notice = { hidden: true, dataset: {}, contains: element => buttons.includes(element), replaceChildren() {}, append() {} };
  const display = { replaceChildren() {}, setAttribute() {}, append() {}, closest: () => null, focus() { focus(this); } };
  const controls = { disabled: false };
  const reload = { disabled: false, closest: () => null, focus() { focus(this); } };
  const progress = { hidden: true };
  const sidebar = {
    addEventListener: (_type, handler) => { handlers.click = handler; },
    querySelector: selector => ({ '.internal-browser-error': errorView, '.internal-browser-notice': notice, '.internal-browser-url': display, '.internal-browser-toolbar [data-action="reload"]': reload, '.internal-browser-progress': progress }[selector] || controls),
  };
  const context = {
    internalBrowserSidebar: sidebar,
    VKIpc: { on: (name, handler) => { handlers[name] = handler; } },
    openExternalUrlSafe: url => opened.push(url),
    syncInternalBrowserLayout() { layoutSyncs++; },
    URL,
    document: { get activeElement() { return activeElement; }, createElement: () => {
      const button = { textContent: '', append() {}, addEventListener(_type, handler) { this.click = handler; } };
      buttons.push(button);
      return button;
    } },
  };
  vm.runInNewContext(`let internalBrowserUrl = 'https://example.com/confirmed'; let internalBrowserFailedUrl = ''; let internalBrowserHasPage = true; ${focusHelpers} ${clickHandler} ${stateHandler}`, context);
  const state = (failedUrl, github404Url = '', loading = false, url = 'https://example.com/confirmed') => handlers['internal-browser:state']({ url, failedUrl, github404Url, loading });
  state('https://example.com/failed', '', false);
  assert.equal(messageWrites, 1);
  state('https://example.com/failed', '', true);
  state('https://example.com/failed', '', false);
  assert.equal(messageWrites, 1);
  assert.equal(message.textContent, 'ページを表示できませんでした（example.com）');
  assert.equal(errorView.hidden, false);
  assert.equal(errorButtons.every(button => !button.disabled), true);
  activeElement = errorReload;
  state('', '', false);
  assert.equal(activeElement, display);
  assert.equal(message.textContent, '');
  assert.equal(errorView.hidden, true);
  assert.equal(messageWrites, 2);
  state('https://example.com/failed', '', false);
  assert.equal(message.textContent, 'ページを表示できませんでした（example.com）');
  assert.equal(messageWrites, 3);
  state('invalid-url', '', false);
  assert.equal(message.textContent, 'ページを表示できませんでした');
  assert.equal(messageWrites, 4);
  state('https://example.com/failed', '', false);
  const click = inError => handlers.click({ target: {
    closest: selector => selector === '[data-action]' ? { dataset: { action: 'external' } } : selector === '.internal-browser-error' && inError ? errorView : null,
  } });
  click(true);
  click(false);
  assert.deepEqual(opened, ['https://example.com/failed', 'https://example.com/confirmed']);
  activeElement = controls;
  state('');
  assert.equal(activeElement, controls);
  state('', 'https://github.com/missing', false);
  state('', 'https://github.com/missing', true);
  assert.equal(notice.hidden, false);
  state('', 'https://github.com/missing', false);
  assert.equal(notice.hidden, false);
  const beforeDismiss = layoutSyncs;
  const closeNotice = buttons.find(button => button.textContent === '案内を閉じる');
  activeElement = closeNotice;
  closeNotice.click();
  assert.equal(notice.hidden, true);
  assert.equal(activeElement, display);
  assert.equal(layoutSyncs, beforeDismiss + 1);
  state('', 'https://github.com/missing', false);
  assert.equal(notice.hidden, true);
  state('', '', false);
  assert.equal(notice.hidden, true);
  state('', 'https://github.com/another');
  activeElement = buttons.find(button => button.textContent === '案内を閉じる' && button !== closeNotice);
  state('', 'https://github.com/another', false, '');
  activeElement.click();
  assert.equal(activeElement, reload);
});
