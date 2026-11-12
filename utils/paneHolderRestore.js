'use strict';

// pane_key_mode は空白を含むため最後に置く。
const MODE_FORMAT = '#{bracket_paste_flag} #{keypad_cursor_flag} #{keypad_flag} #{mouse_any_flag} #{mouse_button_flag} #{mouse_all_flag} #{mouse_sgr_flag} #{alternate_on} #{cursor_x} #{cursor_y} |#{pane_key_mode}';

function buildInputModeSequence(formatOutput) {
  const match = /^(\d) (\d) (\d) (\d) (\d) (\d) (\d) (\d) (\d+) (\d+) \|(.*)$/.exec(String(formatOutput).trim());
  if (!match || match.slice(1, 9).some(value => !/^[01]$/.test(value))) throw new Error('invalid tmux input mode');
  const [paste, cursor, keypad, mouseAny, mouseButton, mouseAll, mouseSgr, alternate, x, y] = match.slice(1, 11).map(Number);
  const keyMode = match[11].trim();
  if (keyMode && !['VT10x', 'Ext 1', 'Ext 2'].includes(keyMode)) throw new Error('invalid tmux key mode');
  const modes = [1000, 1002, 1003, 1006];
  const enabled = [mouseAny, mouseButton, mouseAll, mouseSgr];
  return [
    `\x1b[?2004${paste ? 'h' : 'l'}`,
    `\x1b[?1${cursor ? 'h' : 'l'}`,
    keypad ? '\x1b=' : '\x1b>',
    ...modes.map((mode, index) => `\x1b[?${mode}${enabled[index] ? 'h' : 'l'}`),
    keyMode === 'Ext 1' ? '\x1b[>4;1m' : keyMode === 'Ext 2' ? '\x1b[>4;2m' : '\x1b[>4m',
    `\x1b[?1049${alternate ? 'h' : 'l'}`,
    `\x1b[${Math.min(y + 1, 10000)};${Math.min(x + 1, 10000)}H`,
  ].join('');
}

module.exports = { MODE_FORMAT, buildInputModeSequence };
