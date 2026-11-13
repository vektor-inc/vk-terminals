'use strict';

async function navigateFromLoadingPage(contents, trigger) {
  const expression = trigger === 'link'
    ? 'document.getElementById("link").click()'
    : 'location.replace("/destination")';
  // executeJavaScript は did-stop-loading を待つため、保留中のロードを
  // 旧文書の操作で置換する場合は renderer で直ちに実行できる CDP を使う。
  const result = await contents.debugger.sendCommand('Runtime.evaluate', {
    expression, returnByValue: true, userGesture: true,
  });
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
}

module.exports = { navigateFromLoadingPage };
