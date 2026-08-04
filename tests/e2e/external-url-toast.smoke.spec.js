const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// ─── 外部ブラウザを開けなかったときのトースト（issue #326） ─────────────────────
//
// renderer/app.js の openExternalUrlSafe() は、以前は VKShell.openExternal(url) の
// 戻り値（成否の boolean）を捨てていた。main.js の ipcMain.handle('shell:open-external')
// は URL が http(s) でない場合と shell.openExternal が例外を投げた場合に false を
// 返すが、renderer 側はそれを無視して何も表示していなかった。
//
// ここでは shell.openExternal を main プロセス側で失敗させ（既存の「openExternal は
// http(s) 以外を開かない」テストと同じ手口）、#root に常設される汎用トーストが
// 正しい文言・role・aria 属性で表示されること、コピー操作で本文が差し替わること、
// フォーカスを奪わないこと、同時発生時に積み上がらないことを確認する。
//
// PR バッジ（.pane-task-title-pr）を発火点に選ぶ理由: openExternalUrlSafe() の
// 5 箇所の呼び出し元のうち、HTTP API（/api/set-title）だけで実 URL 付きの状態を
// 作れて他 spec（pr-badge-merged.smoke.spec.js）でも実績のある経路だから。

async function postSetTitle(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/set-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await response.json();
  } catch (_e) {
    /* 診断用。JSON でなくても呼び出し側の expect が拾う */
  }
  return { response, body };
}

async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await postSetTitle(port, { termId: '1', title: '' });
      if (result.response.status === 200) return;
      if (result.response.status !== 404) {
        throw new Error(`unexpected status ${result.response.status}: ${JSON.stringify(result.body)}`);
      }
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(result.body)}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('terminal 1 was not registered in time');
}

// shell.openExternal を main プロセス側で差し替える。失敗を再現するときは例外を
// 投げさせる（main.js の catch 節を通り、ipcMain.handle は false を返す）。
async function stubShellOpenExternal(app, { fail }) {
  await app.evaluate(({ shell }, shouldFail) => {
    if (!globalThis.__origOpenExternal) globalThis.__origOpenExternal = shell.openExternal;
    globalThis.__openExternalCalls = globalThis.__openExternalCalls || [];
    shell.openExternal = async (url) => {
      globalThis.__openExternalCalls.push(url);
      if (shouldFail) throw new Error('stubbed shell.openExternal failure');
      // 成功時も実際に OS のブラウザは開かせない（テスト環境で無関係なプロセスを起こさない）。
    };
  }, fail);
}
async function restoreShellOpenExternal(app) {
  await app.evaluate(({ shell }) => {
    if (!globalThis.__origOpenExternal) return;
    shell.openExternal = globalThis.__origOpenExternal;
    delete globalThis.__origOpenExternal;
    delete globalThis.__openExternalCalls;
  });
}

// クリップボードの成否は main プロセス側の clipboard.writeText を差し替えて制御する
// （settings-mobile-guide-tab.smoke.spec.js と同じ手口。renderer からは electron の
// clipboard を直接触れないため、実際に書き込むのは main の
// ipcMain.handle('clipboard:write-text')）。
async function stubClipboardWrite(app) {
  await app.evaluate(({ clipboard }) => {
    if (!globalThis.__origWriteText) globalThis.__origWriteText = clipboard.writeText;
    globalThis.__written = [];
    clipboard.writeText = (text) => { globalThis.__written.push(text); };
  });
}
async function stubClipboardFailure(app) {
  await app.evaluate(({ clipboard }) => {
    if (!globalThis.__origWriteText) globalThis.__origWriteText = clipboard.writeText;
    clipboard.writeText = () => { throw new Error('stubbed clipboard failure'); };
  });
}
async function restoreClipboardWrite(app) {
  await app.evaluate(({ clipboard }) => {
    if (!globalThis.__origWriteText) return;
    clipboard.writeText = globalThis.__origWriteText;
    delete globalThis.__origWriteText;
    delete globalThis.__written;
  });
}
const writtenTexts = (app) => app.evaluate(() => (globalThis.__written || []).slice());

