const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

test('更新確認の通信が遅くても初期描画直後の HTTP API に接続できる（issue #546）', async () => {
  const port = await getFreePort();
  const markerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-update-delay-'));
  const markerPath = path.join(markerDir, 'started');
  let launched;
  try {
    // どの GitHub origin 表記でも、置換後の URL 部分をシェルのコメントにして 8 秒待たせる。
    const delayedGit = 'ext::sh -c touch% "$VK_TEST_DELAY_MARKER";% sleep% 8% #';
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-api-before-update-',
      unsetEnv: ['GIT_ALLOW_PROTOCOL'],
      env: {
        VK_TEST_DELAY_MARKER: markerPath,
        GIT_CONFIG_COUNT: '4',
        GIT_CONFIG_KEY_0: 'url.' + delayedGit + '.insteadOf',
        GIT_CONFIG_VALUE_0: 'https://github.com/',
        GIT_CONFIG_KEY_1: 'url.' + delayedGit + '.insteadOf',
        GIT_CONFIG_VALUE_1: 'git@github.com:',
        GIT_CONFIG_KEY_2: 'url.' + delayedGit + '.insteadOf',
        GIT_CONFIG_VALUE_2: 'ssh://git@github.com/',
        // 遅延用シェルを実行するため、既定では禁止されている ext トランスポートを許可する。
        GIT_CONFIG_KEY_3: 'protocol.ext.allow',
        GIT_CONFIG_VALUE_3: 'always',
      },
    });

    // ヘルパーが #sidebar を確認した直後の最初の接続だけで判定する。
    const response = await fetch(`http://127.0.0.1:${port}/api/health`);
    expect(response.status).toBe(200);
    expect((await response.json()).ok).toBe(true);

    // URL 置換や Git の設定が効かず、遅延なしで成功するケースを検出する。
    await expect.poll(() => fs.existsSync(markerPath), {
      message: '更新確認の遅延コマンドが実行されていません。origin の URL 置換と Git のプロトコル設定を確認してください。',
    }).toBe(true);
  } finally {
    try {
      await closeApp(launched || {});
    } finally {
      fs.rmSync(markerDir, { recursive: true, force: true });
    }
  }
});
