'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { applyDisplayControls } = require('../renderer/terminalDisplay');
const { applyCarriageReturns, stripAnsi } = require('../renderer/mobilePreviewText');
const { appendAnsiForDisplay, stripAnsiForDisplay } = require('../utils/stripAnsi');

const DISPLAY_CASES = [
  ['plain', 'hello'],
  ['cr overwrite', 'abcdef\rXY'],
  ['crlf newline', 'first\r\nsecond'],
  ['erase line', 'abcdef\rXY\x1b[K'],
  ['erase whole line', '経過 120秒 5000トークン\r\x1b[2K経過 5秒'],
  ['cursor absolute', '\x1b[2;4Htwo-four\x1b[1;1Htop'],
  ['cursor relative', 'abc\x1b[2DXY'],
  ['osc removal', '\x1b]0;title\x07body'],
  ['single esc removal', '\x1b7saved'],
  ['control char removal', 'a\x00b\x08c'],
];

test('terminal display: app 版と mobile 版は同一入力で同一出力を返す', () => {
  for (const [label, input] of DISPLAY_CASES) {
    const shared = applyDisplayControls(input);
    assert.equal(stripAnsiForDisplay(input), shared, `${label}: stripAnsiForDisplay`);
    assert.equal(applyCarriageReturns(input), shared, `${label}: applyCarriageReturns`);
    assert.equal(stripAnsi(input), shared, `${label}: mobile stripAnsi`);
  }
});

test('appendAnsiForDisplay: 共有表示処理でバッファと追加入力を再評価する', () => {
  assert.equal(appendAnsiForDisplay(stripAnsiForDisplay('abc'), '\rXY'), 'XYc');
});
