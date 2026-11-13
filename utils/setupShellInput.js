'use strict';
const { containsUserTerminalInput } = require('./terminalUserInput');

// シェルの入力受付を出力から確認し、コマンドを一度だけ入力する。時間切れの盲打ちはしない。
function createSetupShellInput(command, write, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let output = '';
  let bracketedPaste = false;
  let done = false;
  let timer = null;
  return {
    onData(data) {
      if (done) return;
      if (data.includes('\x1b[?2004h')) bracketedPaste = true;
      if (data.includes('\x1b[?2004l')) bracketedPaste = false;
      output = (output + data).slice(-4096);
      const visible = output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      const lastLine = visible.split(/[\r\n]/).at(-1);
      if (timer) clearTimer(timer);
      if (!/(?:[%$#>❯➜λ] ?)$/.test(lastLine)) return;
      // 出力が静まった後にだけ貼り付ける。入力後の Enter は利用者に委ねる。
      timer = setTimer(() => {
        if (done) return;
        done = true;
        // ブラケット貼り付け未対応時は quote-next でタブ補完を抑える。
        write(bracketedPaste ? `\x1b[200~${command}\x1b[201~` : command.replace(/\t/g, '\x16\t'));
      }, 150);
    },
    onInput(data) { if (!done && containsUserTerminalInput(data)) this.dispose(); },
    dispose() { done = true; if (timer) clearTimer(timer); },
  };
}

module.exports = { createSetupShellInput };
