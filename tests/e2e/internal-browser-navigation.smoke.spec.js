'use strict';
const { test: base, expect, _electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// 実アプリの設定やPTYを使わず、専用BrowserWindowと実WebContentsViewで遷移を検証する。
const test = base.extend({
  browserHarness: async ({}, use) => {
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-browser-navigation-'));
    let electronApp;
    let releaseImage;
    let imageReleased = false;
    const server = http.createServer((request, response) => {
      if (request.url === '/slow') return;
      if (request.url === '/image') {
        if (imageReleased) response.end();
        else releaseImage = () => response.end();
        return;
      }
      response.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (request.url === '/canonical-start') {
        response.end('<img src="/image"><script>history.replaceState({}, "", "/canonical#ready")</script>');
      } else response.end('<a id="link" href="/destination">移動する</a>');
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const origin = `http://127.0.0.1:${server.address().port}`;
      const entry = path.join(temporary, 'main.cjs');
      fs.mkdirSync(path.join(temporary, 'profile'));
      const implementation = path.resolve(__dirname, '../../utils/internalBrowser.js');
      fs.writeFileSync(entry, `
        const { app, BrowserWindow, webContents } = require('electron');
        app.setPath('userData', ${JSON.stringify(path.join(temporary, 'profile'))});
        app.whenReady().then(() => {
          const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
          const states = [];
          window.webContents.send = (channel, state) => { if (channel === 'internal-browser:state') states.push(state); };
          const browser = require(${JSON.stringify(implementation)}).createInternalBrowser(window);
          globalThis.browserTest = { browser, states, contents: () => webContents.getAllWebContents().find(c => c.id !== window.webContents.id) };
        });
      `);
      electronApp = await _electron.launch({ args: [entry] });
      await expect.poll(() => electronApp.evaluate(() => !!globalThis.browserTest)).toBe(true);
      await use({ electronApp, origin, releaseImage: () => { imageReleased = true; releaseImage?.(); } });
    } finally {
      if (electronApp) await electronApp.close();
      server.closeAllConnections();
      if (server.listening) await new Promise(resolve => server.close(resolve));
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  },
});

for (const trigger of ['link', 'location.replace']) {
  test(`${trigger}: Enterの保留を置換した実遷移が完了する`, async ({ browserHarness: { electronApp, origin } }) => {
    await electronApp.evaluate((_electron, url) => globalThis.browserTest.browser.navigate(url), `${origin}/source`);
    await expect.poll(() => electronApp.evaluate(() => globalThis.browserTest.states.at(-1).navigationResult)).toBe('completed');
    await electronApp.evaluate((_electron, url) => globalThis.browserTest.browser.navigate(url, false, 1), `${origin}/slow`);
    // 旧文書からのリンク/location置換で新遷移が始まった後、stopが呼ばれる不具合を再現する。
    await electronApp.evaluate((_electron, trigger) => globalThis.browserTest.contents().executeJavaScript(
      trigger === 'link' ? 'document.getElementById("link").click()' : 'location.replace("/destination")'
    ), trigger);
    await expect.poll(() => electronApp.evaluate(() => {
      const state = globalThis.browserTest.states.at(-1);
      return { url: state.url, result: state.navigationResult };
    })).toEqual({ url: `${origin}/destination`, result: 'completed' });
    expect(await electronApp.evaluate(() => globalThis.browserTest.states.some(state => state.navigationRequestId === 1 && state.navigationResult === 'superseded'))).toBe(true);
  });
}

test('load前のreplaceStateを実WebContentsの確定URLに反映する', async ({ browserHarness: { electronApp, origin, releaseImage } }) => {
  await electronApp.evaluate((_electron, url) => globalThis.browserTest.browser.navigate(url, false, 1), `${origin}/canonical-start`);
  // 画像を保留し、frame commitとloadの間にcanonical更新が済んだことを確認する。
  await expect.poll(() => electronApp.evaluate(() => globalThis.browserTest.contents()?.getURL())).toBe(`${origin}/canonical#ready`);
  expect(await electronApp.evaluate(() => globalThis.browserTest.states.at(-1).navigationResult)).toBe(null);
  releaseImage();
  await expect.poll(() => electronApp.evaluate(() => {
    const state = globalThis.browserTest.states.at(-1);
    return { url: state.url, result: state.navigationResult };
  })).toEqual({ url: `${origin}/canonical#ready`, result: 'completed' });
});
