'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  containsReplyDismissInput,
  detectReplyText,
  extractLatestReplyText,
  isReplyCopyShortcut,
  stripInvisibleControlCharacters,
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

test('Ink が字下げして折り返した長い日本語本文は表示幅から判定して連結する', () => {
  const buffer = bufferOf([
    { text: '  [ユーザー返信用]' },
    { text: '  これは画面の右端近くまで続いている長い日本語の返信文で' },
    { text: '    す。続きも正しくコピーします。' },
    { text: '' },
  ]);
  assert.equal(
    detectReplyText(buffer, 200, 40),
    '[ユーザー返信用]\nこれは画面の右端近くまで続いている長い日本語の返信文です。続きも正しくコピーします。',
  );
});

test('右端まで埋まった案内文を返信 marker に連結しない', () => {
  const buffer = bufferOf([
    { text: '以下はユーザーが操作後に送る返信文です。確認してそのまま使えます。' },
    { text: '  [ユーザー返信用]' },
    { text: '  内容を確認しました。' },
    { text: '' },
  ]);
  assert.equal(
    detectReplyText(buffer, 200, 40),
    '[ユーザー返信用]\n内容を確認しました。',
  );
});

test('3 物理行の段落だけを連結し、短い次段落との改行を残す', () => {
  const buffer = bufferOf([
    { text: '  [ユーザー返信用]' },
    { text: '  これは画面の右端近くまで続く一つ目の長い段落であり、' },
    { text: '    さらに画面の右端近くまで文章が続いて最後の行へと' },
    { text: '    折り返します。' },
    { text: '  短い二つ目の段落です。' },
    { text: '' },
  ]);
  assert.equal(
    detectReplyText(buffer, 200, 40),
    '[ユーザー返信用]\nこれは画面の右端近くまで続く一つ目の長い段落であり、さらに画面の右端近くまで文章が続いて最後の行へと折り返します。\n短い二つ目の段落です。',
  );
});

test('返信直後の非空の終端行を本文に連結しない', () => {
  const buffer = bufferOf([
    { text: '  [ユーザー返信用]' },
    { text: '  これは画面の右端近くまで続いている長い返信本文です。' },
    { text: '⏺ 次の処理を開始します。' },
  ]);
  assert.equal(
    detectReplyText(buffer, 200, 40),
    '[ユーザー返信用]\nこれは画面の右端近くまで続いている長い返信本文です。',
  );
});

test('Ink が英単語の境界で折り返した本文は空白を補って連結する', () => {
  const buffer = bufferOf([
    { text: '  [ユーザー返信用]' },
    { text: '  Please release the updated vk-terminals' },
    { text: '    package after all checks pass.' },
    { text: '' },
  ]);
  assert.equal(
    detectReplyText(buffer, 200, 40),
    '[ユーザー返信用]\nPlease release the updated vk-terminals package after all checks pass.',
  );
});

test('前の行に次の語が収まる本来の複数行は改行を残す', () => {
  const buffer = bufferOf([
    { text: '  [ユーザー返信用]' },
    { text: '  Short first line.' },
    { text: '  Second line.' },
    { text: '' },
  ]);
  assert.equal(
    detectReplyText(buffer, 200, 40),
    '[ユーザー返信用]\nShort first line.\nSecond line.',
  );
});

test('混入した罫線文字だけを除き通常のハイフンは残す', () => {
  assert.equal(extractLatestReplyText([
    '[ユーザー返信用]',
    '──vk-terminals─と──vk-agents─をリリースしました。#748───────────を進めてください。',
    '────',
  ]), '[ユーザー返信用]\nvk-terminals と vk-agents をリリースしました。#748 を進めてください。');
});

test('罫線が混ざった再描画もきれいな表示も同じ返信文として検出する', () => {
  const dirty = bufferOf([
    { text: '[ユーザー返信用]' },
    { text: '──vk-terminals─と──vk-agents─をリリースしました。#748───────────を進めてください。' },
    { text: '────' },
  ]);
  const clean = bufferOf([
    { text: '[ユーザー返信用]' },
    { text: 'vk-terminals と vk-agents をリリースしました。#748 を進めてください。' },
    { text: '' },
  ]);
  assert.equal(detectReplyText(dirty, 200), detectReplyText(clean, 200));
});

test('終わりの目印が無い出力途中は未確定にする', () => {
  assert.equal(extractLatestReplyText(['[ユーザー返信用]', '本文']), null);
});

test('最新の返信文が出力途中なら確定済みの古い返信文を返さない', () => {
  assert.equal(extractLatestReplyText([
    '[ユーザー返信用]', '古い', '',
    '[ユーザー返信用]', '新しい出力途中',
  ]), null);
});

test('本文の tree 罫線と字下げを除き、内容だけを残す', () => {
  assert.equal(extractLatestReplyText([
    '[ユーザー返信用]',
    '├── src',
    '│   └── app.js',
    '',
  ]), '[ユーザー返信用]\nsrc\napp.js');
});

test('コピー対象から改行以外の見えない制御文字を除く', () => {
  assert.equal(
    stripInvisibleControlCharacters('[ユーザー返信用]\n返\u0007信\u061c\u200b\u200f\u202a\u202e\u2060\u2066\u2069\ufeff文'),
    '[ユーザー返信用]\n返信文',
  );
  assert.equal(extractLatestReplyText([
    '[ユーザー返信用]', '返\u0007信\u200b文', '',
  ]), '[ユーザー返信用]\n返信文');
});

test('入力文字または物理キーと修飾キーでコピー操作を判定する', () => {
  assert.equal(isReplyCopyShortcut({
    key: 'Ç', code: 'KeyC', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
  }), true);
  assert.equal(isReplyCopyShortcut({
    key: 'C', code: 'KeyJ', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
  }), true);
  assert.equal(isReplyCopyShortcut({
    key: 'v', code: 'KeyV', altKey: true, shiftKey: true, ctrlKey: false, metaKey: false,
  }), false);
  assert.equal(isReplyCopyShortcut({
    key: 'c', code: 'KeyC', altKey: false, shiftKey: true, ctrlKey: false, metaKey: false,
  }), false);
  assert.equal(isReplyCopyShortcut({
    key: 'c', code: 'KeyC', altKey: true, shiftKey: true, ctrlKey: true, metaKey: false,
  }), false);
  assert.equal(isReplyCopyShortcut({
    key: 'Ç', code: 'KeyC', altKey: true, shiftKey: true, ctrlKey: false, metaKey: true,
  }), false);
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
  assert.equal(containsReplyDismissInput('\t'), false);
  assert.equal(containsReplyDismissInput('\x1b[200~text\x1b[201~'), true);
  assert.equal(containsReplyDismissInput('\x1b[I'), false);
  assert.equal(containsReplyDismissInput('\x1b[A'), false);
  assert.equal(containsReplyDismissInput('\x1b[12;34R'), false);
});
