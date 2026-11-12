'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('失敗表示は失敗 URL、操作列は確定 URL を安全な外部オープン経路へ渡す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../renderer/app.js'), 'utf8');
  const clickHandler = source.match(/internalBrowserSidebar\.addEventListener\('click', event => \{[\s\S]*?\n\}\);/)?.[0];
  const errorHandler = source.match(/VKIpc\.on\('internal-browser:error', \(\{ url \}\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(clickHandler);
  assert.ok(errorHandler);
  const handlers = {};
  const opened = [];
  const errorView = { hidden: true };
  const sidebar = {
    addEventListener: (_type, handler) => { handlers.click = handler; },
    querySelector: selector => selector === '.internal-browser-error' ? errorView : null,
  };
  const context = {
    internalBrowserSidebar: sidebar,
    VKIpc: { on: (name, handler) => { handlers[name] = handler; } },
    openExternalUrlSafe: url => opened.push(url),
    syncInternalBrowserLayout() {},
  };
  vm.runInNewContext(`let internalBrowserUrl = 'https://example.com/confirmed'; let internalBrowserFailedUrl = ''; ${clickHandler} ${errorHandler}`, context);
  handlers['internal-browser:error']({ url: 'https://example.com/failed' });
  assert.equal(errorView.hidden, false);
  const click = inError => handlers.click({ target: {
    closest: selector => selector === '[data-action]' ? { dataset: { action: 'external' } } : selector === '.internal-browser-error' && inError ? errorView : null,
  } });
  click(true);
  click(false);
  assert.deepEqual(opened, ['https://example.com/failed', 'https://example.com/confirmed']);
});
