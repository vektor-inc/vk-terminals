'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODE_FORMAT, buildInputModeSequence } = require('../utils/paneHolderRestore');
test('tmux 入力モードを端末制御シーケンスへ変換する', () => {
  assert.match(MODE_FORMAT, /bracketed_paste_flag/);
  const result = buildInputModeSequence('1 1 1 1 0 0 9 4');
  assert.match(result, /\x1b\[\?2004h/);
  assert.match(result, /\x1b\[\?1h/);
  assert.match(result, /\x1b=/);
  assert.match(result, /\x1b\[\?1006h/);
  assert.match(result, /\x1b\[\?1049l/);
  assert.match(result, /\x1b\[5;10H/);
  assert.throws(() => buildInputModeSequence('1 0 malformed'));
});
