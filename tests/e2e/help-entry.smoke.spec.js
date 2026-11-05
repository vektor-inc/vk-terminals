const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

test('使い方・ヘルプ: 確認失敗の再確認、未保存キャンセル、連打と格納復帰', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-help-e2e-'));
  fs.mkdirSync(path.join(root, 'guide'));
  fs.writeFileSync(path.join(root, 'help.html'), '<html>Help</html>');
  const statusFile = path.join(root, 'status.json');
  fs.writeFileSync(statusFile, '{}');
  let launched;
  try {
    launched = await launchAppAndWait({ port: await getFreePort(), prefix: 'vk-help-', entry: path.resolve(__dirname, '../fixtures/embeddedHelpLauncher.js'), env: { VK_TEST_HELP_ROOT: root } });
    const { win } = launched;
    // 組み込みの入口だけに表示され、タブの無い設定画面にも着地できる。
    await win.evaluate(() => openSettingsModal(VKHelpEntry.TAB_ID));
    await expect(win.getByRole('tab', { name: '使い方・ヘルプ' })).toBeVisible();
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
    await win.screenshot({ path: '/tmp/vk-542-help.png' });
    await win.locator('.settings-close').click();
    // AI 自体は起動せず、画面のライフサイクルを隔離した通常ペインで確かめる。
    await win.evaluate(() => {
      const original = VKIpc.invoke;
      window.helpCalls = 0;
      window.guideResult = null;
      VKIpc.invoke = async (channel, ...args) => {
        if (channel === 'settings:describe') return { available: true, values: { label: 'old' }, groups: [{ tab: 'general', label: '基本', fields: [{ key: 'label', label: '名前', type: 'text' }] }], tabs: [{ id: 'general', label: '基本' }, { id: 'about', label: 'バージョン情報' }] };
        if (channel === 'help:check') return { engine: 'codex', engines: [] };
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
    await expect(win.getByRole('tab')).toHaveText(['基本', '使い方・ヘルプ', 'バージョン情報']);
    await win.getByLabel('名前', { exact: true }).fill('new');
    await win.getByRole('tab', { name: '使い方・ヘルプ' }).click();
    await win.getByRole('button', { name: 'AI に相談', exact: true }).click();
    await win.locator('.settings-help-entry').getByRole('button', { name: 'キャンセル', exact: true }).click();
    expect(await win.evaluate(() => window.helpCalls)).toBe(0);
    const beforeFailure = await win.locator('.pane').count();
    await win.evaluate(() => { window.helpFail = true; });
    await win.getByRole('button', { name: 'AI に相談', exact: true }).click();
    await win.getByRole('button', { name: '破棄して開く' }).click();
    await expect(win.locator('.settings-help-entry')).toContainText('ガイドを起動できませんでした');
    await expect(win.locator('.pane')).toHaveCount(beforeFailure);
    await win.evaluate(() => { window.helpFail = false; });
    await win.getByRole('button', { name: 'AI に相談', exact: true }).click();
    await win.getByRole('button', { name: '破棄して開く' }).click();
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
  }
});
