// 設定の保存・直接編集・読み込み失敗と復旧を一時 HOME で検証する。
//
// 一時 HOME（launchApp が mkdtemp で作る）配下の ~/.vk-terminals/ だけを読み書きし、
// 利用者の実 HOME には触れない。
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

const DEDUP_GAP_MS = 6500; // 同じ文言の通知をまとめる 6 秒を超えて待つ。
const WATCH_CYCLE_MS = 6000; // 5 秒の監視周期を超えて、余計な通知がないか確かめる。
const NOTIFICATION_WINDOW_MS = 8000; // 5 秒の監視周期と 1.2 秒の通知遅延を超えて観測する。
const TOAST_LOG_SETTLE_MS = 400; // 100ms 間隔の表示記録が非表示を捉えるまで待つ。

const MSG_OK = '設定を反映しました';
const MSG_PARTIAL = '一部の設定を反映しました';
const MSG_FAIL = '設定を読み込めませんでした。設定ファイルを修正して保存してください';
const MSG_REST = '残りの設定は再起動後に反映されます';

const baseMenu = [{
  source: 'remi',
  title: 'テスト用メニュー',
  items: [{ id: 'docs', label: 'ドキュメント', action: { type: 'open-url', url: 'https://example.com/docs' } }],
}];

function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }
function writeJson(file, value) { fs.writeFileSync(file, JSON.stringify(value, null, 2)); }

// トーストの表示・非表示の遷移を 100ms 間隔で記録する（同文言の重複抑止や自動消去の確認用）。
async function installToastLog(win) {
  await win.evaluate(() => {
    window.__toastLog = [];
    window.__toastVisible = false;
    setInterval(() => {
      const t = document.querySelector('.vk-toast');
      const visible = !!t && getComputedStyle(t).display !== 'none' && !t.hidden;
      if (visible && !window.__toastVisible) window.__toastLog.push({ type: 'show', text: t.querySelector('.vk-toast-message')?.textContent || t.textContent, at: Date.now() });
      if (!visible && window.__toastVisible) window.__toastLog.push({ type: 'hide', at: Date.now() });
      window.__toastVisible = visible;
    }, 100);
  });
}
const toastLog = (win) => win.evaluate(() => window.__toastLog);
const nowInPage = (win) => win.evaluate(() => Date.now());
const showsAfter = (log, since, text) => log.filter((e) => e.type === 'show' && e.at >= since && (!text || e.text === text));

// 見えている端どうしの間隔（文字は行の箱からハーフレディングを除く）。
async function gaps(win, cardSelector) {
  return await win.evaluate((sel) => {
    const card = document.querySelector(sel);
    if (!card) return null;
    const half = (el) => { const cs = getComputedStyle(el); const lh = parseFloat(cs.lineHeight); const fs = parseFloat(cs.fontSize); return Number.isFinite(lh) ? (lh - fs) / 2 : 0; };
    const textBox = (el) => { const r = el.getBoundingClientRect(); const h = half(el); return { top: r.top + h, bottom: r.bottom - h }; };
    const children = [...card.children].filter((c) => getComputedStyle(c).display !== 'none');
    const boxes = children.map((c) => {
      if (c.tagName === 'UL') { const lis = [...c.children]; return { tag: 'ul', top: textBox(lis[0]).top, bottom: textBox(lis[lis.length - 1]).bottom, n: lis.length }; }
      if (c.tagName === 'BUTTON') { const r = c.getBoundingClientRect(); return { tag: 'button', top: r.top, bottom: r.bottom }; }
      const t = textBox(c); return { tag: c.tagName.toLowerCase() + (c.className ? '.' + c.className : ''), ...t };
    });
    const cr = card.getBoundingClientRect();
    const cs = getComputedStyle(card);
    const bw = parseFloat(cs.borderTopWidth);
    const inner = [];
    for (let i = 1; i < boxes.length; i++) inner.push({ between: `${boxes[i - 1].tag} -> ${boxes[i].tag}`, px: +(boxes[i].top - boxes[i - 1].bottom).toFixed(1) });
    const next = card.nextElementSibling && getComputedStyle(card.nextElementSibling).display !== 'none' ? card.nextElementSibling.getBoundingClientRect() : null;
    return {
      visiblePaddingBottom: +((cr.bottom - bw) - boxes[boxes.length - 1].bottom).toFixed(1),
      inner,
      gapToNextCard: next ? +(next.top - cr.bottom).toFixed(1) : null,
    };
  }, cardSelector);
}

