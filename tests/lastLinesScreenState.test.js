// issue #413: /api/states の lastLines が、チャンク境界で切れた SGR の断片や、
// 同じ位置へ描き直される行の積み重なりで崩れないことを確かめる。
// renderer/app.js の appendWaitingBuffer と同じ手順（write → trim → text）を、
// 画面状態を保持する createDisplayScreen で再現する。
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDisplayScreen } = require('../utils/stripAnsi');

const MAX_LINES = 80;
const MAX_CHARS = 8000;

// app.js の appendWaitingBuffer と同じ形で複数チャンクを流し、最終的な lastLines を返す。
function feed(chunks) {
  const screen = createDisplayScreen();
  let text = '';
  for (const chunk of chunks) {
    screen.write(chunk);
    screen.trim(MAX_LINES, MAX_CHARS);
    text = screen.text();
  }
  return text;
}

const STATUS = '  ⏵⏵ bypass permissions on (shift+tab to cycle)';

// Claude Code の下部: 入力欄 / 罫線 / ステータス行。描画後カーソルは入力欄へ戻る。
const FRAME_FIRST = [
  '❯ hello', '\r\n',
  '\x1b[38;2;136;136;136m────────\x1b[39m', '\r\n',
  STATUS,
  '\x1b[2A\x1b[3G', // 入力欄の行へ 2 行戻る
].join('');

// 次の描き直し: 相対移動で 2 行下のステータス行へ行き、消して書き直す。
const FRAME_REDRAW = '\x1b[2B\r\x1b[2K' + STATUS + '\x1b[2A\x1b[3G';

test('チャンク境界で SGR が途切れても断片が文字として残らない', () => {
  assert.equal(feed(['abc \x1b[38;2;136;1', '36;136m───', ' end']), 'abc ─── end');
});

test('1 文字ずつ分割されて届いても同じ結果になる', () => {
  const whole = FRAME_FIRST + FRAME_REDRAW + FRAME_REDRAW;
  assert.equal(feed([...whole]), feed([whole]));
});

test('OSC・ESC 単体の末尾切れも次のチャンクへ持ち越す', () => {
  assert.equal(feed(['a\x1b]0;ti', 'tle\x07b']), 'ab');
  assert.equal(feed(['a\x1b', '[1mb']), 'ab');
});

test('カーソルを上へ戻したあとの描き直しが同じ行に当たり、ステータス行が積み重ならない', () => {
  const lines = feed([FRAME_FIRST, FRAME_REDRAW, FRAME_REDRAW, FRAME_REDRAW]).split('\n');
  assert.deepEqual(lines, ['❯ hello', '────────', STATUS]);
});

test('入力欄への追記が前の描画と混ざらない', () => {
  const chunks = [FRAME_FIRST, '\x1b[3Gworld', '\x1b[2B\r\x1b[2K' + STATUS + '\x1b[2A\x1b[10G'];
  assert.equal(feed(chunks).split('\n')[0], '❯ world');
});

test('末尾 N 行へ切り詰めても、カーソル行が一緒にずれて描き直しが同じ行に当たる', () => {
  const filler = Array.from({ length: 120 }, (_, i) => `line${i}`).join('\r\n') + '\r\n';
  const lines = feed([filler, FRAME_FIRST, FRAME_REDRAW, FRAME_REDRAW]).split('\n');
  assert.ok(lines.length <= MAX_LINES);
  assert.equal(lines.filter((l) => l === STATUS).length, 1);
  assert.equal(lines[lines.length - 1], STATUS);
});

test('文字数上限で切り詰めた後も、カーソル行が負にならず動作する', () => {
  const screen = createDisplayScreen();
  screen.write('x'.repeat(50) + '\r\n' + 'tail');
  screen.trim(80, 20);
  screen.write('\r\x1b[2K!');
  assert.equal(screen.text().split('\n').pop(), '!');
  screen.write('\x1b[10A\r\x1b[2K');
  screen.write('ok');
  assert.equal(screen.text().split('\n')[0], 'ok');
});

test('reset() で画面・カーソル・持ち越しを初期化する', () => {
  const screen = createDisplayScreen();
  screen.write('abc\r\ndef\x1b[3');
  screen.reset();
  screen.write('1mX');
  assert.equal(screen.text(), '1mX');
});
