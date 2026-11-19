'use strict';

const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
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

    // 設定が空のまま別のページを表示し、ホームで移動せずに設定へ進めることを確認する。
    const currentUrl = 'https://example.com/current';
    await address.fill(currentUrl);
    await address.press('Enter');
    await expect(reload).toBeEnabled();
    await home.press('Enter');
    const homeNotice = win.locator('.internal-browser-home-notice');
    const homeStatus = homeNotice.getByRole('status');
    const configure = homeNotice.getByRole('button', { name: 'ホームページ URL を設定' });
    await expect(homeStatus).toHaveText('ホームページが設定されていません。');
    await expect(homeStatus).toHaveAttribute('aria-live', 'polite');
    await home.focus();
    await win.keyboard.press('Tab');
    await expect(address).toBeFocused();
    await expect(address).toHaveValue(currentUrl);
    await expect(toolbar.getByRole('button', { name: '戻る', exact: true })).toBeDisabled();

    await configure.press('Enter');
    const settings = win.locator('.settings-modal');
    const input = settings.getByRole('textbox', { name: 'ホームページ URL', exact: true });
    await expect(settings).toHaveAttribute('aria-modal', 'true');
    await expect(input).toBeFocused();
    await expect.poll(() => toolbar.evaluate(el => Boolean(el.closest('[inert]')))).toBe(true);
    await win.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(configure).toBeFocused();
    await expect(address).toHaveValue(currentUrl);

    await configure.press('Enter');
    await expect(input).toBeFocused();
    await input.fill('https://example.com/discarded');
    await settings.getByRole('button', { name: 'キャンセル', exact: true }).click();
    await expect(settings).toBeHidden();
    await expect(configure).toBeFocused();
    await expect(homeStatus).toHaveText('ホームページが設定されていません。');

    await configure.press('Enter');
    await expect(input).toHaveValue('');
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
    await expect(homeStatus).toBeEmpty();
    await expect(configure).toBeHidden();
    await expect(home).toBeFocused();
    await expect(address).toHaveValue(currentUrl);
    await win.keyboard.press('Enter');
    await expect(address).toHaveValue(expectedUrl);
    await expect(reload).toBeEnabled();

    fs.mkdirSync(path.dirname(ownerConfig), { recursive: true });
    fs.writeFileSync(ownerConfig, JSON.stringify({ github: { owner: ['first-owner', 'second-owner'] } }));
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

