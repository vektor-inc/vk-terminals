const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// HTTP API へ JSON を送る（API・自動処理からのペイン追加を再現する）。
async function post(port, pathname, payload) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

// 1400px のウィンドウで、ペインを開かずに起動する。
async function start(prefix) {
  const port = await getFreePort();
  const launched = await launchAppAndWait({ port, prefix, config: { confirmClose: 'never', openInitialPane: false } });
  await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1400, 800));
  await expect.poll(() => launched.win.evaluate(() => innerWidth)).toBe(1400);
  return { ...launched, port };
}

// 左サイドバーを開閉し、アプリ内ブラウザを開く。
async function openBrowser(win, { sidebar }) {
  await win.evaluate((open) => setSidebarOpen(open, { focusFirst: false }), sidebar);
  await win.locator('#internal-browser-toggle').click();
  await expect(win.locator('#root')).toHaveClass(/\binternal-browser-open\b/);
}

const wideButton = (win) => win.locator('.internal-browser-toolbar [data-action="wide"]');
const browserWidth = (win) => win.locator('#internal-browser-sidebar').evaluate(element => Math.round(element.getBoundingClientRect().width));
const gridOrder = (win) => win.evaluate(() => tree.order.slice());

// @title 広く表示でペインを全部格納し、もう一度押すと元の並びと比率に戻る
test('広く表示でペインを全部格納し、もう一度押すと元の並びと比率に戻る', async () => {
  const launched = await start('vk-terminals-e2e-browser-wide-');
  const { win } = launched;
  try {
    // @step ペインを 3 枚開き、1 枚をオーケストレーターと同じ閉鎖保護にし、列の幅を手動で変えておく
    const ids = await win.evaluate(async () => {
      const a = (await addPane(null, { noClaude: true })).paneId;
      const b = (await addPane(null, { noClaude: true })).paneId;
      const c = (await addPane(null, { noClaude: true })).paneId;
      terminals[b].lock = { close: false };
      tree.colFr = [3, 1];
      tree.rowFr = [2, 1];
      render();
      return { a, b, c };
    });
    const savedWidth = await win.evaluate(() => localStorage.getItem('vk-terminals.internalBrowserWidth'));

    // @step 左サイドバーを開いた状態でアプリ内ブラウザを開き、「ブラウザを広く表示」を押す
    await openBrowser(win, { sidebar: true });
    const normalWidth = await browserWidth(win);
    await expect(wideButton(win)).toHaveAttribute('aria-label', 'ブラウザを広く表示');
    await expect(wideButton(win)).not.toHaveAttribute('aria-pressed', /.*/);
    await wideButton(win).click();

    // @check 閉鎖保護のペインも含めて全ペインがサイドバーへ格納され、グリッドが消える
    await expect(win.locator('.pane')).toHaveCount(0);
    for (const id of Object.values(ids)) await expect(win.locator(`.stash-item[data-id="${id}"]`)).toHaveCount(1);
    await expect(win.locator('.grid')).toBeHidden();
    // @check ブラウザが左サイドバーを除いたメインエリアの全幅になり、幅変更の境界は隠れる
    const expected = await win.evaluate(() => Math.round(document.getElementById('root').clientWidth - document.getElementById('sidebar').getBoundingClientRect().width));
    await expect.poll(() => browserWidth(win)).toBe(expected);
    expect(expected).toBeGreaterThan(normalWidth);
    await expect(win.locator('.internal-browser-resizer')).toBeHidden();
    // @check ボタンの文言が「元の表示に戻す」に変わり、押した状態の背景色が付く
    await expect(wideButton(win)).toHaveAttribute('aria-label', '元の表示に戻す');
    await expect(wideButton(win)).toHaveAttribute('title', '元の表示に戻す');
    await expect(wideButton(win)).toBeFocused();
    expect(await wideButton(win).evaluate(button => getComputedStyle(button).backgroundColor)).toBe('rgb(33, 38, 45)');

    // @step 「元の表示に戻す」を押す
    await wideButton(win).click();
    // @check ペインが元の順でグリッドに戻り、手動で変えた列・行の比率も戻る
    await expect(win.locator('.pane')).toHaveCount(3);
    expect(await gridOrder(win)).toEqual([ids.a, ids.b, ids.c]);
    expect(await win.evaluate(() => [tree.colFr, tree.rowFr])).toEqual([[3, 1], [2, 1]]);
    // @check ブラウザ幅は広く表示前に戻り、保存済みの幅は上書きされていない
    await expect.poll(() => browserWidth(win)).toBe(normalWidth);
    await expect(win.locator('.internal-browser-resizer')).toBeAttached();
    expect(await win.evaluate(() => localStorage.getItem('vk-terminals.internalBrowserWidth'))).toBe(savedWidth);
    await expect(wideButton(win)).toHaveAttribute('aria-label', 'ブラウザを広く表示');
  } finally {
    await closeApp(launched);
  }
});

