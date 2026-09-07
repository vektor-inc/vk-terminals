'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isMacPlatform,
  isLinkOpenModifierPressed,
  normalizeTerminalLinkClickMode,
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

test('normalizeTerminalLinkClickMode: 既知の値はそのまま通し、未知の値・未設定は既定 click に正規化する（issue #385）', () => {
  assert.equal(normalizeTerminalLinkClickMode('click'), 'click');
  assert.equal(normalizeTerminalLinkClickMode('modifier'), 'modifier');
  assert.equal(normalizeTerminalLinkClickMode('unknown-value'), 'click');
  assert.equal(normalizeTerminalLinkClickMode(undefined), 'click');
  assert.equal(normalizeTerminalLinkClickMode(null), 'click');
  assert.equal(normalizeTerminalLinkClickMode(''), 'click');
});

test('createTerminalLinkHandlers: click モード（既定）・フォーカス済みペインなら修飾キー無しでも openUrl を呼ぶ（issue #385）', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    clickMode: 'click',
    wasPaneFocused: () => true,
    openUrl: (url) => calls.push(url),
  });
  const event = { metaKey: false, ctrlKey: false, preventDefault() { this.prevented = true; } };
  handlers.activate(event, 'https://example.com');
  assert.deepEqual(calls, ['https://example.com']);
  assert.equal(event.prevented, true);
});

test('createTerminalLinkHandlers: click モードでも、フォーカスされていないペインへの最初のクリックでは openUrl を呼ばない（issue #385・最重要のフォーカスガード）', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    clickMode: 'click',
    wasPaneFocused: () => false,
    openUrl: (url) => calls.push(url),
  });
  const event = { metaKey: false, ctrlKey: false, preventDefault() { this.prevented = true; } };
  handlers.activate(event, 'https://example.com');
  assert.deepEqual(calls, []);
  // フォーカス移動だけに使うクリックのため、xterm 本来の挙動（フォーカス移譲・カーソル配置）を
  // 妨げないよう preventDefault は呼ばない（指示仕様）。
  assert.equal(event.prevented, undefined);
});

test('createTerminalLinkHandlers: modifier モードでは従来どおり修飾キー無しのクリックでは openUrl を呼ばない（最重要のセキュリティ分岐）', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    clickMode: 'modifier',
    wasPaneFocused: () => true,
    openUrl: (url) => calls.push(url),
  });
  const event = { metaKey: false, ctrlKey: false, preventDefault() { this.prevented = true; } };
  handlers.activate(event, 'https://example.com');
  assert.deepEqual(calls, []);
  assert.equal(event.prevented, undefined);
});

test('createTerminalLinkHandlers: modifier モードで修飾キー付きクリックなら openUrl を 1 回だけ呼ぶ', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    clickMode: 'modifier',
    wasPaneFocused: () => true,
    openUrl: (url) => calls.push(url),
  });
  const event = { metaKey: true, ctrlKey: false, preventDefault() { this.prevented = true; } };
  handlers.activate(event, 'https://example.com');
  assert.deepEqual(calls, ['https://example.com']);
  assert.equal(event.prevented, true);
});

test('createTerminalLinkHandlers: modifier モードでは Windows/Linux では ctrlKey だけを見る（metaKey では開かない）', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: false,
    clickMode: 'modifier',
    wasPaneFocused: () => true,
    openUrl: (url) => calls.push(url),
  });
  handlers.activate({ metaKey: true, ctrlKey: false }, 'https://example.com');
  assert.deepEqual(calls, []);
  handlers.activate({ metaKey: false, ctrlKey: true }, 'https://example.com');
  assert.deepEqual(calls, ['https://example.com']);
});

test('createTerminalLinkHandlers: modifier モードでも、フォーカスされていないペインへの最初のクリックは修飾キー付きでも openUrl を呼ばない（フォーカスガードは両モード共通）', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    clickMode: 'modifier',
    wasPaneFocused: () => false,
    openUrl: (url) => calls.push(url),
  });
  const event = { metaKey: true, ctrlKey: false, preventDefault() { this.prevented = true; } };
  handlers.activate(event, 'https://example.com');
  assert.deepEqual(calls, []);
  assert.equal(event.prevented, undefined);
});

test('createTerminalLinkHandlers: 未知の clickMode 値は click として扱う（正規化のフォールバック）', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    clickMode: 'nonsense',
    wasPaneFocused: () => true,
    openUrl: (url) => calls.push(url),
  });
  handlers.activate({ metaKey: false, ctrlKey: false }, 'https://example.com');
  assert.deepEqual(calls, ['https://example.com']);
});

test('createTerminalLinkHandlers: wasPaneFocused 未指定時はフォーカス済み相当として扱う（後方互換）', () => {
  const calls = [];
  const handlers = createTerminalLinkHandlers({
    isMac: true,
    clickMode: 'click',
    openUrl: (url) => calls.push(url),
  });
  handlers.activate({ metaKey: false, ctrlKey: false }, 'https://example.com');
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
