const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// 麗美が e2e レビューで追加した、issue #257 の修正（renderer/escapeLayer.js）に対するデグレ確認。
//
// escape-modal-layer.smoke.spec.js が「モーダルが開いている間の Escape」を担保するのに対し、
// こちらは「モーダルが無い / モーダルの外にフォーカスがある」ときに従来の Escape 経路が
// 壊れていないかを見る。capture フェーズの見張りは document 全体へ効くため、ここが壊れると
// ターミナルで Vim の挿入モードを抜けられなくなるなど実害が大きい。

// メインプロセス側に terminal:input の控えを仕掛ける。
// 既存ハンドラはそのまま残るので、PTY への送信自体には干渉しない。
async function installTerminalInputSpy(app) {
  await app.evaluate(({ ipcMain }) => {
    globalThis.__escapeSpyInputs = [];
    globalThis.__escapeSpyListener = (_event, _id, data) => {
      globalThis.__escapeSpyInputs.push(String(data));
    };
    ipcMain.on('terminal:input', globalThis.__escapeSpyListener);
  });
}

// 控えを空にし、直前の操作で送られた入力を持ち越さないようにする。
async function resetTerminalInputSpy(app) {
  await app.evaluate(() => { globalThis.__escapeSpyInputs = []; });
}

// 控えの中に ESC（\x1b 単体）が含まれるか。
async function sawEscapeInput(app) {
  return await app.evaluate(
    () => (globalThis.__escapeSpyInputs || []).some((data) => data === '\u001b')
  );
}

// 先頭ペインの xterm 入力欄（.xterm-helper-textarea）へフォーカスを当てる。
async function focusTerminal(win) {
  const paneId = await win.evaluate(() => document.querySelector('.pane')?.dataset.id || '');
  expect(paneId).not.toBe('');
  const textarea = win.locator(`.pane[data-id="${paneId}"] .xterm-helper-textarea`);
  await textarea.focus();
  await expect(textarea).toBeFocused();
  return paneId;
}

test.describe.serial('Escape レイヤー導入後のデグレ確認（issue #257）', () => {
  let port;
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    port = await getFreePort();
    const launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-escape-regression-',
    });
    app = launched.app;
    win = launched.win;
    tmpRoot = launched.tmpRoot;
    await installTerminalInputSpy(app);
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  // 各テストはサイドバー・モーダルの状態を前提にするため、開始時に必ず揃える。
  test.beforeEach(async () => {
    await win.evaluate(() => {
      document.querySelector('.settings-close')?.click();
      document.querySelector('.confirm-cancel')?.click();
    });
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('.confirm-overlay')).toHaveCount(0);
    const sidebarOpen = await win.locator('#root').evaluate(
      (root) => root.classList.contains('sidebar-open')
    );
    if (!sidebarOpen) await win.locator('#menu-btn').click();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
    await resetTerminalInputSpy(app);
  });

  test('モーダルが無いときの Escape はターミナルへ届く', async () => {
    // サイドバーが開いていても、フォーカスがターミナルにある間は Escape が
    // PTY まで到達する（Vim の挿入モード脱出などが従来どおり効く）。
    await focusTerminal(win);
    await win.keyboard.press('Escape');

    await expect.poll(() => sawEscapeInput(app)).toBe(true);
  });

  test('設定パネルが開いている間はターミナルへ Escape を通さない', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    // パネルを開いたままターミナルへフォーカスを移し、そこで Escape を押す。
    // capture フェーズの見張りが先に消費するため、PTY へは何も送られない。
    await focusTerminal(win);
    await resetTerminalInputSpy(app);
    await win.keyboard.press('Escape');

    await expect(win.locator('.settings-modal')).toHaveCount(0);
    expect(await sawEscapeInput(app)).toBe(false);
    // フォーカスがパネルの外にあったので、歯車ボタンへは引き戻さない。
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
    await win.waitForTimeout(400);
    const activeId = await win.evaluate(
      () => (document.activeElement && document.activeElement.id) || ''
    );
    expect(activeId).not.toBe('settings-btn');
    expect(activeId).not.toBe('menu-btn');

    // 閉じたあとは見張りが外れ、同じ操作で再び ESC が PTY へ届く。
    await resetTerminalInputSpy(app);
    await win.keyboard.press('Escape');
    await expect.poll(() => sawEscapeInput(app)).toBe(true);
  });

  test('サイドバーだけが開いた状態の Escape は従来どおりサイドバーを閉じる', async () => {
    // ターミナル以外（☰ ボタン）にフォーカスがある平常時の経路。
    await win.locator('#menu-btn').focus();
    await win.keyboard.press('Escape');

    await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
    await expect
      .poll(() => win.evaluate(() => (document.activeElement && document.activeElement.id) || ''))
      .toBe('menu-btn');
  });

  test('重なった確認ダイアログは最前面から順に 1 つずつ閉じる', async () => {
    // 設定パネルの上に確認ダイアログを重ね、Escape が LIFO で消費されるかを見る。
    // 確認ダイアログはペインの ✕ から開くが、設定パネルが前面にあるとクリックできないため
    // 同じ関数を直接呼ぶ。
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    const paneId = await win.evaluate(() => document.querySelector('.pane')?.dataset.id || '');
    await win.evaluate((id) => window.openCloseConfirmDialog(id), paneId);
    await expect(win.locator('.confirm-overlay')).toBeVisible();

    // 1 回目: 最後に開いた確認ダイアログだけが閉じ、設定パネルは残る。
    await win.keyboard.press('Escape');
    await expect(win.locator('.confirm-overlay')).toHaveCount(0);
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // 2 回目: 設定パネルが閉じる。サイドバーはまだ開いたまま。
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // 3 回目: ようやくサイドバーが閉じ、☰ へフォーカスが戻る。
    await win.keyboard.press('Escape');
    await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
    await expect
      .poll(() => win.evaluate(() => (document.activeElement && document.activeElement.id) || ''))
      .toBe('menu-btn');
  });

  test('IME 変換中の Escape はパネルもサイドバーも閉じない', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    // Playwright の keyboard では isComposing を立てられないため、変換中の Escape を
    // 合成イベントで再現する（入力欄から bubbles させ、document の capture へ届かせる）。
    await win.locator('#set-field-0').focus();
    await win.locator('#set-field-0').evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    });

    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // 変換確定後の Escape は従来どおりパネルだけを閉じる。
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
  });

  test('✕ / キャンセルで閉じても操作元のボタンへフォーカスが戻る', async () => {
    // ✕ ボタン
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('.settings-close').click();
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#settings-btn')).toBeFocused();

    // キャンセルボタン
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('.settings-cancel').click();
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#settings-btn')).toBeFocused();

    // どちらもサイドバーは開いたまま。
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
  });

  // mousedown の既定動作より先にパネルを閉じても、フォーカスの復帰先を維持する。
  test('背景クリックで閉じても操作元のボタンへフォーカスが戻る', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('.settings-overlay').click({ position: { x: 4, y: 4 } });
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#settings-btn')).toBeFocused();
  });
});
