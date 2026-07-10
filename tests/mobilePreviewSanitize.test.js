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
