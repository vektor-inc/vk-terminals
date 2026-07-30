const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// renderer の window.VKIpc.invoke（renderer 側の中継レイヤ／issue #268）を差し替え、settings:describe の応答を注入する。
// これは main.js の settings:describe が返す形（group ごとに targetPaths を持ち、
// hasMultipleTargets / targetPath / targetPaths を含む）を模したもの。
// describeTargetPaths / describeSettingsValues のユニットテストは別途担保されているため、
// ここでは「describe の応答を renderer がどう表示するか」に絞って検証する。
async function installMultiTargetDescriptor(win) {
  await win.evaluate(() => {
    const vkIpc = window.VKIpc;
    const desc = {
      available: true,
      title: 'マルチターゲット設定',
      note: '',
      // マルチターゲット時はトップレベル targetPath は空（各 group が別ファイル）。
      targetPath: '',
      appVersion: '0.0.0-test',
      hasMultipleTargets: true,
      targetPaths: ['/tmp/group-a.json', '/tmp/group-b.json'],
      groups: [
        {
          label: 'グループA',
          targetPaths: ['/tmp/group-a.json'],
          fields: [{ key: 'aValue', label: 'A の値', type: 'text' }],
        },
        {
          label: 'グループB',
          targetPaths: ['/tmp/group-b.json'],
          fields: [{ key: 'bValue', label: 'B の値', type: 'text' }],
        },
      ],
      values: { aValue: '', bValue: '' },
    };
    vkIpc.invoke = (channel) => {
      if (channel === 'settings:describe') return Promise.resolve(desc);
      if (channel === 'settings:save') return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    };
  });
}

// 単一ターゲット（従来 descriptor）の describe 応答を注入する。
async function installSingleTargetDescriptor(win) {
  await win.evaluate(() => {
    const vkIpc = window.VKIpc;
    const desc = {
      available: true,
      title: '単一ターゲット設定',
      note: '',
      targetPath: '/tmp/single-config.json',
      appVersion: '0.0.0-test',
      hasMultipleTargets: false,
      targetPaths: ['/tmp/single-config.json'],
      groups: [
        {
          label: 'グループA',
          // 単一ターゲット時も describe は group ごとの targetPaths を返しうるが、
          // hasMultipleTargets が false なので renderer は group 別表示を出さない。
          targetPaths: ['/tmp/single-config.json'],
          fields: [{ key: 'aValue', label: 'A の値', type: 'text' }],
        },
      ],
      values: { aValue: '' },
    };
    vkIpc.invoke = (channel) => {
      if (channel === 'settings:describe') return Promise.resolve(desc);
      if (channel === 'settings:save') return Promise.resolve({ ok: true });
      return Promise.resolve(null);
    };
  });
}

test.describe.serial('設定モーダルのマルチターゲット表示（PR #160）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-multitarget-',
      // 実環境の VK_TERMINALS_APP_TITLE / VK_TERMINALS_SETTINGS の中和はヘルパーの既定。
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  // 各テストの後に閉じるボタンでモーダルを閉じる（二重オープン抑止のロックを確実に解放し、
  // 次テストで再オープンできるようにする。Escape でも閉じるが、閉じ処理を確定させるため
  // 閉じるボタンを明示クリックし、DOM から detach されるまで待つ）。
  test.afterEach(async () => {
    const closeBtn = win.locator('.settings-close');
    if (await closeBtn.count()) {
      await closeBtn.click().catch(() => {});
    } else {
      await win.keyboard.press('Escape');
    }
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
  });

  test('マルチターゲット: ヘッダー下に案内、各 fieldset 直下に group 別保存先が表示される', async () => {
    // 前テストのモーダルが残っていないことを保証してから開く。
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    await installMultiTargetDescriptor(win);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });

    // ヘッダー下の案内文（単一パスではなく項目またはグループごとに異なる旨）。
    const targetNotice = win.locator('.settings-target');
    await expect(targetNotice).toHaveText('保存先: 項目またはグループごとに異なります（各項目・グループの下に表示）');

    // 各 group（fieldset）直下に保存先パス表示（.settings-group-target）が出る。
    const groupTargets = win.locator('.settings-group-target');
    await expect(groupTargets).toHaveCount(2);
    await expect(groupTargets.nth(0)).toContainText('/tmp/group-a.json');
    await expect(groupTargets.nth(1)).toContainText('/tmp/group-b.json');

    // 保存先パスは fieldset.settings-group の中（legend 直後）にある。
    const firstGroupTargetInFieldset = win.locator('fieldset.settings-group', { has: win.locator('.settings-group-target') });
    await expect(firstGroupTargetInFieldset).toHaveCount(2);

    // ヘッダー案内が単一パス表示（code 要素）を含まないこと。
    await expect(win.locator('.settings-target code')).toHaveCount(0);
  });

  test('単一ターゲット: 従来どおり単一パス表示、group 別保存先は出ない（挙動不変）', async () => {
    // 前テストのモーダルが残っていないことを保証してから開く。
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    await installSingleTargetDescriptor(win);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    // 単一ターゲットのモーダルが描画され切るまで待つ（前テストの残骸ではないことを確認）。
    await expect(win.locator('.settings-modal h2')).toContainText('単一ターゲット設定');

    // ヘッダー下は単一パスを code で表示。
    const targetNotice = win.locator('.settings-target');
    await expect(targetNotice).toContainText('保存先:');
    await expect(win.locator('.settings-target code')).toHaveText('/tmp/single-config.json');

    // 「グループごとに異なります」の案内は出ない。
    await expect(targetNotice).not.toContainText('グループごとに異なります');

    // group 別保存先表示は 1 つも出ない。
    await expect(win.locator('.settings-group-target')).toHaveCount(0);
  });
});
