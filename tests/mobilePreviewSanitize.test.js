'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const assert = require('node:assert/strict');

function loadSanitizeMobilePreviewText() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'mobile.html'), 'utf8');
  const match = html.match(/\/\/ Claude Code[\s\S]*?\nfunction tail/);
  assert.ok(match, 'sanitizeMobilePreviewText の定義を renderer/mobile.html から抽出できる');

  const context = {};
  vm.runInNewContext(match[0].replace(/\nfunction tail$/, ''), context);
  return context.sanitizeMobilePreviewText;
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