test.describe.serial('設定の再起動なし反映', () => {
  test.setTimeout(240_000);
  let launched;
  let win;
  let app;
  let tmpHome;
  let configPath;
  let restartPath;
  let dirA;
  let dirB;
  test.beforeAll(async () => {
    // @step 一時フォルダに設定ファイルを準備してアプリを起動する
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-config-live-reload-dirA-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-config-live-reload-dirB-'));
    launched = await launchAppAndWait({
      port: await getFreePort(),
      prefix: 'vk-config-live-reload-e2e-',
      config: { newPaneStartupDir: dirA, newPaneAutoLaunchClaude: false, confirmClose: 'busy', menuItems: baseMenu },
      seedHome: ({ configDir }) => {
        fs.writeFileSync(path.join(configDir, 'restart-required.json'), JSON.stringify({ restartRequired: false, tabs: [] }));
        // 起動前から存在する反映結果（vk-orchestrator が書き出したもの）は通知しないことの確認用。
        fs.writeFileSync(path.join(configDir, 'config-reflection.json'), JSON.stringify({ version: 1, eventId: '11111111-2222-4333-8444-555555555555', appliedKeys: ['confirmClose'], failedFiles: [] }));
      },
    });
    ({ win, app, tmpHome } = launched);
    configPath = path.join(tmpHome, '.vk-terminals', 'config.json');
    restartPath = path.join(tmpHome, '.vk-terminals', 'restart-required.json');
    await installToastLog(win);
  });

  test.afterAll(async () => {
    try {
      if (launched) await closeApp(launched);
    } finally {
      if (dirA) fs.rmSync(dirA, { recursive: true, force: true });
      if (dirB) fs.rmSync(dirB, { recursive: true, force: true });
    }
  });

  // @title 起動直後に反映のトーストが出ない
  test('1. 起動直後に反映トーストが出ない・失敗表示も出ない', async () => {
    // @step 起動したアプリで通知が落ち着くまで待つ
    // @check 反映トーストと失敗案内が表示されない
    await win.waitForTimeout(NOTIFICATION_WINDOW_MS);
    const log = await toastLog(win);
    expect(log.filter((e) => e.type === 'show')).toEqual([]);
    await expect(win.locator('#sidebar-config-read-error')).toBeHidden();
    await expect(win.locator('#sidebar-restart-required')).toBeHidden();
    await expect(win.locator('#sidebar-menu')).toContainText('ドキュメント');
  });

  // @title 設定パネルから保存すると再起動なしで反映され、成功トーストが数秒で消える
  test('2. 新しいペインを開くフォルダを保存 → トースト → 新規ペインに反映', async () => {
    // @step 設定画面で新規ペインの初期フォルダを変更して保存し、新規ペインを開く
    // @check 成功通知が消え、新しいペインだけに保存したフォルダが反映される
    const paneHeaderBefore = await win.locator('.pane-header .pane-cwd').first().getAttribute('title');
    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('.settings-modal')).toBeVisible();
    const forId = await win.locator('label', { hasText: '新規ペインを開く時の初期ディレクトリ' }).first().getAttribute('for');
    const input = win.locator(`#${forId}`);
    await expect(input).toHaveValue(dirA);
    await input.fill(dirB);
    const since = await nowInPage(win);
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveText('保存しました。反映状況は設定の案内をご確認ください。');
    const toast = win.locator('.vk-toast');
    await expect(toast).toBeVisible({ timeout: 10000 });
    await expect(toast.locator('.vk-toast-message')).toHaveText(MSG_OK);
    await expect(toast).toHaveClass(/vk-toast--success/);
    await expect(toast).toHaveAttribute('role', 'status');
    await expect(toast).toHaveAttribute('aria-live', 'polite');
    await expect(toast).toBeHidden({ timeout: 10000 });
    // 記録は 100ms 間隔なので、非表示の記録が追いつくまで少し待つ。
    await win.waitForTimeout(TOAST_LOG_SETTLE_MS);
    const log = await toastLog(win);
    const show = showsAfter(log, since, MSG_OK)[0];
    const hide = log.find((e) => e.type === 'hide' && e.at > show.at);
    expect(hide.at - show.at).toBeGreaterThan(3000);
    expect(hide.at - show.at).toBeLessThan(8000);
    // 保存後のファイルも新しい値になっている。
    expect(readJson(configPath).newPaneStartupDir).toBe(dirB);
    // 設定パネルは閉じておく（自動で閉じていなければ Escape）。
    if (await win.locator('.settings-modal').count()) await win.keyboard.press('Escape');
    await expect(win.locator('.settings-modal')).toHaveCount(0);

    // 新規ペイン（ヘッダの＋）が dirB で開く。terminal:create は実処理へ委譲しつつ引数を記録。
    await win.evaluate(() => {
      const vkIpc = window.VKIpc;
      window.__termCreateCalls = [];
      const orig = vkIpc.invoke.bind(vkIpc);
      vkIpc.invoke = (channel, ...args) => {
        if (channel === 'terminal:create') window.__termCreateCalls.push({ cwd: args[0], options: args[1] });
        return orig(channel, ...args);
      };
    });
    await win.locator('.pane-header .btn-split').first().click();
    await expect.poll(() => win.evaluate(() => window.__termCreateCalls.length)).toBeGreaterThan(0);
    const call = await win.evaluate(() => window.__termCreateCalls.at(-1));
    expect(call.cwd).toBe(dirB);
    expect(call.options && call.options.noClaude).toBe(true);
    await expect(win.locator('.pane-header')).toHaveCount(2);
    await expect(win.locator('.pane-header').nth(1)).toContainText(path.basename(dirB));
    // 元のペインは変わらない。
    expect(await win.locator('.pane-header .pane-cwd').first().getAttribute('title')).toBe(paneHeaderBefore);
    expect(paneHeaderBefore).toContain(path.basename(dirA));
    expect(await win.evaluate(() => newPaneStartupDir)).toBe(dirB);
  });

  // @title config.json のメニュー項目を直接編集すると再起動なしでサイドバーへ出る
  test('3. メニュー項目を config.json に足す → サイドバーに出てトーストは 1 回', async () => {
    // @step 設定ファイルにメニュー項目を追加して保存する
    // @check サイドバーに項目が増え、成功通知は一度だけ表示される
    // 直前の同文言トーストから 6 秒以上空ける（重複抑止に巻き込まれないため）。
    await win.waitForTimeout(DEDUP_GAP_MS);
    const config = readJson(configPath);
    config.menuItems = JSON.parse(JSON.stringify(baseMenu));
    config.menuItems[0].items.push({ id: 'guide', label: '追加した項目', action: { type: 'open-url', url: 'https://example.com/guide' } });
    const since = await nowInPage(win);
    writeJson(configPath, config);
    await expect(win.locator('#sidebar-menu')).toContainText('追加した項目', { timeout: 15000 });
    await expect(win.locator('.vk-toast')).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.vk-toast .vk-toast-message')).toHaveText(MSG_OK);
    await win.waitForTimeout(NOTIFICATION_WINDOW_MS);
    const shows = showsAfter(await toastLog(win), since);
    expect(shows.map((e) => e.text)).toEqual([MSG_OK]);
    await expect(win.locator('#sidebar-config-read-error')).toBeHidden();
  });

  // @title config.json を壊すと失敗表示がサイドバーと設定パネル上部に出て、直すと消える
  test('4. 読み込み失敗の常設表示と復旧', async () => {
    // @step 設定ファイルを壊して新規ペインを開き、その後ファイルを修復する
    // @check 失敗案内が表示され、直前の設定が保たれ、修復後に案内が消える
    const valid = fs.readFileSync(configPath, 'utf8');
    await win.waitForTimeout(DEDUP_GAP_MS);
    const since = await nowInPage(win);
    fs.writeFileSync(configPath, valid.trimEnd().replace(/\}\s*$/, ''));
    const sidebarError = win.locator('#sidebar-config-read-error');
    await expect(sidebarError).toBeVisible({ timeout: 15000 });
    await expect(sidebarError.locator('p').first()).toHaveText(MSG_FAIL);
    await expect(sidebarError.locator('li')).toHaveText([configPath]);
    await win.evaluate(() => window.openSettingsModal());
    const panelError = win.locator('.settings-config-read-error');
    await expect(panelError).toBeVisible();
    await expect(panelError.locator('p').first()).toHaveText(MSG_FAIL);
    await expect(panelError.locator('li')).toHaveText([configPath]);
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    // 壊れている間に新しいペインを開くと、壊す前の設定（dirB）のまま。
    await win.locator('.pane-header .btn-split').first().click();
    await expect.poll(() => win.evaluate(() => window.__termCreateCalls.length)).toBeGreaterThan(1);
    expect((await win.evaluate(() => window.__termCreateCalls.at(-1))).cwd).toBe(dirB);
    await win.waitForTimeout(WATCH_CYCLE_MS);
    const showsBroken = showsAfter(await toastLog(win), since);
    expect(showsBroken.map((e) => e.text)).not.toContain(MSG_OK);
    expect(showsBroken.map((e) => e.text)).not.toContain(MSG_PARTIAL);
    // 直す。
    const sinceFix = await nowInPage(win);
    fs.writeFileSync(configPath, valid);
    await expect(sidebarError).toBeHidden({ timeout: 15000 });
    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('.settings-config-read-error')).toBeHidden();
    await win.keyboard.press('Escape');
    await win.waitForTimeout(NOTIFICATION_WINDOW_MS);
    const showsFixed = showsAfter(await toastLog(win), sinceFix);
    expect(showsFixed.map((e) => e.text)).not.toContain(MSG_OK);
    expect(showsFixed.map((e) => e.text)).not.toContain(MSG_PARTIAL);
  });

  // @title メニュー項目だけが不正なときは失敗表示を出さず、ほかの設定は反映する
  test('5. メニュー項目だけ不正 → 失敗表示なし・ほかは反映', async () => {
    // @step メニュー項目だけを不正にし、終了確認の設定も変更する
    // @check 失敗案内を出さずに終了確認の設定が反映される
    await win.waitForTimeout(DEDUP_GAP_MS);
    const config = readJson(configPath);
    config.menuItems = [{ source: 'remi', items: [{ id: 'bad' }] }];
    config.confirmClose = 'always';
    const since = await nowInPage(win);
    writeJson(configPath, config);
    await expect.poll(() => win.evaluate(() => confirmClosePref), { timeout: 15000 }).toBe('always');
    await expect(win.locator('#sidebar-menu')).not.toContainText('ドキュメント');
    await expect(win.locator('.vk-toast')).toBeVisible({ timeout: 10000 });
    await expect(win.locator('.vk-toast .vk-toast-message')).toHaveText(MSG_OK);
    await win.waitForTimeout(WATCH_CYCLE_MS);
    await expect(win.locator('#sidebar-config-read-error')).toBeHidden();
    const shows = showsAfter(await toastLog(win), since);
    expect(shows.map((e) => e.text)).toEqual([MSG_OK]);
    // 戻す。
    config.menuItems = baseMenu;
    writeJson(configPath, config);
    await expect(win.locator('#sidebar-menu')).toContainText('ドキュメント', { timeout: 15000 });
  });

  // @title 再起動が必要な設定も同時に変わると「一部の設定を反映しました」と残りの案内が出る
  test('6. restart-required.json との組み合わせ → 一部反映と「残りの設定は」', async () => {
    // @step 再起動が必要な状態を用意し、即時反映される設定も変更する
    // @check 一部反映の通知と残りの再起動案内が表示され、案内の内側より段落間隔が狭い
    await win.waitForTimeout(DEDUP_GAP_MS);
    writeJson(restartPath, { restartRequired: true, tabs: ['general'] });
    const config = readJson(configPath);
    config.newPaneAutoLaunchClaude = true;
    const since = await nowInPage(win);
    writeJson(configPath, config);
    const toast = win.locator('.vk-toast');
    await expect(toast).toBeVisible({ timeout: 15000 });
    await expect(toast.locator('.vk-toast-message')).toHaveText(MSG_PARTIAL);
    const restartCard = win.locator('#sidebar-restart-required');
    await expect(restartCard).toBeVisible();
    await expect(restartCard.locator('.config-reflection-partial')).toBeVisible();
    await expect(restartCard.locator('.config-reflection-partial')).toHaveText(MSG_REST);
    await win.evaluate(() => window.openSettingsModal());
    const notice = win.locator('.settings-restart-notice[data-tab-id="general"]');
    await expect(notice).toBeVisible();
    await expect(notice.locator('.config-reflection-partial')).toHaveText(MSG_REST);
    const panelGaps = await gaps(win, '.settings-restart-notice[data-tab-id="general"]');
    for (const gap of panelGaps.inner) {
      expect(gap.px).toBeLessThan(panelGaps.visiblePaddingBottom);
    }
    expect(panelGaps.visiblePaddingBottom).toBeLessThanOrEqual(panelGaps.gapToNextCard);
    await win.keyboard.press('Escape');
    await expect(toast).toBeHidden({ timeout: 10000 });
    expect(await win.evaluate(() => newPaneAutoLaunchClaude)).toBe(true);
    const shows = showsAfter(await toastLog(win), since);
    expect(shows.map((e) => e.text)).toEqual([MSG_PARTIAL]);
  });

  // @title ライトテーマ（OS 設定）でも同じ表示が読める
  test('7. ライトテーマで成功トースト・失敗表示・残りの案内', async () => {
    // @step OS のライト表示に切り替え、設定ファイルの破損と修復を行う
    // @check 失敗案内と残りの再起動案内が表示される
    await win.emulateMedia({ colorScheme: 'light' });
    expect(await win.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches)).toBe(true);
    await win.waitForTimeout(DEDUP_GAP_MS);
    const valid = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, valid.trimEnd().replace(/\}\s*$/, ''));
    await expect(win.locator('#sidebar-config-read-error')).toBeVisible({ timeout: 15000 });
    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('.settings-config-read-error')).toBeVisible();
    await win.keyboard.press('Escape');
    fs.writeFileSync(configPath, valid);
    await expect(win.locator('#sidebar-config-read-error')).toBeHidden({ timeout: 15000 });
    await win.waitForTimeout(DEDUP_GAP_MS);
    const config = readJson(configPath);
    config.terminalLinkClickMode = 'modifier';
    writeJson(configPath, config);
    const toast = win.locator('.vk-toast');
    await expect(toast).toBeVisible({ timeout: 15000 });
    await expect(toast.locator('.vk-toast-message')).toHaveText(MSG_PARTIAL);
    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('.settings-restart-notice[data-tab-id="general"] .config-reflection-partial')).toBeVisible();
    await win.keyboard.press('Escape');
    expect(await win.evaluate(() => terminalLinkClickModePref)).toBe('modifier');
    await win.emulateMedia({ colorScheme: 'dark' });
  });

  // @title ウィンドウ幅を狭くしても長いファイルパスが折り返され、はみ出さない
  test('8. 狭いウィンドウで長いパスが折り返される', async () => {
    // @step ウィンドウ幅を狭くし、設定ファイルを壊す
    // @check 長いファイルパスが折り返され、画面からはみ出さない
    // ウィンドウの最小幅（600px）まで狭める。
    await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setSize(560, 720); });
    await expect.poll(() => win.evaluate(() => innerWidth)).toBeLessThanOrEqual(600);
    await win.waitForTimeout(DEDUP_GAP_MS);
    const valid = fs.readFileSync(configPath, 'utf8');
    fs.writeFileSync(configPath, valid.trimEnd().replace(/\}\s*$/, ''));
    const sidebarError = win.locator('#sidebar-config-read-error');
    await expect(sidebarError).toBeVisible({ timeout: 15000 });
    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('.settings-config-read-error')).toBeVisible();
    const narrow = await win.evaluate(() => {
      const pick = (sel) => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); return { right: +r.right.toFixed(1), scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }; };
      const sb = document.querySelector('#sidebar').getBoundingClientRect();
      const modal = document.querySelector('.settings-modal').getBoundingClientRect();
      return {
        innerWidth, sidebarRight: +sb.right.toFixed(1), modalRight: +modal.right.toFixed(1),
        sidebarCard: pick('#sidebar-config-read-error'), sidebarLi: pick('#sidebar-config-read-error li'),
        panelLi: pick('.settings-config-read-error li'),
        docScrollWidth: document.documentElement.scrollWidth,
      };
    });
    expect(narrow.sidebarLi.scrollWidth).toBeLessThanOrEqual(narrow.sidebarLi.clientWidth + 1);
    expect(narrow.sidebarLi.right).toBeLessThanOrEqual(narrow.sidebarRight);
    expect(narrow.sidebarCard.scrollWidth).toBeLessThanOrEqual(narrow.sidebarCard.clientWidth + 1);
    expect(narrow.panelLi.scrollWidth).toBeLessThanOrEqual(narrow.panelLi.clientWidth + 1);
    expect(narrow.panelLi.right).toBeLessThanOrEqual(narrow.modalRight);
    expect(narrow.docScrollWidth).toBeLessThanOrEqual(narrow.innerWidth);
    await win.keyboard.press('Escape');
    fs.writeFileSync(configPath, valid);
    await expect(sidebarError).toBeHidden({ timeout: 15000 });
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1400, 900); });
  });
});
