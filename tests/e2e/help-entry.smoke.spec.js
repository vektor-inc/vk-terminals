const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
const { focusByKeyboard, readOutline } = require('./helpers/focus-ring');

// 文字行の外にある上下の余白も、実際のマウス操作で設定画面へつながる。
async function checkCardEdges(win, selector, panelSelector) {
  const card = win.locator(selector);
  const initialBox = await card.boundingBox();
  expect(initialBox.height).toBe(40);
  for (const y of [2, initialBox.height - 2]) {
    await win.mouse.click(initialBox.x + initialBox.width / 2, initialBox.y + y);
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.locator(panelSelector)).toBeVisible();
    await win.locator('.settings-close').click();
    await expect(win.locator('.settings-modal')).toHaveCount(0);
  }
  // 透明な領域を足してもボタンのリングとカードの寸法を維持する。
  await focusByKeyboard(win, `${selector} button`);
  const ring = await readOutline(win, `${selector} button`);
  expect(ring.style).toBe('solid');
  expect(parseFloat(ring.width)).toBeGreaterThan(0);
  expect(ring.color).not.toBe('rgba(0, 0, 0, 0)');
  expect(await card.boundingBox()).toEqual(initialBox);
  await win.keyboard.press('Enter');
  await expect(win.locator(panelSelector)).toBeVisible();
  await win.locator('.settings-close').click();
}

test('単体起動: 設定カードの上下端とキーボードで設定を開く', async () => {
  let launched;
  try {
    launched = await launchAppAndWait({ port: await getFreePort(), prefix: 'vk-settings-card-' });
    await expect(launched.win.locator('#sidebar-help')).toHaveCount(0);
    await checkCardEdges(launched.win, '#sidebar-settings', '#settings-panel-0');
  } finally {
    if (launched) await closeApp(launched);
  }
});

