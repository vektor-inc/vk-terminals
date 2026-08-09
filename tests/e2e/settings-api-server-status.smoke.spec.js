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
  // 「モバイルから確認」タブを開き、実行時データが差し込まれた status ブロックを見る。
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

// ポートが使用中（EADDRINUSE）のケースだけは、Electron の起動そのもの（API サーバーの
// bind 失敗）が検証対象のため、起動を他のテストと共有できない（起動後にブロッカーを
// 立てても、既に bind が済んだ後では意味がない）。このテストだけは独立起動を保つ。
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

// 残り 3 テストは「ポートが正常に空いている」という同じ起動条件で、差はいずれも
// window.VKIpc.invoke の差し替え（renderer 側の状態）だけなので、起動を 1 回に共有する。
// 各テストの前に win.reload() して #sidebar の再描画を待ち、直前のテストが差し替えた
// window.VKIpc.invoke を確実に素の実装へ戻す（差し替えはページの JS 実行コンテキストに
// 乗っているため、reload で読み込み直せば消える。localStorage 等の永続状態はこの spec の
// どのテストも書いていないので reload だけで十分）。
test.describe.serial('設定パネルの API サーバー状態表示（起動が正常な場合）', () => {
  let launched;
  let port;

  test.beforeAll(async () => {
    port = await getFreePort();
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-api-status-',
    });
  });

  test.afterAll(async () => {
    if (launched) await closeApp(launched);
  });

  test.beforeEach(async () => {
    await launched.win.reload();
    await launched.win.waitForSelector('#sidebar', { state: 'attached' });
  });

  test('127.0.0.1 で実際に待ち受けているアドレスを表示する', async () => {
    const { win } = launched;
    const status = await openApiServerStatus(win);
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
  });

  test('確認中の live region は器を保ったまま更新し、5 秒で確認打ち切りを案内する', async () => {
    const { win } = launched;
    // settings:describe と状態の取り直しを pending に固定し、20 回上限へ到達させる。
    // 差し替え先は window.VKIpc（renderer 側の中継レイヤ／issue #268）。
    await win.evaluate(() => {
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

    const startedAt = Date.now();
    const status = await openApiServerStatus(win);
    const body = status.locator('.settings-content-status-body');
    await expect(body).toHaveAttribute('role', 'status');
    await expect(body).toHaveAttribute('aria-busy', 'true');
    await expect(body.locator('.settings-content-status-label')).toHaveText('確認中');
    await expect(body).toContainText('API サーバーの起動を確認しています');

    // body 自体が差し替わっていないことを、任意属性が残ることで固定する。
    await body.evaluate((element) => element.setAttribute('data-e2e-live-region', 'same'));
    // 打ち切りは renderer 側の 250ms 間隔 setInterval を 20 回（想定 5000ms）重ねた時点で
    // 発火する。高負荷でイベントループが詰まると setInterval の間隔が遅れ、5000ms より
    // 大きく伸びることがある（#348 で確認した flaky の原因）。ここは「5 秒で打ち切る」
    // という仕様値自体は変えず、確認手段側の余裕だけを広げる（7000ms→15000ms）。
    await expect(body.locator('.settings-content-status-label'))
      .toHaveText('注意', { timeout: 15_000 });
    // 上限（15000ms）だけでは「即時に打ち切った」退行（5 秒のはずが 0 秒になる等）を
    // 検知できない（安藤のレビュー指摘）。打ち切りは 250ms × 20 回の setInterval なので
    // 遅れる方向にしかブレず、下限は決定論的に置ける。5000ms からの余裕として 4000ms を
    // 下限に置く。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(4_000);
    await expect(body).toHaveAttribute('data-e2e-live-region', 'same');
    await expect(body).not.toHaveAttribute('aria-busy', 'true');
    await expect(body).toContainText('しばらくしてから設定パネルを開き直してください');
  });

  test('API ホストのエラーから設定欄へ移動してフォーカスできる', async () => {
    const { win } = launched;
    await win.evaluate(() => {
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

    const status = await openApiServerStatus(win);
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
    await expect(win.locator('#settings-tab-0')).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByLabel('API ホスト', { exact: true })).toBeFocused();
  });
});
