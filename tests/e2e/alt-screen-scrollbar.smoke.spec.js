const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #659: 代替画面（全画面を描き替える表示方式。Claude Code の全画面表示など）のあいだだけ、
// ペインの縦スクロールバーを隠すことの確認。
//   1. 通常画面（履歴あり）ではスクロールバーを表示する
//   2. 代替画面に入るとスクロールバーを隠す
//   3. 通常画面に戻るとスクロールバーを表示し直す
// 対象のスクロールバーは 2 つ（renderer/style.css の issue #659 のコメント参照）。
//   - xterm.js が描くスクロールバー（.xterm-scrollable-element > .scrollbar.vertical）: display で見る
//   - xterm.css の overflow-y: scroll で .xterm-viewport に出るスクロールバー: overflow-y で見る
//     （macOS のスクロールバー自動表示では幅が 0 になり、幅では判定できないため）
// 隠す CSS は xterm.js 内部の要素名に依存するため、要素がそれぞれ 1 つ見つかることも確かめる
// （xterm.js の更新で名前が変わったら、ここで落ちる）。

const PANE_ID = 'pane-1';
const SCROLLBAR_SELECTOR = '.pane .term-viewport .xterm-scrollable-element > .scrollbar.vertical';
const NATIVE_VIEWPORT_SELECTOR = '.pane .term-viewport .xterm-viewport';

async function postSend(port, input) {
  const res = await fetch(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId: '1', input }),
  });
  let body = null;
  try { body = await res.json(); } catch (_e) { /* 非 JSON 応答も診断のため許容 */ }
  return { status: res.status, body };
}

// termId "1" は起動時に renderer が作る最初のペインの PTY。登録前は 404 を返すため、
// 200 になるまで短くリトライする（他 spec の waitForPtyRegistration と同じ考え方）。
async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const { status, body } = await postSend(port, '');
      if (status === 200) return;
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(body)}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('terminal 1 was not registered in time');
}

// xterm.js の実際のバッファの種類（'normal' / 'alternate'）を読む。目印のクラスと突き合わせる。
async function readBufferType(win) {
  return win.evaluate((id) => {
    const t = terminals[id];
    return t ? t.term.buffer.active.type : null;
  }, PANE_ID);
}

// 通常画面のスクロールで遡れる行数（baseY）。履歴を作れたことの確認に使う。
async function readScrollbackRows(win) {
  return win.evaluate((id) => {
    const t = terminals[id];
    return t ? t.term.buffer.normal.baseY : 0;
  }, PANE_ID);
}

// 2 つのスクロールバーの表示状態をまとめて読む。
async function readScrollbarState(win) {
  return win.evaluate(({ scrollbarSelector, nativeSelector }) => {
    const scrollbar = document.querySelector(scrollbarSelector);
    const nativeViewport = document.querySelector(nativeSelector);
    return {
      display: scrollbar ? getComputedStyle(scrollbar).display : null,
      nativeOverflowY: nativeViewport ? getComputedStyle(nativeViewport).overflowY : null,
    };
  }, { scrollbarSelector: SCROLLBAR_SELECTOR, nativeSelector: NATIVE_VIEWPORT_SELECTOR });
}

test('代替画面のあいだだけ、ペインの縦スクロールバーを隠す', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp({
    port,
    prefix: 'vk-terminals-e2e-alt-screen-scrollbar-',
  });

  try {
    await waitForPtyRegistration(port);

    const viewport = win.locator('.pane .term-viewport').first();

    // 1. 通常画面で履歴を作る。スクロールバーは表示したまま。
    const seq = await postSend(port, 'seq 1 300\r');
    expect(seq.status).toBe(200);
    await expect.poll(() => readScrollbackRows(win), { timeout: 20_000 }).toBeGreaterThan(0);
    await expect(win.locator(SCROLLBAR_SELECTOR)).toHaveCount(1);
    await expect(win.locator(NATIVE_VIEWPORT_SELECTOR)).toHaveCount(1);
    expect(await readBufferType(win)).toBe('normal');
    await expect(viewport).not.toHaveClass(/\bis-alt-screen\b/);
    const normalState = await readScrollbarState(win);
    expect(normalState.display).not.toBe('none');
    expect(normalState.nativeOverflowY).toBe('scroll');

    // 2. 代替画面に入る（DECSET 1049）。スクロールバーを隠す。
    const enter = await postSend(port, "printf '\\033[?1049h'\r");
    expect(enter.status).toBe(200);
    await expect.poll(() => readBufferType(win), { timeout: 20_000 }).toBe('alternate');
    await expect(viewport).toHaveClass(/\bis-alt-screen\b/);
    await expect.poll(() => readScrollbarState(win)).toEqual({ display: 'none', nativeOverflowY: 'hidden' });

    // 3. 通常画面に戻る（DECRST 1049）。スクロールバーを表示し直す。
    const leave = await postSend(port, "printf '\\033[?1049l'\r");
    expect(leave.status).toBe(200);
    await expect.poll(() => readBufferType(win), { timeout: 20_000 }).toBe('normal');
    await expect(viewport).not.toHaveClass(/\bis-alt-screen\b/);
    await expect.poll(() => readScrollbarState(win)).toEqual(normalState);
    // 代替画面に入る前の履歴は残っている。
    expect(await readScrollbackRows(win)).toBeGreaterThan(0);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
