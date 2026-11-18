'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
const { PARTITION } = require('../../utils/internalBrowserPolicy');

// 対象: 実際の設定保存と IPC を通し、ホームの優先順位と空のときの挙動を確かめる。
test('ホームは専用 URL、先頭オーナーの順に開き、設定が無ければ移動しない', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchAppAndWait({
    port,
    prefix: 'vk-terminals-e2e-browser-home-',
    config: { openInitialPane: false },
  });

  try {
    // 遷移先だけを専用セッション内で応答し、外部通信に依存せず URL と履歴を確かめる。
    await app.evaluate(({ session }, partition) => {
      session.fromPartition(partition).protocol.handle('https', () => new Response('browser home', {
        headers: { 'Content-Type': 'text/html' },
      }));
    }, PARTITION);
    const homeDir = path.join(tmpRoot, 'home');
    const configPath = path.join(homeDir, '.vk-terminals', 'config.json');
    const ownerConfig = path.join(homeDir, '.vk-orchestrator', 'config.json');

    await win.locator('#internal-browser-toggle').click();
    const toolbar = win.locator('.internal-browser-toolbar');
    const home = toolbar.getByRole('button', { name: 'ホーム', exact: true });
    const address = toolbar.getByRole('textbox', { name: 'URL または検索語を入力' });
    const reload = toolbar.getByRole('button', { name: '再読み込み', exact: true });
    await expect(reload).toBeDisabled();
    await expect(home).toBeEnabled();
    await expect(home).toHaveAttribute('title', 'ホーム');
    await expect(toolbar.locator('[data-action="reload"] + [data-action="home"]')).toHaveCount(1);
    await home.click();
    await expect(address).toHaveValue('');
    await expect(reload).toBeDisabled();

    fs.mkdirSync(path.dirname(ownerConfig), { recursive: true });
    fs.writeFileSync(ownerConfig, JSON.stringify({ github: { owner: ['first-owner', 'second-owner'] } }));

    await win.locator('#settings-btn').click();
    const settings = win.locator('.settings-modal');
    const input = settings.getByRole('textbox', { name: 'ホームページ URL', exact: true });
    const save = settings.getByRole('button', { name: '保存', exact: true });
    await input.fill('file:///tmp/example');
    await save.click();
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(settings.getByText('有効な HTTP または HTTPS の URL を入力してください。')).toBeVisible();
    const rejected = await win.evaluate(() => window.VKIpc.invoke('settings:save', {
      internalBrowserHomeUrl: 'file:///tmp/example',
    }));
    expect(rejected.ok).toBe(false);
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).internalBrowserHomeUrl).toBeUndefined();

    // 前後の空白と大文字、既定ポートを取り除いた URL がすぐ使える。
    const expectedUrl = 'https://example.com/start';
    await input.fill('  HTTPS://EXAMPLE.COM:443/start  ');
    await save.click();
    await expect(settings).toBeHidden();
    expect(JSON.parse(fs.readFileSync(configPath, 'utf8')).internalBrowserHomeUrl).toBe(expectedUrl);
    await address.focus();
    await win.keyboard.press('Shift+Tab');
    await expect(home).toBeFocused();
    await win.keyboard.press('Enter');
    await expect(address).toHaveValue(expectedUrl);
    await expect(reload).toBeEnabled();

    await win.locator('#settings-btn').click();
    await input.fill('');
    await save.click();
    await expect(settings).toBeHidden();
    await home.press('Space');
    await expect(address).toHaveValue('https://github.com/first-owner');
    const back = toolbar.getByRole('button', { name: '戻る', exact: true });
    await expect(back).toBeEnabled();
    await back.click();
    await expect(address).toHaveValue(expectedUrl);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
