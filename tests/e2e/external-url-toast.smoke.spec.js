const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// ─── 外部ブラウザを開けなかったときのトースト（issue #326） ─────────────────────
//
// renderer/app.js の openExternalUrlSafe() は、以前は VKShell.openExternal(url) の
// 戻り値（成否の boolean）を捨てていた。main.js の ipcMain.handle('shell:open-external')
// は URL が http(s) でない場合と shell.openExternal が例外を投げた場合に false を
// 返すが、renderer 側はそれを無視して何も表示していなかった。
//
// ここでは shell.openExternal を main プロセス側で失敗させ（既存の「openExternal は
// http(s) 以外を開かない」テストと同じ手口）、document.body 直下に常設される汎用
// トーストが正しい文言・role・aria 属性で表示されること、コピー操作で本文が差し替わる
// こと、フォーカスを奪わないこと、同時発生時に積み上がらないことを確認する。
//
// 加えて、安藤（リードエンジニア）のレビューで実機再現された 2 つの実害の回帰テスト
// も持つ（トーストを #root 直下ではなく document.body 直下へ置く理由そのもの）。
//   - 高1: #root は render() が root.replaceChildren() で子を丸ごと差し替えるため、
//     #root の内側にトーストを置くとペイン追加・移動・格納のたびに DOM から外れ、
//     以後アプリ再起動まで二度と表示されなくなる。
//   - 高2: #root は position: fixed で独自の重なり文脈を作るため、内側の要素は
//     document.body 直下の設定モーダル・確認ダイアログより前面に出られない。さらに
//     モーダル表示中は focusTrap.js の applyInert が #root へ inert を付けるため、
//     内側のトーストは操作不可・支援技術からも除外される。
//
// PR バッジ（.pane-task-title-pr）を発火点に選ぶ理由: openExternalUrlSafe() の
// 5 箇所の呼び出し元のうち、HTTP API（/api/set-title）だけで実 URL 付きの状態を
// 作れて他 spec（pr-badge-merged.smoke.spec.js）でも実績のある経路だから。

async function postSetTitle(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/set-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await response.json();
  } catch (_e) {
    /* 診断用。JSON でなくても呼び出し側の expect が拾う */
  }
  return { response, body };
}

async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await postSetTitle(port, { termId: '1', title: '' });
      if (result.response.status === 200) return;
      if (result.response.status !== 404) {
        throw new Error(`unexpected status ${result.response.status}: ${JSON.stringify(result.body)}`);
      }
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(result.body)}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('terminal 1 was not registered in time');
}

// shell.openExternal を main プロセス側で差し替える。失敗を再現するときは例外を
// 投げさせる（main.js の catch 節を通り、ipcMain.handle は false を返す）。
async function stubShellOpenExternal(app, { fail }) {
  await app.evaluate(({ shell }, shouldFail) => {
    if (!globalThis.__origOpenExternal) globalThis.__origOpenExternal = shell.openExternal;
    globalThis.__openExternalCalls = globalThis.__openExternalCalls || [];
    shell.openExternal = async (url) => {
      globalThis.__openExternalCalls.push(url);
      if (shouldFail) throw new Error('stubbed shell.openExternal failure');
      // 成功時も実際に OS のブラウザは開かせない（テスト環境で無関係なプロセスを起こさない）。
    };
  }, fail);
}
async function restoreShellOpenExternal(app) {
  await app.evaluate(({ shell }) => {
    if (!globalThis.__origOpenExternal) return;
    shell.openExternal = globalThis.__origOpenExternal;
    delete globalThis.__origOpenExternal;
    delete globalThis.__openExternalCalls;
  });
}

// 特定の URL だけ失敗させ、それ以外は成功させる（中: 直前の失敗トーストが残ったまま
// 別のリンクが成功したときの回帰テスト用）。
async function stubShellOpenExternalSelective(app, failingUrl) {
  await app.evaluate(({ shell }, url) => {
    if (!globalThis.__origOpenExternal) globalThis.__origOpenExternal = shell.openExternal;
    globalThis.__openExternalCalls = globalThis.__openExternalCalls || [];
    shell.openExternal = async (u) => {
      globalThis.__openExternalCalls.push(u);
      if (u === url) throw new Error('stubbed shell.openExternal failure');
      // それ以外（成功させたい URL）は実際に OS のブラウザは開かせない。
    };
  }, failingUrl);
}

