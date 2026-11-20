'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// ⌘ + W でウィンドウを閉じないこと、ウィンドウを閉じても作業ペインが動き続け、
// Dock のアイコン（activate）で作り直したウィンドウへ同じペインがつながることを、実アプリで確かめる（issue #649）。

const holderLauncherPath = path.resolve(__dirname, '..', 'fixtures', 'embeddedHolderLauncher.js');

test.skip(process.platform !== 'darwin', '⌘ + W と Dock からの作り直しは macOS の動作');

async function start(prefix, options = {}) {
  const port = await getFreePort();
  const launched = await launchAppAndWait({ port, prefix, config: { confirmClose: 'never' }, ...options });
  return { ...launched, port };
}

// 組み込み元（古い VK Orchestrator.app）と同じく、「ファイル」メニューに「ウィンドウを閉じる」（⌘ + W）を置く。
async function installFileMenu(app) {
  await app.evaluate(({ Menu }) => {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { label: 'App', submenu: [{ role: 'quit' }] },
      { role: 'fileMenu' },
    ]));
  });
}

// 指定した webContents へ ⌘ + W を押した入力を送る。target は 'window' か、アプリ内ブラウザのページの URL。
async function pressCommandW(app, target) {
  await app.evaluate(({ BrowserWindow, webContents }, url) => {
    const contents = url === 'window'
      ? BrowserWindow.getAllWindows()[0].webContents
      : webContents.getAllWebContents().find(item => item.getURL() === url);
    contents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['meta'] });
    contents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['meta'] });
  }, target);
}

const windowCount = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
const tabs = win => win.getByRole('tablist', { name: 'アプリ内ブラウザのタブ' }).getByRole('tab');
const address = win => win.locator('.internal-browser-toolbar').getByRole('textbox', { name: 'URL または検索語を入力' });

