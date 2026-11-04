const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// @title 再起動案内を開き、確認ダイアログをキャンセルできる
// @step 状態ファイルを置いて起動し、サイドバーの「設定を確認」を押す
// @check 対象タブの先頭に案内が出て、キャンセル後もアプリが動作する
// Electron の native dialog は renderer の DOM 外なので showMessageBox を本体側で観測する。
test('再起動が必要な設定への案内とキャンセル', async () => {
  const port = await getFreePort();
  const launched = await launchAppAndWait({
    port,
    prefix: 'vk-restart-required-e2e-',
    seedHome: ({ configDir }) => fs.writeFileSync(path.join(configDir, 'restart-required.json'), JSON.stringify({ restartRequired: true, tabs: ['mobile'] })),
  });
  try {
    const { app, win } = launched;
    // 起動直後の状態取得と定期更新を待ち、初回描画のタイミングに依存させない。
    await expect(win.locator('#sidebar-restart-required')).toBeVisible({ timeout: 10000 });
    expect(await win.locator('#sidebar-menu').evaluate((nav) => {
      const notice = nav.querySelector('#sidebar-restart-required');
      const menu = nav.querySelector('.sidebar-menu-inner');
      return !!(notice.compareDocumentPosition(menu) & Node.DOCUMENT_POSITION_FOLLOWING);
    })).toBe(true);
    await win.locator('#sidebar-restart-required button').click();
    await expect(win.locator('#settings-panel-1')).toBeVisible();
    await expect(win.locator('#settings-panel-1 .settings-restart-notice')).toBeVisible();
    await expect(win.locator('.settings-modal')).toHaveAttribute('aria-describedby', 'settings-tab-1 settings-restart-mobile');
    expect(await win.locator('.settings-view-config').evaluate((el) => el.scrollTop)).toBe(0);
    await app.evaluate(({ dialog }) => {
      const original = dialog.showMessageBox;
      dialog.showMessageBox = async (...args) => {
        globalThis.__restartDialogOptions = args.at(-1);
        return { response: 0 };
      };
      globalThis.__restoreRestartDialog = () => { dialog.showMessageBox = original; };
    });
    await win.locator('#settings-panel-1 .settings-restart-button').click();
    await expect.poll(() => app.evaluate(() => globalThis.__restartDialogOptions?.title)).toBe('アプリを再起動しますか？');
    expect(await app.evaluate(() => globalThis.__restartDialogOptions.defaultId)).toBe(0);
    expect(await app.evaluate(() => globalThis.__restartDialogOptions.cancelId)).toBe(0);
    await expect(win.locator('#settings-panel-1')).toBeVisible();
    // 確認を保留している間の連打でも、ネイティブダイアログは一つに保つ。
    await app.evaluate(({ dialog }) => {
      globalThis.__restartDialogCount = 0;
      dialog.showMessageBox = () => {
        globalThis.__restartDialogCount += 1;
        return new Promise((resolve) => { globalThis.__cancelRestartDialog = () => resolve({ response: 0 }); });
      };
    });
    await win.locator('#settings-panel-1 .settings-restart-button').click();
    await expect.poll(() => app.evaluate(() => globalThis.__restartDialogCount)).toBe(1);
    await win.locator('#settings-panel-1 .settings-restart-button').click();
    expect(await app.evaluate(() => globalThis.__restartDialogCount)).toBe(1);
    await app.evaluate(() => globalThis.__cancelRestartDialog());
    await app.evaluate(() => globalThis.__restoreRestartDialog());
    await win.locator('#settings-panel-1 .settings-restart-button').focus();
    fs.writeFileSync(path.join(launched.tmpHome, '.vk-terminals', 'restart-required.json'), JSON.stringify({ restartRequired: false, tabs: [] }));
    await expect(win.locator('#sidebar-restart-required')).toBeHidden({ timeout: 10000 });
    await expect(win.locator('#settings-tab-1')).toBeFocused();
    await expect(win.locator('#settings-panel-1 .settings-restart-notice')).toBeHidden();
    // 開いた起点の案内が消えても、閉じた後は常設の設定ボタンへ戻す。
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#sidebar-settings button')).toBeFocused();
  } finally {
    await closeApp(launched);
  }
});

