const net = require('net');
const { test, expect } = require('@playwright/test');
const {
  closeApp,
  getFreePort,
  launchAppAndWait,
} = require('./helpers/electron-app');

async function openApiServerStatus(win) {
  await win.evaluate(() => window.openSettingsModal());
  await win.waitForSelector('.settings-modal', { state: 'visible' });
  // 「外出先から確認」タブを開き、実行時データが差し込まれた status ブロックを見る。
  await win.locator('#settings-tab-1').click();
  return win.locator('#settings-panel-1 [data-status-source="apiServer"]');
}

async function listenOn(port) {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

async function closeServer(server) {
  if (!server) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test('127.0.0.1 で実際に待ち受けているアドレスを表示する', async () => {
  const port = await getFreePort();
  let launched;
  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-api-status-listening-',
      env: { VK_TERMINALS_APP_TITLE: '', VK_TERMINALS_SETTINGS: '' },
    });

    const status = await openApiServerStatus(launched.win);
    await expect(status).toHaveAttribute('data-tone', 'info');
    await expect(status.locator('.settings-content-status-label')).toHaveText('補足');
    await expect(status.locator('.settings-content-code code'))
      .toHaveText(`http://127.0.0.1:${port}/`);
    await expect(status).toContainText('このパソコンからのみ開けます');

    // 実クリップボードは汚さず、#266 と同じ Electron clipboard.writeText 経路へ
    // 画面に出ている URL がそのまま渡ることを確認する。
    await launched.win.evaluate(() => {
      const { clipboard } = require('electron');
      window.__apiStatusOriginalWriteText = clipboard.writeText;
      window.__apiStatusWritten = [];
      clipboard.writeText = (text) => window.__apiStatusWritten.push(text);
    });
    await status.locator('.settings-content-copy').click();
    await expect(status.locator('.settings-content-copy-status')).toHaveText('コピーしました');
    expect(await launched.win.evaluate(() => window.__apiStatusWritten)).toEqual([
      `http://127.0.0.1:${port}/`,
    ]);
    await launched.win.evaluate(() => {
      const { clipboard } = require('electron');
      clipboard.writeText = window.__apiStatusOriginalWriteText;
      delete window.__apiStatusOriginalWriteText;
      delete window.__apiStatusWritten;
    });
  } finally {
    if (launched) await closeApp(launched);
  }
});

test('ポートが使用中なら API サーバーが起動していないエラーを表示する', async () => {
  const port = await getFreePort();
  let blocker;
  let launched;
  try {
    // Electron より先に同じアドレスとポートを確保し、EADDRINUSE を決定論的に発生させる。
    blocker = await listenOn(port);
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-api-status-in-use-',
      env: { VK_TERMINALS_APP_TITLE: '', VK_TERMINALS_SETTINGS: '' },
    });

    const status = await openApiServerStatus(launched.win);
    await expect(status).toHaveAttribute('data-tone', 'error');
    await expect(status.locator('.settings-content-status-label')).toHaveText('エラー');
    await expect(status).toContainText(`ポート ${port} が他のプログラムに使われている`);
    await expect(status).toContainText('API サーバーが起動していません');
    // 起動していない状態ではコピー可能なアドレスを提示しない。
    await expect(status.locator('.settings-content-copy')).toHaveCount(0);
  } finally {
    if (launched) await closeApp(launched);
    if (blocker) await closeServer(blocker);
  }
});
