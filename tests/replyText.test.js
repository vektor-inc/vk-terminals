'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  containsReplyDismissInput,
  detectReplyText,
  extractLatestReplyText,
} = require('../renderer/replyText');

function bufferOf(rows) {
  return {
    length: rows.length,
    getLine(index) {
      const row = rows[index];
      return row && {
        isWrapped: !!row.wrapped,
        translateToString: () => row.text,
      };
    },
  };
}

test('字下げ付きの marker と本文を字下げなしで取り出す', () => {
  assert.equal(extractLatestReplyText([
    '  [ユーザー返信用]',
    '  #748 を進めてください。',
    '',
  ]), '[ユーザー返信用]\n#748 を進めてください。');
});

test('画面幅で折り返した本文は改行なしで連結する', () => {
  const buffer = bufferOf([
    { text: '  [ユーザー返信用]' },
    { text: '  vk-terminals と ' },
    { text: 'vk-agents をリリースしました。', wrapped: true },
    { text: '' },
  ]);
  assert.equal(detectReplyText(buffer, 200), '[ユーザー返信用]\nvk-terminals と vk-agents をリリースしました。');
});

test('混入した罫線文字だけを除き通常のハイフンは残す', () => {
  assert.equal(extractLatestReplyText([
    '[ユーザー返信用]',
    '──vk-terminals─と──vk-agents─をリリースしました。#748───────────を進めてください。',
    '────',
  ]), '[ユーザー返信用]\nvk-terminalsとvk-agentsをリリースしました。#748を進めてください。');
});

test('終わりの目印が無い出力途中は未確定にする', () => {
  assert.equal(extractLatestReplyText(['[ユーザー返信用]', '本文']), null);
});

test('複数の返信文から最新のものを採る', () => {
  assert.equal(extractLatestReplyText([
    '[ユーザー返信用]', '古い', '',
    '[ユーザー返信用]', '新しい', '',
  ]), '[ユーザー返信用]\n新しい');
});

test('返信文が無いときは null', () => {
  assert.equal(extractLatestReplyText(['通常の出力', '']), null);
});

test('本来の複数行の改行は残す', () => {
  assert.equal(extractLatestReplyText([
    '  [ユーザー返信用]', '  1 行目', '  2 行目', '',
  ]), '[ユーザー返信用]\n1 行目\n2 行目');
});

test('返信バーは本文・改行・貼り付けで閉じ、自動応答と移動キーでは閉じない', () => {
  assert.equal(containsReplyDismissInput('a'), true);
  assert.equal(containsReplyDismissInput('\r'), true);
  assert.equal(containsReplyDismissInput('\x1b[200~text\x1b[201~'), true);
  assert.equal(containsReplyDismissInput('\x1b[I'), false);
  assert.equal(containsReplyDismissInput('\x1b[A'), false);
  assert.equal(containsReplyDismissInput('\x1b[12;34R'), false);
});
