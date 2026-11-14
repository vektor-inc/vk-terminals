const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

const holderLauncherPath = path.resolve(__dirname, '..', 'fixtures', 'embeddedHolderLauncher.js');
const setupLauncherPath = path.resolve(__dirname, '..', 'fixtures', 'embeddedSetupLauncher.js');

// HTTP API へ JSON を送る（API・自動処理からのペイン追加を再現する）。
async function post(port, pathname, payload) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

// 1400px のウィンドウで、ペインを開かずに起動する。
async function start(prefix, options = {}) {
  const port = await getFreePort();
  const launched = await launchAppAndWait({ port, prefix, config: { confirmClose: 'never', openInitialPane: false }, ...options });
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
    // @check ボタンの文言が「元の表示に戻す」に変わり、押した状態の背景色が付き、ホバーすると一段明るくなる
    await expect(wideButton(win)).toHaveAttribute('aria-label', '元の表示に戻す');
    await expect(wideButton(win)).toHaveAttribute('title', '元の表示に戻す');
    await expect(wideButton(win)).toBeFocused();
    const background = () => wideButton(win).evaluate(button => getComputedStyle(button).backgroundColor);
    // 押した直後はポインターが重なっているため、ホバー時の一段明るい色になる。
    await wideButton(win).hover();
    await expect.poll(background).toBe('rgb(48, 54, 61)');
    // ポインターを外すと、押した状態の背景色が残る。
    await win.mouse.move(5, 400);
    await expect.poll(background).toBe('rgb(33, 38, 45)');

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

// @title 左サイドバーを閉じているときはブラウザを全幅にし、通知は右下に出してページを詰める
test('左サイドバーを閉じた広く表示ではブラウザを全幅にし、通知の表示中だけページの下端を詰める', async () => {
  const launched = await start('vk-terminals-e2e-browser-wide-closed-sidebar-');
  const { win } = launched;
  try {
    // @step 左サイドバーを閉じたままペインを開き、アプリ内ブラウザを広く表示にする
    await win.evaluate(async () => { await addPane(null, { noClaude: true }); });
    await openBrowser(win, { sidebar: false });
    await wideButton(win).click();
    // @check ブラウザが root の全幅になり、左右に帯を残さない
    const rootWidth = await win.evaluate(() => document.getElementById('root').clientWidth);
    await expect.poll(() => browserWidth(win)).toBe(rootWidth);
    expect(await win.locator('#internal-browser-sidebar').evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(0);

    // ページ領域（WebContentsView を置く範囲）の下端。通知が出ていないときの値を覚えておく。
    const pageArea = win.locator('.internal-browser-page');
    const pageBottom = async () => {
      const box = await pageArea.boundingBox();
      return box.y + box.height;
    };
    const fullBottom = await pageBottom();

    // @step 短い通知（トースト）を出す
    await win.evaluate(() => showGenericToast('ペインを閉じました'));
    const toast = win.locator('.vk-toast');
    await expect(toast).toBeVisible();
    // @check 通知は 1 行で表示される（語句の途中で折り返さない）
    const lines = await win.locator('.vk-toast-message').evaluate((element) => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight);
      return Math.round(element.getBoundingClientRect().height / lineHeight);
    });
    expect(lines).toBe(1);
    // @check 通知は画面の右下にあり、ページ領域の下端は通知の上端から 16px 以上空く（重ならない）
    const toastBox = await toast.boundingBox();
    expect(Math.round(toastBox.x + toastBox.width)).toBe(rootWidth - 16);
    await expect.poll(pageBottom).toBeLessThanOrEqual(toastBox.y - 16);

    // @step 通知を消す
    await win.evaluate(() => hideExternalUrlToast());
    await expect(toast).toBeHidden();
    // @check ページ領域の下端が元に戻る
    await expect.poll(pageBottom).toBe(fullBottom);
  } finally {
    await closeApp(launched);
  }
});

