const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// settings:describe の初回応答だけ values を欠落させ、設定フィールドの描画中に
// desc.values[f.key] の参照エラーを起こす。2 回目以降は正常な応答へ戻すことで、
// Electron アプリを再起動せずに同じ画面から復帰できるかを検証する。
async function installRecoverableDescribeFailure(win) {
  await win.evaluate(() => {
    const vkIpc = window.VKIpc;
    const originalInvoke = vkIpc.invoke.bind(vkIpc);
    const descriptor = {
      available: true,
      title: '描画エラー復帰テスト',
      note: '',
      targetPath: '/tmp/render-error-recovery.json',
      appVersion: '0.0.0-test',
      hasMultipleTargets: false,
      targetPaths: ['/tmp/render-error-recovery.json'],
      groups: [{
        label: 'テストグループ',
        targetPaths: ['/tmp/render-error-recovery.json'],
        fields: [{ key: 'sample', label: 'サンプル値', type: 'text' }],
      }],
      values: { sample: '復帰後の初期値' },
    };

    window.__settingsDescribeCalls = 0;
    vkIpc.invoke = (channel, ...args) => {
      if (channel !== 'settings:describe') return originalInvoke(channel, ...args);
      window.__settingsDescribeCalls += 1;
      if (window.__settingsDescribeCalls === 1) {
        const { values: _values, ...descriptorWithoutValues } = descriptor;
        return Promise.resolve(descriptorWithoutValues);
      }
      return Promise.resolve(descriptor);
    };
  });
}

test.describe('設定パネル描画エラー後のロック解放（issue #259）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-render-error-',
      // 実環境の設定スキーマに左右されないよう、renderer 側で応答を差し替える。
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test('描画失敗後も作りかけの要素を残さず、再起動なしで正常に開き直せる', async () => {
    await installRecoverableDescribeFailure(win);
    const settingsButton = win.locator('#settings-btn');

    // 1 回目は values の欠落で描画を失敗させる。実際の設定ボタンから開く経路を使う。
    await settingsButton.click();
    await expect.poll(
      () => win.evaluate(() => window.__settingsDescribeCalls),
      { message: 'settings:describe の初回応答が処理されること' }
    ).toBe(1);

    // 描画自体は失敗するため、モーダルも作りかけの overlay も画面に残らない。
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('.settings-overlay')).toHaveCount(0);

    // IPC 応答は 2 回目から正常に戻る。同じ Electron プロセスのまま再度ボタンを押すと、
    // ロックが解放済みなので設定パネルを正常に開き直せる。
    await settingsButton.click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.locator('#set-field-0')).toHaveValue('復帰後の初期値');
    await expect.poll(() => win.evaluate(() => window.__settingsDescribeCalls)).toBe(2);

    // 開いたパネルは通常どおり入力でき、設定ボタンを連続クリックしても 2 枚に増えない。
    await win.locator('#set-field-0').fill('操作できる');
    await expect(win.locator('#set-field-0')).toHaveValue('操作できる');
    // overlay は背面のボタンへの物理クリックを遮るため、ボタン要素自身へ連続 click
    // イベントを送る。これで設定ボタンのイベントハンドラを通る二重起動要求を再現する。
    await settingsButton.evaluate((button) => {
      button.click();
      button.click();
    });
    await expect(win.locator('.settings-modal')).toHaveCount(1);
    await expect(win.locator('.settings-overlay')).toHaveCount(1);

    // 通常の閉じる操作でもロックが解放され、さらにもう一度開けることを確認する。
    await win.locator('.settings-close').click();
    await expect(win.locator('.settings-overlay')).toHaveCount(0);
    await settingsButton.click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.locator('.settings-modal')).toHaveCount(1);

    // 背景の暗い部分をクリックする従来の閉じ方も、復帰後のパネルで機能する。
    await win.locator('.settings-overlay').click({ position: { x: 5, y: 5 } });
    await expect(win.locator('.settings-overlay')).toHaveCount(0);
  });
});
