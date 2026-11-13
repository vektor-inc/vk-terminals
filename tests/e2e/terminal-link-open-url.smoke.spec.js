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

// pane-1 の可視バッファの各行を走査し、needle を含む行が現れるまで待つ。
//
// 【既知の穴・麗美の切り分け（issue #385 レビュー指摘）】この関数は行を1行ずつ
// line.includes(needle) で見るだけで、xterm の折り返し（isWrapped）を一切考慮して
// いない。ペイン幅が狭く（cols が数十程度）、needle が cols を超える長さの場合、
// 入力エコー行・出力行のどちらも複数行にまたがって折り返され、needle がどの1行にも
// 単独では現れなくなるため見つからない（15秒でタイムアウトする）。グリッド表示の
// ような十分広い幅（cols=100+ 程度）では表面化しない。折り返し行の連結対応は
// renderer/terminalLinkProvider.js の getWrappedLineWindow() 相当の実装が要り、
// 「連結後の座標をどう画面座標へ戻すか」という別の設計判断も伴うため、このヘルパー
// 自体は対応していない（司・麗美合意。tests/e2e/terminal-link-open-url.smoke.spec.js
// の「格納（サイドバー）」テストで実際に踏んだ）。細い幅のペインで長い URL を使う
// テストを新しく書く場合は、この関数を直さず、needle 自体をそのペイン幅で折り返さない
// 短さにすること。
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
//
// 【既知の穴】waitForBufferText() と同じ理由（折り返しを連結しない）で、needle が
// 折り返されると見つからない。詳細・対処方針は waitForBufferText() 冒頭のコメント参照。
//
// containerSelector（省略可）: xterm の描画要素（.xterm-screen）を探す起点の CSS
// セレクタ。既定はグリッド表示（.pane[data-id="..."]）。格納ペイン（.stash-item[data-id=
// "..."]）内で xterm を開いた状態（issue #385 レビュー指摘・MEDIUM-4 の回帰テスト）を
// 見る場合は呼び出し側から `.stash-item[data-id="${paneId}"]` を渡す。xterm 要素自体は
// render() の再アタッチで .stash-item .term-container へ移されるだけで生きたまま
// （renderer/app.js のコメント参照）なので、terminals[id].term のバッファ内容・
// cols/rows は共通のまま、DOM 上の位置だけがコンテナに応じて変わる。
async function findTextPosition(win, needle, paneId = 'pane-1', containerSelector = null) {
  return win.evaluate(({ u, id, selector }) => {
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
    const container = document.querySelector(`${selector} .xterm-screen`);
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    return {
      row: rowFound,
      col,
      cols: t.term.cols,
      rows: t.term.rows,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    };
  }, { u: needle, id: paneId, selector: containerSelector || `.pane[data-id="${paneId}"]` });
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

async function chooseExternalBrowser(win, app) {
  const external = win.getByRole('menuitem', { name: '外部ブラウザで開く ↗', exact: true });
  await expect(external).toBeVisible();
  expect(await getOpenExternalCalls(app)).toEqual([]);
  await external.click();
}

// 右クリック（button: 2）で pos.col + colOffset のセルをクリックする（issue #385
// レビュー指摘・MEDIUM-B・HIGH-1 の計測側回帰）。
async function rightClickAtOffset(win, pos, colOffset) {
  const cellW = pos.rect.width / pos.cols;
  const cellH = pos.rect.height / pos.rows;
  const x = pos.rect.x + (pos.col + colOffset) * cellW;
  const y = pos.rect.y + (pos.row + 0.5) * cellH;
  await win.mouse.move(x, y);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await win.mouse.down({ button: 'right' });
  await win.mouse.up({ button: 'right' });
  await new Promise((resolve) => setTimeout(resolve, 250));
}

async function blockedClickAtOffset(win, pos, colOffset, options) {
  const cellW = pos.rect.width / pos.cols;
  const cellH = pos.rect.height / pos.rows;
  const x = pos.rect.x + (pos.col + colOffset) * cellW;
  const y = pos.rect.y + (pos.row + 0.5) * cellH;
  await win.mouse.move(x, y);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await win.mouse.down(options);
  await win.mouse.up(options);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

// 同一リンク（同じ URL）の中だけをドラッグする（issue #385 レビュー指摘・MEDIUM-B・
// HIGH-2 の計測側回帰）。fromColOffset・toColOffset は両方とも pos の URL の文字範囲に
// 収まる値を渡すこと（呼び出し側の責務。ここでは範囲チェックしない）。
async function dragWithinLinkAtOffset(win, pos, fromColOffset, toColOffset) {
  const cellW = pos.rect.width / pos.cols;
  const cellH = pos.rect.height / pos.rows;
  const fromX = pos.rect.x + (pos.col + fromColOffset) * cellW;
  const toX = pos.rect.x + (pos.col + toColOffset) * cellW;
  const y = pos.rect.y + (pos.row + 0.5) * cellH;
  await win.mouse.move(fromX, y);
  await new Promise((resolve) => setTimeout(resolve, 150));
  await win.mouse.down();
  await win.mouse.move(toX, y, { steps: 5 });
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
    // 直前のドラッグ選択を残すと xterm.js がリンクのホバー解決を抑止するため、
    // 各ケースを独立させる。製品側では選択内容を維持する既存挙動を変えない。
    await win.evaluate(() => Object.values(terminals).forEach(({ term }) => term.clearSelection()));
  });

  // issue #385: terminalLinkClickMode の既定は 'click'（単クリックで開く）に変更された。
  // ツールチップは開き先メニューの予告文になり、修飾キー案内は 'modifier' モード
  // 専用になった（'modifier' モードの回帰は本ファイル末尾の別 describe ブロック参照）。
  test('URL にホバーすると、解決後のホスト名と単クリックで開く予告をツールチップに出す（issue #385）', async () => {
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
    // なりすまし対策としてのホスト表示は 'click' モードでも維持される（安藤指摘）。
    expect(tooltip.text).toContain('example.com');
    expect(tooltip.text).toContain('開き先を選ぶ');
  });

  // issue #385: 既定モードでは、フォーカス済みペインへの修飾キー無しクリックで開く
  // （旧仕様「修飾キー無しでは開かない」を上書き。pane-1 はこの describe.serial の
  // 起動直後から常にフォーカス済みのため、このテストはフォーカス済みペインの経路を見る。
  // フォーカス未取得ペインへの最初のクリックでは開かないガードの検証は別途必要）。
  test('フォーカス済みペインでは修飾キー無しの単クリックでブラウザを開く（issue #385）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-plain-click';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await plainClickAtOffset(win, pos, 3);
    await chooseExternalBrowser(win, app);

    expect(await getOpenExternalCalls(app)).toEqual([url]);

    // レビュー指摘（麗美の e2e で発見）の回帰確認: 開いた直後に出る「開きました」トーストは
    // コピーボタンを持たない（＝操作できる部品が無い）ため、クリックを下（ターミナル等）へ
    // 透過させる pointer-events: none になっていること。ここでは実際のクリック透過を
    // 画面上の座標（ウィンドウサイズ・フォント計測に依存し不安定になりやすい）で証明する
    // 代わりに、実際の変更点である computed style を直接確認する（renderer/app.js の
    // setExternalUrlToastInteractive / renderer/style.css の .vk-toast--interactive 参照）。
    // 失敗トースト側（コピーボタンを持つ＝押せる必要がある）が pointer-events: auto の
    // ままであることは、既存の tests/e2e/external-url-toast.smoke.spec.js が
    // toast.locator('.vk-toast-copy').click() で実際にクリックしており、Playwright の
    // クリックは対象要素が操作可能（pointer-events が click を妨げない）であることを
    // 自動で検証するため、そちら側の回帰はそのテスト群がそのまま守ってくれる。
    const toastPointerEvents = await win.evaluate(() => {
      const toast = document.querySelector('.vk-toast');
      return toast ? getComputedStyle(toast).pointerEvents : null;
    });
    expect(toastPointerEvents).toBe('none');
  });

  test('Cmd/Ctrl+クリックでブラウザが開く（openExternal に正しい URL が渡る）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-modifier-click';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await modifierClickAtOffset(win, pos, 3, mac);
    await chooseExternalBrowser(win, app);

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
    await chooseExternalBrowser(win, app);

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
    await chooseExternalBrowser(win, app);
    expect(await getOpenExternalCalls(app)).toEqual([localUrl]);

    await moveMouseAway(win);
    await clearOpenExternalCalls(app);

    const loopbackPos = await findTextPosition(win, loopbackUrl);
    expect(loopbackPos).not.toBeNull();
    await modifierClickAtOffset(win, loopbackPos, 3, mac);
    await chooseExternalBrowser(win, app);
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
    await expect(win.locator('.internal-browser-choice')).toHaveCount(0);
    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

  test('URL を含む行をドラッグして範囲選択できる（従来どおりの選択・コピー操作のデグレ確認）', async () => {
    // 【訂正・issue #385 レビュー指摘（植草）】ここでのドラッグは startX〜endX が
    // 同じ URL（同一リンク）の中に収まっている。以前このコメントには「xterm.js の
    // Linkifier は mousedown 時点のリンクと mouseup 時点のリンクが一致したときだけ
    // activate を呼ぶため、ドラッグ選択はこの経路と衝突しないはず」と書いていたが、
    // これは誤り。この一致条件は「別々のリンクをまたぐドラッグ」は弾けても、この
    // テストのように「同一リンクの中だけをなぞる」ドラッグはまさにその条件を満たして
    // しまい、対策前は activate が呼ばれて開いてしまっていた（HIGH-2 として修正済み。
    // utils/terminalLinkPolicy.js の wasDragged() 依存関数の説明コメント参照）。
    // このテストで実際に openExternal が呼ばれないのは、mousedown → mouseup の移動量が
    // HIGH-2 のドラッグしきい値（4px）を大きく超え、wasDragged() のガードに引っかかる
    // ためであり、「リンクの不一致」によるものではない。ここでは実際にマウスで
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
    // wasDragged() のガード（HIGH-2）により、同一リンク内のドラッグでも開かない。
    await expect(win.locator('.internal-browser-choice')).toHaveCount(0);
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
        // echo の入力行と出力行に同じ URL が現れるため、下から探して出力行を優先する。
        for (let i = lines.length - 1; i >= 0; i -= 1) {
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
      await chooseExternalBrowser(win, app);
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

// ─── terminalLinkClickMode: 'modifier'（従来挙動へ戻す設定・issue #385） ────────────
// 既定は 'click' へ変わったが、config.json の terminalLinkClickMode: 'modifier' で
// 旧仕様（修飾キー必須）へ戻せる。この設定を使うユーザー向けの回帰を維持するため、
// 上の describe.serial とは別に config を注入したアプリインスタンスで確認する。
test.describe.serial('ペイン内 URL クリック: terminalLinkClickMode が modifier のときは従来どおり修飾キー必須（issue #385）', () => {
  let app;
  let win;
  let tmpRoot;
  let port;
  let mac;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp({
      port,
      prefix: 'vk-terminals-e2e-terminal-link-modifier-mode-',
      config: { terminalLinkClickMode: 'modifier' },
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

  test('ホバー時のツールチップに修飾キー案内を出す（従来どおり）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-modifier-mode-hover';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 3);

    const tooltip = await getTooltip(win);
    expect(tooltip).not.toBeNull();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.text).toContain('example.com');
    expect(tooltip.text).toContain(mac ? '⌘+クリック' : 'Ctrl+クリック');
  });

  test('修飾キー無しのクリックではブラウザを開かない（誤操作防止・従来どおり）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-modifier-mode-plain-click';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await plainClickAtOffset(win, pos, 3);

    await expect(win.locator('.internal-browser-choice')).toHaveCount(0);
    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

  test('Cmd/Ctrl+クリックでブラウザが開く（従来どおり）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-modifier-mode-modifier-click';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await modifierClickAtOffset(win, pos, 3, mac);
    await chooseExternalBrowser(win, app);

    expect(await getOpenExternalCalls(app)).toEqual([url]);
  });
});

// ─── 未フォーカスのペインでも最初のクリックで選択メニューを出す ──────────────────
test.describe.serial('ペイン内 URL クリック: 未フォーカスのグリッド・格納ペインでも最初に開き先を選べる', () => {
  let app;
  let win;
  let tmpRoot;
  let port;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp({
      port,
      prefix: 'vk-terminals-e2e-terminal-link-unfocused-',
    }));
    await waitForPtyRegistration(port);
    await stubShellOpenExternal(app);
  });

  test.afterAll(async () => {
    await restoreShellOpenExternal(app);
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await clearOpenExternalCalls(app);
    await moveMouseAway(win);
  });

  // 2つ目のテストは、1つ目で作成した pane-2 をフォーカス移動先として使う。
  test('グリッド: 未フォーカスのペインでも最初のクリックで選択メニューを表示する', async () => {
    await win.locator('.pane-header .btn-split').first().click();
    await expect(win.locator('.pane')).toHaveCount(2);
    await expect(win.locator('.pane[data-id="pane-1"]')).not.toHaveClass(/\bfocused\b/);

    const url = 'https://example.com/vk-terminals-e2e-grid-unfocused';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url, 'pane-1');

    const pos = await findTextPosition(win, url, 'pane-1');
    expect(pos).not.toBeNull();
    await plainClickAtOffset(win, pos, 3);

    await expect(win.locator('.internal-browser-choice')).toBeVisible();
    expect(await getOpenExternalCalls(app)).toEqual([]);
    await chooseExternalBrowser(win, app);
    expect(await getOpenExternalCalls(app)).toEqual([url]);
  });

  test('格納: 未フォーカスのペインでも最初のクリックで選択メニューを表示する', async () => {
    await win.locator('.pane[data-id="pane-1"] .btn-stash').click();
    const stashItem = win.locator('.stash-item[data-id="pane-1"]');
    await expect(stashItem).toBeVisible({ timeout: 10_000 });
    await stashItem.locator('.btn-stash-toggle').click();
    await expect(stashItem.locator('.term-container')).toBeVisible();

    await win.locator('.pane[data-id="pane-2"] .pane-header').click();
    await expect(stashItem).not.toHaveClass(/\bfocused\b/);

    const url = 'https://example.com/600s';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url, 'pane-1');

    const pos = await findTextPosition(win, url, 'pane-1', '.stash-item[data-id="pane-1"]');
    expect(pos).not.toBeNull();
    await plainClickAtOffset(win, pos, 3);

    await expect(win.locator('.internal-browser-choice')).toBeVisible();
    expect(await getOpenExternalCalls(app)).toEqual([]);
    await chooseExternalBrowser(win, app);
    expect(await getOpenExternalCalls(app)).toEqual([url]);
  });
});
// ─── メニューを表示しないマウス操作の実 UI 回帰 ───────────────────────────────
test.describe.serial('ペイン内 URL クリック: 右・中・ダブルクリックとドラッグではメニューを出さない', () => {
  let app;
  let win;
  let tmpRoot;
  let port;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp({
      port,
      prefix: 'vk-terminals-e2e-terminal-link-measurement-',
    }));
    await waitForPtyRegistration(port);
    await stubShellOpenExternal(app);
  });

  test.afterAll(async () => {
    await restoreShellOpenExternal(app);
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await clearOpenExternalCalls(app);
    await moveMouseAway(win);
  });

  test('右クリックでは openExternal が呼ばれない（HIGH-1 の計測側回帰）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-measurement-right-click';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await rightClickAtOffset(win, pos, 3);

    await expect(win.locator('.internal-browser-choice')).toHaveCount(0);
    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

  test('中クリックでは選択メニューを表示せず openExternal も呼ばない', async () => {
    const url = 'https://example.com/vk-terminals-e2e-measurement-middle-click';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await blockedClickAtOffset(win, pos, 3, { button: 'middle' });

    await expect(win.locator('.internal-browser-choice')).toHaveCount(0);
    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

  test('ダブルクリックの2回目では選択メニューを表示せず openExternal も呼ばない', async () => {
    const url = 'https://example.com/vk-terminals-e2e-measurement-double-click';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await blockedClickAtOffset(win, pos, 3, { clickCount: 2 });

    await expect(win.locator('.internal-browser-choice')).toHaveCount(0);
    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

  test('URL 内をドラッグ（20〜30px 相当・同一リンク内で完結）しても openExternal が呼ばれない（HIGH-2 の計測側回帰）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-measurement-drag';
    await postSend(port, `echo "${url}"\r`);
    await waitForBufferText(win, url);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    // colOffset 2 → 6（4 セル分）。既定フォント（13px monospace）でおおむね 20〜30px の
    // 移動になり、かつ url の文字範囲（先頭から4文字以上）に収まるため同一リンク内で
    // 完結する。TERM_LINK_DRAG_THRESHOLD_PX（4px）を確実に超える。
    await dragWithinLinkAtOffset(win, pos, 2, 6);

    // 選択が実際に成立したことも確認する（安藤の案・LOW-H）。既存の「URL を含む行を
    // ドラッグして範囲選択できる」テストと同じ形にすることで、「ガードが効いて開かな
    // かった」のか「そもそも activate が呼ばれる状況になっていなかった」のかを
    // 区別できるようにする。
    const selection = await win.evaluate(() => terminals['pane-1'].term.getSelection());
    expect(selection.length).toBeGreaterThan(0);
    expect(url).toContain(selection);

    await expect(win.locator('.internal-browser-choice')).toHaveCount(0);
    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

});
