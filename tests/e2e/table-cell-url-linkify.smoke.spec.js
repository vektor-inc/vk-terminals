const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// ─── 罫線テーブルのセル境界での URL リンク化抑止（issue #361 / PR #365） ─────────
//
// renderer/urlLinkify.js の isTruncatedAtTableCellBorder() /
// isSafeHttpUrl 等の純粋関数レベルの判定は tests/urlLinkify.test.js で
// 網羅済み（extractUrlMatches の入出力を fixture 文字列だけで検証）。
// ここでは terminal-link-open-url.smoke.spec.js と同じ考え方で、それが実際に
// xterm.js のバッファへ配線され、本物のホバー・修飾キー+クリックで
// 「リンクとして登録されない（ホバーイベント自体が発生しない）」ことを見る。
//
// PR #365 の仕様（司・植草合意・B案で確定）: 罫線テーブルのセル右端（縦線）の
// 直前が「句読点（. , 等）だけを挟んだ、または挟まない」状態の URL はリンク化
// されない（切り詰められているかどうかに関わらず）。ただし閉じ括弧（) ] や
// 全角の ） 等）はセル内容として扱うため、"#399 (https://.../pull/399) │ x │"
// のように閉じ括弧がセル右端に来る場合は従来どおりリンク化される
// （renderer/urlLinkify.js の isTruncatedAtTableCellBorder / skipTrailingPunctuation
// のコメント「句読点だけを読み飛ばす理由（B案）」参照）。
// この「(URL) がセル右端に来る」ケースは tests/urlLinkify.test.js（純粋関数レベル）に
// 加えて、このファイルでも実物のホバー・修飾キー+クリックで固定している。

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
// 「最後の出現」を選ぶのは、`echo "..."` と打鍵したときにコマンドライン自体にも
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
// 動かす。
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

test.describe.serial('罫線テーブルのセル境界での URL リンク化抑止（issue #361 / PR #365）', () => {
  let app;
  let win;
  let tmpRoot;
  let port;
  let mac;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp({
      port,
      prefix: 'vk-terminals-e2e-table-cell-url-linkify-',
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

  test('セル幅で切れた URL 断片はリンクにならない（下線・ツールチップ・クリックのいずれも反応しない）', async () => {
    // "vk-agen" は "vk-agents" が罫線位置でちょうど切られた断片を模している
    // （issue #361 の再現ケース）。ホストは github.com のためドット判定は通り、
    // 純粋関数レベルの他の弾き条件（安全でないスキーム等）には該当しない。
    // セル境界の抑止だけが効いてリンク化されないことを見る。
    const fragment = 'https://github.com/vektor-inc/vk-agen';
    const line = `│ #399 (${fragment} │ x │`;
    await postSend(port, `echo "${line}"\r`);
    await waitForBufferText(win, line);

    const pos = await findTextPosition(win, fragment);
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 10);

    // リンクとして登録されていないため、ホバーしてもツールチップは出ない。
    const tooltip = await getTooltip(win);
    expect(tooltip === null || tooltip.hidden === true).toBe(true);

    // 修飾キー付きクリックをしても openExternal は一切呼ばれない。
    await modifierClickAtOffset(win, pos, 10, mac);
    expect(await getOpenExternalCalls(app)).toEqual([]);
  });

  test('セル内で URL の後ろに他の文字が続く場合は従来どおりリンクになる（issue #361 リグレッション）', async () => {
    const url = 'https://github.com/vektor-inc/vk-terminals';
    const line = `│ #363 (${url}) 済 │ done │`;
    await postSend(port, `echo "${line}"\r`);
    await waitForBufferText(win, line);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 10);

    const tooltip = await getTooltip(win);
    expect(tooltip).not.toBeNull();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.text).toContain('github.com');

    await modifierClickAtOffset(win, pos, 10, mac);
    // 閉じ括弧は対応が取れていない（開き括弧は URL 候補の外）ため trim され、
    // openExternal に渡るのは括弧を含まない URL。
    expect(await getOpenExternalCalls(app)).toEqual([url]);
  });

  test('表の外にある URL は従来どおりリンクになる', async () => {
    // 全角文字を URL より前に置くと xterm 側のセル幅と JS 文字列インデックスが
    // ずれて位置計算が破綻するため（terminal-link-open-url.smoke.spec.js と同じ
    // 注意点）、URL を先頭に置き、日本語の説明文は URL の後ろに続ける。
    const url = 'https://example.com/vk-terminals-e2e-outside-table';
    const line = `${url} を参照。`;
    await postSend(port, `echo "${line}"\r`);
    await waitForBufferText(win, line);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 10);

    const tooltip = await getTooltip(win);
    expect(tooltip).not.toBeNull();
    expect(tooltip.hidden).toBe(false);

    await modifierClickAtOffset(win, pos, 10, mac);
    expect(await getOpenExternalCalls(app)).toEqual([url]);
  });

  test('シェルパイプ（ASCII の |）を含む行の URL は従来どおりリンクになる（ASCII | は罫線とみなさない）', async () => {
    const url = 'https://example.com/vk-terminals-e2e-pipe';
    const line = `cmd1 | grep ${url} | wc -l`;
    await postSend(port, `echo "${line}"\r`);
    await waitForBufferText(win, line);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 10);

    const tooltip = await getTooltip(win);
    expect(tooltip).not.toBeNull();
    expect(tooltip.hidden).toBe(false);

    await modifierClickAtOffset(win, pos, 10, mac);
    expect(await getOpenExternalCalls(app)).toEqual([url]);
  });

  test('(URL) が丸ごとセルに収まり閉じ括弧がセル右端に来る場合は従来どおりリンクになる（B案・#361 起票者の再現例そのもの）', async () => {
    // 3b513df（生マッチ終端で判定する初版）は「#399 (URL)」のように閉じ括弧が
    // セル右端に来るケースまで抑止してしまっていた。これは issue #361 の起票者が
    // 最初に貼った再現例そのもので、GitHub CLI や Claude Code のログで頻出する
    // 書式のため、司・植草合意（B案）で閉じ括弧は「セル内容」として扱い直し、
    // 読み飛ばすのは句読点だけにした（tests/urlLinkify.test.js の同名ケースの
    // 実物確認）。
    const url = 'https://github.com/vektor-inc/vk-agents/pull/399';
    const line = `│ #399 (${url}) │ x │`;
    await postSend(port, `echo "${line}"\r`);
    await waitForBufferText(win, line);

    const pos = await findTextPosition(win, url);
    expect(pos).not.toBeNull();
    await hoverAtOffset(win, pos, 10);

    const tooltip = await getTooltip(win);
    expect(tooltip).not.toBeNull();
    expect(tooltip.hidden).toBe(false);
    expect(tooltip.text).toContain('github.com');

    await modifierClickAtOffset(win, pos, 10, mac);
    expect(await getOpenExternalCalls(app)).toEqual([url]);
  });
});