// @title 操作列のグループの間が、グループの中の間隔より広い
test('操作列は表示内容の操作と表示の操作の間を、グループ内のどの間隔より広く空ける', async () => {
  const launched = await start('vk-terminals-e2e-browser-wide-toolbar-gap-');
  const { win } = launched;
  try {
    // @step アプリ内ブラウザを開き、狭い幅（360px）と広く表示の両方で操作列の間隔を測る
    await openBrowser(win, { sidebar: true });
    // 見えている端を返す。ボタンはホバー・押した状態で背景（ボタンの箱）が見え、
    // 通常はアイコンの線だけが見える。アイコンは線の太さ（viewBox 単位で 2、半分の 1 が外側）を含める。
    const measure = () => win.evaluate(() => {
      const toolbar = document.querySelector('.internal-browser-toolbar');
      const iconEdges = (button) => {
        const svg = button.querySelector('svg');
        const use = svg.querySelector('use');
        const rect = svg.getBoundingClientRect();
        const scale = rect.width / 24;
        const box = use.getBBox();
        return { left: rect.left + (box.x - 1) * scale, right: rect.left + (box.x + box.width + 1) * scale };
      };
      const items = [...toolbar.children].map((element) => {
        const rect = element.getBoundingClientRect();
        const box = { left: rect.left, right: rect.right };
        // 入力欄は枠線が常に見える。ボタンは「アイコンだけ見える」と「背景が見える」の 2 通り。
        // 広く表示の押した状態は背景が常に見えるため、アイコンではなくボタンの箱が見えている端になる。
        if (element.tagName === 'INPUT') return { action: 'url', icon: box, box };
        const pressed = element.classList.contains('internal-browser-wide-toggle')
          && document.getElementById('root').classList.contains('internal-browser-wide');
        return { action: element.dataset.action, icon: pressed ? box : iconEdges(element), box };
      });
      return items;
    });
    const groups = [['back', 'forward', 'reload', 'url'], ['wide', 'external', 'close']];
    const check = async () => {
      const items = await measure();
      const byAction = Object.fromEntries(items.map(item => [item.action, item]));
      expect(items.map(item => item.action)).toEqual(groups.flat());
      // グループ内で最も広く見える間隔は、隣どうしがどちらもアイコンだけ見えているとき。
      const within = groups.flatMap(group => group.slice(1).map((action, index) => byAction[action].icon.left - byAction[group[index]].icon.right));
      // グループ間で最も狭く見える間隔は、右のグループの先頭（広く表示）の背景が見えているとき。
      const between = byAction.wide.box.left - byAction.url.box.right;
      return { within: Math.max(...within), between };
    };

    await win.evaluate(() => { preferredInternalBrowserWidth = 360; syncInternalBrowserLayout(); });
    await expect.poll(() => browserWidth(win)).toBe(360);
    // @check どの状態（通常・ホバー・押した状態）でも、グループ間 > グループ内の最大
    const narrow = await check();
    expect(narrow.between).toBeGreaterThan(narrow.within);

    await wideButton(win).click();
    await expect(win.locator('#root')).toHaveClass(/\binternal-browser-wide\b/);
    const wide = await check();
    expect(wide.between).toBeGreaterThan(wide.within);
  } finally {
    await closeApp(launched);
  }
});

// @title ペインを 1 枚だけ広く表示した状態から、ブラウザの広く表示へ切り替える
test('先頭以外のペインを単独表示した状態からブラウザを広く表示しても、元の並びに戻る', async () => {
  const launched = await start('vk-terminals-e2e-browser-wide-focus-');
  const { win } = launched;
  try {
    // @step ペインを 3 枚開き、3 枚目だけを「このペインを広く表示」にする
    const ids = await win.evaluate(async () => {
      const a = (await addPane(null, { noClaude: true })).paneId;
      const b = (await addPane(null, { noClaude: true })).paneId;
      const c = (await addPane(null, { noClaude: true })).paneId;
      return { a, b, c };
    });
    await win.locator(`.pane[data-id="${ids.c}"] .btn-focus-mode`).click();
    await expect(win.locator('.pane')).toHaveCount(1);

    // @step アプリ内ブラウザを開いて「ブラウザを広く表示」を押し、続けて「元の表示に戻す」を押す
    await openBrowser(win, { sidebar: true });
    await wideButton(win).click();
    await expect(win.locator('.pane')).toHaveCount(0);
    await wideButton(win).click();
    // @check 3 枚が単独表示の前と同じ順でグリッドに戻る
    await expect(win.locator('.pane')).toHaveCount(3);
    expect(await gridOrder(win)).toEqual([ids.a, ids.b, ids.c]);
    expect(await win.evaluate(() => paneFocusMode)).toBeNull();
  } finally {
    await closeApp(launched);
  }
});

// @title 広く表示中に使い方ガイドを開く
test('広く表示中に使い方ガイドを開くと、解除して元のペインの後ろにガイドを出す', async () => {
  const launched = await start('vk-terminals-e2e-browser-wide-guide-');
  const { win } = launched;
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

    // @step 使い方ガイドを開く（ガイドの起動処理は通常のペインで代用する）
    const guideId = await win.evaluate(async () => {
      const original = VKIpc.invoke.bind(VKIpc);
      VKIpc.invoke = async (channel, ...args) => (channel === 'help:open-guide'
        ? original('terminal:create', null, { noClaude: true })
        : original(channel, ...args));
      return openHelpGuide();
    });
    // @check 広く表示が解除され、元のペインの後ろにガイドのペインが並び、ガイドにフォーカスが移る
    await expect(win.locator('#root')).not.toHaveClass(/\binternal-browser-wide\b/);
    expect(await gridOrder(win)).toEqual([ids.a, ids.b, guideId]);
    await expect(win.locator(`.pane[data-id="${guideId}"]`)).toHaveClass(/\bfocused\b/);
    expect(await win.evaluate(() => tree.stashOrder)).toEqual([]);
  } finally {
    await closeApp(launched);
  }
});

