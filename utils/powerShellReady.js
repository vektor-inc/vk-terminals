const { containsUserTerminalInput } = require('./terminalUserInput');
const { classifyShell } = require('./shellQuoting');

/** PowerShell の最初の入力受付を待ち、終了・時間切れでも監視を解放する。 */
function observePowerShellReady(ptyProcess, shell, { platform = process.platform, timeoutMs = 10000, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (platform === 'win32' || classifyShell(shell) !== 'powershell') return null;
  let acceptInput = () => {};
  let userInput = false;
  const ready = new Promise((resolve) => {
    let buffer = '';
    let finished = false;
    const subscriptions = [];
    let timer;
    const finish = (status) => {
      if (finished) return;
      finished = true;
      clearTimer(timer);
      for (const subscription of subscriptions) subscription.dispose();
      acceptInput = () => {};
      resolve({ status, userInput });
    };
    // 分割された制御シーケンスもまとめてから除き、起動バナーだけでは送信しない。
    subscriptions.push(ptyProcess.onData((data) => {
      buffer = (buffer + data).slice(-8192);
      const text = buffer.replace(/\x1b\][^\x07]*?(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[ -/]*[0-~]/g, '');
      // 後続出力でプロンプトではなくなったら、古い一致を破棄する。
      acceptInput = /(?:^|[\r\n])PS [^\r\n]*> ?$/.test(text)
        ? (input) => { if (/\x1b\[\d+;\d+R/.test(input)) finish('ready'); }
        : () => {};
    }));
    subscriptions.push(ptyProcess.onExit(() => finish('exit')));
    // プロンプトを変更した環境でも永久に起動待ちにしない。
    timer = setTimer(() => finish('timeout'), timeoutMs);
  });
  return { ready, onInput: (data) => {
    if (containsUserTerminalInput(data)) userInput = true;
    acceptInput(data);
  } };
}

module.exports = { observePowerShellReady };
