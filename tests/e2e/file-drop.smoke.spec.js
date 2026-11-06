const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// ペインへのドロップを実物の File と実物のシェルで確認する。
// ドロップの処理が画面・preload・main の経路で実際につながっていることも、ここで検出する。
test.describe.serial('ペインへのファイルドロップ', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port: await getFreePort(),
      prefix: 'vk-terminals-e2e-file-drop-',
    }));
    const screen = win.locator('.pane .xterm-screen').first();
    await expect(screen).toBeVisible();
    await screen.click();
    await win.keyboard.type(`cd '${tmpRoot.replace(/'/g, "'\\''")}'`);
    await win.keyboard.press('Enter');
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  async function dropFile(filePath) {
    await win.evaluate(() => {
      document.getElementById('e2e-file-drop-input')?.remove();
      const input = document.createElement('input');
      input.type = 'file';
      input.id = 'e2e-file-drop-input';
      document.body.appendChild(input);
    });
    await win.locator('#e2e-file-drop-input').setInputFiles(filePath);
    await win.evaluate(() => {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(document.getElementById('e2e-file-drop-input').files[0]);
      document.querySelector('.pane').dispatchEvent(new DragEvent('drop', {
        bubbles: true,
        cancelable: true,
        dataTransfer,
      }));
    });
  }

  test('空白と引用符を含むパスが 1 つの引数としてシェルへ渡る', async () => {
    const filePath = path.join(tmpRoot, "dropped file's $(path).txt");
    const outputPath = path.join(tmpRoot, 'argument.txt');
    fs.writeFileSync(filePath, 'vk-terminals', 'utf8');

    await win.keyboard.type("printf '%s' ");
    await dropFile(filePath);
    await expect.poll(() => win.evaluate(() => (
      document.querySelector('.pane .xterm-rows')?.textContent ?? ''
    ))).toContain('dropped');
    await win.keyboard.type(' > argument.txt');
    await win.keyboard.press('Enter');

    await expect.poll(() => (
      fs.existsSync(outputPath) ? fs.realpathSync(fs.readFileSync(outputPath, 'utf8')) : ''
    )).toBe(fs.realpathSync(filePath));
  });

  test('制御文字を含むパスは入力せず、トーストで知らせる', async () => {
    const markerName = 'drop-marker';
    const filePath = path.join(tmpRoot, `a\u0003touch ${markerName}\rb.txt`);
    fs.writeFileSync(filePath, 'vk-terminals', 'utf8');

    await dropFile(filePath);

    await expect(win.locator('.vk-toast-message')).toContainText('1 件のファイル');
    await win.waitForTimeout(500);
    expect(fs.existsSync(path.join(tmpRoot, markerName))).toBe(false);
  });
});