// @title 広く表示を解除するとセットアップ状況の一覧が再表示される
test('広く表示中はセットアップ状況の一覧を隠し、解除すると再表示する', async () => {
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-browser-wide-setup-'));
  const statusFile = path.join(statusDir, 'status.json');
  const setupCwd = path.join(statusDir, 'setup-cwd');
  fs.mkdirSync(setupCwd);
  // 必須項目が 1 件足りない状態にし、セットアップ状況の一覧を出す。
  fs.writeFileSync(statusFile, JSON.stringify({
    requirements: [{ id: 'gh-auth', group: 'tools', label: 'GitHub CLI のログイン', required: true, ok: false, hint: 'gh auth login', target: 'external' }],
    summary: { total: 1, okCount: 0, requiredCount: 1, requiredOkCount: 0, missingRequired: ['gh-auth'], allRequiredOk: false },
  }));
  let launched;
  try {
    launched = await start('vk-terminals-e2e-browser-wide-setup-', {
      entry: setupLauncherPath, env: { VK_TEST_SETUP_STATUS_FILE: statusFile, VK_TEST_SETUP_CWD: setupCwd },
    });
    const { win } = launched;
    // @step セットアップ状況の一覧が出ている状態で、アプリ内ブラウザを開いて広く表示にする
    const panel = win.locator('.setup-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await openBrowser(win, { sidebar: true });
    await expect(panel).toBeVisible();
    await wideButton(win).click();
    // @check 広く表示中は一覧が隠れる
    await expect(panel).toBeHidden();
    // @step 「元の表示に戻す」を押す
    await wideButton(win).click();
    // @check 一覧が再表示される
    await expect(panel).toBeVisible();
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(statusDir, { recursive: true, force: true });
  }
});

// @title 広く表示中に終了しても、再起動後は広く表示前の並びで復元する
test('保持役を使うとき、広く表示中に終了しても再起動後は広く表示前の並びで復元する', async () => {
  const tmux = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'tmux'))
    .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; } });
  test.skip(!tmux, 'tmux is unavailable');
  // ソケットのパス長の上限に収まるよう、短い実パスのフォルダを保持役の置き場にする。
  const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vkw-')));
  const env = { VK_TERMINALS_HOLDER_RUN_DIR: runDir };
  const readSaved = () => {
    try { return JSON.parse(fs.readFileSync(path.join(runDir, 'panes.json'), 'utf8')); } catch (_) { return null; }
  };
  let launched;
  try {
    launched = await start('vk-terminals-e2e-browser-wide-holder-', { entry: holderLauncherPath, env });
    let { win } = launched;
    // @step ペインを 3 枚開いて 1 枚を手動で格納し、2 枚目にフォーカスしてから、アプリ内ブラウザを広く表示にする
    const ids = await win.evaluate(async () => {
      const a = (await addPane(null, { noClaude: true })).paneId;
      const b = (await addPane(null, { noClaude: true })).paneId;
      const c = (await addPane(null, { noClaude: true })).paneId;
      const m = (await addPane(null, { noClaude: true })).paneId;
      stashPane(m);
      return { a, b, c, m };
    });
    // ペイン追加後のフォーカス移動（次の描画フレーム）が済んでから、2 枚目へフォーカスする。
    await win.evaluate((id) => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => { focusPane(id); resolve(); }))), ids.b);
    await openBrowser(win, { sidebar: true });
    await wideButton(win).click();
    await expect(win.locator('.pane')).toHaveCount(0);

    // @check 保存された並びは広く表示にする前のもの（グリッドに 3 枚、格納に手動の 1 枚、フォーカスは 2 枚目）
    await expect.poll(() => {
      const saved = readSaved();
      return saved && { order: saved.order, stashOrder: saved.stashOrder, focusedPaneId: saved.focusedPaneId };
    }).toEqual({ order: [ids.a, ids.b, ids.c], stashOrder: [ids.m], focusedPaneId: ids.b });

    // @step 広く表示のままアプリを終了し、もう一度起動する
    await closeApp(launched);
    launched = null;
    launched = await start('vk-terminals-e2e-browser-wide-holder-restart-', { entry: holderLauncherPath, env });
    ({ win } = launched);
    // @check ペインが広く表示前の並びで復元され、広く表示は引き継がれない
    await expect.poll(() => win.evaluate(() => tree && { order: tree.order, stashOrder: tree.stashOrder }))
      .toEqual({ order: [ids.a, ids.b, ids.c], stashOrder: [ids.m] });
    expect(await win.evaluate(() => focusedPaneId)).toBe(ids.b);
    expect(await win.evaluate(() => internalBrowserWide)).toBeNull();
    await expect(win.locator('#root')).not.toHaveClass(/\binternal-browser-open\b/);
  } finally {
    if (launched) await closeApp(launched);
    // 保持役の tmux サーバーを止め、置き場を片付ける。
    spawnSync(tmux, ['-S', path.join(runDir, 'tmux.sock'), 'kill-server'], { stdio: 'ignore' });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
