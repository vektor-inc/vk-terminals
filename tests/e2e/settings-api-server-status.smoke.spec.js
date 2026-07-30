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
    });

    const status = await openApiServerStatus(launched.win);
    await expect(status).toHaveAttribute('data-tone', 'info');
    await expect(status.locator('.settings-content-status-label')).toHaveText('補足');
    await expect(status.locator('.settings-content-code code'))
      .toHaveText(`http://127.0.0.1:${port}/`);
    await expect(status).toContainText('このパソコンからのみ開けます');

    // 実クリップボードは汚さず、#266 と同じ Electron clipboard.writeText 経路へ
    // 画面に出ている URL がそのまま渡ることを確認する。
    // issue #268 で renderer から clipboard を直接触れなくなったため、実際に書き込む
    // main プロセス側（ipcMain.handle('clipboard:write-text')）でスタブする。
    await launched.app.evaluate(({ clipboard }) => {
      globalThis.__apiStatusOriginalWriteText = clipboard.writeText;
      globalThis.__apiStatusWritten = [];
      clipboard.writeText = (text) => globalThis.__apiStatusWritten.push(text);
    });
    await status.locator('.settings-content-copy').click();
    await expect(status.locator('.settings-content-copy-status')).toHaveText('コピーしました');
    expect(await launched.app.evaluate(() => globalThis.__apiStatusWritten)).toEqual([
      `http://127.0.0.1:${port}/`,
    ]);
    await launched.app.evaluate(({ clipboard }) => {
      clipboard.writeText = globalThis.__apiStatusOriginalWriteText;
      delete globalThis.__apiStatusOriginalWriteText;
      delete globalThis.__apiStatusWritten;
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
    });

    const status = await openApiServerStatus(launched.win);
    await expect(status).toHaveAttribute('data-tone', 'error');
    await expect(status.locator('.settings-content-status-label')).toHaveText('エラー');
    await expect(status).toContainText(
      `API サーバーが使うポート番号 ${port} を別のプログラムが使用している`
    );
    await expect(status).toContainText('起動時の設定値（環境変数）VK_TERMINALS_API_PORT');
    await expect(status).toContainText('別のポート番号を指定してから、vk-terminals を再起動');
    // 起動していない状態ではコピー可能なアドレスを提示しない。
    await expect(status.locator('.settings-content-copy')).toHaveCount(0);
  } finally {
    if (launched) await closeApp(launched);
    if (blocker) await closeServer(blocker);
  }
});

test('確認中の live region は器を保ったまま更新し、5 秒で確認打ち切りを案内する', async () => {
  const port = await getFreePort();
  let launched;
  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-api-status-pending-',
    });
    // settings:describe と状態の取り直しを pending に固定し、20 回上限へ到達させる。
    // 差し替え先は window.VKIpc（renderer 側の中継レイヤ／issue #268）。
    await launched.win.evaluate(() => {
      const vkIpc = window.VKIpc;
      const originalInvoke = vkIpc.invoke.bind(vkIpc);
      vkIpc.invoke = async (channel, ...args) => {
        if (channel === 'settings:api-server-status') return { phase: 'pending' };
        const result = await originalInvoke(channel, ...args);
        if (channel === 'settings:describe') {
          return { ...result, apiServerStatus: { phase: 'pending' } };
        }
        return result;
      };
    });

    const status = await openApiServerStatus(launched.win);
    const body = status.locator('.settings-content-status-body');
    await expect(body).toHaveAttribute('role', 'status');
    await expect(body).toHaveAttribute('aria-busy', 'true');
    await expect(body.locator('.settings-content-status-label')).toHaveText('確認中');
    await expect(body).toContainText('API サーバーの起動を確認しています');

    // body 自体が差し替わっていないことを、任意属性が残ることで固定する。
    await body.evaluate((element) => element.setAttribute('data-e2e-live-region', 'same'));
    await expect(body.locator('.settings-content-status-label'))
      .toHaveText('注意', { timeout: 7000 });
    await expect(body).toHaveAttribute('data-e2e-live-region', 'same');
    await expect(body).not.toHaveAttribute('aria-busy', 'true');
    await expect(body).toContainText('しばらくしてから設定パネルを開き直してください');
  } finally {
    if (launched) await closeApp(launched);
  }
});

test('API ホストのエラーから設定欄へ移動してフォーカスできる', async () => {
  const port = await getFreePort();
  let launched;
  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-api-status-host-error-',
    });
    await launched.win.evaluate(() => {
      const vkIpc = window.VKIpc;
      const originalInvoke = vkIpc.invoke.bind(vkIpc);
      vkIpc.invoke = async (channel, ...args) => {
        const result = await originalInvoke(channel, ...args);
        if (channel === 'settings:describe') {
          return {
            ...result,
            apiServerStatus: { phase: 'error', port: 13847, errorCode: 'EACCES' },
          };
        }
        return result;
      };
    });

    const status = await openApiServerStatus(launched.win);
    await expect(status).toContainText('API サーバーの起動に失敗しました');
    await expect(status).toContainText('「設定」タブの「API ホスト」');
    const link = status.locator('.settings-content-tablink');
    await expect(link).toHaveText('API ホストの設定へ移動');
    const spacing = await link.evaluate((element) => {
      const style = getComputedStyle(element);
      return { marginTop: style.marginTop, marginBottom: style.marginBottom };
    });
    expect(spacing).toEqual({ marginTop: '10px', marginBottom: '0px' });
    await link.click();
    await expect(launched.win.locator('#settings-tab-0')).toHaveAttribute('aria-selected', 'true');
    await expect(launched.win.getByLabel('API ホスト', { exact: true })).toBeFocused();
  } finally {
    if (launched) await closeApp(launched);
  }
});
