const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// レイアウト切り替えのアニメーション（issue #629）。
// 実アプリの renderer で、main へ送る IPC・遷移の開始・再フィットの呼び出しを記録して確かめる。

// 1400px のウィンドウで、ペインを開かずに起動する。
async function start(prefix) {
  const port = await getFreePort();
  const launched = await launchAppAndWait({ port, prefix, config: { confirmClose: 'never', openInitialPane: false } });
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 800));
  await expect.poll(() => launched.win.evaluate(() => innerWidth)).toBe(1400);
  return launched;
}

// main へ送る IPC と、遷移の開始・ターミナルの再フィットを記録する。
// 再フィットは「遷移の最中だったか」も一緒に残し、遷移中に PTY リサイズが飛んでいないかを見る。
async function startRecording(win) {
  await win.evaluate(() => {
    window.__layoutLog = { sends: [], transitions: 0, fits: [] };
    const send = VKIpc.send;
    VKIpc.send = (channel, ...args) => {
      if (channel === 'internal-browser:visible' || channel === 'internal-browser:bounds') {
        window.__layoutLog.sends.push({ channel, value: args[0], during: !!layoutTransition });
      }
      return send(channel, ...args);
    };
    const startViewTransition = document.startViewTransition.bind(document);
    document.startViewTransition = (...args) => { window.__layoutLog.transitions += 1; return startViewTransition(...args); };
    const fit = window.fitTerminal;
    window.fitTerminal = (...args) => { window.__layoutLog.fits.push({ during: !!layoutTransition }); return fit(...args); };
  });
}

const layoutLog = (win) => win.evaluate(() => window.__layoutLog);
const transitionActive = (win) => win.evaluate(() => !!layoutTransition);

// ページ領域の実際の位置（main へ送る bounds と同じ計算）。
const pageRect = (win) => win.evaluate(() => {
  const rect = document.querySelector('#internal-browser-sidebar .internal-browser-page').getBoundingClientRect();
  const zoom = window.VKWebFrame?.getZoomFactor?.() || 1;
  return { x: rect.x * zoom, y: rect.y * zoom, width: rect.width * zoom, height: rect.height * zoom };
});

// @title アプリ内ブラウザを開く・広く表示する間はページ表示を隠し、終わったら最終の位置で出し直す
test('アプリ内ブラウザを開く・広く表示する間はページ表示を隠し、終わったら最終の位置で出し直す', async () => {
  const launched = await start('vk-terminals-e2e-layout-transition-browser-');
  const { win } = launched;
  try {
    // @step ペインを 2 枚開き、IPC と再フィットの記録を始める
    await win.evaluate(async () => {
      await addPane(null, { noClaude: true });
      await addPane(null, { noClaude: true });
    });
    await startRecording(win);

    // @step タイトルバーのボタンでアプリ内ブラウザを開く
    await win.locator('#internal-browser-toggle').click();
    // @check 遷移が始まり、ブラウザが開いた状態になる
    await expect(win.locator('#root')).toHaveClass(/\binternal-browser-open\b/);
    await expect.poll(() => transitionActive(win)).toBe(false);
    let log = await layoutLog(win);
    expect(log.transitions).toBe(1);
    // @check 遷移の最中はページ表示を隠す指示（visible: false）だけを送り、表示する指示は送らない
    const during = log.sends.filter(entry => entry.channel === 'internal-browser:visible' && entry.during);
    expect(during.length).toBeGreaterThan(0);
    expect(during.every(entry => entry.value === false)).toBe(true);
    // @check 終わったら表示する指示を送り、最後に送った位置が実際のページ領域と一致する
    const visibles = log.sends.filter(entry => entry.channel === 'internal-browser:visible');
    expect(visibles.at(-1)).toEqual({ channel: 'internal-browser:visible', value: true, during: false });
    const lastBounds = log.sends.filter(entry => entry.channel === 'internal-browser:bounds').at(-1);
    expect(lastBounds.value).toEqual(await pageRect(win));
    // @check 遷移の最中にターミナルの再フィットをせず、終わってから合わせる
    expect(log.fits.some(entry => entry.during)).toBe(false);
    expect(log.fits.length).toBeGreaterThan(0);

    // @step 「ブラウザを広く表示」を押す
    await win.evaluate(() => { window.__layoutLog = { sends: [], transitions: 0, fits: [] }; });
    await win.locator('.internal-browser-toolbar [data-action="wide"]').click();
    await expect(win.locator('.pane')).toHaveCount(0);
    await expect.poll(() => transitionActive(win)).toBe(false);
    // @check 同じく遷移の間はページ表示を隠し、終わったら全幅の位置で出し直す
    log = await layoutLog(win);
    expect(log.transitions).toBe(1);
    expect(log.sends.filter(entry => entry.channel === 'internal-browser:visible' && entry.during).every(entry => entry.value === false)).toBe(true);
    expect(log.sends.filter(entry => entry.channel === 'internal-browser:visible').at(-1).value).toBe(true);
    expect(log.sends.filter(entry => entry.channel === 'internal-browser:bounds').at(-1).value).toEqual(await pageRect(win));
    // @check 押したボタンにフォーカスが残る
    await expect(win.locator('.internal-browser-toolbar [data-action="wide"]')).toBeFocused();
    // @check 遷移が終わるとペインとブラウザに付けた遷移用の名前が外れる
    expect(await win.evaluate(() => document.getElementById('internal-browser-sidebar').style.getPropertyValue('view-transition-name'))).toBe('');
  } finally {
    await closeApp(launched);
  }
});

