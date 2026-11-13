'use strict';
const { containsUserTerminalInput } = require('./terminalUserInput');

// 入力受付を出力で確認して一度だけ入力する。検出できなければ30秒で監視を終える。
function createSetupShellInput(command, write, { setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  let output = '';
  let done = false;
  let quietTimer = null;
  const timeoutTimer = setTimer(() => dispose(), 30000);
  function dispose() {
    done = true;
    if (quietTimer !== null) clearTimer(quietTimer);
    clearTimer(timeoutTimer);
  }
  return {
    onData(data) {
      if (done) return;
      output = (output + data).slice(-4096);
      const enabledAt = output.lastIndexOf('\x1b[?2004h');
      const disabledAt = output.lastIndexOf('\x1b[?2004l');
      const bracketedPaste = enabledAt >= 0 && enabledAt > disabledAt;
      const visible = output.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
      const lastLine = visible.split(/[\r\n]/).at(-1);
      // 貼り付けモード開始を主シグナルとし、未対応シェルでは行末の記号を使う。
      const ready = bracketedPaste || (enabledAt < 0 && /(?:[%$#>❯➜λ](?:\s+[^\r\n]*)?)$/.test(lastLine));
      if (quietTimer !== null) clearTimer(quietTimer);
      quietTimer = null;
      if (!ready) return;
      quietTimer = setTimer(() => {
        if (done) return;
        dispose();
        write(bracketedPaste ? `\x1b[200~${command}\x1b[201~` : command);
      }, 150);
    },
    onInput(data) { if (!done && containsUserTerminalInput(data)) dispose(); },
    dispose,
  };
}

module.exports = { createSetupShellInput };