// 対象: 外部ディスクリプタで起動し、組み込みの保存先と外部オーナーへのフォールバックを確認する。
test('外部設定で起動してもホーム URL は VK Terminals に保存し、空欄なら外部の先頭オーナーを開く', async () => {
  const descriptorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-external-home-'));
  const descriptorPath = path.join(descriptorDir, 'descriptor.json');
  const externalConfigPath = path.join(descriptorDir, 'orchestrator.json');
  const legacyOwners = '  \n\nexternal-first\nexternal-second';
  const externalConfig = {
    github: { owner: legacyOwners },
    internalBrowserHomeUrl: 'https://example.com/external-value',
  };
  const externalConfigBytes = Buffer.from(JSON.stringify(externalConfig));
  let launched;
  try {
    fs.writeFileSync(externalConfigPath, externalConfigBytes);
    fs.writeFileSync(descriptorPath, JSON.stringify({
      title: 'VK Orchestrator 設定',
      tabs: [{ id: 'github', label: 'GitHub' }],
      targetPath: externalConfigPath,
      groups: [{
        tab: 'github',
        fields: [
          { key: 'github.owner', type: 'lines', label: '作業対象リポジトリのオーナー' },
          { key: 'internalBrowserHomeUrl', type: 'text', label: '外部のホーム URL' },
        ],
      }],
    }));
    launched = await launchAppAndWait({
      port: await getFreePort(),
      prefix: 'vk-terminals-e2e-external-home-',
      config: { openInitialPane: false },
      env: { VK_TERMINALS_SETTINGS: descriptorPath },
      seedHome({ tmpHome }) {
        const dir = path.join(tmpHome, '.vk-orchestrator');
        fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ github: { owner: ['default-owner'] } }));
      },
    });
    const { app, win, tmpRoot } = launched;
    const ownConfigPath = path.join(tmpRoot, 'home', '.vk-terminals', 'config.json');
    await app.evaluate(({ session }, partition) => {
      session.fromPartition(partition).protocol.handle('https', () => new Response('browser home', {
        headers: { 'Content-Type': 'text/html' },
      }));
    }, PARTITION);

    const settingsButton = win.locator('#settings-btn');
    const settings = win.getByRole('dialog', { name: /VK Orchestrator 設定/ });
    const browserTab = settings.getByRole('tab', { name: 'アプリ内ブラウザ' });
    const githubTab = settings.getByRole('tab', { name: /^GitHub(?:（未保存の変更あり）)?$/ });
    const ownerInput = settings.getByRole('textbox', { name: '作業対象リポジトリのオーナー' });
    const input = settings.getByRole('textbox', { name: 'ホームページ URL', exact: true });
    const save = settings.getByRole('button', { name: '保存', exact: true });
    await settingsButton.click();
    await expect(ownerInput).toHaveValue(legacyOwners);
    await expect(settings.getByText('外部のホーム URL', { exact: true })).toHaveCount(0);
    await browserTab.click();
    await expect(input).toHaveValue('');
    const normalizedUrl = 'https://example.com/home';
    await input.fill('  HTTPS://EXAMPLE.COM:443/home  ');
    await save.click();
    await expect(settings).toBeHidden();
    expect(JSON.parse(fs.readFileSync(ownConfigPath, 'utf8')).internalBrowserHomeUrl).toBe(normalizedUrl);
    expect(fs.readFileSync(externalConfigPath)).toEqual(externalConfigBytes);

    // 直後に変更せず保存しても、旧形式の owner やファイルの書式が変わらない。
    const savedOwnConfigBytes = fs.readFileSync(ownConfigPath);
    await settingsButton.click();
    await save.click();
    await expect(settings).toBeHidden();
    expect(fs.readFileSync(externalConfigPath)).toEqual(externalConfigBytes);
    expect(fs.readFileSync(ownConfigPath)).toEqual(savedOwnConfigBytes);

    await win.locator('#internal-browser-toggle').click();
    const toolbar = win.locator('.internal-browser-toolbar');
    const home = toolbar.getByRole('button', { name: 'ホーム', exact: true });
    const address = toolbar.getByRole('textbox', { name: 'URL または検索語を入力' });
    const reload = toolbar.getByRole('button', { name: '再読み込み', exact: true });
    await home.click();
    await expect(address).toHaveValue(normalizedUrl);
    await expect(reload).toBeEnabled();

    await settingsButton.click();
    await browserTab.click();
    await expect(input).toHaveValue(normalizedUrl);
    await input.fill('');
    await save.click();
    await expect(settings).toBeHidden();
    expect(JSON.parse(fs.readFileSync(ownConfigPath, 'utf8')).internalBrowserHomeUrl).toBe('');
    expect(fs.readFileSync(externalConfigPath)).toEqual(externalConfigBytes);
    await home.click();
    await expect(address).toHaveValue('https://github.com/external-first');
    await expect(toolbar.getByRole('button', { name: '戻る', exact: true })).toBeEnabled();

    // 外部だけの編集と、外部とホームの同時編集も保存できる。
    const ownConfigBytes = fs.readFileSync(ownConfigPath);
    await settingsButton.click();
    await githubTab.click();
    await ownerInput.fill('external-edited');
    await save.click();
    await expect(settings).toBeHidden();
    expect(JSON.parse(fs.readFileSync(externalConfigPath, 'utf8')).github.owner).toEqual(['external-edited']);
    expect(fs.readFileSync(ownConfigPath)).toEqual(ownConfigBytes);

    await settingsButton.click();
    await githubTab.click();
    await ownerInput.fill('external-edited-again');
    await browserTab.click();
    await input.fill(normalizedUrl);
    await save.click();
    await expect(settings).toBeHidden();
    expect(JSON.parse(fs.readFileSync(externalConfigPath, 'utf8')).github.owner).toEqual(['external-edited-again']);
    expect(JSON.parse(fs.readFileSync(ownConfigPath, 'utf8')).internalBrowserHomeUrl).toBe(normalizedUrl);

    // 外部ファイルが保存できない状態でも、ホームに成功した分は次回の比較元になる。
    await settingsButton.click();
    await browserTab.click();
    await input.fill('');
    await save.click();
    await expect(settings).toBeHidden();
    fs.writeFileSync(externalConfigPath, '{');
    await home.press('Enter');
    const notice = win.locator('.internal-browser-home-notice');
    const status = notice.locator('[role="status"]');
    const configure = notice.getByRole('button', { name: 'ホームページ URL を設定' });
    await expect(status).toHaveText('ホームページが設定されていません。');
    await configure.press('Enter');
    await expect(input).toBeFocused();
    await input.fill(normalizedUrl);
    await githubTab.click();
    await ownerInput.fill('retry-owner');
    await save.click();
    const message = settings.locator('.settings-msg');
    const partialMessage = '「ホームページ URL」を保存しました。「作業対象リポジトリのオーナー」は再保存してください。';
    await expect(message).toHaveText(partialMessage);
    await expect(message).toHaveAttribute('role', 'status');
    await expect(browserTab).not.toHaveClass(/is-dirty/);
    await expect(githubTab).toHaveClass(/is-dirty/);
    expect(JSON.parse(fs.readFileSync(ownConfigPath, 'utf8')).internalBrowserHomeUrl).toBe(normalizedUrl);
    expect(fs.readFileSync(externalConfigPath, 'utf8')).toBe('{');
    await expect(status).toBeEmpty();

    await browserTab.click();
    await input.fill('');
    await save.click();
    await expect(message).toHaveText(partialMessage);
    await expect(status).toHaveText('ホームページが設定されていません。');
    expect(JSON.parse(fs.readFileSync(ownConfigPath, 'utf8')).internalBrowserHomeUrl).toBe('');
    expect(fs.readFileSync(externalConfigPath, 'utf8')).toBe('{');
    await win.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect(configure).toBeFocused();

    // 空欄の保存応答より先に閉じたときは、ホームにとどまる場合だけ案内へフォーカスを移す。
    for (const moveFocus of [false, true]) {
      await configure.press('Enter');
      await input.fill(normalizedUrl);
      await githubTab.click();
      await ownerInput.fill('retry-owner');
      await save.click();
      await expect(status).toBeEmpty();
      await expect(message).toHaveText(partialMessage);
      await browserTab.click();
      await input.fill('');
      await expect(message).toHaveText(partialMessage);
      await win.evaluate(() => {
        const original = VKIpc.invoke;
        VKIpc.invoke = async (channel, ...args) => {
          const result = await original(channel, ...args);
          if (channel !== 'settings:save') return result;
          VKIpc.invoke = original;
          return new Promise(resolve => { window.releaseEmptyHomeSave = () => resolve(result); });
        };
      });
      await save.click();
      await win.waitForFunction(() => typeof window.releaseEmptyHomeSave === 'function');
      expect(JSON.parse(fs.readFileSync(ownConfigPath, 'utf8')).internalBrowserHomeUrl).toBe('');
      if (moveFocus) await settings.getByRole('button', { name: 'キャンセル' }).click();
      else await win.keyboard.press('Escape');
      await expect(settings).toBeHidden();
      await expect(home).toBeFocused();
      if (moveFocus) await address.focus();
      await win.evaluate(() => {
        window.releaseEmptyHomeSave();
        delete window.releaseEmptyHomeSave;
      });
      await expect(status).toHaveText('ホームページが設定されていません。');
      await expect(moveFocus ? address : configure).toBeFocused();
    }

    // 案内から設定を開き、専用 URL を空欄のまま owner だけ保存する。
    fs.writeFileSync(externalConfigPath, '{}');
    await expect(status).toHaveText('ホームページが設定されていません。');
    await configure.press('Enter');
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('');
    await githubTab.click();
    await ownerInput.fill('owner-only\nsecond-owner');
    await save.click();
    await expect(settings).toBeHidden();
    await expect(status).toBeEmpty();
    await expect(configure).toBeHidden();
    await expect(home).toBeFocused();
    expect(JSON.parse(fs.readFileSync(ownConfigPath, 'utf8')).internalBrowserHomeUrl).toBe('');
    expect(JSON.parse(fs.readFileSync(externalConfigPath, 'utf8')).github.owner).toEqual(['owner-only', 'second-owner']);
    await home.press('Enter');
    await expect(address).toHaveValue('https://github.com/owner-only');
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(descriptorDir, { recursive: true, force: true });
  }
});
