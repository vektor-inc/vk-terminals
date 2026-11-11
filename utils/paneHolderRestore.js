'use strict';

// tmux の表示形式は空白を含まない数値とフラグだけを並べる。
const MODE_FORMAT = '#{bracketed_paste_flag} #{keypad_cursor_flag} #{keypad_flag} #{mouse_any_flag} #{alternate_on} #{pane_key_mode} #{cursor_x} #{cursor_y}';

function buildInputModeSequence(formatOutput) {
  const parts = String(formatOutput).trim().split(/\s+/);
  if (parts.length !== 8 || parts.slice(0, 6).some(value => !/^(?:0|1)$/.test(value)) || parts.slice(6).some(value => !/^\d+$/.test(value))) {
    throw new Error('invalid tmux input mode');
  }
  const [paste, cursor, keypad, mouse, alternate, keyMode, x, y] = parts.map(Number);
  const sequences = [
    `\x1b[?2004${paste ? 'h' : 'l'}`,
    `\x1b[?1${cursor ? 'h' : 'l'}`,
    keypad ? '\x1b=' : '\x1b>',
    `\x1b[?1000${mouse ? 'h' : 'l'}`,
    `\x1b[?1006${mouse ? 'h' : 'l'}`,
    `\x1b[?1049${alternate ? 'h' : 'l'}`,
    `\x1b[${Math.min(y + 1, 10000)};${Math.min(x + 1, 10000)}H`,
  ];
  // copy mode 中のペインにもキー送信は再開後の制御状態を優先する。
  void keyMode;
  return sequences.join('');
}

module.exports = { MODE_FORMAT, buildInputModeSequence };