// @title ペインを広く表示すると遷移の中で他のペインが格納され、終わってから再フィットする
test('ペインを広く表示すると遷移の中で他のペインが格納され、終わってから再フィットする', async () => {
  const launched = await start('vk-terminals-e2e-layout-transition-pane-');
  const { win } = launched;
  try {
    // @step ペインを 3 枚開き、記録を始める
    const ids = await win.evaluate(async () => [
      (await addPane(null, { noClaude: true })).paneId,
      (await addPane(null, { noClaude: true })).paneId,
      (await addPane(null, { noClaude: true })).paneId,
    ]);
    await startRecording(win);

    // @step 1 枚目の「このペインを広く表示」を押す
    await win.locator(`.pane[data-id="${ids[0]}"] .btn-focus-mode`).click();
    // @check 遷移が始まり、選んだペインだけがグリッドに残る
    await expect(win.locator('.pane')).toHaveCount(1);
    await expect.poll(() => transitionActive(win)).toBe(false);
    const log = await layoutLog(win);
    expect(log.transitions).toBe(1);
    // @check 遷移の最中に再フィットせず、終わってから合わせる
    expect(log.fits.some(entry => entry.during)).toBe(false);
    expect(log.fits.length).toBeGreaterThan(0);
    // @check 選んだペインにフォーカスが移る
    await expect.poll(() => win.evaluate(() => focusedPaneId)).toBe(ids[0]);

    // @step 「格納したペインを戻す」を押す
    await win.locator(`.pane[data-id="${ids[0]}"] .btn-focus-mode`).click();
    // @check 元の 3 枚がグリッドに戻る
    await expect(win.locator('.pane')).toHaveCount(3);
    await expect.poll(() => transitionActive(win)).toBe(false);
    expect((await layoutLog(win)).transitions).toBe(2);
  } finally {
    await closeApp(launched);
  }
});

