const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

test('更新確認の通信が遅くても初期描画直後の HTTP API に接続できる（issue #546）', async () => {
  const port = await getFreePort();
  let launched;
  try {
    // どの GitHub origin 表記でも、置換後の URL 部分をシェルのコメントにして 8 秒待たせる。
    const delayedGit = 'ext::sh -c sleep% 8% #';
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-api-before-update-',
      env: {
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_0: 'url.' + delayedGit + '.insteadOf',
        GIT_CONFIG_VALUE_0: 'https://github.com/',
        GIT_CONFIG_KEY_1: 'url.' + delayedGit + '.insteadOf',
        GIT_CONFIG_VALUE_1: 'git@github.com:',
        GIT_CONFIG_KEY_2: 'url.' + delayedGit + '.insteadOf',
        GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
        GIT_CONFIG_KEY_3: 'protocol.ext.allow',
        GIT_CONFIG_VALUE_3: 'always',
      },
    });

    // ヘルパーが #sidebar を確認した直後の最初の接続だけで判定する。
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);
  } finally {
    await closeApp(launched || {});
  }
});