for (const restartRequired of [false, true]) {
  // @title サイドバーを開くと表示中の先頭メニューへフォーカスする
  // @step 再起動案内の有無それぞれで、キーボードからサイドバーを開く
  // @check 非表示の案内を飛ばし、表示中は「設定を確認」へ移る
  test(`サイドバーの初期フォーカス（再起動案内${restartRequired ? '表示' : '非表示'}）`, async () => {
    const port = await getFreePort();
    const launched = await launchAppAndWait({
      port,
      prefix: 'vk-sidebar-first-focus-e2e-',
      seedHome: ({ configDir }) => fs.writeFileSync(path.join(configDir, 'restart-required.json'), JSON.stringify({ restartRequired, tabs: restartRequired ? ['mobile'] : [] })),
    });
    try {
      const { win } = launched;
      const notice = win.locator('#sidebar-restart-required');
      if (restartRequired) await expect(notice).toBeVisible({ timeout: 10000 });
      else await expect(notice).toBeHidden();
      // 初期設定に依存せず閉じ、実際の開閉ボタンをキーボードで操作する。
      await win.evaluate(() => setSidebarOpen(false, { focusFirst: false }));
      await expect(win.locator('#menu-btn')).toHaveAttribute('aria-expanded', 'false');
      await win.locator('#menu-btn').focus();
      await win.keyboard.press('Enter');
      await expect(win.locator('#menu-btn')).toHaveAttribute('aria-expanded', 'true');
      const expected = restartRequired ? '#sidebar-restart-required button' : '#sidebar-settings button';
      await expect(win.locator(expected)).toBeFocused();
      if (!restartRequired) await expect(notice.locator('button')).not.toBeFocused();
    } finally {
      await closeApp(launched);
    }
  });
}

for (const originDisappears of [true, false]) {
  // @title サイドバーを畳んだ後はタイトルバーへフォーカスを戻す
  // @step サイドバーから設定を開き、起点の表示状態を変えてサイドバーを畳む
  // @check 起点が消えた場合も残る場合も、閉じた後はタイトルバーの設定ボタンへ戻る
  test(`サイドバーを畳んだ設定パネルのフォーカス復帰（起点${originDisappears ? '非表示' : '残存'}）`, async () => {
    const port = await getFreePort();
    const launched = await launchAppAndWait({
      port,
      prefix: 'vk-restart-focus-e2e-',
      seedHome: ({ configDir }) => fs.writeFileSync(path.join(configDir, 'restart-required.json'), JSON.stringify({ restartRequired: true, tabs: ['mobile'] })),
    });
    try {
      const { win } = launched;
      await win.locator('#sidebar-restart-required button').click();
      await expect(win.locator('.settings-modal')).toBeVisible();
      if (originDisappears) {
        fs.writeFileSync(path.join(launched.tmpHome, '.vk-terminals', 'restart-required.json'), JSON.stringify({ restartRequired: false, tabs: [] }));
        await expect(win.locator('#sidebar-restart-required')).toBeHidden({ timeout: 10000 });
      }
      // モーダル表示中は背景が inert のため、実際の開閉関数を直接呼ぶ。
      await win.evaluate(() => setSidebarOpen(false, { focusFirst: false }));
      await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
      await win.keyboard.press('Escape');
      await expect(win.locator('.settings-modal')).toHaveCount(0);
      await expect(win.locator('#settings-btn')).toBeFocused();
    } finally {
      await closeApp(launched);
    }
  });
}

// @title 再起動状態の取得失敗で設定パネルの表示を妨げない
// @step 不正な応答と IPC 例外を順に返し、設定パネルを開く
// @check すべて空状態になり、設定パネルを開閉できる
test('再起動状態の不正な応答と IPC 例外を空状態として扱う', async () => {
  const launched = await launchAppAndWait({ port: await getFreePort(), prefix: 'vk-restart-invalid-e2e-' });
  try {
    const { win } = launched;
    const cases = [null, 42, 'invalid', [], {}, { restartRequired: 'true', tabs: [] },
      { restartRequired: true, tabs: null }, { restartRequired: true, tabs: [42] }, 'throw'];
    for (const response of cases) {
      // 再起動状態以外の IPC は実装に委譲して設定パネル自体を検証する。
      await win.evaluate(async (value) => {
        window.__restartOriginalInvoke ??= VKIpc.invoke;
        VKIpc.invoke = (channel, ...args) => {
          if (channel !== 'app:restart-required') return window.__restartOriginalInvoke(channel, ...args);
          if (value === 'throw') throw new Error('restart state unavailable');
          return Promise.resolve(value);
        };
        await refreshRestartRequired();
        await window.openSettingsModal();
      }, response);
      await expect(win.locator('.settings-modal')).toBeVisible();
      await expect(win.locator('#sidebar-restart-required')).toBeHidden();
      expect(await win.locator('.settings-restart-notice:visible').count()).toBe(0);
      await win.locator('.settings-close').click();
      await expect(win.locator('.settings-modal')).toHaveCount(0);
    }
  } finally {
    await closeApp(launched);
  }
});
