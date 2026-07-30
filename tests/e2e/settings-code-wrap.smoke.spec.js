const { test, expect } = require('@playwright/test');
const path = require('path');
const builtinDescriptor = require('../../settings-schema.json');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// window.VKIpc.invoke（renderer 側の中継レイヤ／issue #268）を差し替え、組み込みの「外出先から確認」タブへ、実際のスキーマでは
// 再現できない 100 文字超のコマンドを注入する。保存はこのテストでは行わない。
async function installDescriptor(win, desc) {
  await win.evaluate((descriptor) => {
    const vkIpc = window.VKIpc;
    if (!window.__origInvoke) window.__origInvoke = vkIpc.invoke.bind(vkIpc);
    vkIpc.invoke = (channel, ...args) => {
      if (channel === 'settings:describe') return Promise.resolve(descriptor);
      if (channel === 'settings:save') return Promise.resolve({ ok: true });
      return window.__origInvoke(channel, ...args);
    };
  }, desc);
}

async function restoreInvoke(win) {
  await win.evaluate(() => {
    const vkIpc = window.VKIpc;
    if (!window.__origInvoke) return;
    vkIpc.invoke = window.__origInvoke;
    delete window.__origInvoke;
  });
}

function descriptorWithLongCommand(targetPath) {
  const descriptor = structuredClone(builtinDescriptor);
  descriptor.available = true;
  descriptor.targetPath = targetPath;
  descriptor.appVersion = '0.0.0-test';
  descriptor.values = {};
  const mobileTab = descriptor.tabs.find((tab) => tab.id === 'mobile');
  if (!mobileTab) throw new Error('settings-schema.json に mobile タブが無い');
  const command = `curl https://example.test/${'unbroken-command-segment-'.repeat(8)}done`;
  const target = mobileTab.content.find(
    (block) => block.type === 'code' && block.text === 'tailscale serve --bg 13847'
  );
  if (!target) throw new Error('mobile タブに "tailscale serve --bg 13847" の code ブロックが無い');
  target.text = command;
  // コピーボタンの有無で Tab 停止位置を変えず、組み込みスキーマと同じ構造を保つ。
  return { descriptor, command };
}

const TAB_MOBILE = '#settings-tab-1';
const PANEL_MOBILE = '#settings-panel-1';

test.describe.serial('設定パネルのコード折り返しとボタン境界色（issue #267）', () => {
  let app;
  let win;
  let tmpRoot;
  let command;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-code-wrap-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    // 起動ヘルパーが spec ごとに作成・後片付けする一時領域内だけを保存先として示す。
    const injected = descriptorWithLongCommand(path.join(tmpRoot, 'settings.json'));
    command = injected.command;
    await installDescriptor(win, injected.descriptor);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    await win.locator(TAB_MOBILE).click();
  });

  test.afterEach(async () => {
    const closeButton = win.locator('.settings-close');
    if ((await closeButton.count()) > 0 && await closeButton.isVisible()) {
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

  test('「外出先から確認」タブの Tab キー停止位置にコードブロックを含まない', async () => {
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
    // 停止位置が空振りしていないことの担保（本文が描かれず空パスするのを防ぐ）。
    expect(stops.some((stop) => stop.includes('settings-content-copy'))).toBe(true);
    // 本題の不変条件: 折り返したコードブロック（pre）は Tab 停止位置に現れない。
    // 停止位置の「数」を固定すると、説明コンテンツにリンクやコードブロックが増えただけで
    // 落ちるうえ、「pre が増えた」のかどうかも分からない。性質そのものを主張する。
    expect(
      stops.filter((stop) => stop.includes('settings-content-code')),
      `実測した停止位置: ${stops.join(' -> ')}`
    ).toEqual([]);
  });

  test('二次ボタンと保存ボタンの枠線の色が共通スタイルに上書きされない', async () => {
    await win.locator('#settings-tab-0').click();
    const save = win.locator('.settings-save');
    await expect(save).toBeVisible();
    // 共通ルール（.settings-footer button）が border-color を直接持つと詳細度で勝ち、
    // 保存ボタンの緑がグレー（#30363d）へ戻る。issue #267 の回帰をここで押さえる。
    await expect(save).toHaveCSS('border-color', 'rgb(46, 160, 67)');
    await expect(win.locator('.settings-cancel')).toHaveCSS('border-color', 'rgb(139, 148, 158)');
  });
});
