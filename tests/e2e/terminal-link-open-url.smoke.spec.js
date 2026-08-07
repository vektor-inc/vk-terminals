const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// ─── ペイン内 URL の Cmd/Ctrl+クリック（issue #349 / PR #350） ─────────────────────
//
// tests/urlLinkify.test.js・tests/terminalLinkProvider.test.js・
// tests/terminalLinkPolicy.test.js は「文字列から URL 範囲を切り出す」「折り返し行を
// バッファ座標へ写像する」「修飾キーが押されているか」を純粋関数レベルで個別に検証
// 済み（29 件追加）。ここではそれらが実際に xterm.js のバッファへ配線され、本物の
// マウスイベントでホバー・クリックが動くかという統合部分だけを見る。
//
// 位置計算の考え方:
//   ペインの `.xterm-screen` の getBoundingClientRect() を term.cols / term.rows で
//   割ってセル 1 個分のピクセルサイズを近似し、バッファ上の (行, 列) から画面座標へ
//   変換する。xterm.js は screenElement に mousemove / mousedown / mouseup を
//   listen しているため、Playwright の win.mouse.move/down/up が本物のブラウザ
//   イベントとして届けば、そのまま Linkifier のホバー・クリック判定を通る。
//
// PTY への文字列注入は POST /api/send（main.js）を使う。実際にシェルへ
// `echo "<文字列>"` を打鍵させて xterm に描画させるため、@xterm/addon-web-links を
// 使わない自前実装が「本物の描画結果」に対しても正しく動くことを見られる。

async function postSend(port, input) {
  const res = await fetch(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId: '1', input }),
  });
  let body = null;
  try { body = await res.json(); } catch (_e) { /* 診断用 */ }
  return { res, body };
}

// termId "1" は起動時に renderer が作る最初のペインの PTY。登録前は 404 を返すため、
// 200 になるまで短くリトライする（他 spec の waitForPtyRegistration と同じ考え方）。
async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const { res, body } = await postSend(port, '');
      if (res.status === 200) return;
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(body)}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('terminal 1 was not registered in time');
}

// pane-1 の可視バッファ（折り返しを含む全行）に needle を含む行が現れるまで待つ。
async function waitForBufferText(win, needle, paneId = 'pane-1', timeout = 15_000) {
  await win.waitForFunction(({ u, id }) => {
    const t = terminals[id];
    if (!t) return false;
    const buf = t.term.buffer.active;
    for (let i = 0; i < t.term.rows; i += 1) {
      const line = buf.getLine(buf.viewportY + i);
      if (line && line.translateToString(true).includes(u)) return true;
    }
    return false;
  }, { u: needle, id: paneId }, { timeout });
}

