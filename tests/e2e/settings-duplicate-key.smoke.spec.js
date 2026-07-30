const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// 同じ key の欄を別タブへ置き、説明タブの移動ボタンから先に描画される欄へ着地させる。
// 保存処理が別の欄を採用すると、着地した欄へ入力した値と保存値が食い違う。
async function installDuplicateKeyDescriptor(win) {
  await win.evaluate(() => {
    const vkIpc = window.VKIpc;
    const desc = {
      available: true,
      title: '重複キー設定',
      note: '保存後に反映されます。',
      targetPath: '/tmp/settings.json',
      appVersion: '0.0.0-test',
      tabs: [
        { id: 'general', label: '基本' },
        { id: 'tokens', label: 'トークン' },
        {
          id: 'guide',
          label: '案内',
          content: [
            {
              type: 'tabLink',
              label: '接続先を設定',
              tab: 'general',
              field: 'duplicate',
            },
          ],
        },
      ],
      // 宣言順と描画順を逆にし、実際の描画順（タブ順）で先に現れる基本タブの欄を
      // 移動先・保存対象として一貫して採用できることを確かめる。
      groups: [
        {
          label: 'トークン設定',
          tab: 'tokens',
          fields: [
            { key: 'duplicate', label: '後から描画される接続先', type: 'text' },
          ],
        },
        {
          label: '基本設定',
          tab: 'general',
          fields: [
            { key: 'duplicate', label: '移動先の接続先', type: 'text' },
          ],
        },
      ],
      values: { duplicate: '' },
    };

    window.__savedPayloads = [];
    vkIpc.invoke = (channel, payload) => {
      if (channel === 'settings:describe') return Promise.resolve(desc);
      if (channel === 'settings:save') {
        window.__savedPayloads.push(payload);
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    };
  });
}

test.describe.serial('設定キー重複時の移動先と保存値（issue #258）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-duplicate-key-',
      // 実環境の設定ディスクリプタは読み込まない（ヘルパーが VK_TERMINALS_* を中和する）。
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.afterEach(async () => {
    const closeButton = win.locator('.settings-close');
    if (await closeButton.isVisible()) await closeButton.click();
  });

  test('移動ボタンで着地した欄の入力値がそのまま保存される', async () => {
    await installDuplicateKeyDescriptor(win);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });

    // 案内タブから、重複キーのうち描画順で先に現れる基本タブの欄へ移動する。
    await win.getByRole('tab', { name: '案内' }).click();
    await win.getByRole('button', { name: '接続先を設定' }).click();
    const target = win.getByLabel('移動先の接続先', { exact: true });
    await expect(target).toBeFocused();

    // 移動先へ入力して保存し、保存処理も同じ欄を採用したことを IPC の payload で観測する。
    await target.fill('guided.example');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveText(
      '保存しました。次回の起動から反映されます。'
    );
    const payload = await win.evaluate(
      () => window.__savedPayloads[window.__savedPayloads.length - 1]
    );
    expect(payload.duplicate).toBe('guided.example');
  });

  test('重複した欄は描画されず、そのタブは保存対象なしになる', async () => {
    await installDuplicateKeyDescriptor(win);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });

    // 後から描画される重複欄だけのグループは消え、このタブは説明だけのタブと同様に
    // 保存対象無しになる。legend だけの空 fieldset と保存ボタンを残さず、代わりに
    // パネルが空であることを伝える。
    await win.getByRole('tab', { name: 'トークン' }).click();
    await expect(win.getByLabel('後から描画される接続先', { exact: true })).toHaveCount(0);
    await expect(win.locator('#settings-panel-1 .settings-empty'))
      .toHaveText('このタブに表示できる設定項目はありません。');
    await expect(win.locator('.settings-save')).toBeHidden();
  });
});