// クリップボードの成否は main プロセス側の clipboard.writeText を差し替えて制御する
// （settings-mobile-guide-tab.smoke.spec.js と同じ手口。renderer からは electron の
// clipboard を直接触れないため、実際に書き込むのは main の
// ipcMain.handle('clipboard:write-text')）。
async function stubClipboardWrite(app) {
  await app.evaluate(({ clipboard }) => {
    if (!globalThis.__origWriteText) globalThis.__origWriteText = clipboard.writeText;
    globalThis.__written = [];
    clipboard.writeText = (text) => { globalThis.__written.push(text); };
  });
}
async function stubClipboardFailure(app) {
  await app.evaluate(({ clipboard }) => {
    if (!globalThis.__origWriteText) globalThis.__origWriteText = clipboard.writeText;
    clipboard.writeText = () => { throw new Error('stubbed clipboard failure'); };
  });
}
async function restoreClipboardWrite(app) {
  await app.evaluate(({ clipboard }) => {
    if (!globalThis.__origWriteText) return;
    clipboard.writeText = globalThis.__origWriteText;
    delete globalThis.__origWriteText;
    delete globalThis.__written;
  });
}
const writtenTexts = (app) => app.evaluate(() => (globalThis.__written || []).slice());

// ウィンドウを main.js の最小サイズ（minWidth: 600 / minHeight: 400）まで縮めて fn を
// 実行し、終わったら元のサイズへ戻す（このテストの後に追加される他テストへ影響させない）。
async function withSmallWindow(app, fn) {
  const originalBounds = await app.evaluate(({ BrowserWindow }) => (
    BrowserWindow.getAllWindows()[0].getBounds()
  ));
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ width: 600, height: 400 });
  });
  try {
    await fn();
  } finally {
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0].setBounds(bounds);
    }, originalBounds);
  }
}

// 要素の中心座標で document.elementFromPoint() を取り、その要素自身（またはその子孫）が
// 最前面に来ているかを見る。安藤が実機のレビューで使っていた判定と同じ考え方
// （中心の最前面がボタン自身ではなくトーストなら、クリックはトーストへ吸われる）。
async function isOnTopAtOwnCenter(win, selector) {
  return win.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const top = document.elementFromPoint(cx, cy);
    if (!top) return false;
    return top === el || el.contains(top);
  }, selector);
}