// @title 広く表示中に増えたペイン・閉じたペインの扱い
test('広く表示中に API で増えたペインは格納のまま残し、閉じたペインは戻さない', async () => {
  const launched = await start('vk-terminals-e2e-browser-wide-api-');
  const { win, port } = launched;
  try {
    // @step ペインを 2 枚開き、アプリ内ブラウザを広く表示にする
    const ids = await win.evaluate(async () => {
      const a = (await addPane(null, { noClaude: true })).paneId;
      const b = (await addPane(null, { noClaude: true })).paneId;
      return { a, b };
    });
    await openBrowser(win, { sidebar: true });
    await wideButton(win).click();
    await expect(win.locator('.pane')).toHaveCount(0);

    // @step 外部のプログラムから API でペインを 2 枚追加する（1 枚は格納指定つき）
    const created = await post(port, '/api/new-pane', { noClaude: true });
    expect(created.status).toBe(200);
    const stashedByApi = await post(port, '/api/new-pane', { noClaude: true, stashed: true });
    expect(stashedByApi.status).toBe(200);
    const apiIds = await win.evaluate(({ created, stashed }) => ({
      created: Object.keys(terminals).find(id => terminals[id].termId === created),
      stashed: Object.keys(terminals).find(id => terminals[id].termId === stashed),
    }), { created: created.body.termId, stashed: stashedByApi.body.termId });
    // @check 広く表示は続き、追加されたペインはサイドバーに格納される
    await expect(win.locator('#root')).toHaveClass(/\binternal-browser-wide\b/);
    await expect(win.locator('.pane')).toHaveCount(0);
    await expect(win.locator(`.stash-item[data-id="${apiIds.created}"]`)).toHaveCount(1);

    // @step 格納中のペインを 1 枚閉じてから、「元の表示に戻す」を押す
    await win.evaluate((id) => closePane(id, { force: true }), ids.b);
    await wideButton(win).click();
    // @check 閉じたペインは戻らず、API で追加したペインは末尾に戻り、格納指定のペインは格納のまま残る
    expect(await gridOrder(win)).toEqual([ids.a, apiIds.created]);
    await expect(win.locator(`.stash-item[data-id="${apiIds.stashed}"]`)).toHaveCount(1);
    // @check ペインの数が変わったため、比率は均等のまま戻る
    expect(await win.evaluate(() => [tree.colFr, tree.rowFr])).toEqual([null, null]);
  } finally {
    await closeApp(launched);
  }
});

// @title ペインをグリッドへ出す操作・ブラウザを閉じる操作で広く表示を解除する
test('格納ペインを戻す操作やブラウザを閉じる操作で広く表示を解除する', async () => {
  const launched = await start('vk-terminals-e2e-browser-wide-exit-');
  const { win } = launched;
  try {
    // @step ペインを 3 枚開き、アプリ内ブラウザを広く表示にする
    const ids = await win.evaluate(async () => {
      const a = (await addPane(null, { noClaude: true })).paneId;
      const b = (await addPane(null, { noClaude: true })).paneId;
      const c = (await addPane(null, { noClaude: true })).paneId;
      return { a, b, c };
    });
    await openBrowser(win, { sidebar: true });
    await wideButton(win).click();
    await expect(win.locator('.pane')).toHaveCount(0);

    // @step サイドバーで 2 枚目のペインの「グリッドへ戻す」を押す
    await win.locator(`.stash-item[data-id="${ids.b}"] .btn-stash-restore`).click();
    // @check 広く表示が解除され、格納したペインが全部元の順で戻り、選んだペインにフォーカスが移る
    await expect(win.locator('#root')).not.toHaveClass(/\binternal-browser-wide\b/);
    expect(await gridOrder(win)).toEqual([ids.a, ids.b, ids.c]);
    await expect(win.locator(`.pane[data-id="${ids.b}"]`)).toHaveClass(/\bfocused\b/);
    await expect(wideButton(win)).toHaveAttribute('aria-label', 'ブラウザを広く表示');

    // @step もう一度広く表示にしてから、操作列の「閉じる」を押す
    await wideButton(win).click();
    await expect(win.locator('.pane')).toHaveCount(0);
    await win.locator('.internal-browser-toolbar [data-action="close"]').click();
    // @check ブラウザが閉じ、格納したペインがグリッドへ戻る
    await expect(win.locator('#root')).not.toHaveClass(/\binternal-browser-open\b/);
    expect(await gridOrder(win)).toEqual([ids.a, ids.b, ids.c]);

    // @step ペインを 1 枚だけ広く表示にしてから、アプリ内ブラウザを広く表示にし、タイトルバーの開閉ボタンで閉じる
    await win.evaluate((id) => togglePaneFocusMode(id), ids.a);
    await expect(win.locator('.pane')).toHaveCount(1);
    await openBrowser(win, { sidebar: true });
    await wideButton(win).click();
    await expect(win.locator('.pane')).toHaveCount(0);
    await win.locator('#internal-browser-toggle').click();
    // @check ペインの広く表示は先に解除されており、閉じた後は 3 枚とも元の順でグリッドに戻る
    expect(await win.evaluate(() => paneFocusMode)).toBeNull();
    expect(await gridOrder(win)).toEqual([ids.a, ids.b, ids.c]);
  } finally {
    await closeApp(launched);
  }
});

// @title 左サイドバーを閉じているときは通知用に左 96px を残す
test('左サイドバーを閉じた広く表示ではトースト用に左 96px を残す', async () => {
  const launched = await start('vk-terminals-e2e-browser-wide-closed-sidebar-');
  const { win } = launched;
  try {
    // @step 左サイドバーを閉じたままペインを開き、アプリ内ブラウザを広く表示にする
    await win.evaluate(async () => { await addPane(null, { noClaude: true }); });
    await openBrowser(win, { sidebar: false });
    await wideButton(win).click();
    // @check ブラウザ幅がウィンドウ幅から 96px を引いた幅になる
    const rootWidth = await win.evaluate(() => document.getElementById('root').clientWidth);
    await expect.poll(() => browserWidth(win)).toBe(rootWidth - 96);
  } finally {
    await closeApp(launched);
  }
});
