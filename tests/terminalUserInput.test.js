'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { containsUserTerminalInput } = require('../utils/terminalUserInput');

test('端末の自動応答・通知だけなら利用者入力として扱わない', () => {
  const automaticInputs = [
    '\x1b[12;34R',
    '\x1b[?12;34R',
    '\x1b[?1;2c',
    '\x1b[>0;163;0c',
    '\x1b[=1;2c',
    '\x1b[?0u',
    '\x1b[I\x1b[O',
    '\x1b[<0;10;20M\x1b[<0;10;20m',
    '\x1b[M' + String.fromCharCode(32, 42, 52),
    '\x1b]10;rgb:ffff/ffff/ffff\x07',
    '\x1b]11;rgb:0000/0000/0000\x1b\\',
  ];

  for (const input of automaticInputs) {
    assert.equal(containsUserTerminalInput(input), false, JSON.stringify(input));
  }
  assert.equal(containsUserTerminalInput(automaticInputs.join('')), false);
});

test('矢印キー・通常文字・Enter は利用者入力として扱う', () => {
  for (const input of ['\x1b[A', 'a', '\r']) {
    assert.equal(containsUserTerminalInput(input), true, JSON.stringify(input));
  }
});

test('端末の自動応答と通常文字が混在した入力は利用者入力として扱う', () => {
  assert.equal(containsUserTerminalInput('\x1b[1;1Rhello\x1b]10;rgb:ffff/ffff/ffff\x07'), true);
});