test.describe.serial('外部ブラウザを開けなかったときのトースト（issue #326）', () => {
  let app;
  let win;
  let tmpRoot;
  let port;
  let prUrl;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp({
      port,
      prefix: 'vk-terminals-e2e-external-url-toast-',
    }));
    await waitForPtyRegistration(port);
    // ネットワークへ実際に出る必要はない（クリックしない）ため自サーバーの URL を使う
    // （pr-badge-merged.smoke.spec.js と同じ理由）。
    prUrl = `http://127.0.0.1:${port}/?pr=326`;
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test('ブラウザを開けたとき（成功時）はトーストを出さない', async () => {
    await stubShellOpenExternal(app, { fail: false });
    try {
      await postSetTitle(port, { termId: '1', title: 'issue #326 成功時', prUrl });
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await expect(prBadge).toBeVisible();
      await prBadge.click();

      // main まで実際に届いたことを確認したうえで、成功時は画面に何も出ないことを見る。
      await expect
        .poll(() => app.evaluate(() => (globalThis.__openExternalCalls || []).length))
        .toBeGreaterThan(0);
      await expect(win.locator('.vk-toast')).toHaveCount(0);
    } finally {
      await restoreShellOpenExternal(app);
    }
  });

  test('ブラウザを開けなかったとき（失敗時）はトーストで知らせ、フォーカスは奪わない', async () => {
    await stubShellOpenExternal(app, { fail: true });
    try {
      await postSetTitle(port, { termId: '1', title: 'issue #326 失敗時', prUrl });
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await expect(prBadge).toBeVisible();
      await prBadge.click();

      const toast = win.locator('.vk-toast');
      await expect(toast).toBeVisible();
      await expect(toast).toHaveAttribute('role', 'status');
      await expect(toast).toHaveAttribute('aria-live', 'polite');
      await expect(toast.locator('.vk-toast-message')).toHaveText('ブラウザを開けませんでした');

      const copyButton = toast.locator('.vk-toast-copy');
      await expect(copyButton).toBeVisible();
      // 可視ラベルの文言を aria-label の先頭に含める（WCAG 2.5.3 Label in Name）。
      await expect(copyButton).toHaveText('URLをコピー');
      await expect(copyButton).toHaveAttribute('aria-label', '開けなかったURLをコピー');

      // 出現時にフォーカスを奪わない。操作した要素（PR バッジ）にフォーカスが残る。
      const activeElementClass = await win.evaluate(() => document.activeElement?.className || '');
      expect(activeElementClass).toContain('pane-task-title-pr');
    } finally {
      await restoreShellOpenExternal(app);
    }
  });

  test('同時発生時は積み上げず、前のトーストを新しい内容で上書きする', async () => {
    await stubShellOpenExternal(app, { fail: true });
    try {
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await postSetTitle(port, { termId: '1', title: 'issue #326 積み上げ確認', prUrl });

      // 連続でクリックして 2 回失敗させる。積み上げる実装なら .vk-toast が複数生えるが、
      // 「#root 直下に 1 つだけ常設し、前の内容を上書きする」実装なら常に 1 個のまま。
      await prBadge.click();
      await expect(win.locator('.vk-toast')).toBeVisible();
      await expect(win.locator('.vk-toast')).toHaveCount(1);

      await prBadge.click();
      await expect(win.locator('.vk-toast')).toHaveCount(1);
      await expect(win.locator('.vk-toast .vk-toast-message')).toHaveText('ブラウザを開けませんでした');
    } finally {
      await restoreShellOpenExternal(app);
    }
  });

  test('コピーボタンを押すと、押したときだけ VKClipboard.writeText が呼ばれ、成否に応じて本文が差し替わる', async () => {
    await stubShellOpenExternal(app, { fail: true });
    await stubClipboardWrite(app);
    try {
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await postSetTitle(port, { termId: '1', title: 'issue #326 コピー成功', prUrl });
      await prBadge.click();

      const toast = win.locator('.vk-toast');
      await expect(toast.locator('.vk-toast-message')).toHaveText('ブラウザを開けませんでした');

      // トーストが出ただけでは自動コピーしない（押したときだけコピーする）。
      expect(await writtenTexts(app)).toEqual([]);

      await toast.locator('.vk-toast-copy').click();
      await expect(toast.locator('.vk-toast-message')).toHaveText('URLをコピーしました');
      expect(await writtenTexts(app)).toEqual([prUrl]);
    } finally {
      await restoreShellOpenExternal(app);
      await restoreClipboardWrite(app);
    }
  });

  test('コピーに失敗したときは「コピーできませんでした」に本文が差し替わる', async () => {
    await stubShellOpenExternal(app, { fail: true });
    await stubClipboardFailure(app);
    try {
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await postSetTitle(port, { termId: '1', title: 'issue #326 コピー失敗', prUrl });
      await prBadge.click();

      const toast = win.locator('.vk-toast');
      await expect(toast.locator('.vk-toast-message')).toHaveText('ブラウザを開けませんでした');
      await toast.locator('.vk-toast-copy').click();
      await expect(toast.locator('.vk-toast-message')).toHaveText('コピーできませんでした');
    } finally {
      await restoreShellOpenExternal(app);
      await restoreClipboardWrite(app);
    }
  });
});
