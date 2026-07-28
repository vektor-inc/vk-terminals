const { test, expect } = require('@playwright/test');
const builtinDescriptor = require('../../settings-schema.json');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// ipcRenderer.invoke を差し替え、組み込みの「外出先から確認」タブへ、実際のスキーマでは
// 再現できない 100 文字超のコマンドを注入する。保存はこのテストでは行わない。
async function installDescriptor(win, desc) {
  await win.evaluate((descriptor) => {
    const { ipcRenderer } = require('electron');
    if (!window.__origInvoke) window.__origInvoke = ipcRenderer.invoke.bind(ipcRenderer);
    ipcRenderer.invoke = (channel, ...args) => {
      if (channel === 'settings:describe') return Promise.resolve(descriptor);
      if (channel === 'settings:save') return Promise.resolve({ ok: true });
      return window.__origInvoke(channel, ...args);
    };
  }, desc);
}

async function restoreInvoke(win) {
  await win.evaluate(() => {
    const { ipcRenderer } = require('electron');
    if (!window.__origInvoke) return;
    ipcRenderer.invoke = window.__origInvoke;
    delete window.__origInvoke;
  });
}

function descriptorWithLongCommand() {
  const descriptor = structuredClone(builtinDescriptor);
  descriptor.available = true;
  descriptor.targetPath = '/tmp/settings.json';
  descriptor.appVersion = '0.0.0-test';
  descriptor.values = {};
  const mobileTab = descriptor.tabs.find((tab) => tab.id === 'mobile');
  const command = `curl https://example.test/${'unbroken-command-segment-'.repeat(8)}done`;
  const target = mobileTab.content.find(
    (block) => block.type === 'code' && block.text === 'tailscale serve --bg 13847'
  );
  target.text = command;
  // コピーボタンの有無で Tab 停止位置を変えず、組み込みスキーマと同じ構造を保つ。
  return { descriptor, command };
}

const TAB_MOBILE = '#settings-tab-1';
const PANEL_MOBILE = '#settings-panel-1';

test.describe.serial('設定パネルの長いコードとキーボード停止位置（issue #267）', () => {
  let app;
  let win;
  let tmpRoot;
  let command;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-code-wrap-',
      env: { VK_TERMINALS_APP_TITLE: '', VK_TERMINALS_SETTINGS: '' },
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    const injected = descriptorWithLongCommand();
    command = injected.command;
    await installDescriptor(win, injected.descriptor);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    await win.locator(TAB_MOBILE).click();
  });

  test.afterEach(async () => {
    const closeButton = win.locator('.settings-close');
    if (await closeButton.count() && await closeButton.isVisible()) {
      await closeButton.click().catch(() => {});
    }
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    await restoreInvoke(win).catch(() => {});
  });

  test('長いコマンドを枠内で折り返し、コード自身を Tab 停止位置に増やさない', async () => {
    const code = win.locator(`${PANEL_MOBILE} .settings-content-code`, { hasText: command });
    await expect(code).toHaveCount(1);

    // 整数丸めによる 1px の誤差だけを許し、横方向にはみ出していないことを確かめる。
    const box = await code.evaluate((el) => ({
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
    }));
    expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);

    // 折り返して全文を読めるため、pre 自体は余分なキーボード停止位置にしない。
    await expect(code).not.toHaveAttribute('tabindex');
  });

  test('「外出先から確認」タブの Tab キー停止位置は期待数から増えない', async () => {
    await win.locator('.settings-close').focus();

    // モーダル先頭の閉じるボタンから Tab を送り、モーダル外へ出るまでを 1 周として数える。
    // 上限を設け、予期しないフォーカス循環が起きても無限ループにしない。
    const stops = ['button.settings-close'];
    let leftModal = false;
    for (let i = 0; i < 20; i += 1) {
      await win.keyboard.press('Tab');
      const current = await win.evaluate(() => {
        const el = document.activeElement;
        if (!el) return { stop: '(none)', inModal: false };
        const className = typeof el.className === 'string'
          ? el.className.trim().split(/\s+/).filter(Boolean).join('.')
          : '';
        const stop = el.id
          ? `#${el.id}`
          : `${el.tagName.toLowerCase()}${className ? `.${className}` : ''}`;
        return { stop, inModal: Boolean(el.closest('.settings-modal')) };
      });
      if (!current.inModal) {
        leftModal = true;
        break;
      }
      stops.push(current.stop);
    }

    expect(leftModal, `Tab がモーダル外へ進まない: ${stops.join(' -> ')}`).toBe(true);
    expect(stops, `実測した停止位置: ${stops.join(' -> ')}`).toHaveLength(9);
  });
});
