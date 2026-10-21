'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { containsUserTerminalInput } = require('../utils/terminalUserInput');

test('端末の自動応答・通知だけなら利用者入力として扱わない', () => {
  const automaticInputs = [
    '\x1b[12;34R',
    '\x1b[?12;34R',
    '\x1b[?2026;2$y',
    '\x1b[0n',
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

test('キー操作・通常文字・貼り付けは利用者入力として扱う', () => {
  const userInputs = [
    '\x1b[A',
    'a',
    '\r',
    '\x03',
    '\x1b',
    '\x1bOA',
    '\x1b[Z',
    '\x1b[200~hello\x1b[201~',
    '\x1b[Mabcdef',
  ];

  for (const input of userInputs) {
    assert.equal(containsUserTerminalInput(input), true, JSON.stringify(input));
  }
});

test('端末の自動応答と通常文字が混在した入力は利用者入力として扱う', () => {
  assert.equal(containsUserTerminalInput('\x1b[1;1Rhello\x1b]10;rgb:ffff/ffff/ffff\x07'), true);
});
