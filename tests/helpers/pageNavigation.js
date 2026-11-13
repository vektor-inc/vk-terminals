'use strict';

async function prepareLoadingPageNavigation(contents, trigger) {
  // 式は固定の二択。安定した /source 上でだけ評価し、ロード開始前に待ち終える。
  const expressions = {
    link: 'document.getElementById("link").click()',
    'location.replace': 'location.replace("/destination")',
  };
  if (!Object.hasOwn(expressions, trigger)) throw new Error('Unknown navigation trigger');
  await contents.executeJavaScript(`
    window.addEventListener('keydown', function navigateOnce(event) {
      if (event.code !== 'F8') return;
      event.preventDefault();
      window.removeEventListener('keydown', navigateOnce, true);
      ${expressions[trigger]};
    }, true);
  `);
}

async function navigateFromLoadingPage(contents) {
  // Runtime.evaluate も executeJavaScript も Page.navigate 中は保留される。
  // 非表示ウィンドウでも renderer へ直接届く CDP 入力を使い、down/up を対にする。
  contents.focus();
  const key = { key: 'F8', code: 'F8', windowsVirtualKeyCode: 119 };
  try {
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...key });
  } finally {
    await contents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...key });
  }
}

module.exports = { prepareLoadingPageNavigation, navigateFromLoadingPage };