// 手元の HTTP サーバーでページを応答する（外部の通信に頼らない）。
async function startPageServer() {
  const server = http.createServer((req, res) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>ページ ${pathname.slice(1).toUpperCase()}</title><p>${pathname}</p>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  server.origin = `http://127.0.0.1:${server.address().port}`;
  server.stop = () => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
  return server;
}

// 最初のペインのシェルが起動するまで待ち、ペインの名前と番号を返す。
async function waitForFirstPane(win) {
  await win.waitForFunction(() => Object.keys(terminals).length === 1 && Object.values(terminals)[0].termId);
  return win.evaluate(() => {
    const [paneId, t] = Object.entries(terminals)[0];
    return { paneId, termId: t.termId };
  });
}

// ペインへ printf を打ち、出力行（コマンドのエコーではない行）が画面に出るまで待つ。
async function printMarker(win, paneId, marker) {
  await win.evaluate(({ id, text }) => terminals[id].term.input(`printf '%s\\n' ${text}\r`), { id: paneId, text: marker });
  await waitForMarker(win, paneId, marker);
}

async function waitForMarker(win, paneId, marker) {
  await win.waitForFunction(({ id, text }) => {
    const t = terminals[id];
    if (!t) return false;
    const buffer = t.term.buffer.active;
    for (let i = 0; i < buffer.length; i += 1) {
      const line = buffer.getLine(i)?.translateToString(true) || '';
      if (line.includes(text) && !line.includes('printf')) return true;
    }
    return false;
  }, { id: paneId, text: marker }, { timeout: 15_000 });
}

// ウィンドウを閉じ、アプリが終了せず残っていることを確かめる。
async function closeWindow(app) {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
  await expect.poll(() => windowCount(app)).toBe(0);
}

// Dock のアイコンを押したときの activate を送り、作り直したウィンドウを受け取る。
async function reopenFromDock(app) {
  const [win] = await Promise.all([
    app.waitForEvent('window'),
    app.evaluate(({ app: electronApp }) => { electronApp.emit('activate'); }),
  ]);
  await win.waitForSelector('#sidebar', { state: 'attached' });
  return win;
}

// @title ⌘ + W はアプリ内ブラウザのタブを 1 つ閉じ、最後のタブでもウィンドウを閉じない
test('⌘ + W はアプリ内ブラウザのタブを 1 つ閉じ、最後のタブでもウィンドウを閉じない', async () => {
  const pages = await startPageServer();
  let launched;
  try {
    launched = await start('vk-terminals-e2e-cmd-w-browser-', { config: { confirmClose: 'never', openInitialPane: false } });
    const { app, win } = launched;
    await installFileMenu(app);
    // @step アプリ内ブラウザを開き、2 つのタブにページを開く
    await win.locator('#internal-browser-toggle').click();
    await address(win).fill(`${pages.origin}/a`);
    await address(win).press('Enter');
    await expect(tabs(win).first()).toHaveAccessibleName('ページ A');
    await win.getByRole('button', { name: '新しいタブ', exact: true }).click();
    await address(win).fill(`${pages.origin}/b`);
    await address(win).press('Enter');
    await expect(tabs(win).nth(1)).toHaveAccessibleName('ページ B');

    // @step ページを操作している状態で ⌘ + W を押す
    await pressCommandW(app, `${pages.origin}/b`);
    // @check そのタブだけが閉じ、残ったタブが選ばれる。ウィンドウは閉じない
    await expect(tabs(win)).toHaveCount(1);
    await expect(tabs(win).first()).toHaveAccessibleName('ページ A');
    await expect(tabs(win).first()).toHaveAttribute('aria-selected', 'true');
    expect(await windowCount(app)).toBe(1);
    // 次に選んだタブのページへのフォーカスの移動は、e2e ではウィンドウを表示しないため isFocused が常に false になり確かめられない。
    // tests/windowLifecycle.test.js で確かめる。

    // @step URL 欄にフォーカスを置いて ⌘ + W を押す（最後のタブ）
    await address(win).focus();
    await pressCommandW(app, 'window');
    // @check 最後のタブが閉じてサイドバーごと閉じ、ウィンドウは閉じない
    await expect(win.locator('#root')).not.toHaveClass(/\binternal-browser-open\b/);
    await expect(win.locator('#internal-browser-toggle')).toBeFocused();
    expect(await windowCount(app)).toBe(1);
  } finally {
    if (launched) await closeApp(launched);
    await pages.stop();
  }
});

// @title 作業ペインを操作しているときの ⌘ + W は何もしない
test('作業ペインを操作しているときの ⌘ + W は何もしない', async () => {
  let launched;
  try {
    launched = await start('vk-terminals-e2e-cmd-w-pane-');
    const { app, win } = launched;
    await installFileMenu(app);
    const { paneId } = await waitForFirstPane(win);
    // 画面のキー入力（ペインへ届く入力）を記録する。
    await win.evaluate(() => {
      window.__commandWKeys = 0;
      window.addEventListener('keydown', event => { if (event.metaKey && event.key.toLowerCase() === 'w') window.__commandWKeys += 1; }, true);
    });
    // @step ペインにフォーカスを置いて ⌘ + W を押す
    await win.evaluate(id => terminals[id].term.focus(), paneId);
    await pressCommandW(app, 'window');
    // @check ウィンドウもペインも残り、ペインへキー入力は届かない
    await expect.poll(() => win.evaluate(() => Object.keys(terminals).length)).toBe(1);
    expect(await windowCount(app)).toBe(1);
    expect(await win.evaluate(() => window.__commandWKeys)).toBe(0);
  } finally {
    if (launched) await closeApp(launched);
  }
});

// @title ウィンドウを閉じても作業ペインは動き続け、Dock から開くと同じペインへつながる
test('ウィンドウを閉じても作業ペインは動き続け、Dock から開くと同じペインへつながる', async () => {
  let launched;
  try {
    launched = await start('vk-terminals-e2e-window-reopen-');
    const { app } = launched;
    let { win } = launched;
    const first = await waitForFirstPane(win);
    // @step ペインに目印を表示してから、ウィンドウを閉じる
    await printMarker(win, first.paneId, 'BEFORE_CLOSE_649');
    await closeWindow(app);

    // @step Dock のアイコンを押す
    win = await reopenFromDock(app);
    // @check 同じ番号のペインが 1 枚だけ戻り、閉じる前の表示も戻る
    await expect.poll(() => win.evaluate(() => Object.values(terminals).map(t => t.termId))).toEqual([first.termId]);
    const reopened = await waitForFirstPane(win);
    await waitForMarker(win, reopened.paneId, 'BEFORE_CLOSE_649');
    // @check 戻ったペインへ入力でき、出力が画面に出る
    await printMarker(win, reopened.paneId, 'AFTER_REOPEN_649');
  } finally {
    if (launched) await closeApp(launched);
  }
});

async function postJson(port, pathname, payload) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const setupShellLauncherPath = path.resolve(__dirname, '..', 'fixtures', 'embeddedSetupShellLauncher.js');

// @title セットアップ用シェルの組み込み起動でも、Dock から開くと新しいシェルを作らず同じペインへつながる
test('セットアップ用シェルの組み込み起動でも、Dock から開くと新しいシェルを作らず同じペインへつながる', async () => {
  let launched;
  try {
    launched = await start('vk-terminals-e2e-window-reopen-setup-shell-', { entry: setupShellLauncherPath });
    const { app } = launched;
    let { win } = launched;
    const first = await waitForFirstPane(win);
    await printMarker(win, first.paneId, 'SETUP_SHELL_649');
    // @step ウィンドウを閉じて、Dock のアイコンを押す
    await closeWindow(app);
    win = await reopenFromDock(app);
    // @check 同じ番号のペイン 1 枚だけにつながり、新しいシェルは作られない
    const reopened = await waitForFirstPane(win);
    expect(reopened.termId).toBe(first.termId);
    await waitForMarker(win, reopened.paneId, 'SETUP_SHELL_649');
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(await win.evaluate(() => Object.values(terminals).map(t => t.termId))).toEqual([first.termId]);
  } finally {
    if (launched) await closeApp(launched);
  }
});

// @title 閉じる保護・入力待ち・作業フォルダは、ウィンドウを作り直しても戻る
test('閉じる保護・入力待ち・作業フォルダは、ウィンドウを作り直しても戻る', async () => {
  let launched;
  try {
    launched = await start('vk-terminals-e2e-window-reopen-state-');
    const { app, port, tmpHome } = launched;
    let { win } = launched;
    const first = await waitForFirstPane(win);
    const second = await win.evaluate(async () => {
      const { paneId } = await addPane(null, { noClaude: true });
      return { paneId, termId: terminals[paneId].termId };
    });
    // @step 1 枚目は閉じられないよう保護し、作業フォルダの通知を /a → /b の順に出す
    expect((await postJson(port, '/api/set-lock', { termId: first.termId, lock: { close: false } })).status).toBe(200);
    await expect(win.locator(`.pane[data-id="${first.paneId}"] .btn-close`)).toHaveAttribute('aria-disabled', 'true');
    const dirA = path.join(tmpHome, 'a');
    const dirB = path.join(tmpHome, 'b');
    await win.evaluate(({ id, a, b }) => terminals[id].term.input(`printf '\\033]7;file://h%s\\007\\033]7;file://h%s\\007' ${a} ${b}\r`), { id: first.paneId, a: dirA, b: dirB });
    await expect.poll(() => win.evaluate(id => terminals[id].cwdFull, first.paneId)).toBe(dirB);
    // 並びの記録が main へ届くのを待つ（保存は 100ms まとめてから送る）
    await new Promise(resolve => setTimeout(resolve, 500));

    // @step ウィンドウを閉じている間に、2 枚目を保護し、1 枚目を入力待ちにする
    await closeWindow(app);
    expect((await postJson(port, '/api/set-lock', { termId: second.termId, lock: { close: false } })).status).toBe(200);
    expect((await postJson(port, '/api/set-status', { termId: first.termId, waiting: true })).status).toBe(200);

    // @step Dock のアイコンを押す
    win = await reopenFromDock(app);
    await expect.poll(() => win.evaluate(() => Object.keys(terminals).length)).toBe(2);
    const paneIdOf = termId => win.evaluate(id => Object.keys(terminals).find(key => terminals[key].termId === id), termId);
    const firstPaneId = await paneIdOf(first.termId);
    const secondPaneId = await paneIdOf(second.termId);
    // @check 閉じる前と閉じている間の保護が残り、閉じる操作をしてもペインは閉じない
    for (const paneId of [firstPaneId, secondPaneId]) {
      await expect(win.locator(`.pane[data-id="${paneId}"] .btn-close`)).toHaveAttribute('aria-disabled', 'true');
      await win.locator(`.pane[data-id="${paneId}"] .btn-close`).click({ force: true });
    }
    expect(await win.evaluate(() => Object.keys(terminals).length)).toBe(2);
    // @check 入力待ちと、最後に通知された作業フォルダ（/b）が戻る
    expect(await win.evaluate(id => terminals[id].externalWaiting, firstPaneId)).toBe(true);
    await expect.poll(() => win.evaluate(id => terminals[id].cwdFull, firstPaneId)).toBe(dirB);
  } finally {
    if (launched) await closeApp(launched);
  }
});

// @title 保持役を使うとき、ウィンドウを閉じても tmux のペインを止めず、Dock から開くと同じペインへつながる
test('保持役を使うとき、ウィンドウを閉じても tmux のペインを止めず、Dock から開くと同じペインへつながる', async () => {
  const tmux = (process.env.PATH || '').split(path.delimiter).map(dir => path.join(dir, 'tmux'))
    .find(file => { try { fs.accessSync(file, fs.constants.X_OK); return true; } catch (_) { return false; } });
  test.skip(!tmux, 'tmux is unavailable');
  // 利用者の保持役とは別の、このテスト専用のソケットを短い実パスのフォルダに置く。
  const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vkc-')));
  const socket = path.join(runDir, 'tmux.sock');
  const listPanes = () => spawnSync(tmux, ['-S', socket, 'list-panes', '-a', '-F', '#{pane_id} #{@vk_term_id}'], { encoding: 'utf8' }).stdout
    .split('\n').filter(line => /^%\d+ \d+$/.test(line));
  let launched;
  try {
    launched = await start('vk-terminals-e2e-window-reopen-holder-', { entry: holderLauncherPath, env: { VK_TERMINALS_HOLDER_RUN_DIR: runDir } });
    const { app } = launched;
    let { win } = launched;
    const first = await waitForFirstPane(win);
    await printMarker(win, first.paneId, 'HOLDER_BEFORE_CLOSE_649');
    const panesBeforeClose = listPanes();
    expect(panesBeforeClose.some(line => line.endsWith(` ${first.termId}`))).toBe(true);

    // @step ウィンドウを閉じる
    await closeWindow(app);
    // @check tmux のペインは止まらずに残る
    await new Promise(resolve => setTimeout(resolve, 1000));
    expect(listPanes()).toEqual(panesBeforeClose);

    // @step Dock のアイコンを押す
    win = await reopenFromDock(app);
    // @check 同じペインへつながり、閉じる前の表示が tmux の履歴から戻り、入力もできる
    await expect.poll(() => win.evaluate(() => Object.values(terminals).map(t => t.termId))).toEqual([first.termId]);
    const reopened = await waitForFirstPane(win);
    await waitForMarker(win, reopened.paneId, 'HOLDER_BEFORE_CLOSE_649');
    await printMarker(win, reopened.paneId, 'HOLDER_AFTER_REOPEN_649');
    expect(listPanes()).toEqual(panesBeforeClose);
  } finally {
    if (launched) await closeApp(launched);
    // このテスト専用の保持役の tmux サーバーを止め、置き場を片付ける。
    spawnSync(tmux, ['-S', socket, 'kill-server'], { stdio: 'ignore' });
    fs.rmSync(runDir, { recursive: true, force: true });
  }
});
