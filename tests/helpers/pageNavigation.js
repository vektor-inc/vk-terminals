'use strict';

async function navigateFromLoadingPage(contents, trigger) {
  const expression = trigger === 'link'
    ? 'document.getElementById("link").click()'
    : 'location.replace("/destination")';
  // executeJavaScript は did-stop-loading を待つため CDP を使う。
  // 評価中に同期で遷移すると CDP 応答まで保留されるため、旧文書の
  // renderer タイマーへ操作を予約し、評価自体は遷移開始前に返す。
  const result = await contents.debugger.sendCommand('Runtime.evaluate', {
    expression: `void setTimeout(() => { ${expression}; }, 0)`,
    returnByValue: true, userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
}

module.exports = { navigateFromLoadingPage };
