const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// Electron 32 で File.path が削除されたため、renderer は preload が公開する
// VKFiles.getPath を通して実ファイルの絶対パスを取得する。この経路を実際の File で
// 確認し、contextBridge 越しの型変換を含めて回帰を検出する。
test.describe.serial('File のパス取得（issue #397）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-file-path-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test('空白とシングルクォートを含む実ファイルの絶対パスを返す', async () => {
    const filePath = path.join(tmpRoot, "dropped file's path.txt");
    fs.writeFileSync(filePath, 'vk-terminals', 'utf8');

    // setInputFiles で Chromium が生成した File を取得するため、一時的な input を使う。
    await win.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'e2e-file-path-input';
      document.body.appendChild(input);
    });
    await win.locator('#e2e-file-path-input').setInputFiles(filePath);

    const actualPath = await win.locator('#e2e-file-path-input').evaluate((input) => (
      window.VKFiles.getPath(input.files[0])
    ));
    expect(actualPath).toBe(filePath);
  });

  test('File 以外を渡すと例外にならず空文字を返す', async () => {
    expect(await win.evaluate(() => window.VKFiles.getPath({}))).toBe('');
  });
});
