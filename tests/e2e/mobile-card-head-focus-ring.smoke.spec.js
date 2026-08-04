const { test, expect, chromium } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #302: .card-head（renderer/mobile.js が作るペインカードのヘッダー帯。
// role="button" tabindex="0"）は、親の .card（renderer/mobile.css: overflow: hidden +
// border-radius）の最初の直下要素で、左右上が親の内側の境界にぴったり接している。
// shared.css の網羅指定がそのまま外向き 2px の枠を出すと、枠の大半が親の
// overflow: hidden に切り取られて輪郭が途中で欠ける。renderer/mobile.css の
// .card-head:focus-visible が outline-offset: -2px へ個別上書きしていることを、
// 実際の mobile.html 描画で確かめる。
//
// 検証手法は既存の mobile 系 spec（mobile-title-link.smoke.spec.js 等）を踏襲する。
// --no-claude で Electron を起動すると素のシェルのペインが 1 枚だけ作られるため、
// 追加のデータ注入なしで chromium から mobile.html を開けば .card-head が実描画される。

// GET /api/states を叩き、少なくとも 1 件のペインが現れるまで待つ。
async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return json.terminals || {};
}

async function waitForAnyPane(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      if (Object.keys(states).length > 0) return;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('ペインが時間内に現れなかった');
}

// キーボード由来のフォーカスでないと :focus-visible は当たらない
// （settings-focus-ring.smoke.spec.js の focusByKeyboard と同じ手法）。
async function focusByKeyboard(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} が見つからない`);
    el.scrollIntoView({ block: 'center' });
    el.focus();
  }, selector);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator(selector).first()).toBeFocused();
  expect(
    await page.evaluate((sel) => document.querySelector(sel).matches(':focus-visible'), selector),
    `${selector} が :focus-visible にならない`
  ).toBe(true);
}

test('モバイル版のペインカードの見出し（.card-head）は、キーボードフォーカス時に内側オフセットの個別上書きが効く（issue #302）', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp({ port, prefix: 'vk-terminals-e2e-mobile-card-head-focus-ring-' });
  const browser = await chromium.launch();
  try {
    await waitForAnyPane(port);

    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    const cardHead = page.locator('.card-head').first();
    await expect(cardHead).toBeVisible();

    await focusByKeyboard(page, '.card-head');

    const style = await page.evaluate(() => {
      const el = document.querySelector('.card-head');
      const s = getComputedStyle(el);
      return {
        color: s.outlineColor,
        style: s.outlineStyle,
        width: s.outlineWidth,
        offset: s.outlineOffset,
      };
    });

    // 色・太さ・スタイルはアプリ共通の値のまま、offset だけ内側 -2px になっている
    // （親 .card の overflow: hidden に外向きの枠が切り取られるため）。
    expect(style, '.card-head のフォーカスリング').toEqual({
      color: 'rgb(88, 166, 255)',
      style: 'solid',
      width: '2px',
      offset: '-2px',
    });
  } finally {
    await browser.close();
    await closeApp({ app, tmpRoot });
  }
});
