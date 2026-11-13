'use strict';
const { test: base, expect, _electron } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

// 実アプリの設定やPTYを使わず、専用BrowserWindowと実WebContentsViewで遷移を検証する。
const test = base.extend({
  browserHarness: async ({}, use, testInfo) => {
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
      const pageNavigation = path.resolve(__dirname, '../helpers/pageNavigation.js');
      fs.writeFileSync(entry, `
        const { app, BrowserWindow, WebContentsView } = require('electron');
        app.setPath('userData', ${JSON.stringify(path.join(temporary, 'profile'))});
        app.whenReady().then(() => {
          const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
          const states = [];
          const trace = [];
          let contents;
          let heldResponse;
          class TracedView extends WebContentsView {
            constructor(options) {
              super(options);
              contents = this.webContents;
              // コマンド応答待ちとイベント不足を区別し、失敗時に初期化順も確認する。
              for (const [target, method] of [[contents, 'loadURL'], [contents.debugger, 'sendCommand']]) {
                const original = target[method].bind(target);
                target[method] = (...args) => {
                  trace.push({ method, args });
                  const response = original(...args).then(result => {
                    trace.push({ method, result: result ?? null });
                    return result;
                  }, error => {
                    trace.push({ method, error: error.message });
                    throw error;
                  });
                  if (method === 'sendCommand' && args[0] === 'Page.navigate' && args[1].url === heldResponse?.url) {
                    const held = heldResponse;
                    // Chromium の実応答は記録し、アプリへの配送だけを遅らせる。
                    // ERR_ABORTED が will-navigate より先でも「旧応答待ち」の条件を保つ。
                    held.delivery = response.then(async result => {
                      held.result = result;
                      await held.gate;
                      return result;
                    }, async error => {
                      held.error = error.message;
                      await held.gate;
                      throw error;
                    });
                    return held.delivery;
                  }
                  return response;
                };
              }
              contents.debugger.on('message', (_event, method, params) => {
                if (method.startsWith('Page.') || method.startsWith('Network.')) trace.push({ event: method, params });
              });
              contents.on('will-navigate', event => trace.push({ event: 'will-navigate', url: event.url }));
            }
          }
          window.webContents.send = (channel, state) => {
            if (channel === 'internal-browser:state') { states.push(state); trace.push({ state }); }
          };
          const browser = require(${JSON.stringify(implementation)}).createInternalBrowser(window, { ...require('electron'), WebContentsView: TracedView });
          globalThis.browserTest = {
            browser, states, trace, contents: () => contents,
            preparePageNavigation: trigger => require(${JSON.stringify(pageNavigation)}).prepareLoadingPageNavigation(contents, trigger),
            navigateFromPage: () => require(${JSON.stringify(pageNavigation)}).navigateFromLoadingPage(contents),
            holdNavigationResponse: url => {
              let release;
              const gate = new Promise(resolve => { release = resolve; });
              heldResponse = { url, gate, release };
            },
            releaseNavigationResponse: async () => {
              if (!heldResponse?.delivery) throw new Error('Held navigation was not sent');
              heldResponse.release();
              await heldResponse.delivery.catch(() => {});
              // 本番の Page.navigate 継続処理と catch の配送まで終える。
              await new Promise(resolve => setImmediate(resolve));
              browser.publish();
              return { result: heldResponse.result, error: heldResponse.error };
            },
          };
        });
      `);
      electronApp = await _electron.launch({ args: [entry] });
      await expect.poll(() => electronApp.evaluate(() => !!globalThis.browserTest)).toBe(true);
      await use({ electronApp, origin, releaseImage: () => { imageReleased = true; releaseImage?.(); } });
    } finally {
      // 成功時も、実CDP応答・Electronイベント・公開状態の前後関係を残す。
      if (electronApp) {
        try {
          const diagnostics = await electronApp.evaluate(() => ({
            states: globalThis.browserTest?.states,
            trace: globalThis.browserTest?.trace,
            url: globalThis.browserTest?.contents()?.getURL(),
          }));
          await testInfo.attach('navigation-trace', { body: JSON.stringify(diagnostics, null, 2), contentType: 'application/json' });
        } catch { /* Electron 自体が終了した場合も後片付けを続ける。 */ }
      }
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
    expect(await electronApp.evaluate(() => globalThis.browserTest.contents().getURL())).toBe(`${origin}/source`);
    expect(await electronApp.evaluate(() => globalThis.browserTest.contents().executeJavaScript('document.getElementById("link").textContent'))).toBe('移動する');
    await electronApp.evaluate((_electron, trigger) => globalThis.browserTest.preparePageNavigation(trigger), trigger);
    const pending = await electronApp.evaluate((_electron, url) => {
      const harness = globalThis.browserTest;
      harness.holdNavigationResponse(url);
      harness.browser.navigate(url, false, 1);
      return harness.states.at(-1);
    }, `${origin}/slow`);
    expect(pending).toMatchObject({
      url: `${origin}/source`, pendingUrl: `${origin}/slow`, navigationRequestId: 1, navigationResult: null,
    });
    // Page.navigate が送信され、実際に応答待ちになってから旧文書を操作する。
    await expect.poll(() => electronApp.evaluate(() => globalThis.browserTest.contents().isLoading())).toBe(true);
    await expect.poll(() => electronApp.evaluate((_electron, url) => globalThis.browserTest.trace.some(entry =>
      entry.method === 'sendCommand' && entry.args?.[0] === 'Page.navigate' && entry.args[1].url === url), `${origin}/slow`)).toBe(true);
    // 旧文書からのリンク/location置換で新遷移が始まった後、stopが呼ばれる不具合を再現する。
    await electronApp.evaluate(() => globalThis.browserTest.navigateFromPage());
    await expect.poll(() => electronApp.evaluate(() => {
      const state = globalThis.browserTest.states.at(-1);
      return { url: state.url, result: state.navigationResult };
    })).toEqual({ url: `${origin}/destination`, result: 'completed' });
    expect(await electronApp.evaluate(() => globalThis.browserTest.contents().getURL())).toBe(`${origin}/destination`);
    const beforeRelease = await electronApp.evaluate(() => globalThis.browserTest.states.slice());
    const oldStates = beforeRelease.filter(state => state.navigationOperationId === pending.navigationOperationId);
    // 他の要求や別世代の superseded を成功として拾わない。
    expect(oldStates.filter(state => state.navigationResult !== null)).toEqual([{
      ...oldStates.at(-1), navigationRequestId: 1, navigationResult: 'superseded',
      pendingUrl: `${origin}/slow`, url: `${origin}/source`,
    }]);
    const completed = beforeRelease.at(-1);
    expect(completed).toMatchObject({
      navigationOperationId: pending.navigationOperationId + 1,
      navigationRequestId: null, navigationResult: 'completed', pendingUrl: '',
      url: `${origin}/destination`, failedUrl: '', downloadUrl: '',
    });
    // 実 Chromium が返した旧応答を新文書の完了後に配送し、状態を全項目比較する。
    const oldResponse = await electronApp.evaluate(() => globalThis.browserTest.releaseNavigationResponse());
    expect(oldResponse).toEqual({ result: expect.objectContaining({ errorText: 'net::ERR_ABORTED' }), error: undefined });
    const afterRelease = await electronApp.evaluate(() => globalThis.browserTest.states.slice());
    expect(afterRelease.slice(beforeRelease.length)).toEqual([completed]);
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