test.describe.serial('外部ブラウザを開けなかったときのトースト（issue #326）', () => {
  let app;
  let win;
  let tmpRoot;
  let port;
  let prUrl;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp({
      port,
      prefix: 'vk-terminals-e2e-external-url-toast-',
    }));
    await waitForPtyRegistration(port);
    // ネットワークへ実際に出る必要はない（クリックしない）ため自サーバーの URL を使う
    // （pr-badge-merged.smoke.spec.js と同じ理由）。
    prUrl = `http://127.0.0.1:${port}/?pr=326`;
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test('ブラウザを開けたとき（成功時）はトーストを出さない', async () => {
    await stubShellOpenExternal(app, { fail: false });
    try {
      await postSetTitle(port, { termId: '1', title: 'issue #326 成功時', prUrl });
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await expect(prBadge).toBeVisible();
      await prBadge.click();

      // main まで実際に届いたことを確認したうえで、成功時は画面に何も出ないことを見る。
      // toBeHidden() は「存在しない」「存在するが非表示」のどちらも合格にする
      // （このテストは describe.serial の 1 番目なのでまだ DOM に無いはずだが、
      // トーストの生成タイミング（遅延生成かどうか）に依存しない判定にしておく）。
      await expect
        .poll(() => app.evaluate(() => (globalThis.__openExternalCalls || []).length))
        .toBeGreaterThan(0);
      await expect(win.locator('.vk-toast')).toBeHidden();
    } finally {
      await restoreShellOpenExternal(app);
    }
  });

  test('ブラウザを開けなかったとき（失敗時）はトーストで知らせ、フォーカスは奪わない', async () => {
    await stubShellOpenExternal(app, { fail: true });
    try {
      await postSetTitle(port, { termId: '1', title: 'issue #326 失敗時', prUrl });
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await expect(prBadge).toBeVisible();
      await prBadge.click();

      const toast = win.locator('.vk-toast');
      await expect(toast).toBeVisible();
      await expect(toast).toHaveAttribute('role', 'status');
      await expect(toast).toHaveAttribute('aria-live', 'polite');
      await expect(toast.locator('.vk-toast-message')).toHaveText('ブラウザを開けませんでした');

      const copyButton = toast.locator('.vk-toast-copy');
      await expect(copyButton).toBeVisible();
      // 可視ラベルの文言を aria-label の先頭に含める（WCAG 2.5.3 Label in Name）。
      await expect(copyButton).toHaveText('URLをコピー');
      await expect(copyButton).toHaveAttribute('aria-label', '開けなかったURLをコピー');

      // 出現時にフォーカスを奪わない。操作した要素（PR バッジ）にフォーカスが残る。
      const activeElementClass = await win.evaluate(() => document.activeElement?.className || '');
      expect(activeElementClass).toContain('pane-task-title-pr');
    } finally {
      await restoreShellOpenExternal(app);
    }
  });

  test('同時発生時は積み上げず、前のトーストを新しい内容で上書きする', async () => {
    await stubShellOpenExternal(app, { fail: true });
    try {
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await postSetTitle(port, { termId: '1', title: 'issue #326 積み上げ確認', prUrl });

      // 連続でクリックして 2 回失敗させる。積み上げる実装なら .vk-toast が複数生えるが、
      // 「#root 直下に 1 つだけ常設し、前の内容を上書きする」実装なら常に 1 個のまま。
      await prBadge.click();
      await expect(win.locator('.vk-toast')).toBeVisible();
      await expect(win.locator('.vk-toast')).toHaveCount(1);

      await prBadge.click();
      await expect(win.locator('.vk-toast')).toHaveCount(1);
      await expect(win.locator('.vk-toast .vk-toast-message')).toHaveText('ブラウザを開けませんでした');
    } finally {
      await restoreShellOpenExternal(app);
    }
  });

  test('コピーボタンを押すと、押したときだけ VKClipboard.writeText が呼ばれ、成否に応じて本文が差し替わる', async () => {
    await stubShellOpenExternal(app, { fail: true });
    await stubClipboardWrite(app);
    try {
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await postSetTitle(port, { termId: '1', title: 'issue #326 コピー成功', prUrl });
      await prBadge.click();

      const toast = win.locator('.vk-toast');
      await expect(toast.locator('.vk-toast-message')).toHaveText('ブラウザを開けませんでした');

      // トーストが出ただけでは自動コピーしない（押したときだけコピーする）。
      expect(await writtenTexts(app)).toEqual([]);

      await toast.locator('.vk-toast-copy').click();
      await expect(toast.locator('.vk-toast-message')).toHaveText('URLをコピーしました');
      expect(await writtenTexts(app)).toEqual([prUrl]);
    } finally {
      await restoreShellOpenExternal(app);
      await restoreClipboardWrite(app);
    }
  });

  test('コピーに失敗したときは「コピーできませんでした」に本文が差し替わる', async () => {
    await stubShellOpenExternal(app, { fail: true });
    await stubClipboardFailure(app);
    try {
      const prBadge = win.locator('.pane .pane-task-title-pr').first();
      await postSetTitle(port, { termId: '1', title: 'issue #326 コピー失敗', prUrl });
      await prBadge.click();

      const toast = win.locator('.vk-toast');
      await expect(toast.locator('.vk-toast-message')).toHaveText('ブラウザを開けませんでした');
      await toast.locator('.vk-toast-copy').click();
      await expect(toast.locator('.vk-toast-message')).toHaveText('コピーできませんでした');
    } finally {
      await restoreShellOpenExternal(app);
      await restoreClipboardWrite(app);
    }
  });

  // ─── 中: 直前の失敗トーストが残ったまま、別のリンクが成功するとコピー対象がずれる ───
  // 安藤レビュー指摘。openExternalUrlSafe() が成功時（true 解決時）に表示中のトーストを
  // 消すようになったことの回帰テスト。「成功時に新たなトーストを出さない」方針自体は
  // 変えていないので、ここでは「消えること」だけを見る。
  test('別のリンクが成功すると、表示中の失敗トーストが消える', async () => {
    const succeedingUrl = `http://127.0.0.1:${port}/?pr=326-succeed`;
    await stubShellOpenExternalSelective(app, prUrl); // prUrl だけ失敗、succeedingUrl は成功
    try {
      // ① リンク A（prUrl）が失敗しトースト表示。
      await postSetTitle(port, { termId: '1', title: 'issue #326 中: 失敗A', prUrl });
      const prBadgeA = win.locator(`.pane-task-title-pr[title="${prUrl}"]`).first();
      await expect(prBadgeA).toBeVisible();
      await prBadgeA.click();
      await expect(win.locator('.vk-toast')).toBeVisible();
      await expect(win.locator('.vk-toast .vk-toast-message')).toHaveText('ブラウザを開けませんでした');

      // ② 別のリンク B（succeedingUrl）を開いて成功させる。バッジのクリックハンドラは
      // 描画時点の URL をクロージャで掴むため、postSetTitle 直後にまだ古い（失敗する）
      // prUrl のままクリックすると、succeedingUrl ではなく prUrl が main へ届いてしまう
      // （安藤レビュー指摘）。title 属性が succeedingUrl に描き直されるまで待ってから
      // クリックする。
      await postSetTitle(port, { termId: '1', title: 'issue #326 中: 成功B', prUrl: succeedingUrl });
      const prBadgeB = win.locator(`.pane-task-title-pr[title="${succeedingUrl}"]`).first();
      await expect(prBadgeB).toBeVisible();
      await prBadgeB.click();

      // main まで実際に succeedingUrl が届いたことを確認したうえで、トーストが
      // 消えていること（「ブラウザを開けませんでした」が A のまま残ってコピー対象が
      // ずれる、を再発させないこと）を見る。
      await expect
        .poll(() => app.evaluate(
          (url) => (globalThis.__openExternalCalls || []).includes(url),
          succeedingUrl
        ))
        .toBe(true);
      await expect(win.locator('.vk-toast')).toBeHidden();
    } finally {
      await restoreShellOpenExternal(app);
    }
  });

  // ─── 高1: ペインを追加すると、以後トーストが二度と出なくなる ───────────────────
  // 安藤レビュー指摘・実機再現済み。render()（renderer/app.js）が #root の子を
  // root.replaceChildren() で丸ごと差し替えるため、#root の直下にトーストを置くと
  // ペイン追加のたびに DOM から外れ、ensureExternalUrlToast() のキャッシュ短絡が
  // 切り離し済みノードをそのまま返すため以後二度と表示されなくなっていた。
  // トーストを document.body 直下へ移すことの回帰テスト。
  //
  // .first() ではなく PR バッジの title 属性（= prUrl）で狙い撃ちする。ペイン追加後は
  // 画面上に PR バッジが 2 つになりうり、DOM 順が termId "1" のペインと一致する保証が
  // 無いため。
  test('ペインを追加した後（render() の再構築後）も、トーストは再び表示される', async () => {
    await stubShellOpenExternal(app, { fail: true });
    try {
      const prBadge = win.locator(`.pane-task-title-pr[title="${prUrl}"]`).first();
      await postSetTitle(port, { termId: '1', title: 'issue #326 ペイン追加前', prUrl });
      await expect(prBadge).toBeVisible();
      await prBadge.click();
      await expect(win.locator('.vk-toast')).toBeVisible();

      // ペインを追加する（render() が #root の子を丸ごと差し替える経路を踏む）。
      await win.locator('.pane-header .btn-split').first().click();
      await expect(win.locator('.pane')).toHaveCount(2);

      // 同じリンクをもう一度失敗させる。#root の外（document.body 直下）にあれば、
      // ペイン追加の影響を受けずに再表示できるはず。
      await postSetTitle(port, { termId: '1', title: 'issue #326 ペイン追加後', prUrl });
      await prBadge.click();
      await expect(win.locator('.vk-toast')).toBeVisible();
      await expect(win.locator('.vk-toast .vk-toast-message')).toHaveText('ブラウザを開けませんでした');
    } finally {
      await restoreShellOpenExternal(app);
    }
  });

  // ─── 高2: z-index 2200 が効いておらず、設定モーダル表示中はトーストが見えず操作もできない ───
  // 安藤レビュー指摘・実機再現済み（{"rootInert":true,"toastInsideInertRoot":true,...}）。
  // #root は position: fixed で独自の重なり文脈を作るため、内側のトーストは
  // document.body 直下の .settings-overlay（2000）より前面に出られない。さらに
  // モーダル表示中は focusTrap.js の applyInert が #root へ inert を付けるため、
  // 内側のトーストは操作不可・支援技術からも除外される。
  //
  // 実機の再現条件（#root が既にモーダルより前に存在した状態で inert が付く）を
  // 忠実に再現するため、先にペイン外の失敗でトースト DOM を常設させてから設定
  // モーダルを開く（focusTrap.js の applyInert はトラップの活性化時にしか body 直下を
  // 走査しないため、モーダルを開いた「後」に初めてトーストを作るケースでは、そもそも
  // この経路を通らない）。
  test('設定モーダル表示中でも説明リンクの失敗が見え、コピーボタンを押せる（inert にならない）', async () => {
    await stubShellOpenExternal(app, { fail: true });
    await stubClipboardWrite(app);
    try {
      const prBadge = win.locator(`.pane-task-title-pr[title="${prUrl}"]`).first();
      await postSetTitle(port, { termId: '1', title: 'issue #326 モーダル前の失敗', prUrl });
      await prBadge.click();
      await expect(win.locator('.vk-toast')).toBeVisible();

      // 設定モーダルを開く（ここで focusTrap.js の applyInert が body 直下の子を
      // 走査する。.vk-toast-layer に data-vk-inert-exempt が無ければ inert が付く）。
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.waitForSelector('.settings-tabs', { state: 'visible' });

      const layerInert = await win.evaluate(() => {
        const layer = document.querySelector('.vk-toast-layer');
        return layer ? layer.inert : null;
      });
      expect(layerInert).toBe(false);

      // 「外出先から確認」タブ（#settings-tab-1）の説明リンクを失敗させる
      // （settings-mobile-guide-tab.smoke.spec.js が同じタブ・同じセレクタで検証済み）。
      await win.locator('#settings-tab-1').click();
      const link = win.locator('#settings-panel-1 .settings-content-link').first();
      await expect(link).toBeVisible();
      await link.click();

      const toast = win.locator('.vk-toast');
      await expect(toast).toBeVisible();
      await expect(toast.locator('.vk-toast-message')).toHaveText('ブラウザを開けませんでした');

      // 実際にコピーボタンを押せる（inert なら click() の効果が中の要素へ届かない）。
      await toast.locator('.vk-toast-copy').click();
      await expect(toast.locator('.vk-toast-message')).toHaveText('URLをコピーしました');
    } finally {
      await restoreShellOpenExternal(app);
      await restoreClipboardWrite(app);
      const closeBtn = win.locator('.settings-close');
      if (await closeBtn.count()) await closeBtn.click().catch(() => {});
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    }
  });

  // ─── 中: 最小ウィンドウで、設定パネルのボタンをトーストの箱が覆う ───────────────
  // 安藤の実測（600×400 / 700×500 / 800×600 で .settings-cancel の中心の最前面が
  // .vk-toast-message）を受けた植草の確定仕様（issue #326）。設定パネル・確認
  // ダイアログはいずれも中央配置でボタン列が下部の右寄りに並ぶため、それらの表示中は
  // トーストを左下へ逃がす（renderer/style.css の
  // body:has(.settings-overlay) .vk-toast-layer / body:has(.confirm-overlay) ...）。
  test('最小ウィンドウでも、設定パネルの「キャンセル」「保存」をトーストが覆わない', async () => {
    await stubShellOpenExternal(app, { fail: true });
    try {
      await withSmallWindow(app, async () => {
        await win.evaluate(() => window.openSettingsModal());
        await win.waitForSelector('.settings-modal', { state: 'visible' });
        await win.waitForSelector('.settings-tabs', { state: 'visible' });

        // 「外出先から確認」タブの説明リンクを失敗させ、トーストを表示する。
        await win.locator('#settings-tab-1').click();
        const link = win.locator('#settings-panel-1 .settings-content-link').first();
        await expect(link).toBeVisible();
        await link.click();
        await expect(win.locator('.vk-toast')).toBeVisible();

        // .settings-overlay 表示中は左下へ寄っていること。
        const toastSide = await win.evaluate(() => {
          const rect = document.querySelector('.vk-toast-layer').getBoundingClientRect();
          return rect.left < window.innerWidth / 2 ? 'left' : 'right';
        });
        expect(toastSide).toBe('left');

        // 「キャンセル」は常設（説明タブでも隠れない）。中心の最前面が自分自身であること。
        expect(await isOnTopAtOwnCenter(win, '.settings-cancel')).toBe(true);

        // 「保存」は説明だけのタブでは隠れる（hidden 属性）ため、フィールドのある
        // 「設定」タブへ戻ってから確かめる。トーストは .settings-overlay が
        // 表示され続けている限り左下のまま（タブ切替では消えない）。
        await win.locator('#settings-tab-0').click();
        await expect(win.locator('.settings-save')).toBeVisible();
        expect(await isOnTopAtOwnCenter(win, '.settings-save')).toBe(true);
        expect(await isOnTopAtOwnCenter(win, '.settings-cancel')).toBe(true);
      });
    } finally {
      await restoreShellOpenExternal(app);
      const closeBtn = win.locator('.settings-close');
      if (await closeBtn.count()) await closeBtn.click().catch(() => {});
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    }
  });

  test('最小ウィンドウでも、確認ダイアログの「キャンセル」「閉じる」をトーストが覆わない', async () => {
    await stubShellOpenExternal(app, { fail: true });
    try {
      await withSmallWindow(app, async () => {
        // まずリンクを失敗させてトーストを表示する（確認ダイアログとは無関係の経路）。
        const prBadge = win.locator(`.pane-task-title-pr[title="${prUrl}"]`).first();
        await postSetTitle(port, { termId: '1', title: 'issue #326 中: 確認ダイアログ前', prUrl });
        await expect(prBadge).toBeVisible();
        await prBadge.click();
        await expect(win.locator('.vk-toast')).toBeVisible();

        // ペインを閉じる確認ダイアログを開く。status（running/waiting）に依存する
        // 通常の ✕ クリック経路（confirmClose: 'busy' が既定）を避け、この spec が
        // レイアウトだけを見たいことを明確にするため window.openCloseConfirmDialog を
        // 直接呼ぶ（app.js のトップレベル関数宣言は window へ生える。issue #184）。
        const paneId = await win.evaluate(() => document.querySelector('.pane')?.dataset.id || '');
        expect(paneId).not.toBe('');
        await win.evaluate((id) => window.openCloseConfirmDialog(id), paneId);
        await win.waitForSelector('.confirm-overlay', { state: 'visible' });

        // .confirm-overlay 表示中も左下へ寄っていること。
        const toastSide = await win.evaluate(() => {
          const rect = document.querySelector('.vk-toast-layer').getBoundingClientRect();
          return rect.left < window.innerWidth / 2 ? 'left' : 'right';
        });
        expect(toastSide).toBe('left');

        expect(await isOnTopAtOwnCenter(win, '.confirm-cancel')).toBe(true);
        expect(await isOnTopAtOwnCenter(win, '.confirm-close-pane')).toBe(true);

        // キャンセルして閉じる（実際にペインを閉じない）。
        await win.locator('.confirm-cancel').click();
        await win.waitForSelector('.confirm-overlay', { state: 'detached' });
      });
    } finally {
      await restoreShellOpenExternal(app);
    }
  });
});