// @title 遷移の途中で次の操作をすると、前の遷移を打ち切って最後の操作の状態へ即時に切り替える
test('遷移の途中で次の操作をすると、前の遷移を打ち切って最後の操作の状態へ即時に切り替える', async () => {
  const launched = await start('vk-terminals-e2e-layout-transition-skip-');
  const { win } = launched;
  try {
    // @step ペインを 1 枚開き、記録を始める
    await win.evaluate(async () => { await addPane(null, { noClaude: true }); });
    await startRecording(win);

    // @step 同じタスクの中でブラウザの開くボタンを 2 回押す（開いて、すぐ閉じる）
    const state = await win.evaluate(() => {
      const toggle = document.getElementById('internal-browser-toggle');
      toggle.click();
      toggle.click();
      return { open: internalBrowserOpen, active: !!layoutTransition };
    });
    // @check 2 回目の操作の時点で前の遷移は打ち切られ、ブラウザは閉じた状態に即時に切り替わる
    expect(state).toEqual({ open: false, active: false });
    await expect(win.locator('#root')).not.toHaveClass(/\binternal-browser-open\b/);
    // @check 最後に送った指示はページ表示を隠す指示（閉じた状態）になる
    await win.waitForTimeout(400);
    const visibles = (await layoutLog(win)).sends.filter(entry => entry.channel === 'internal-browser:visible');
    expect(visibles.at(-1).value).toBe(false);
    expect(await transitionActive(win)).toBe(false);
  } finally {
    await closeApp(launched);
  }
});

// 再フィットの実行回数（遷移の外で実際に合わせた回数）と、PTY へのリサイズ通知の回数を記録する。
async function startFitCounting(win) {
  await win.evaluate(() => {
    window.__fitCount = { fits: 0, resizes: 0 };
    const fit = window.fitAll;
    window.fitAll = (...args) => { if (!layoutTransition) window.__fitCount.fits += 1; return fit(...args); };
    const send = VKIpc.send;
    VKIpc.send = (channel, ...args) => {
      if (channel === 'terminal:resize') window.__fitCount.resizes += 1;
      return send(channel, ...args);
    };
  });
}

// @title 左サイドバーが一緒に開閉する遷移でも、再フィットは遷移の終わりの 1 回だけにする
test('左サイドバーが一緒に開閉する遷移でも、再フィットは遷移の終わりの 1 回だけにする', async () => {
  const launched = await start('vk-terminals-e2e-layout-transition-fit-once-');
  const { app, win } = launched;
  try {
    // @step ペインを 2 枚開き、左サイドバーを閉じておく
    const ids = await win.evaluate(async () => [
      (await addPane(null, { noClaude: true })).paneId,
      (await addPane(null, { noClaude: true })).paneId,
    ]);
    await win.evaluate(() => setSidebarOpen(false, { focusFirst: false }));
    await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
    await win.waitForTimeout(400);
    await startFitCounting(win);

    // @step 1 枚目の「このペインを広く表示」を押す（左サイドバーが自動で開く）
    await win.locator(`.pane[data-id="${ids[0]}"] .btn-focus-mode`).click();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
    await expect.poll(() => transitionActive(win)).toBe(false);
    // 左サイドバーの開閉完了待ち（220ms）より後まで待ってから数える。
    await win.waitForTimeout(500);
    // @check 再フィットは遷移の終わりの 1 回だけで、PTY へのリサイズ通知もグリッドのペイン 1 枚分を超えない
    let counts = await win.evaluate(() => window.__fitCount);
    expect(counts.fits).toBe(1);
    expect(counts.resizes).toBeLessThanOrEqual(1);

    // @step ウィンドウを狭くしてペインの広く表示を解除し、アプリ内ブラウザを開く（左サイドバーが自動で閉じる）
    await win.locator(`.pane[data-id="${ids[0]}"] .btn-focus-mode`).click();
    await expect(win.locator('.pane')).toHaveCount(2);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 800));
    await expect.poll(() => win.evaluate(() => innerWidth)).toBe(900);
    await expect.poll(() => transitionActive(win)).toBe(false);
    await win.waitForTimeout(400);
    await win.evaluate(() => { window.__fitCount.fits = 0; window.__fitCount.resizes = 0; });
    await win.locator('#internal-browser-toggle').click();
    await expect(win.locator('#root')).toHaveClass(/\binternal-browser-open\b/);
    await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
    await expect.poll(() => transitionActive(win)).toBe(false);
    await win.waitForTimeout(500);
    // @check こちらも再フィットは遷移の終わりの 1 回だけで、リサイズ通知はグリッドのペイン 2 枚分を超えない
    counts = await win.evaluate(() => window.__fitCount);
    expect(counts.fits).toBe(1);
    expect(counts.resizes).toBeLessThanOrEqual(2);
  } finally {
    await closeApp(launched);
  }
});