// 可視バッファの中から needle を含む最後（＝一番下）の出現位置を探し、画面上の
// セル座標へ変換するための情報を返す。見つからなければ null。
// 「最後の出現」を選ぶのは、`echo "url"` と打鍵したときにコマンドライン自体にも
// 同じ文字列が現れるため、実際の出力行（後に描画される方）を優先するため。
async function findTextPosition(win, needle, paneId = 'pane-1') {
  return win.evaluate(({ u, id }) => {
    const t = terminals[id];
    if (!t) return null;
    const buf = t.term.buffer.active;
    let rowFound = -1;
    let col = -1;
    for (let i = 0; i < t.term.rows; i += 1) {
      const line = buf.getLine(buf.viewportY + i);
      if (!line) continue;
      const text = line.translateToString(true);
      const idx = text.lastIndexOf(u);
      if (idx >= 0) { rowFound = i; col = idx; }
    }
    if (rowFound < 0) return null;
    const container = document.querySelector(`.pane[data-id="${id}"] .xterm-screen`);
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return {
      row: rowFound,
      col,
      cols: t.term.cols,
      rows: t.term.rows,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }, { u: needle, id: paneId });
}

// pos（findTextPosition の戻り値）の col から colOffset 分だけ右のセル中央へマウスを
// 動かす。needle の先頭ちょうどだと隣接テキストとの境界に乗りやすいため、呼び出し側は
// 基本的に needle の内側（2〜3 セルほど右）を指す colOffset を渡す。
async function hoverAtOffset(win, pos, colOffset) {
  const cellW = pos.rect.width / pos.cols;
  const cellH = pos.rect.height / pos.rows;
  const x = pos.rect.x + (pos.col + colOffset) * cellW;
  const y = pos.rect.y + (pos.row + 0.5) * cellH;
  await win.mouse.move(x, y);
  // xterm.js 側のホバー判定（Linkifier._handleMouseMove）が走るのを待つ。
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// ターミナル領域の外（サイドバー付近）へ退避させ、ホバー状態を確実に解除する。
async function moveMouseAway(win) {
  await win.mouse.move(4, 4);
  await new Promise((resolve) => setTimeout(resolve, 150));
}

async function getTooltip(win) {
  return win.evaluate(() => {
    const el = document.querySelector('.term-link-tooltip');
    return el ? { hidden: el.hidden, text: el.textContent } : null;
  });
}

async function isMacPlatform(win) {
  return win.evaluate(() => window.VKTerminalLinkPolicy.isMacPlatform());
}

// pos の col + colOffset のセルへ、実行環境の修飾キー（mac なら Cmd、それ以外は Ctrl）を
// 押しながらクリックする。
async function modifierClickAtOffset(win, pos, colOffset, mac) {
  const cellW = pos.rect.width / pos.cols;
  const cellH = pos.rect.height / pos.rows;
  const x = pos.rect.x + (pos.col + colOffset) * cellW;
  const y = pos.rect.y + (pos.row + 0.5) * cellH;
  const key = mac ? 'Meta' : 'Control';
  await win.mouse.move(x, y);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await win.keyboard.down(key);
  // ホバー状態を保ったままキーだけ足す（xterm.js のクリック判定は最新の hover 結果を使う）。
  await win.mouse.move(x, y);
  await win.mouse.down();
  await win.mouse.up();
  await win.keyboard.up(key);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// 修飾キー無しでそのままクリックする（pos.col + colOffset のセル）。
async function plainClickAtOffset(win, pos, colOffset) {
  const cellW = pos.rect.width / pos.cols;
  const cellH = pos.rect.height / pos.rows;
  const x = pos.rect.x + (pos.col + colOffset) * cellW;
  const y = pos.rect.y + (pos.row + 0.5) * cellH;
  await win.mouse.move(x, y);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await win.mouse.down();
  await win.mouse.up();
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// shell.openExternal を main プロセス側で差し替える（external-url-toast.smoke.spec.js と
// 同じ手口）。実際に OS のブラウザは開かせず、呼び出しだけを記録する。
async function stubShellOpenExternal(app) {
  await app.evaluate(({ shell }) => {
    if (!globalThis.__origOpenExternal) globalThis.__origOpenExternal = shell.openExternal;
    globalThis.__openExternalCalls = [];
    shell.openExternal = async (url) => {
      globalThis.__openExternalCalls.push(url);
    };
  });
}
async function restoreShellOpenExternal(app) {
  await app.evaluate(({ shell }) => {
    if (!globalThis.__origOpenExternal) return;
    shell.openExternal = globalThis.__origOpenExternal;
    delete globalThis.__origOpenExternal;
    delete globalThis.__openExternalCalls;
  });
}
async function getOpenExternalCalls(app) {
  return app.evaluate(() => (globalThis.__openExternalCalls || []).slice());
}
async function clearOpenExternalCalls(app) {
  await app.evaluate(() => { globalThis.__openExternalCalls = []; });
}

test.describe.serial('ペイン内 URL の Cmd/Ctrl+クリック（issue #349 / PR #350）', () => {
  let app;
  let win;
  let tmpRoot;
  let port;
  let mac;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp({
      port,
      prefix: 'vk-terminals-e2e-terminal-link-open-url-',
    }));
    await waitForPtyRegistration(port);
    await stubShellOpenExternal(app);
    mac = await isMacPlatform(win);
  });

  test.afterAll(async () => {
    await restoreShellOpenExternal(app);
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await clearOpenExternalCalls(app);
    await moveMouseAway(win);
  });

  test('URL にホバーすると、解決後のホスト名と修飾キー案内をツールチップに出す', async () => {
    const url = 'https://example.com/vk-terminals-e2e-hover';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 3);

    const tooltip = await getTooltip(win);
    expect(tooltip).not.toBeNull();
    expect(tooltip.hidden).toBe(false);
    // ホストは new URL(url).host（VKUrlLinkify.getUrlHost）による解決後の値。
    expect(tooltip.text).toContain('example.com');
    expect(tooltip.text).toContain(mac ? '⌘+クリック' : 'Ctrl+クリック');
  });

  test('修飾キー無しのクリックではブラウザを開かない（誤操作防止の最重要仕様）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-plain-click';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await plainClickAtOffset(win, pos, 3);

    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

  test('Cmd/Ctrl+クリックでブラウザが開く（openExternal に正しい URL が渡る）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-modifier-click';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await modifierClickAtOffset(win, pos, 3, mac);

    expect(await getOpenExternalCalls(app)).toEqual([url]);
  });

  test('URL 末尾に日本語の句読点が続いても、句読点自体はリンクに含まれない', async () => {
    // 先頭に全角文字を置くと xterm 側のセル幅（ワイド文字は 2 セル）と JS 文字列
    // インデックスがずれるため、この spec の位置計算（indexOf ベース）が破綻する。
    // 末尾の巻き込み確認が目的なので、URL 自体は先頭に置き、句読点だけを後ろに続ける。
    const url = 'https://example.com/vk-terminals-e2e-punct';
    await postSend(port, `echo "${url}。"\r`);
    await waitForBufferText(win, `${url}。`);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await modifierClickAtOffset(win, pos, 3, mac);

    // 「。」を含まない、trimTrailingPunctuation() 適用後の URL だけが渡る。
    expect(await getOpenExternalCalls(app)).toEqual([url]);
  });

  test('http://localhost:PORT / http://127.0.0.1:PORT はどちらもリンクとして機能する（ドットの無いホスト誤除外の回帰）', async () => {
    const localUrl = `http://localhost:${port}/vk-terminals-e2e-localhost`;
    const loopbackUrl = `http://127.0.0.1:${port}/vk-terminals-e2e-loopback`;
    await postSend(port, `echo "${localUrl} ${loopbackUrl}"\r`);
    await waitForBufferText(win, loopbackUrl);

    const localPos = await findTextPosition(win, localUrl);
    expect(localPos).not.toBeNull();
    await modifierClickAtOffset(win, localPos, 3, mac);
    expect(await getOpenExternalCalls(app)).toEqual([localUrl]);

    await moveMouseAway(win);
    await clearOpenExternalCalls(app);

    const loopbackPos = await findTextPosition(win, loopbackUrl);
    expect(loopbackPos).not.toBeNull();
    await modifierClickAtOffset(win, loopbackPos, 3, mac);
    expect(await getOpenExternalCalls(app)).toEqual([loopbackUrl]);
  });

  test('なりすまし URL（user:pass@host 形式）はリンク化されない', async () => {
    const spoofed = 'https://github.com@example.com/login';
    await postSend(port, `echo "${spoofed}"\r`);
    await waitForBufferText(win, spoofed);

    const pos = await findTextPosition(win, 'github.com@example.com/login');
    expect(pos).not.toBeNull();
    // ホバーしてもツールチップは出ない（リンクとして登録されていない）。
    await hoverAtOffset(win, pos, 3);
    const tooltip = await getTooltip(win);
    expect(tooltip === null || tooltip.hidden === true).toBe(true);

    // 修飾キー付きクリックをしても openExternal は一切呼ばれない。
    await modifierClickAtOffset(win, pos, 3, mac);
    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

  test('URL を含む行をドラッグして範囲選択できる（従来どおりの選択・コピー操作のデグレ確認）', async () => {
    // xterm.js の Linkifier は mousedown 時点のリンクと mouseup 時点のリンクが一致した
    // ときだけ activate を呼ぶ（renderer/app.js のコメント・xterm.js 本体の
    // src/browser/Linkifier.ts で保証されている挙動）。ドラッグ選択は mousedown と
    // mouseup の位置が変わるため、この経路と衝突しないはず。ここでは実際にマウスで
    // ドラッグして、選択できること・その間 openExternal が呼ばれないことを確認する。
    const url = 'https://example.com/vk-terminals-e2e-drag-select';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    const cellW = pos.rect.width / pos.cols;
    const cellH = pos.rect.height / pos.rows;
    const startX = pos.rect.x + (pos.col + 1) * cellW;
    const endX = pos.rect.x + (pos.col + url.length - 1) * cellW;
    const y = pos.rect.y + (pos.row + 0.5) * cellH;

    await win.mouse.move(startX, y);
    await win.mouse.down();
    await win.mouse.move(endX, y, { steps: 10 });
    await win.mouse.up();
    await new Promise((resolve) => setTimeout(resolve, 250));

    const selection = await win.evaluate(() => terminals['pane-1'].term.getSelection());
    expect(selection).toContain('example.com/vk-terminals-e2e-drag-select');
    // ドラッグはクリックではないため、ブラウザは開かない。
    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

  test('ペイン幅を狭めて折り返した URL は、後半行からホバーしても 1 本のリンクとして開ける', async () => {
    const originalBounds = await app.evaluate(({ BrowserWindow }) => (
      BrowserWindow.getAllWindows()[0].getBounds()
    ));
    try {
      // 折り返しが起きるところまで cols を減らす。
      await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].setBounds({ width: 700, height: 500 });
      });
      await win.waitForFunction(() => {
        const t = terminals['pane-1'];
        return t && t.term.cols < 60;
      }, null, { timeout: 15_000 });

      const url = 'https://github.com/vektor-inc/vk-terminals/issues?q=is%3Aissue+is%3Aopen+sort%3Aupdated-desc';
      await postSend(port, `echo "${url}"\r`);

      // 出力行の折り返しが完了し、かつ折り返し継続行（isWrapped）のうち URL の末尾を
      // 含む行が現れるまで待つ。末尾の断片（例: "dated-desc"）は cols の値次第で
      // ちょうど折り返し境界をまたぐことがあり、1 行だけを見ると一致しない場合がある
      // ため、隣接する折り返し継続行どうしを連結してから判定する（renderer/
      // terminalLinkProvider.js の getWrappedLineWindow と同じ考え方）。
      // 高負荷環境（並行して他の Electron/Playwright プロセスが動く等）では PTY 出力の
      // 反映が遅れることがあるため、既定より長めに待つ。
      const findTailRow = (u) => {
        const t = terminals['pane-1'];
        const buf = t.term.buffer.active;
        const lines = [];
        for (let i = 0; i < t.term.rows; i += 1) {
          const line = buf.getLine(buf.viewportY + i);
          lines.push(line ? { isWrapped: line.isWrapped, text: line.translateToString(true) } : null);
        }
        for (let i = 0; i < lines.length; i += 1) {
          if (!lines[i] || !lines[i].isWrapped) continue;
          // この行だけ、または前の折り返し継続行（あれば）と連結した文字列に
          // 末尾断片が含まれていれば、この行を「末尾を含む折り返し継続行」とみなす。
          const prevText = (i > 0 && lines[i - 1]) ? lines[i - 1].text : '';
          const merged = prevText + lines[i].text;
          if (merged.includes(u.slice(-10)) && lines[i].text.length > 0) {
            return { row: i, text: lines[i].text };
          }
        }
        return null;
      };
      await win.waitForFunction(findTailRow, url, { timeout: 30_000 });
      const tailRow = await win.evaluate(findTailRow, url);
      expect(tailRow).not.toBeNull();

      const container = await win.evaluate(() => {
        const rect = document.querySelector('.xterm-screen').getBoundingClientRect();
        const t = terminals['pane-1'];
        return { rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, cols: t.term.cols, rows: t.term.rows };
      });
      const pos = {
        row: tailRow.row,
        col: 0,
        cols: container.cols,
        rows: container.rows,
        rect: container.rect,
      };
      // 折り返し継続行の先頭寄りをホバー・クリックする（後半行だけを見ている状態を再現）。
      await hoverAtOffset(win, pos, 1);
      const tooltip = await getTooltip(win);
      expect(tooltip).not.toBeNull();
      expect(tooltip.hidden).toBe(false);
      expect(tooltip.text).toContain('github.com');

      await modifierClickAtOffset(win, pos, 1, mac);
      // 分断されていない完全な URL が渡る。
      expect(await getOpenExternalCalls(app)).toEqual([url]);
    } finally {
      await app.evaluate(({ BrowserWindow }, bounds) => {
        BrowserWindow.getAllWindows()[0].setBounds(bounds);
      }, originalBounds);
      await win.waitForFunction(() => {
        const t = terminals['pane-1'];
        return t && t.term.cols >= 60;
      }, null, { timeout: 15_000 });
    }
  });

  test('ホバー中に window blur が起きるとツールチップが消える（別アプリへの切り替え相当）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-blur';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 3);
    let tooltip = await getTooltip(win);
    expect(tooltip.hidden).toBe(false);

    // renderer/app.js は window の 'blur' イベントで hideTermLinkTooltip() を呼ぶ
    // （⌘+Tab 等での他アプリへの切り替え相当）。
    await win.evaluate(() => window.dispatchEvent(new Event('blur')));
    await new Promise((resolve) => setTimeout(resolve, 150));
    tooltip = await getTooltip(win);
    expect(tooltip.hidden).toBe(true);
  });

  // ─── render() の再構築でツールチップが残らない（PR #350 追補） ──────────────────
  // tests/e2e/external-url-toast.smoke.spec.js の「ペインを追加した後（render() の
  // 再構築後）も、トーストは再び表示される」と同じ考え方。render()（renderer/app.js）は
  // #root の子を root.replaceChildren() で丸ごと差し替え、xterm の要素を新しい
  // コンテナへ移し替える。ホバー中に呼ばれると xterm 側の leave が発火しないため、
  // render() の先頭で明示的に hideTermLinkTooltip() を呼ぶようにした（Claude Code
  // レビュー指摘・LOW）。この回帰テスト。
  //
  // ⚠ このファイルは test.describe.serial + beforeAll で 1 つのアプリインスタンスを
  // 全テストで共有しており、実行順に依存する（司のレビューで実際に踏んだ落とし穴）。
  // 直後の「ホバー中にそのペインを閉じると…」テストが最後に pane-1 を閉じるため、
  // pane-1 を前提にするテストは必ずそれより前に置くこと。後から追加するテストで
  // pane-1（や他テストが閉じる／作り直すペイン）に依存する場合は、この並び順の制約を
  // 忘れずに確認する。
  test('ペインを追加した後（render() の再構築後）は、古いツールチップが残らずホバーし直せば再表示される', async () => {
    const url = 'https://example.com/vk-terminals-e2e-render-rebuild';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url, 'pane-1');

    let pos = await findTextPosition(win, url, 'pane-1');
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 3);
    let tooltip = await getTooltip(win);
    expect(tooltip.hidden).toBe(false);

    // ペインを追加する（render() が #root の子を丸ごと差し替える経路を踏む）。マウスは
    // 動かしていないため、xterm 側の leave には頼れない状態を再現している。
    // このファイルは test.describe.serial でアプリを共有しており、後続テストも
    // ペインを追加するため、絶対数ではなく「1 枚増えたこと」で判定する。
    const paneCountBefore = await win.locator('.pane').count();
    await win.locator('.pane-header .btn-split').first().click();
    await expect(win.locator('.pane')).toHaveCount(paneCountBefore + 1);

    // render() の先頭の hideTermLinkTooltip() により、この時点で隠れているはず。
    tooltip = await getTooltip(win);
    expect(tooltip.hidden).toBe(true);

    // レイアウト変更（ペイン幅が変わる）後の座標で取り直し、もう一度ホバーすれば
    // 問題無く再表示できる（トーストと違い document.body 直下は元から変えていないが、
    // 「消えたまま二度と出ない」退行になっていないことを確認する）。
    await moveMouseAway(win);
    pos = await findTextPosition(win, url, 'pane-1');
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 3);
    tooltip = await getTooltip(win);
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.text).toContain('example.com');
  });

  // ⚠ このテストは pane-1 を消費する（後始末として最後に閉じる）。pane-1 を前提にする
  // テストを新しく足す場合は、必ずこのテストより前に置くこと（このファイルは
  // test.describe.serial + beforeAll でアプリを共有しているため、以後のテストからは
  // pane-1 が存在しないものとして扱われる）。
  test('ホバー中にそのペインを閉じるとツールチップが残らない', async () => {
    // 最後の 1 ペインを閉じると自動で新しいペインが作られる経路まで踏みたくないため、
    // 先にペインを追加してから、ホバー対象のペイン（pane-1）を閉じる。
    // 直前のテストが既にペインを追加しているため、絶対数（2枚）ではなく
    // 「1 枚増えたこと」で判定する（このファイルの test.describe.serial 共有前提）。
    const paneCountBefore = await win.locator('.pane').count();
    await win.locator('.pane-header .btn-split').first().click();
    await expect(win.locator('.pane')).toHaveCount(paneCountBefore + 1);

    const url = 'https://example.com/vk-terminals-e2e-close-pane';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url, 'pane-1');

    const pos = await findTextPosition(win, url, 'pane-1');
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 3);
    let tooltip = await getTooltip(win);
    expect(tooltip.hidden).toBe(false);

    // closePane('pane-1', { force: true, skipConfirm: true }) を直接呼ぶ。
    // トップレベルの function 宣言は window に生える（issue #184 と同じ扱い）。
    await win.evaluate(() => window.closePane('pane-1', { force: true, skipConfirm: true }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    tooltip = await getTooltip(win);
    expect(tooltip.hidden).toBe(true);
  });
});
