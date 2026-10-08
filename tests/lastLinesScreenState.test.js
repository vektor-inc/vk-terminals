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

test('文字数上限を少し超えただけなら、先頭行の先頭だけを削り確認文を残す', () => {
  const screen = createDisplayScreen();
  const confirm = 'ご確認をお願いします。';
  screen.write('a'.repeat(30) + '\r\n' + confirm);
  const max = confirm.length + 1 + 25; // 先頭行は 25 文字だけ残る
  screen.trim(80, max);
  assert.equal(screen.text(), 'a'.repeat(25) + '\n' + confirm);
});

// 上限（4096 文字）を超えて終端が来ない制御列を流し、続きが文字として混ざらないことを確かめる。
const BIG = 'x'.repeat(5000);

test('CSI の持ち越しが上限を超えても、終端までを読み捨てて後ろだけを通す', () => {
  const body = '1;'.repeat(2500);
  assert.equal(feed(['a\x1b[' + body, '1;2mnormal']), 'anormal');
  assert.equal(feed([...('a\x1b[' + body + 'mnormal')]), 'anormal');
});

test('OSC の持ち越しが上限を超えても、BEL まで読み捨てて後ろだけを通す', () => {
  assert.equal(feed(['a\x1b]0;' + BIG, 'continuation\x07normal']), 'anormal');
});

test('OSC の持ち越しが上限を超え、ESC と \\ が別チャンクに分かれても終端として扱う', () => {
  assert.equal(feed(['a\x1b]0;' + BIG + '\x1b', '\\normal']), 'anormal');
  assert.equal(feed(['a\x1b]0;' + BIG, 'mid\x1b', '\\normal']), 'anormal');
});

test('DCS の持ち越しが上限を超えても、終端まで読み捨てて後ろだけを通す', () => {
  assert.equal(feed(['a\x1bP' + BIG, 'continuation\x1b\\normal']), 'anormal');
});

test('reset() で読み捨て状態も初期化する', () => {
  const screen = createDisplayScreen();
  screen.write('\x1b]0;' + BIG);
  screen.reset();
  screen.write('plain');
  assert.equal(screen.text(), 'plain');
});

test('reset() で画面・カーソル・持ち越しを初期化する', () => {
  const screen = createDisplayScreen();
  screen.write('abc\r\ndef\x1b[3');
  screen.reset();
  screen.write('1mX');
  assert.equal(screen.text(), '1mX');
});

// e2e（lastlines-screen-state.smoke.spec.js）と同じシナリオ。
// 分割された SGR は、あとで消されない行（SPLITLINE）へ出し、
// 枠（罫線・入力行・罫線・ステータス行）の描き直しは入力行へ戻る形を繰り返す。
test('分割 SGR の行が完全一致で残り、枠の描き直しを繰り返してもステータス行は 1 行だけ', () => {
  const RULE = '────413';
  const chunks = [
    '\x1b[3',
    '1mSPLITLINE413\x1b[0m\r\n',
    `${RULE}\r\n❯ INPUT413\r\n${RULE}\r\nSTATUS413 v1\x1b[2A\r`,
    '\x1b[2B\r\x1b[2KSTATUS413 v2\x1b[2A\r',
    '\x1b[2B\r\x1b[2KSTATUS413 v3\x1b[2A\r',
    '\x1b[2B\r\x1b[2KSTATUS413 v4\x1b[2A\r',
    '\x1b[2B\r\nMARK413\r\n',
  ];
  const lines = feed(chunks).split('\n').map((l) => l.trimEnd());
  assert.deepEqual(lines, [
    'SPLITLINE413', RULE, '❯ INPUT413', RULE, 'STATUS413 v4', 'MARK413', '',
  ]);
});