// @title 遷移の状態変更が反映される前に左サイドバーを操作しても、後からブラウザの開閉が巻き戻らない
test('遷移の状態変更が反映される前に左サイドバーを操作しても、後からブラウザの開閉が巻き戻らない', async () => {
  const launched = await start('vk-terminals-e2e-layout-transition-sidebar-');
  const { app, win } = launched;
  try {
    // @step 左右のサイドバーを同時に開けない 900px にし、ペインを 1 枚開いてアプリ内ブラウザを開く
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 800));
    await expect.poll(() => win.evaluate(() => innerWidth)).toBe(900);
    await win.evaluate(async () => { await addPane(null, { noClaude: true }); });
    await win.locator('#internal-browser-toggle').click();
    await expect(win.locator('#root')).toHaveClass(/\binternal-browser-open\b/);
    await expect.poll(() => transitionActive(win)).toBe(false);

    // @step 同じタスクの中で、タイトルバーのボタンでブラウザを閉じ、すぐにハンバーガーボタンで左サイドバーを開く
    await win.evaluate(() => {
      document.getElementById('internal-browser-toggle').click();
      document.getElementById('menu-btn').click();
    });
    await win.waitForTimeout(500);
    // @check ブラウザは閉じたまま再び開かず、左サイドバーは開いたまま
    await expect(win.locator('#root')).not.toHaveClass(/\binternal-browser-open\b/);
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
    expect(await win.evaluate(() => ({ browser: internalBrowserOpen, sidebar: sidebarOpen }))).toEqual({ browser: false, sidebar: true });

    // @step 同じタスクの中で、ブラウザを開き、すぐに Escape キーで左サイドバーを閉じる
    await win.evaluate(() => {
      document.getElementById('internal-browser-toggle').click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await win.waitForTimeout(500);
    // @check ブラウザは開いたまま、左サイドバーは閉じたまま
    expect(await win.evaluate(() => ({ browser: internalBrowserOpen, sidebar: sidebarOpen }))).toEqual({ browser: true, sidebar: false });
  } finally {
    await closeApp(launched);
  }
});

// @title 視差効果を減らす設定では、遷移もページ表示を隠す処理も行わず即時に切り替える
test('視差効果を減らす設定では、遷移もページ表示を隠す処理も行わず即時に切り替える', async () => {
  const launched = await start('vk-terminals-e2e-layout-transition-reduced-');
  const { win } = launched;
  try {
    // @step 視差効果を減らす設定を有効にし、ペインを 2 枚開いて記録を始める
    await win.emulateMedia({ reducedMotion: 'reduce' });
    const ids = await win.evaluate(async () => [
      (await addPane(null, { noClaude: true })).paneId,
      (await addPane(null, { noClaude: true })).paneId,
    ]);
    await startRecording(win);

    // @step ブラウザの開くボタンを押す
    const opened = await win.evaluate(() => {
      document.getElementById('internal-browser-toggle').click();
      return { open: document.getElementById('root').classList.contains('internal-browser-open'), active: !!layoutTransition };
    });
    // @check 押した直後に開いた状態になり、遷移は始まらない
    expect(opened).toEqual({ open: true, active: false });
    // @check ページ表示を隠す指示を送らず、表示する指示だけを送る
    let log = await layoutLog(win);
    expect(log.transitions).toBe(0);
    expect(log.sends.filter(entry => entry.channel === 'internal-browser:visible').map(entry => entry.value)).toEqual([true]);

    // @step ペインの「このペインを広く表示」を押す
    const focused = await win.evaluate((id) => {
      document.querySelector(`.pane[data-id="${id}"] .btn-focus-mode`).click();
      return document.querySelectorAll('.pane').length;
    }, ids[0]);
    // @check 押した直後に単独表示へ切り替わり、遷移は始まらない
    expect(focused).toBe(1);
    log = await layoutLog(win);
    expect(log.transitions).toBe(0);
  } finally {
    await closeApp(launched);
  }
});
