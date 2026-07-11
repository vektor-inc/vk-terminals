'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const {
  appendAnsiForDisplay,
  stripAnsiForDisplay,
} = require('../utils/stripAnsi');

const MAX_DISPLAY_ROWS = 500;
const MAX_DISPLAY_LINE_LENGTH = 1001;

function loadSanitizeMobilePreviewText() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'mobile.html'), 'utf8');
  const match = html.match(/\/\/ Claude Code[\s\S]*?\nfunction tail/);
  assert.ok(match, 'sanitizeMobilePreviewText の定義を renderer/mobile.html から抽出できる');

  const context = {};
  vm.runInNewContext(match[0].replace(/\nfunction tail$/, ''), context);
  return context.sanitizeMobilePreviewText;
}

function loadMobileStripAnsi() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'mobile.html'), 'utf8');
  const match = html.match(/"use strict";[\s\S]*?\n\/\/ Claude Code/);
  assert.ok(match, 'stripAnsi の定義を renderer/mobile.html から抽出できる');

  const context = {};
  vm.runInNewContext(match[0].replace(/\n\/\/ Claude Code$/, ''), context);
  return context.stripAnsi;
}

function tailString(s, n) {
  return s.length > n ? s.slice(s.length - n) : s;
}

function buildClaudeCodeCsiRedrawFrame() {
  return [
    '\x1b[1;1H\x1b[2K実装内容を確認しています',
    '\x1b[2;1H\x1b[2K- renderer/mobile.html のモバイルプレビューを調査',
    '\x1b[3;1H\x1b[2K- sanitize の処理順と CSS 高さを確認',
    '\x1b[4;1H\x1b[2K- 直近の本文出力を最低10行見えるように修正',
    '\x1b[5;1H\x1b[2Knpm test を実行して回帰を確認します',
    '\x1b[6;1H\x1b[2K変更後は本文行が消えないことを検証します',
    '\x1b[7;1H\x1b[2K',
    '\x1b[8;1H\x1b[2K╭────────────────────────────╮',
    '\x1b[9;1H\x1b[2K│ > 1. Yes                    │',
    '\x1b[10;1H\x1b[2K╰────────────────────────────╯',
  ].join('');
}

function assertBoundedDisplayControls(name, fn) {
  const cases = [
    ['huge absolute row', '\x1b[999999Hrow'],
    ['huge relative row', `top\x1b[2147483647Bbottom`],
    ['huge absolute row and col', '\x1b[999999;9999999999999999HX'],
    ['huge relative col', `start\x1b[9999999999999999CX`],
    ['negative relative col', `abc\x1b[-5CX`],
  ];

  for (const [label, input] of cases) {
    assert.doesNotThrow(() => fn(input), `${name}: ${label} should not throw`);
    const output = fn(input);
    const lines = output.split('\n');

    assert.ok(
      lines.length <= MAX_DISPLAY_ROWS,
      `${name}: ${label} should clamp rows, got ${lines.length}`
    );
    assert.ok(
      lines.every((line) => line.length <= MAX_DISPLAY_LINE_LENGTH),
      `${name}: ${label} should clamp line length`
    );
  }
}

test('sanitizeMobilePreviewText: スピナー記号だけの行と数字断片行を除去する', () => {
  const sanitizeMobilePreviewText = loadSanitizeMobilePreviewText();
  const input = [
    '✻',
    '✳40',
    ' 123 ',
    '---',
    'Claude is working',
    '作業完了です',
    '✻ Thinking...',
  ].join('\n');

  assert.equal(
    sanitizeMobilePreviewText(input),
    [
      'Claude is working',
      '作業完了です',
      ' Thinking...',
    ].join('\n')
  );
});

test('sanitizeMobilePreviewText: 英字と日本語を含む本文行は残す', () => {
  const sanitizeMobilePreviewText = loadSanitizeMobilePreviewText();
  const input = [
    'npm test passed 12/12',
    '変更内容をご確認ください',
    'カタカナの本文も残す',
    'APIレスポンスは200',
    '',
    '次の作業に進みます',
  ].join('\n');

  assert.equal(sanitizeMobilePreviewText(input), input);
});

test('sanitizeMobilePreviewText: 半角カナと全角英数だけの本文行は残す', () => {
  const sanitizeMobilePreviewText = loadSanitizeMobilePreviewText();
  const input = [
    'ﾆﾎﾝｺﾞ',
    '２０２０',
    'ＡＢＣ',
    'ａｂｃ',
  ].join('\n');

  assert.equal(sanitizeMobilePreviewText(input), input);
});

test('mobile preview: CR で再描画された日本語行を途中改行として残さない', () => {
  const sanitizeMobilePreviewText = loadSanitizeMobilePreviewText();
  const redraw = [
    'ペイン',
    'ペインの',
    'ペインのリンク付き',
    'ペインのリンク付きの部分、B',
  ].join('\r');

  const preview = sanitizeMobilePreviewText(stripAnsiForDisplay(redraw))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  assert.equal(preview, 'ペインのリンク付きの部分、B');
});

