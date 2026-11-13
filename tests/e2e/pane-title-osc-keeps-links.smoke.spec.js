const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #614: API（POST /api/set-title）でタイトル・URL・PR URL を設定したペインで、
// ペイン内のプログラムが OSC 0 / OSC 2 でターミナルのタイトルを書き換えても、
// タイトル行のリンク（.pane-task-title-link）と PR ラベル（.pane-task-title-pr）を
// 作り直さないことの確認。
// Codex はスピナーで OSC タイトルを高頻度に書き換える。表示は API タイトルで変わらないのに
// 毎回作り直していたため、押してから離すまでに要素が入れ替わり click が成立しなかった。
//   1. OSC タイトルが変わっても、リンクと PR ラベルが同じ要素のまま残る
//   2. API でタイトルが変わったときは、これまでどおり表示が更新される

async function postJson(port, pathname, payload) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch (_e) { /* 非 JSON 応答も診断のため許容 */ }
  return { status: res.status, body };
}

async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      // termId "1" は起動時に renderer が作る最初のペインの PTY。登録前は 404 が返る。
      const result = await postJson(port, '/api/set-title', { termId: '1', title: '' });
      if (result.status === 200) return;
      if (result.status !== 404) {
        throw new Error(`unexpected status ${result.status}: ${JSON.stringify(result.body)}`);
      }
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(result.body)}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('terminal 1 was not registered in time');
}

// renderer が states を main へ報告するまで待ち、termId "1" の taskTitle（OSC 由来）を返す。
async function readOscTitle(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`, { cache: 'no-store' });
  if (!res.ok) return null;
  const data = await res.json();
  const terms = (data && data.terminals) || {};
  const pane = Object.values(terms).find((t) => String(t && t.termId) === '1');
  return pane ? pane.taskTitle : null;
}

test('OSC タイトルが変わってもタイトルリンクと PR ラベルを作り直さない', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp({
    port,
    prefix: 'vk-terminals-e2e-osc-keeps-links-',
  });

  try {
    await waitForPtyRegistration(port);

    const issueUrl = `http://127.0.0.1:${port}/?issue=614`;
    const prUrl = `http://127.0.0.1:${port}/?pr=614`;
    const setTitle = await postJson(port, '/api/set-title', {
      termId: '1',
      title: 'issue 614 のタイトル',
      url: issueUrl,
      prUrl,
    });
    expect(setTitle.status).toBe(200);

    const titleLink = win.locator('.pane .pane-task-title-link').first();
    const prBadge = win.locator('.pane .pane-task-title-pr').first();
    await expect(titleLink).toBeVisible();
    await expect(prBadge).toBeVisible();

    // 今描画されている要素に目印を付ける。作り直されると目印の無い新しい要素に置き換わる。
    await titleLink.evaluate((el) => { el.dataset.e2eMarker = 'kept'; });
    await prBadge.evaluate((el) => { el.dataset.e2eMarker = 'kept'; });

    // Codex のスピナーを模して、OSC 0 でターミナルのタイトルを数回書き換える。
    const oscCommand = "for s in vk614-a vk614-b vk614-c; do printf '\\033]0;%s\\007' \"$s\"; done\r";
    const sent = await postJson(port, '/api/send', { termId: '1', input: oscCommand });
    expect(sent.status).toBe(200);

    // renderer が OSC を受け取ったこと（taskTitle が最後の値になったこと）を待つ。
    await expect.poll(() => readOscTitle(port), { timeout: 20_000 }).toBe('vk614-c');

    // 表示は API タイトルのまま、要素も同じもの（目印付き）が残っていること。
    await expect(titleLink).toHaveText(/issue 614 のタイトル/);
    await expect(titleLink).toHaveAttribute('data-e2e-marker', 'kept');
    await expect(prBadge).toHaveAttribute('data-e2e-marker', 'kept');

    // API でタイトルを変えたときは、これまでどおり表示が更新される。
    const changed = await postJson(port, '/api/set-title', {
      termId: '1',
      title: 'issue 614 の新しいタイトル',
      url: issueUrl,
      prUrl,
      prMerged: true,
    });
    expect(changed.status).toBe(200);
    await expect(titleLink).toHaveText(/issue 614 の新しいタイトル/);
    await expect(prBadge).toHaveClass(/\bmerged\b/);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
