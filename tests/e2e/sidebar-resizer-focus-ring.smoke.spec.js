const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// .sidebar-resizer は、アプリ内で唯一 outline-offset を意図的に「内側」（-2px）にしている
// 例外（renderer/style.css の .sidebar-resizer:focus-visible）。幅 8px の帯の外側に
// 通常どおり 2px の枠を出すと隣接ペインへ食い込むため、outline は内側オフセットにし、
// さらに box-shadow の inset で内側の線を重ねて描いている。
//
// settings-focus-ring.smoke.spec.js は設定パネル内（.settings-modal 配下）の要素だけを
// 見るテストで、設定ディスクリプタの差し込み等セットアップが専用になっている。
// .sidebar-resizer は設定パネルの外（常設のサイドバー）にあり、そのセットアップは不要な
// ため、別ファイルに分離した（issue #302）。

async function launchSidebarResizerApp(port) {
  return await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-sidebar-resizer-focus-ring-' });
}

// キーボード由来のフォーカスでないと :focus-visible は当たらない
// （settings-focus-ring.smoke.spec.js の focusByKeyboard と同じ手法）。
async function focusByKeyboard(win, selector) {
  await win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} が見つからない`);
    el.scrollIntoView({ block: 'center' });
    el.focus();
  }, selector);
  await win.keyboard.press('Tab');
  await win.keyboard.press('Shift+Tab');
  await expect(win.locator(selector).first()).toBeFocused();
  expect(
    await win.evaluate((sel) => document.querySelector(sel).matches(':focus-visible'), selector),
    `${selector} が :focus-visible にならない`
  ).toBe(true);
}

test('サイドバーの幅リサイズハンドルは、キーボードフォーカス時に内側オフセットの枠と内側の線を描く（issue #302）', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchSidebarResizerApp(port);
  try {
    // issue #169 以降、起動直後からサイドバーが開いており .sidebar-resizer も表示される
    // （閉じているときは display: none でフォーカス対象からも外れるため、開状態が前提）。
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    const resizer = win.locator('.sidebar-resizer');
    await expect(resizer).toBeVisible();

    await focusByKeyboard(win, '.sidebar-resizer');

    const style = await win.evaluate(() => {
      const el = document.querySelector('.sidebar-resizer');
      const s = getComputedStyle(el);
      return {
        outlineColor: s.outlineColor,
        outlineStyle: s.outlineStyle,
        outlineWidth: s.outlineWidth,
        outlineOffset: s.outlineOffset,
        boxShadow: s.boxShadow,
      };
    });

    // 色・太さ・スタイルはアプリ共通の値（shared.css の --vktm--outline--focus-ring）だが、
    // offset だけ共通の外側 2px ではなく内側 -2px の個別上書きが効いている。
    expect(style.outlineColor, '.sidebar-resizer の outline-color').toBe('rgb(88, 166, 255)');
    expect(style.outlineStyle, '.sidebar-resizer の outline-style').toBe('solid');
    expect(style.outlineWidth, '.sidebar-resizer の outline-width').toBe('2px');
    expect(style.outlineOffset, '.sidebar-resizer の outline-offset').toBe('-2px');

    // box-shadow の inset（内側の線）が重なって描かれている。
    // computed 値の書式はブラウザ依存のため、色・inset キーワード・広がり 2px の存在で判定する。
    expect(style.boxShadow, '.sidebar-resizer の box-shadow').toContain('inset');
    expect(style.boxShadow, '.sidebar-resizer の box-shadow の色').toContain('rgb(88, 166, 255)');
    expect(style.boxShadow, '.sidebar-resizer の box-shadow の広がり').toContain('2px');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
