'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isMacPlatform,
  isLinkOpenModifierPressed,
  createTerminalLinkHandlers,
} = require('../utils/terminalLinkPolicy');

test('isMacPlatform: platform 文字列から macOS 系かどうかを判定する', () => {
  assert.equal(isMacPlatform('MacIntel'), true);
  assert.equal(isMacPlatform('iPhone'), true);
  assert.equal(isMacPlatform('Win32'), false);
  assert.equal(isMacPlatform('Linux x86_64'), false);
  assert.equal(isMacPlatform(''), false);
});

test('isLinkOpenModifierPressed: macOS は metaKey、Windows/Linux は ctrlKey だけを見る', () => {
  assert.equal(isLinkOpenModifierPressed({ metaKey: true, ctrlKey: false }, true), true);
  assert.equal(isLinkOpenModifierPressed({ metaKey: false, ctrlKey: true }, true), false);
  assert.equal(isLinkOpenModifierPressed({ metaKey: false, ctrlKey: true }, false), true);
  assert.equal(isLinkOpenModifierPressed({ metaKey: true, ctrlKey: false }, false), false);
});

test('isLinkOpenModifierPressed: 修飾キーが無いイベントでは false', () => {
  assert.equal(isLinkOpenModifierPressed({ metaKey: false, ctrlKey: false }, true), false);
  assert.equal(isLinkOpenModifierPressed({ metaKey: false, ctrlKey: false }, false), false);
  assert.equal(isLinkOpenModifierPressed(null, true), false);
  assert.equal(isLinkOpenModifierPressed(undefined, false), false);
});

test('createTerminalLinkHandlers: 修飾キー無しのクリックでは openUrl を呼ばない（最重要のセキュリティ分岐）', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    openUrl: (url) => calls.push(url),
  });
  const event = { metaKey: false, ctrlKey: false, preventDefault() { this.prevented = true; } };
  handlers.activate(event, 'https://example.com');
  assert.deepEqual(calls, []);
  assert.equal(event.prevented, undefined);
});

test('createTerminalLinkHandlers: 修飾キー付きクリックで openUrl を 1 回だけ呼ぶ', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    openUrl: (url) => calls.push(url),
  });
  const event = { metaKey: true, ctrlKey: false, preventDefault() { this.prevented = true; } };
  handlers.activate(event, 'https://example.com');
  assert.deepEqual(calls, ['https://example.com']);
  assert.equal(event.prevented, true);
});

test('createTerminalLinkHandlers: Windows/Linux では ctrlKey だけを見る（metaKey では開かない）', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: false,
    openUrl: (url) => calls.push(url),
  });
  handlers.activate({ metaKey: true, ctrlKey: false }, 'https://example.com');
  assert.deepEqual(calls, []);
  handlers.activate({ metaKey: false, ctrlKey: true }, 'https://example.com');
  assert.deepEqual(calls, ['https://example.com']);
});

test('createTerminalLinkHandlers: hover/leave はツールチップの表示・非表示へ橋渡しするだけ', () => {
  const shown = [];
  const hidden = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    openUrl: () => {},
    showTooltip: (event, url) => shown.push(url),
    hideTooltip: (event, url) => hidden.push(url),
  });
  handlers.hover({}, 'https://example.com');
  handlers.leave({}, 'https://example.com');
  assert.deepEqual(shown, ['https://example.com']);
  assert.deepEqual(hidden, ['https://example.com']);
});

test('createTerminalLinkHandlers: deps 未指定でも例外を投げない（no-op フォールバック）', () => {
  const handlers = createTerminalLinkHandlers();
  assert.doesNotThrow(() => {
    handlers.activate({ metaKey: true, ctrlKey: true }, 'https://example.com');
    handlers.hover({}, 'https://example.com');
    handlers.leave({}, 'https://example.com');
  });
});
