const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #282: 設定パネル・ペインを閉じる確認ダイアログのフォーカス制御。
//
// どちらも aria-modal="true" と宣言しているのに、実際には Tab で背後のペインの ✕ や
// タイトルバーの ☰ / ⚙ へ抜けられていた。ここでは
//   1. 開いた時点でモーダルの中へフォーカスが入る
//   2. Tab / Shift+Tab がモーダルの中で循環し、背後へ到達しない
//   3. 表示中は背後が inert で、閉じたら元に戻る
// を実際のキー操作で確かめる。

// 連続して Tab（または Shift+Tab）を送り、各停止位置と「モーダルの中かどうか」を集める。
// 停止位置は失敗時のメッセージにそのまま出せるよう、id かタグ + クラスで表す。
async function collectTabStops(win, { times, shift = false, container }) {
  const stops = [];
  for (let i = 0; i < times; i += 1) {
    await win.keyboard.press(shift ? 'Shift+Tab' : 'Tab');
    stops.push(await win.evaluate((selector) => {
      const el = document.activeElement;
      if (!el || el === document.body) return { label: '(body)', inside: false };
      const className = typeof el.className === 'string'
        ? el.className.trim().split(/\s+/).filter(Boolean).join('.')
        : '';
      return {
        label: el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}${className ? `.${className}` : ''}`,
        inside: Boolean(el.closest(selector)),
      };
    }, container));
  }
  return stops;
}

function describeStops(stops) {
  return stops.map((stop) => stop.label).join(' -> ');
}

// モーダルの背後にある代表的な操作。issue #282 以前はここへ Tab で到達できていた。
// ☰ / ⚙ はタイトルバー、btn-close はペインの ✕。モーダル内の要素名（settings-close /
// confirm-close-pane など）とは重ならないので、部分一致で判定してよい。
const BACKGROUND_CONTROLS = ['menu-btn', 'settings-btn', 'btn-close'];

// 背後の無効化は inert プロパティで見る（属性の書き方に依存させない）。
async function isInert(win, selector) {
  return await win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} が見つからない`);
    return el.inert === true;
  }, selector);
}

test.describe.serial('モーダルのフォーカストラップ（issue #282）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-modal-focus-trap-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  // 各テストはモーダルが無い状態から始める。サイドバーも開いておき、背後に
  // Tab の停止位置（サイドバーのボタン群）がある状態で確かめる。
  test.beforeEach(async () => {
    await win.evaluate(() => {
      document.querySelector('.confirm-cancel')?.click();
      document.querySelector('.settings-close')?.click();
    });
    await expect(win.locator('.settings-overlay')).toHaveCount(0);
    await expect(win.locator('.confirm-overlay')).toHaveCount(0);
    const sidebarOpen = await win.locator('#root').evaluate(
      (root) => root.classList.contains('sidebar-open')
    );
    if (!sidebarOpen) await win.locator('#menu-btn').click();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
  });

  test('設定パネルを開いた直後、フォーカスはパネル内の先頭の操作対象にある', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    // 先頭の操作対象はヘッダーの ✕。開いた直後の Tab がパネルの中から始まる。
    await expect(win.locator('.settings-close')).toBeFocused();
  });

  test('設定パネル表示中は Tab を連打してもパネルの外へ出ない', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    // パネル内の停止位置の数より十分多く送り、循環していることまで見る。
    const stops = await collectTabStops(win, { times: 30, container: '.settings-modal' });

    expect(
      stops.every((stop) => stop.inside),
      `Tab がパネル外へ抜けた: ${describeStops(stops)}`
    ).toBe(true);
    // 背後の代表的な操作（☰ / ⚙ / ペインの ✕）へは 1 度も到達しない。
    // クラスの増減に影響されないよう、要素の識別子を部分一致で見る。
    for (const name of BACKGROUND_CONTROLS) {
      expect(describeStops(stops)).not.toContain(name);
    }
    // 停止位置を実際に移動できている（Tab がすべて空振りしていない）ことの担保。
    expect(new Set(stops.map((stop) => stop.label)).size).toBeGreaterThan(1);
  });

  test('設定パネル表示中は Shift+Tab を連打してもパネルの外へ出ない', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    // 開いた直後は先頭にいるため、1 回目の Shift+Tab がそのまま「先頭からの逆行」になる。
    const stops = await collectTabStops(win, { times: 30, shift: true, container: '.settings-modal' });

    expect(
      stops.every((stop) => stop.inside),
      `Shift+Tab がパネル外へ抜けた: ${describeStops(stops)}`
    ).toBe(true);
    for (const name of BACKGROUND_CONTROLS) {
      expect(describeStops(stops)).not.toContain(name);
    }
    expect(new Set(stops.map((stop) => stop.label)).size).toBeGreaterThan(1);
  });

  test('設定パネル表示中は背後が無効化され、閉じると元に戻る', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    expect(await isInert(win, '.titlebar')).toBe(true);
    expect(await isInert(win, '#root')).toBe(true);

    // 無効化されているので、プログラムからのフォーカス移動も背後には入らない。
    await win.evaluate(() => document.getElementById('menu-btn').focus());
    expect(await win.evaluate(() => document.activeElement?.id || '')).not.toBe('menu-btn');

    await win.locator('.settings-close').click();
    await expect(win.locator('.settings-overlay')).toHaveCount(0);
    expect(await isInert(win, '.titlebar')).toBe(false);
    expect(await isInert(win, '#root')).toBe(false);
    // 無効化を解いてからフォーカスを戻すため、操作元の歯車まで戻れる。
    await expect(win.locator('#settings-btn')).toBeFocused();
  });

  test('確認ダイアログはキャンセルへフォーカスが入り、Tab で外へ出ない', async () => {
    const paneId = await win.evaluate(() => document.querySelector('.pane')?.dataset.id || '');
    expect(paneId).not.toBe('');
    const closeBtn = win.locator(`.pane[data-id="${paneId}"] .btn-close`);
    await closeBtn.focus();
    await win.evaluate((id) => window.openCloseConfirmDialog(id), paneId);
    await expect(win.locator('.confirm-overlay')).toBeVisible();

    // 既定は安全側（キャンセル）。ここは #257 以前から正しいので維持する。
    await expect(win.locator('.confirm-cancel')).toBeFocused();
    expect(await isInert(win, '#root')).toBe(true);

    const stops = await collectTabStops(win, { times: 8, container: '.confirm-modal' });
    expect(
      stops.every((stop) => stop.inside),
      `Tab がダイアログ外へ抜けた: ${describeStops(stops)}`
    ).toBe(true);

    // Shift+Tab も同じく閉じ込める。
    const backStops = await collectTabStops(win, { times: 8, shift: true, container: '.confirm-modal' });
    expect(
      backStops.every((stop) => stop.inside),
      `Shift+Tab がダイアログ外へ抜けた: ${describeStops(backStops)}`
    ).toBe(true);

    await win.keyboard.press('Escape');
    await expect(win.locator('.confirm-overlay')).toHaveCount(0);
    expect(await isInert(win, '#root')).toBe(false);
    await expect(closeBtn).toBeFocused();
    // キャンセル扱いなのでペインは残る。
    await expect(win.locator(`.pane[data-id="${paneId}"]`)).toHaveCount(1);
  });

  test('設定パネルに確認ダイアログを重ねて閉じても、設定パネルは操作できる状態へ戻る', async () => {
    // 重なり順は escapeLayer と同じ前提（後から開いたものが最前面）。最前面だけを
    // 閉じたときに、下のモーダルが無効化されたまま取り残されないことを見る。
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    const paneId = await win.evaluate(() => document.querySelector('.pane')?.dataset.id || '');
    await win.evaluate((id) => window.openCloseConfirmDialog(id), paneId);
    await expect(win.locator('.confirm-overlay')).toBeVisible();

    // 重なっている間は下の設定パネルも無効化する（背後の操作を止めるのが目的なので、
    // 「下のモーダル」も背後として扱う）。
    await expect(win.locator('.confirm-cancel')).toBeFocused();
    expect(await isInert(win, '.settings-overlay')).toBe(true);
    expect(await isInert(win, '.confirm-overlay')).toBe(false);

    await win.keyboard.press('Escape');
    await expect(win.locator('.confirm-overlay')).toHaveCount(0);

    // 設定パネルの無効化は解け、背後（タイトルバー・ペイン領域）は無効のまま。
    expect(await isInert(win, '.settings-overlay')).toBe(false);
    expect(await isInert(win, '.titlebar')).toBe(true);
    expect(await isInert(win, '#root')).toBe(true);

    // Tab は設定パネルの中で循環し続ける。
    const stops = await collectTabStops(win, { times: 12, container: '.settings-modal' });
    expect(
      stops.every((stop) => stop.inside),
      `ダイアログを閉じた後に Tab がパネル外へ抜けた: ${describeStops(stops)}`
    ).toBe(true);

    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-overlay')).toHaveCount(0);
    expect(await isInert(win, '.titlebar')).toBe(false);
    expect(await isInert(win, '#root')).toBe(false);
  });
});