test('前ページの画像読み込み中でも案内を開いて設定を閉じる', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-help-pending-e2e-'));
  fs.mkdirSync(path.join(root, 'guide'));
  fs.writeFileSync(path.join(root, 'help.html'), '<html><body>Help guide</body></html>');
  fs.writeFileSync(path.join(root, 'status.json'), '{}');
  let pendingImage;
  const imageRequested = new Promise((resolve) => { pendingImage = resolve; });
  let imageResponse;
  let pageResponse;
  const previousPage = http.createServer((request, response) => {
    if (request.url === '/pending.png') {
      imageResponse = response;
      response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '100000' });
      response.write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      pendingImage();
      return;
    }
    response.writeHead(200, { 'Content-Type': 'text/html' });
    pageResponse = response;
    response.write('<html><body>Previous<img src="/pending.png">');
  });
  await new Promise((resolve) => previousPage.listen(0, '127.0.0.1', resolve));
  let launched;
  try {
    launched = await launchAppAndWait({ port: await getFreePort(), prefix: 'vk-help-pending-', entry: path.resolve(__dirname, '../fixtures/embeddedHelpLauncher.js'), env: { VK_TEST_HELP_ROOT: root } });
    const { win } = launched;
    // 前ページの本文表示後も画像応答を保留し、読み込み中に案内へ切り替える。
    await win.locator('#internal-browser-toggle').click();
    await win.evaluate((url) => VKIpc.invoke('internal-browser:open', url), `http://127.0.0.1:${previousPage.address().port}/previous`);
    await imageRequested;
    await expect(win.locator('.internal-browser-url')).toHaveValue(/\/previous/);
    await expect(win.locator('.internal-browser-progress')).toBeVisible();
    await win.locator('#sidebar-help button').click();
    await win.getByRole('button', { name: 'ドキュメント', exact: true }).click();
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('.internal-browser-url')).toHaveValue('vk-terminals-help://guide/');
    await expect(win.locator('body')).not.toContainText('ドキュメントを開けませんでした');
  } finally {
    if (imageResponse && !imageResponse.destroyed) imageResponse.end();
    if (pageResponse && !pageResponse.destroyed) pageResponse.end('</body></html>');
    if (launched) await closeApp(launched);
    await new Promise((resolve) => previousPage.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ヘルプは保存予約と条件付き入力を確認し、起動応答待ちの追加編集も残す', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-help-save-queue-'));
  fs.mkdirSync(path.join(root, 'guide'));
  fs.writeFileSync(path.join(root, 'help.html'), '<h1>Help</h1>');
  fs.writeFileSync(path.join(root, 'status.json'), '{}');
  let launched;
  try {
    launched = await launchAppAndWait({ port: await getFreePort(), prefix: 'vk-help-save-queue-', entry: path.resolve(__dirname, '../fixtures/embeddedHelpLauncher.js'), env: { VK_TEST_HELP_ROOT: root } });
    const { win } = launched;
    const config = require('../../settings-schema.json');
    const engineFields = config.groups.flatMap(group => group.fields || [])
      .filter(field => ['initialEngine', 'initialCodexModel'].includes(field.key));
    expect(engineFields).toHaveLength(2);
    await win.evaluate(({ engineFields }) => {
      const original = VKIpc.invoke;
      window.saveRequests = [];
      window.releaseSaves = [];
      window.savedValues = { label: 'old', initialEngine: 'claude', initialCodexModel: 'invalid model' };
      window.documentRequests = 0;
      window.deferSaves = true;
      VKIpc.invoke = async (channel, ...args) => {
        if (channel === 'settings:describe') return {
          available: true,
          values: { ...window.savedValues },
          groups: [{ tab: 'general', label: '基本', fields: [
            { key: 'label', label: '名前', type: 'text' }, ...engineFields,
            { key: 'internalBrowserHomeUrl', label: 'ホームページ URL', type: 'http-url' },
          ] }],
          tabs: [{ id: 'general', label: '基本' }],
        };
        if (channel === 'settings:save') {
          const [payload] = args;
          window.saveRequests.push(payload);
          if (window.deferSaves) await new Promise(resolve => { window.releaseSaves.push(resolve); });
          Object.assign(window.savedValues, payload);
          return { ok: true, writtenKeys: Object.keys(payload) };
        }
        if (channel === 'app:config-reflection') return { revision: Date.now(), failedFiles: [] };
        if (channel === 'help:check') return { engine: 'codex', engines: [] };
        if (channel === 'help:document') {
          window.documentRequests++;
          return new Promise(resolve => { window.releaseDocument = () => resolve(true); });
        }
        return original(channel, ...args);
      };
      return openSettingsModal();
    }, { engineFields });
    const basicTab = win.getByRole('tab', { name: /^基本/ });
    const helpTab = win.getByRole('tab', { name: '使い方・ヘルプ' });
    const name = win.getByLabel('名前', { exact: true });
    const engine = win.getByLabel('通常ペインの既定 AI エンジン');
    const model = win.getByLabel('起動時・空画面・自動処理用ペインからの追加・分割用 Codex モデル');
    const documentButton = win.getByRole('button', { name: 'ドキュメント', exact: true });
    const saveButton = win.getByRole('button', { name: '保存', exact: true });
    const saveAndOpen = win.getByRole('button', { name: '保存して開く' });
    const footer = win.locator('.settings-msg');

    // A の応答によって一時的に dirty が消えても、予約された B の結果まで待つ。
    await name.fill('a');
    await saveButton.click();
    await win.waitForFunction(() => window.releaseSaves.length === 1);
    await name.fill('b');
    await saveButton.click();
    await name.fill('a');
    await helpTab.click();
    await win.evaluate(() => window.releaseSaves[0]());
    await win.waitForFunction(() => window.releaseSaves.length === 2);
    await expect(basicTab).not.toHaveClass(/is-dirty/);
    await documentButton.click();
    await expect(documentButton).toBeDisabled();
    await expect(saveAndOpen).toHaveCount(0);
    expect(await win.evaluate(() => window.documentRequests)).toBe(0);
    await win.evaluate(() => {
      window.deferSaves = false;
      window.releaseSaves[1]();
    });
    await expect(saveAndOpen).toBeVisible();
    expect(await win.evaluate(() => window.saveRequests)).toEqual([{ label: 'a' }, { label: 'b' }]);
    expect(await win.evaluate(() => window.documentRequests)).toBe(0);
    await win.getByRole('group', { name: /未保存の変更/ }).getByRole('button', { name: 'キャンセル' }).click();
    const helpStatus = win.locator('.settings-help-entry [role=status]');
    await expect(helpStatus).toHaveText('ドキュメントを開く操作をキャンセルしました。');

    // 条件を切り替えて表示された不正値は、欄自体を編集していなくても保存と起動を止める。
    await basicTab.click();
    await engine.selectOption('codex');
    await helpTab.click();
    await documentButton.click();
    await saveAndOpen.click();
    await expect(model).toHaveValue('invalid model');
    await expect(model).toHaveAttribute('aria-invalid', 'true');
    await expect(model).toBeFocused();
    await expect(helpStatus).toBeEmpty();
    expect(await win.evaluate(() => window.saveRequests)).toHaveLength(2);
    expect(await win.evaluate(() => window.documentRequests)).toBe(0);

    // 保存に成功して起動 IPC を送った後でも、追加編集とフォーカスを保持する。
    await model.fill('gpt-5');
    await helpTab.click();
    await documentButton.click();
    await saveAndOpen.click();
    await win.waitForFunction(() => window.documentRequests === 1);
    await basicTab.click();
    await name.fill('extra');
    await win.evaluate(() => window.releaseDocument());
    await expect(footer).toHaveText('追加の編集が保存されていません。もう一度保存してください。');
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(name).toHaveValue('extra');
    await expect(name).toBeFocused();
    await expect(basicTab).toHaveClass(/is-dirty/);
    expect(await win.evaluate(() => window.saveRequests)).toEqual([
      { label: 'a' }, { label: 'b' }, { label: 'a', initialEngine: 'codex', initialCodexModel: 'gpt-5' },
    ]);

    // 確認を表示する前の保存待ちでタブを移り、キーボードで追加入力する。
    await win.evaluate(() => { window.deferSaves = true; });
    await saveButton.click();
    await win.waitForFunction(() => window.releaseSaves.length === 3);
    await helpTab.click();
    await documentButton.press('Enter');
    await expect(documentButton).toBeDisabled();
    await helpTab.press('ArrowLeft');
    await expect(basicTab).toBeFocused();
    await win.keyboard.press('Tab');
    await expect(name).toBeFocused();
    await win.keyboard.press('End');
    await win.keyboard.type('-edited');
    await win.evaluate(() => {
      window.deferSaves = false;
      window.releaseSaves[2]();
    });
    await expect(footer).toHaveText('設定を保存してから、使い方・ヘルプで開き直してください。');
    await expect(footer).toHaveAttribute('role', 'status');
    await expect(footer).toBeVisible();
    await expect(win.locator('.settings-help-entry [role=group]')).toHaveCount(0);
    await expect(name).toHaveValue('extra-edited');
    await expect(name).toBeFocused();
    expect(await win.evaluate(() => window.documentRequests)).toBe(1);

    // A の破棄に同意した後、起動応答待ちで B を保存して A に戻しても追加編集が残る。
    const discard = win.getByRole('button', { name: '破棄して開く' });
    await name.fill('discard-a');
    await helpTab.click();
    await documentButton.click();
    await discard.click();
    await win.waitForFunction(() => window.documentRequests === 2);
    await basicTab.click();
    await name.fill('save-b');
    await saveButton.click();
    await expect(footer).toContainText('保存しました');
    await name.fill('discard-a');
    await win.evaluate(() => window.releaseDocument());
    await expect(footer).toHaveText('追加の編集が保存されていません。もう一度保存してください。');
    await expect(name).toHaveValue('discard-a');
    await expect(name).toBeFocused();
    expect(await win.evaluate(() => window.savedValues.label)).toBe('save-b');

    // 確認中のフッター保存がまだ応答待ちなら、破棄を押しても予約をすべて待つ。
    await helpTab.click();
    await documentButton.click();
    await expect(discard).toBeVisible();
    await win.evaluate(() => { window.deferSaves = true; });
    await saveButton.click();
    await win.waitForFunction(() => window.releaseSaves.length === 4);
    await saveButton.click();
    await discard.click();
    expect(await win.evaluate(() => window.documentRequests)).toBe(2);
    await win.evaluate(() => window.releaseSaves[3]());
    await win.waitForFunction(() => window.releaseSaves.length === 5);
    expect(await win.evaluate(() => window.documentRequests)).toBe(2);
    await win.evaluate(() => window.releaseSaves[4]());
    await win.waitForFunction(() => window.documentRequests === 3);
    expect(await win.evaluate(() => window.savedValues.label)).toBe('discard-a');
    await win.evaluate(() => window.releaseDocument());
    await expect(win.locator('.settings-modal')).toHaveCount(0);

    // Esc、フッターのキャンセル、ヘッダーの閉じるで A の待機中に閉じても B を保存する。
    for (const closeMethod of ['escape', 'cancel', 'close']) {
      await win.evaluate(() => openSettingsModal());
      const offset = await win.evaluate(() => window.releaseSaves.length);
      await name.fill(`first-${closeMethod}`);
      await saveButton.click();
      await win.waitForFunction(count => window.releaseSaves.length === count, offset + 1);
      await name.fill(`queued-${closeMethod}`);
      await saveButton.click();
      if (closeMethod === 'escape') await win.keyboard.press('Escape');
      else if (closeMethod === 'cancel') await win.locator('.settings-cancel').click();
      else await win.locator('.settings-close').click();
      await expect(win.locator('.settings-modal')).toHaveCount(0);
      await win.evaluate(index => window.releaseSaves[index](), offset);
      await win.waitForFunction(count => window.releaseSaves.length === count, offset + 2);
      expect(await win.evaluate(() => window.saveRequests.slice(-2))).toEqual([
        { label: `first-${closeMethod}` }, { label: `queued-${closeMethod}` },
      ]);
      await win.evaluate(index => window.releaseSaves[index](), offset + 1);
      await win.waitForFunction(value => window.savedValues.label === value, `queued-${closeMethod}`);
    }

    // 未編集の不正 URL はヘルプを止める。単行表示で改行が消えて有効に見える場合も修正できる。
    await win.evaluate(() => {
      window.deferSaves = false;
      window.savedValues.internalBrowserHomeUrl = 'https://example.com/bad\npath';
      return openSettingsModal(VKHelpEntry.TAB_ID);
    });
    const homeUrl = win.getByLabel('ホームページ URL', { exact: true });
    await documentButton.click();
    await expect(homeUrl).toHaveValue('https://example.com/bad path');
    await expect(homeUrl).toBeFocused();
    await expect(homeUrl).toHaveAttribute('aria-invalid', 'true');
    await expect(footer).toHaveText('入力内容に問題があります');
    await expect(helpStatus).toBeEmpty();
    expect(await win.evaluate(() => window.documentRequests)).toBe(3);
    await homeUrl.fill('https://example.com/badpath');
    await saveButton.click();
    await expect(footer).toContainText('保存しました');
    expect(await win.evaluate(() => window.savedValues.internalBrowserHomeUrl)).toBe('https://example.com/badpath');
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('使い方・ヘルプ: 確認失敗の再確認、未保存キャンセル、連打と格納復帰', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-help-e2e-'));
  fs.mkdirSync(path.join(root, 'guide'));
  const linkedPage = http.createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end(`<html><body>${request.url}<a href="/next">Next</a></body></html>`);
  });
  await new Promise((resolve) => linkedPage.listen(0, '127.0.0.1', resolve));
  const linkedUrl = `http://127.0.0.1:${linkedPage.address().port}/`;
  const previousUrl = `${linkedUrl}previous`;
  fs.writeFileSync(path.join(root, 'help.html'), `<html><body>Help<a href="#section">Section</a><h2 id="section">Section</h2><a href="${linkedUrl}">External</a></body></html>`);
  const statusFile = path.join(root, 'status.json');
  fs.writeFileSync(statusFile, '{}');
  let launched;
  try {
    launched = await launchAppAndWait({ port: await getFreePort(), prefix: 'vk-help-', entry: path.resolve(__dirname, '../fixtures/embeddedHelpLauncher.js'), env: { VK_TEST_HELP_ROOT: root } });
    const { win, app } = launched;
    await app.evaluate(({ shell }) => { global.helpDocumentUrls = []; shell.openExternal = async (url) => { global.helpDocumentUrls.push(url); }; });
    // 組み込みの入口だけに表示され、タブの無い設定画面にも着地できる。
    const settingsCard = await win.locator('#sidebar-settings').boundingBox();
    const helpCard = await win.locator('#sidebar-help').boundingBox();
    expect(helpCard.height).toBe(settingsCard.height);
    await checkCardEdges(win, '#sidebar-settings', '#settings-panel-0');
    await checkCardEdges(win, '#sidebar-help', '.settings-help-entry');
    await win.locator('#sidebar-help button').click();
    await expect(win.getByRole('tab', { name: '使い方・ヘルプ' })).toBeVisible();
    expect(await win.locator('.settings-help-entry [role=status]').evaluate((element) => getComputedStyle(element).wordBreak)).toBe('auto-phrase');
    await expect(win.locator('.settings-help-entry')).toContainText('確認できませんでした');
    await expect(win.getByRole('button', { name: 'AI に相談', exact: true })).toBeHidden();
    fs.writeFileSync(statusFile, JSON.stringify({ engine: null, engines: ['claude', 'codex'].map((engine) => ({ engine, state: 'unavailable', reason: '<b>認証が必要</b>', preparation: 'ログインしてください' })) }));
    await win.getByRole('button', { name: '再確認', exact: true }).click();
    await expect(win.locator('.settings-help-entry')).toContainText('<b>認証が必要</b>');
    await expect(win.locator('.settings-help-entry b')).toHaveCount(0);
    for (const colorScheme of ['light', 'dark']) {
      await win.emulateMedia({ colorScheme });
      const docButton = win.getByRole('button', { name: 'ドキュメント', exact: true });
      expect((await docButton.boundingBox()).height).toBeGreaterThanOrEqual(44);
      await docButton.focus();
      await expect(docButton).toBeFocused();
    }
    // 案内より前のページをローカルで読み込み、完了後に通常の履歴へ残す。
    await win.evaluate((url) => VKIpc.invoke('internal-browser:open', url), previousUrl);
    await expect.poll(() => app.evaluate(({ webContents }, expectedUrl) =>
      webContents.getAllWebContents().some((contents) => contents.getURL() === expectedUrl), previousUrl)).toBe(true);
    await expect(win.locator('.internal-browser-url')).toHaveValue(/\/previous/);
    await expect(win.locator('.internal-browser-progress')).toBeHidden();
    await expect(win.locator('.internal-browser-error')).toBeHidden();
    // IPC を保留し、未保存変更が無い場合の読み込み中表示を観察する。
    await win.evaluate(() => {
      const original = VKIpc.invoke;
      window.releaseDocument = null;
      VKIpc.invoke = (channel, ...args) => channel === 'help:document'
        ? new Promise((resolve, reject) => { window.releaseDocument = () => { VKIpc.invoke = original; original(channel, ...args).then(resolve, reject); }; })
        : original(channel, ...args);
    });
    await win.getByRole('button', { name: 'ドキュメント', exact: true }).click();
    await expect(win.locator('.settings-help-entry [role=status]')).toHaveText('ドキュメントを読み込んでいます…');
    await win.evaluate(() => window.releaseDocument());
    await expect(win.locator('.internal-browser-url')).toHaveValue(/guide/);
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#internal-browser-sidebar')).toBeVisible();
    // 読み込み済みの操作列へフォーカスし、無関係な初期案内を残さない。
    await expect(win.locator('.internal-browser-url')).toBeFocused();
    await expect(win.locator('.internal-browser-toolbar [data-action="reload"]')).toBeEnabled();
    await expect(win.locator('.internal-browser-notice')).toBeHidden();
    expect(await win.evaluate(() => internalBrowserHasPage)).toBe(true);
    // 専用スキームの別パスと file: はナビゲーション入口で拒否する。
    const refusedNavigation = await win.evaluate(async () => ({
      path: await VKIpc.invoke('internal-browser:open', 'vk-terminals-help://guide/other'),
      file: await VKIpc.invoke('internal-browser:open', 'file:///tmp/help.html'),
    }));
    expect(refusedNavigation).toEqual({ path: false, file: false });
    // 同じ案内内の見出しリンクは URL のハッシュだけを更新する。
    await app.evaluate(async ({ webContents }) => {
      const guide = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('vk-terminals-help://guide/'));
      await guide.executeJavaScript("document.querySelector('a[href=\"#section\"]').click()", true);
    });
    await expect(win.locator('.internal-browser-url')).toHaveValue(/\#section/);
    // 案内内の外部リンクをクリックし、履歴の「戻る」で案内へ復帰する。
    await app.evaluate(async ({ webContents }) => {
      const guide = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('vk-terminals-help://guide/'));
      await guide.executeJavaScript("document.querySelector('a[href^=\"http:\"]').click()", true);
    });
    await expect(win.locator('.internal-browser-url')).toHaveValue(/127\.0\.0\.1/);
    await win.locator('.internal-browser-toolbar [data-action="back"]').click();
    await expect(win.locator('.internal-browser-url')).toHaveValue(/\#section/);
    await win.locator('.internal-browser-toolbar [data-action="forward"]').click();
    await expect(win.locator('.internal-browser-url')).toHaveValue(/127\.0\.0\.1/);
    // B からは A を経由し、案内とその前のローカルページまで順に戻る。
    await app.evaluate(async ({ webContents }) => {
      const page = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('http://127.0.0.1:'));
      await page.executeJavaScript("document.querySelector('a').click()", true);
    });
    await expect(win.locator('.internal-browser-url')).toHaveValue(/\/next/);
    await win.locator('.internal-browser-toolbar [data-action="back"]').click();
    await expect(win.locator('.internal-browser-url')).toHaveValue(linkedUrl);
    await win.locator('.internal-browser-toolbar [data-action="back"]').click();
    await expect(win.locator('.internal-browser-url')).toHaveValue(/\#section/);
    await win.locator('.internal-browser-toolbar [data-action="back"]').click();
    // #section も /guide/ に一致するため、基底URLへの履歴移動完了を完全一致で待つ。
    await expect(win.locator('.internal-browser-url')).toHaveValue('vk-terminals-help://guide/');
    await win.locator('.internal-browser-toolbar [data-action="back"]').click();
    await expect(win.locator('.internal-browser-url')).toHaveValue(previousUrl);
    await win.locator('.internal-browser-toolbar [data-action="forward"]').click();
    await expect(win.locator('.internal-browser-url')).toHaveValue(/guide/);
    await expect.poll(() => app.evaluate(({ webContents }) =>
      webContents.getAllWebContents().some((contents) => contents.getURL() === 'vk-terminals-help://guide/'))).toBe(true);
    await win.locator('.internal-browser-toolbar [data-action="external"]').click();
    await expect.poll(() => app.evaluate(() => global.helpDocumentUrls)).toEqual([require('url').pathToFileURL(fs.realpathSync(path.join(root, 'help.html'))).href]);
    // 同梱 HTML が消えた場合は設定を閉じず、再試行の案内を残す。
    fs.unlinkSync(path.join(root, 'help.html'));
    await win.evaluate(() => openSettingsModal(VKHelpEntry.TAB_ID));
    await win.getByRole('button', { name: 'ドキュメント', exact: true }).click();
    await expect(win.locator('.settings-help-entry [role=status]')).toContainText('もう一度押してください');
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('.settings-close').click();
    // 利用可否が正常でも作業フォルダ消失時は、画面側の代替指定を使わず失敗する。
    fs.writeFileSync(statusFile, JSON.stringify({ engine: 'codex', engines: [
      { engine: 'claude', state: 'unknown' }, { engine: 'codex', state: 'available' },
    ] }));
    fs.rmdirSync(path.join(root, 'guide'));
    const countBeforeInvalidCwd = await win.locator('.pane').count();
    const refused = await win.evaluate(async () => {
      try { await VKIpc.invoke('help:open-guide', { cwd: '/tmp', engine: 'claude', prompt: '/bad' }); return false; }
      catch (_) { return true; }
    });
    expect(refused).toBe(true);
    await expect(win.locator('.pane')).toHaveCount(countBeforeInvalidCwd);
    // AI 自体は起動せず、画面のライフサイクルを隔離した通常ペインで確かめる。
    await win.evaluate(() => {
      const original = VKIpc.invoke;
      window.helpCalls = 0;
      window.helpChecks = 0;
      window.guideResult = null;
      VKIpc.invoke = async (channel, ...args) => {
        if (channel === 'settings:describe') return { available: true, values: { label: 'old' }, groups: [{ tab: 'general', label: '基本', fields: [{ key: 'label', label: '名前', type: 'text', pattern: '^[a-z]+$' }] }], tabs: [{ id: 'general', label: '基本' }, { id: 'about', label: 'バージョン情報' }] };
        if (channel === 'help:check') { window.helpChecks++; return { engine: 'codex', engines: [] }; }
        if (channel === 'settings:save') {
          if (window.saveMode === 'throw') throw new Error('保存できません');
          if (window.saveMode === 'fail') return { ok: false, error: '保存できません' };
          if (window.saveMode === 'delay') {
            await new Promise(resolve => { window.releaseHelpSave = resolve; });
          }
          return { ok: true, writtenKeys: Object.keys(args[0]) };
        }
        if (channel === 'app:config-reflection' && window.saveMode === 'readThrow') throw new Error('読み込みできません');
        if (channel === 'app:config-reflection') return { revision: Date.now(), failedFiles: window.saveMode === 'read' ? ['config.json'] : [] };
        if (channel === 'help:open-guide') {
          window.helpCalls++;
          if (window.helpFail) throw new Error('起動失敗');
          await new Promise((resolve) => setTimeout(resolve, 150));
          if (!window.guideResult) window.guideResult = await original('terminal:create', null, { noClaude: true });
          return window.guideResult;
        }
        return original(channel, ...args);
      };
    });
    await win.evaluate(() => openSettingsModal());
    // アプリ内ブラウザのタブ（issue #644）と区別するため、設定画面の中のタブだけを数える。
    await expect(win.locator('.settings-modal').getByRole('tab')).toHaveText(['基本', '使い方・ヘルプ', 'バージョン情報']);
    expect(await win.evaluate(() => window.helpChecks)).toBe(0);
    await win.getByLabel('名前', { exact: true }).fill('new');
    await win.getByRole('tab', { name: '使い方・ヘルプ' }).click();
    expect(await win.evaluate(() => window.helpChecks)).toBe(1);
    // ドキュメントも未保存の確認を経由し、キャンセルでは設定を残す。
    await win.getByRole('button', { name: 'ドキュメント', exact: true }).click();
    const documentChoices = win.getByRole('group', { name: '未保存の変更があります。保存してからドキュメントを開きますか？' });
    await expect(documentChoices).toBeVisible();
    await expect(win.locator('.settings-help-entry [role=status]')).toHaveText('未保存の変更を保存するか選んでください。');
    await documentChoices.getByRole('button', { name: 'キャンセル' }).click();
    await expect(win.locator('.settings-help-entry [role=status]')).toHaveText('ドキュメントを開く操作をキャンセルしました。');
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.getByRole('button', { name: 'ドキュメント', exact: true })).toBeFocused();
    await win.evaluate(() => {
      const original = VKIpc.invoke;
      VKIpc.invoke = (channel, ...args) => channel === 'help:document'
        ? new Promise((resolve, reject) => {
          window.releaseDocument = () => { VKIpc.invoke = original; original(channel, ...args).then(resolve, reject); };
        }) : original(channel, ...args);
    });
    await win.getByRole('button', { name: 'ドキュメント', exact: true }).click();
    await documentChoices.getByRole('button', { name: '破棄して開く' }).click();
    await expect(win.locator('.settings-help-entry [role=status]')).toHaveText('ドキュメントを読み込んでいます…');
    await expect(documentChoices).toHaveCount(0);
    await win.evaluate(() => window.releaseDocument());
    await expect(win.locator('.settings-help-entry [role=status]')).toContainText('もう一度押してください');
    await win.getByRole('button', { name: 'AI に相談', exact: true }).click();
    await expect(win.locator('.settings-help-entry [role=status]')).toBeEmpty();
    const unsavedGroup = win.getByRole('group', { name: '未保存の変更があります。保存してからガイドを開きますか？' });
    await expect(unsavedGroup).toBeVisible();
    await expect(unsavedGroup.getByRole('button', { name: '保存して開く' })).toBeFocused();
    // 文字の見える端まで測り、確認グループの外側がボタン間より広いことを確かめる。
    const spacing = await unsavedGroup.evaluate((group) => {
      const heading = group.querySelector('p');
      const range = document.createRange();
      range.selectNodeContents(heading);
      const textTop = range.getBoundingClientRect().top;
      const buttons = group.querySelectorAll('button');
      const ai = group.parentElement.querySelectorAll('button')[1];
      return {
        outer: textTop - ai.getBoundingClientRect().bottom,
        inner: buttons[1].getBoundingClientRect().top - buttons[0].getBoundingClientRect().bottom,
      };
    });
    expect(spacing.outer).toBeGreaterThan(spacing.inner);
    await win.locator('.settings-help-entry').getByRole('button', { name: 'キャンセル', exact: true }).click();
    expect(await win.evaluate(() => window.helpCalls)).toBe(0);
    await expect(win.getByRole('button', { name: 'AI に相談', exact: true })).toBeFocused();
    // 保存失敗・例外・読み込み失敗のすべてで確認待ちを解除する。
    for (const mode of ['invalid', 'fail', 'throw', 'readThrow', 'read']) {
      await win.getByRole('tab', { name: '基本' }).click();
      await win.getByLabel('名前', { exact: true }).fill(mode === 'invalid' ? '123' : `new${'a'.repeat(mode.length)}`);
      await win.getByRole('tab', { name: '使い方・ヘルプ' }).click();
      await win.evaluate((value) => { window.saveMode = value; }, mode);
      await win.getByRole('button', { name: 'AI に相談', exact: true }).click();
      await win.getByRole('group', { name: '未保存の変更があります。保存してからガイドを開きますか？' }).getByRole('button', { name: '保存して開く' }).click();
      await expect(win.getByRole('button', { name: 'AI に相談', exact: true, includeHidden: true })).toBeEnabled();
      await expect(win.getByRole('button', { name: '保存して開く' })).toHaveCount(0);
      expect(await win.evaluate(() => window.helpCalls)).toBe(0);
      if (mode === 'invalid') {
        await expect(win.getByLabel('名前', { exact: true })).toBeFocused();
        await expect(win.locator('.settings-msg')).toHaveText('入力内容に問題があります');
        await expect(win.locator('.settings-help-entry [role=status]')).toBeEmpty();
      } else {
        await expect(win.locator('.settings-help-entry [role=status]')).toContainText('内容を確認して再試行してください。');
      }
      await expect(win.locator('.settings-help-entry [role=status]')).not.toContainText('ガイドを起動できませんでした');
      if (mode === 'read') {
        // 保存済みでも読み込み失敗なら起動しない。再編集して次の選択へ進む。
        await win.getByRole('tab', { name: '基本' }).click();
        await win.getByLabel('名前', { exact: true }).fill('newer');
        await win.getByRole('tab', { name: '使い方・ヘルプ' }).click();
      }
    }
    // ドキュメント側も保存理由の再試行案内を重ねない。
    await win.evaluate(() => { window.saveMode = 'fail'; });
    await win.getByRole('button', { name: 'ドキュメント', exact: true }).click();
    await win.getByRole('group', { name: '未保存の変更があります。保存してからドキュメントを開きますか？' }).getByRole('button', { name: '保存して開く' }).click();
    await expect(win.locator('.settings-help-entry [role=status]')).toContainText('内容を確認して再試行してください。');
    await expect(win.locator('.settings-help-entry [role=status]')).not.toContainText('もう一度押してください。');
    // 最小幅で「ください」が行をまたがないことを文字の位置で確かめる。
    const viewport = await win.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    await win.setViewportSize({ width: 600, height: viewport.height });
    const wordLines = await win.locator('.settings-help-entry [role=status]').evaluate((element) => {
      const text = element.firstChild;
      const start = text.textContent.lastIndexOf('ください');
      return Array.from({ length: 4 }, (_, offset) => {
        const range = document.createRange();
        range.setStart(text, start + offset);
        range.setEnd(text, start + offset + 1);
        return range.getBoundingClientRect().top;
      });
    });
    expect(new Set(wordLines).size).toBe(1);
    await win.setViewportSize(viewport);
    await win.evaluate(() => { window.saveMode = null; });
    // 後の通常保存にも起動予約が残っていない。
    await win.getByRole('tab', { name: '基本' }).click();
    await win.getByRole('button', { name: '保存', exact: true }).click();
    await expect(win.locator('.settings-msg')).toContainText('保存しました');
    expect(await win.evaluate(() => window.helpCalls)).toBe(0);
    await win.getByLabel('名前', { exact: true }).fill('next');
    await win.getByRole('tab', { name: '使い方・ヘルプ' }).click();
    const beforeFailure = await win.locator('.pane').count();
    await win.evaluate(() => { window.helpFail = true; });
    await win.getByRole('button', { name: 'AI に相談', exact: true }).click();
    await win.getByRole('button', { name: '破棄して開く' }).click();
    await expect(win.locator('.settings-help-entry')).toContainText('ガイドを起動できませんでした');
    await expect(win.locator('.pane')).toHaveCount(beforeFailure);
    await win.evaluate(() => { window.helpFail = false; });

    // 「保存して開く」の応答を待つ間に追加入力すると、ガイドを開かず設定を保持する。
    await win.evaluate(() => { window.saveMode = 'delay'; });
    await win.getByRole('button', { name: 'AI に相談', exact: true }).click();
    await win.getByRole('button', { name: '保存して開く' }).click();
    await win.waitForFunction(() => typeof window.releaseHelpSave === 'function');
    const basicTab = win.getByRole('tab', { name: /^基本/ });
    await basicTab.click();
    await win.getByLabel('名前', { exact: true }).fill('extra');
    await win.evaluate(() => {
      window.saveMode = null;
      window.releaseHelpSave();
      delete window.releaseHelpSave;
    });
    await expect(win.locator('.settings-msg')).toHaveText('設定を保存してから、使い方・ヘルプで開き直してください。');
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.getByLabel('名前', { exact: true })).toHaveValue('extra');
    await expect(basicTab).toHaveClass(/is-dirty/);
    expect(await win.evaluate(() => window.helpCalls)).toBe(1);

    await win.getByRole('tab', { name: '使い方・ヘルプ' }).click();
    await win.getByRole('button', { name: 'AI に相談', exact: true }).click();
    await win.getByRole('button', { name: '保存して開く' }).click();
    await expect(win.getByRole('button', { name: 'AI に相談', exact: true })).toBeDisabled();
    await expect(win.locator('.settings-help-entry')).toContainText('ガイドを起動しています…');
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    expect(await win.evaluate(() => window.helpCalls)).toBe(2);
    const count = await win.locator('.pane').count();
    await win.evaluate(() => {
      const id = Object.keys(terminals).find((id) => terminals[id].apiTitle === '使い方ガイド');
      stashPane(id);
    });
    await win.evaluate(() => openSettingsModal(VKHelpEntry.TAB_ID));
    await win.getByRole('button', { name: 'AI に相談', exact: true }).click();
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('.pane')).toHaveCount(count);
    expect(await win.evaluate(() => tree.stashOrder.length)).toBe(0);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(root, { recursive: true, force: true });
    await new Promise((resolve) => linkedPage.close(resolve));
  }
});

