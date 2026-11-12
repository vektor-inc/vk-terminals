'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('失敗表示は失敗 URL、操作列は確定 URL を安全な外部オープン経路へ渡す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const clickHandler = source.match(/internalBrowserSidebar\.addEventListener\('click', event => \{[\s\S]*?\n\}\);/)?.[0];
  const stateHandler = source.match(/VKIpc\.on\('internal-browser:state', state => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(clickHandler);
  assert.ok(stateHandler);
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
  const errorView = { hidden: true, querySelector: () => message };
  const notice = { hidden: true, dataset: {}, replaceChildren() {}, append() {} };
  const display = { replaceChildren() {}, setAttribute() {}, append() {} };
  const controls = { disabled: false };
  const progress = { hidden: true };
  const sidebar = {
    addEventListener: (_type, handler) => { handlers.click = handler; },
    querySelector: selector => ({ '.internal-browser-error': errorView, '.internal-browser-notice': notice, '.internal-browser-url': display, '.internal-browser-progress': progress }[selector] || controls),
  };
  const context = {
    internalBrowserSidebar: sidebar,
    VKIpc: { on: (name, handler) => { handlers[name] = handler; } },
    openExternalUrlSafe: url => opened.push(url),
    syncInternalBrowserLayout() { layoutSyncs++; },
    URL,
    document: { createElement: () => {
      const button = { textContent: '', addEventListener(_type, handler) { this.click = handler; } };
      buttons.push(button);
      return button;
    } },
  };
  vm.runInNewContext(`let internalBrowserUrl = 'https://example.com/confirmed'; let internalBrowserFailedUrl = ''; let internalBrowserHasPage = false; ${clickHandler} ${stateHandler}`, context);
  const state = (failedUrl, github404Url = '', loading = false) => handlers['internal-browser:state']({ url: 'https://example.com/confirmed', failedUrl, github404Url, loading });
  state('https://example.com/failed', '', false);
  assert.equal(messageWrites, 1);
  state('https://example.com/failed', '', true);
  state('https://example.com/failed', '', false);
  assert.equal(messageWrites, 1);
  assert.equal(message.textContent, 'ページを表示できませんでした（example.com）');
  assert.equal(errorView.hidden, false);
  state('', '', false);
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
  state('', 'https://github.com/missing', false);
  state('', 'https://github.com/missing', true);
  assert.equal(notice.hidden, false);
  state('', 'https://github.com/missing', false);
  assert.equal(notice.hidden, false);
  const beforeDismiss = layoutSyncs;
  buttons.find(button => button.textContent === '案内を閉じる').click();
  assert.equal(notice.hidden, true);
  assert.equal(layoutSyncs, beforeDismiss + 1);
  state('', 'https://github.com/missing', false);
  assert.equal(notice.hidden, true);
  state('', '', false);
  assert.equal(notice.hidden, true);
});