test('mobile stripAnsi: 生の CR 再描画を途中改行として残さない', () => {
  const sanitizeMobilePreviewText = loadSanitizeMobilePreviewText();
  const stripAnsi = loadMobileStripAnsi();
  const redraw = [
    'ペイン',
    'ペインの',
    'ペインのリンク付き',
    'ペインのリンク付きの部分、B',
  ].join('\r');

  const preview = sanitizeMobilePreviewText(stripAnsi(redraw))
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  assert.equal(preview, 'ペインのリンク付きの部分、B');
});

test('stripAnsiForDisplay: CR は現在行を部分上書きする', () => {
  assert.equal(stripAnsiForDisplay('abc\rXY'), 'XYc');
});

test('mobile stripAnsi: CR は現在行を部分上書きする', () => {
  const stripAnsi = loadMobileStripAnsi();

  assert.equal(stripAnsi('abc\rXY'), 'XYc');
});

test('stripAnsiForDisplay: erase-in-line CSI を CR 再描画に反映する', () => {
  assert.equal(stripAnsiForDisplay('経過 120秒 5000トークン\r\x1b[2K経過 5秒'), '経過 5秒');
  assert.equal(stripAnsiForDisplay('abcdef\rXY\x1b[K'), 'XY');
  assert.equal(stripAnsiForDisplay('abcdef\rXY\x1b[0K'), 'XY');
  assert.equal(stripAnsiForDisplay('abcdef\rXY\x1b[1K'), '  cdef');
  assert.equal(stripAnsiForDisplay('abc\rXY'), 'XYc');
  assert.equal(
    stripAnsiForDisplay(['ペイン', 'ペインの', 'ペインのリンク付き', 'ペインのリンク付きの部分、B'].join('\r')),
    'ペインのリンク付きの部分、B'
  );
  assert.equal(stripAnsiForDisplay('\x1b[31mred\x1b[0m'), 'red');
});

test('mobile stripAnsi: erase-in-line CSI を CR 再描画に反映する', () => {
  const stripAnsi = loadMobileStripAnsi();

  assert.equal(stripAnsi('経過 120秒 5000トークン\r\x1b[2K経過 5秒'), '経過 5秒');
  assert.equal(stripAnsi('abcdef\rXY\x1b[K'), 'XY');
  assert.equal(stripAnsi('abcdef\rXY\x1b[0K'), 'XY');
  assert.equal(stripAnsi('abcdef\rXY\x1b[1K'), '  cdef');
  assert.equal(stripAnsi('abc\rXY'), 'XYc');
  assert.equal(
    stripAnsi(['ペイン', 'ペインの', 'ペインのリンク付き', 'ペインのリンク付きの部分、B'].join('\r')),
    'ペインのリンク付きの部分、B'
  );
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m'), 'red');
});

test('stripAnsiForDisplay: Claude Code 風の CSI 位置指定再描画を複数行として復元する', () => {
  assert.equal(
    stripAnsiForDisplay(buildClaudeCodeCsiRedrawFrame()),
    [
      '実装内容を確認しています',
      '- renderer/mobile.html のモバイルプレビューを調査',
      '- sanitize の処理順と CSS 高さを確認',
      '- 直近の本文出力を最低10行見えるように修正',
      'npm test を実行して回帰を確認します',
      '変更後は本文行が消えないことを検証します',
      '',
      '╭────────────────────────────╮',
      '│ > 1. Yes                    │',
      '╰────────────────────────────╯',
    ].join('\n')
  );
});

test('stripAnsiForDisplay: 巨大な CSI カーソル移動でも行数と列幅を上限内に収める', () => {
  assertBoundedDisplayControls('stripAnsiForDisplay', stripAnsiForDisplay);
});

test('mobile stripAnsi: 巨大な CSI カーソル移動でも行数と列幅を上限内に収める', () => {
  const stripAnsi = loadMobileStripAnsi();

  assertBoundedDisplayControls('mobile stripAnsi', stripAnsi);
});

test('mobile preview: Claude Code 風の CSI 位置指定再描画でも直近本文行を残す', () => {
  const sanitizeMobilePreviewText = loadSanitizeMobilePreviewText();
  const stripAnsi = loadMobileStripAnsi();
  const preview = tailString(
    sanitizeMobilePreviewText(stripAnsi(buildClaudeCodeCsiRedrawFrame()))
      .replace(/\n{3,}/g, '\n\n')
      .trim(),
    4000
  );

  assert.match(preview, /renderer\/mobile\.html のモバイルプレビューを調査/);
  assert.match(preview, /直近の本文出力を最低10行見えるように修正/);
  assert.match(preview, /変更後は本文行が消えないことを検証します/);
  assert.ok(preview.split('\n').filter((line) => line.trim()).length >= 6);
});

test('mobile preview: PTY イベントをまたぐ CR 再描画も同一行として扱う', () => {
  const sanitizeMobilePreviewText = loadSanitizeMobilePreviewText();
  const lastLines = appendAnsiForDisplay(
    stripAnsiForDisplay('ペイン'),
    '\rペインのリンク付きの部分、B'
  );

  const preview = sanitizeMobilePreviewText(lastLines)
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  assert.equal(preview, 'ペインのリンク付きの部分、B');
});

test('appendAnsiForDisplay: PTY イベントをまたぐ CR は既存行を部分上書きする', () => {
  assert.equal(appendAnsiForDisplay(stripAnsiForDisplay('abc'), '\rXY'), 'XYc');
});