// 実際の IPC → PTY → CLI を通し、シェルへ渡った値を外側から確かめる。
test('ガイドの実起動: 状態変化、専用経路、Codex の引数と cwd', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-help-launch-'));
  const guide = path.join(root, 'guide');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(guide);
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(root, 'help.html'), '<html>Help</html>');
  const statusFile = path.join(root, 'status.json');
  const available = { engine: 'codex', engines: [{ engine: 'claude', state: 'unknown' }, { engine: 'codex', state: 'available' }] };
  fs.writeFileSync(statusFile, JSON.stringify(available));
  fs.writeFileSync(path.join(bin, 'codex'), '#!/bin/sh\nprintf "%s\\n" "$PWD" "$@" > "$VK_TEST_HELP_ROOT/arguments"\nwhile :; do sleep 1; done\n', { mode: 0o755 });
  let launched;
  try {
    const port = await getFreePort();
    launched = await launchAppAndWait({ port, prefix: 'vk-help-real-', entry: path.resolve(__dirname, '../fixtures/embeddedHelpLauncher.js'), env: { VK_TEST_HELP_ROOT: root } });
    const { app, win } = launched;
    await app.evaluate((_, binPath) => { process.env.PATH = `${binPath}:/usr/bin:/bin`; process.env.SHELL = '/bin/sh'; }, bin);
    const response = await fetch(`http://127.0.0.1:${port}/api/new-pane`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ guidePane: true, noClaude: true, cwd: root }) });
    expect(response.status).toBe(200);
    expect(fs.existsSync(path.join(root, 'arguments'))).toBe(false);
    await win.locator('#sidebar-help button').click();
    const ai = win.getByRole('button', { name: 'AI に相談', exact: true });
    await expect(ai).toBeEnabled();
    // 起動直前の状態変化でも、キーボードの操作位置を次のボタンへ引き継ぐ。
    const retry = win.getByRole('button', { name: '再確認', exact: true });
    for (const state of ['unavailable', 'unknown']) {
      fs.writeFileSync(statusFile, JSON.stringify({ engine: null, engines: ['claude', 'codex'].map((engine) => ({ engine, state, reason: '利用できません', preparation: '導入してログインしてください' })) }));
      await ai.focus();
      await win.keyboard.press('Enter');
      await expect(ai).toBeHidden();
      await expect(retry).toBeEnabled();
      await expect(retry).toBeFocused();
      await expect(win.locator('.settings-help-entry')).toContainText('導入してログインしてください');
      // 確認に再度失敗した場合も、再確認へ戻って操作を続けられる。
      await win.keyboard.press('Enter');
      await expect(retry).toBeEnabled();
      await expect(retry).toBeFocused();
      fs.writeFileSync(statusFile, JSON.stringify(available));
      await win.keyboard.press('Enter');
      await expect(ai).toBeVisible();
      await expect(ai).toBeFocused();
    }
    // 汎用 IPC のガイド指定は実行時にも拒否される。
    expect(await win.evaluate(async () => {
      try { await VKIpc.invoke('terminal:create', null, { guidePane: true }); return false; }
      catch (_) { return true; }
    })).toBe(true);
    await ai.click();
    await expect.poll(() => fs.existsSync(path.join(root, 'arguments'))).toBe(true);
    const args = fs.readFileSync(path.join(root, 'arguments'), 'utf8').trimEnd().split('\n');
    expect(fs.realpathSync(args[0])).toBe(fs.realpathSync(guide));
    expect(args.slice(1)).toEqual(['--no-daemon', '$helper']);
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await win.locator('#sidebar-help button').click();
    await ai.click();
    await expect(win.locator('.settings-modal')).toHaveCount(0);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
