const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #460 / PR #461: ペインヘッダーの「ペインid : N」バッジ（.pane-id-badge）の回帰確認。
//   1. 各ペインのバッジ文言が「ペインid : N」で、N が GET /api/states の termId と一致する
//   2. ペインを追加すると別の番号のバッジが出る
//   3. バッジがステータスバッジ（.pane-status）より左にある
//   4. ステータスバッジと高さが同じ
//   5. ペイン幅を狭めると、パス（.pane-cwd）→ペインidバッジの順に省略され、
//      ステータスバッジ（.pane-status）は文字が切れず、ペイン右端も越えない

async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  return (await res.json()).terminals || {};
}

// 画面側の paneId（pane-N）→ API の termId の対応を、states から作る。
async function paneIdToTermId(port) {
  const states = await getStates(port);
  const map = {};
  for (const [paneId, t] of Object.entries(states)) {
    if (t && t.termId != null) map[paneId] = String(t.termId);
  }
  return map;
}

async function waitForPaneCount(port, count) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const map = await paneIdToTermId(port);
      if (Object.keys(map).length >= count) return map;
    } catch (_e) {
      // API サーバー起動前は fetch 自体が失敗するため、同じ待機ループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`panes did not reach ${count} in time`);
}

test('ペインIDバッジ: 番号が API の termId と一致し、ステータスバッジの左に同じ高さで並ぶ', async () => {
  const port = await getFreePort();
  const launched = await launchApp({ port, prefix: 'vk-terminals-e2e-pane-id-badge-' });
  try {
    const { win, app } = launched;
    const first = await waitForPaneCount(port, 1);
    const firstTermId = Object.values(first)[0];

    // ─── (1) 1枚目: 文言が「ペインid : N」で N が API の termId と一致 ───
    for (const [paneId, termId] of Object.entries(first)) {
      const badge = win.locator(`.pane[data-id="${paneId}"] .pane-id-badge`);
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText(`ペインid : ${termId}`);
    }

    // ─── (2) ペインを追加すると別の番号が出る ───
    const paneIdOfFirst = Object.keys(first)[0];
    await win.locator(`.pane[data-id="${paneIdOfFirst}"] .btn-split`).click();
    const two = await waitForPaneCount(port, 2);
    const termIds = Object.values(two);
    expect(new Set(termIds).size).toBe(termIds.length);
    expect(termIds).toContain(firstTermId);
    for (const [paneId, termId] of Object.entries(two)) {
      await expect(win.locator(`.pane[data-id="${paneId}"] .pane-id-badge`)).toHaveText(`ペインid : ${termId}`);
    }

    // ステータスを「入力待ち」にして、色付きバッジと並べた状態も測る。
    const res = await fetch(`http://127.0.0.1:${port}/api/set-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ termId: firstTermId, waiting: true }),
    });
    expect(res.status).toBe(200);
    const firstStatus = win.locator(`.pane[data-id="${paneIdOfFirst}"] .pane-status`);
    await expect(firstStatus).toHaveAttribute('data-status', 'waiting');

    // ─── (3)(4) 位置と高さ・角丸・左右の余白（idle・waiting の両方のペインで測る） ───
    for (const paneId of Object.keys(two)) {
      const m = await win.evaluate((id) => {
        const el = (s) => document.querySelector(`.pane[data-id="${id}"] ${s}`);
        const idb = el('.pane-id-badge').getBoundingClientRect();
        const st = el('.pane-status').getBoundingClientRect();
        const idCs = getComputedStyle(el('.pane-id-badge'));
        const stCs = getComputedStyle(el('.pane-status'));
        return {
          idLeft: idb.left, idRight: idb.right, stLeft: st.left,
          idH: idb.height, stH: st.height, idTop: idb.top, stTop: st.top,
          idRadius: idCs.borderTopLeftRadius, stRadius: stCs.borderTopLeftRadius,
          idPadL: idCs.paddingLeft, stPadL: stCs.paddingLeft,
          idPadR: idCs.paddingRight, stPadR: stCs.paddingRight,
        };
      }, paneId);
      expect(m.idLeft).toBeLessThan(m.stLeft);
      expect(m.idRight).toBeLessThanOrEqual(m.stLeft + 0.5);
      expect(m.idH).toBeCloseTo(m.stH, 1);
      expect(m.idTop).toBeCloseTo(m.stTop, 1);
      expect(m.idRadius).toBe(m.stRadius);
      expect(m.idPadL).toBe(m.stPadL);
      expect(m.idPadR).toBe(m.stPadR);
    }

    // ─── (5) 狭くしても、ステータスバッジは切れず右端を越えない（ペインidバッジが先に省略される） ───
    // ウィンドウには最小幅があるため、ペインを増やして 1 枚あたりの幅を狭くする。
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setSize(600, 700);
    });
    let narrow = two;
    for (let n = 3; n <= 5; n += 1) {
      await win.locator('.pane .btn-split').last().click();
      narrow = await waitForPaneCount(port, n);
    }
    await expect.poll(async () => await win.evaluate(() => Math.min(...[...document.querySelectorAll('.pane')]
      .map((p) => p.getBoundingClientRect().width))), { timeout: 10_000 }).toBeLessThan(260);
    for (const paneId of Object.keys(narrow)) {
      const m = await win.evaluate((id) => {
        const el = (s) => document.querySelector(`.pane[data-id="${id}"] ${s}`);
        const st = el('.pane-status');
        const pane = document.querySelector(`.pane[data-id="${id}"]`);
        return {
          statusClipped: st.scrollWidth > st.clientWidth,
          statusRight: st.getBoundingClientRect().right,
          statusWidth: st.getBoundingClientRect().width,
          paneRight: pane.getBoundingClientRect().right,
        };
      }, paneId);
      expect(m.statusClipped).toBe(false);
      expect(m.statusWidth).toBeGreaterThan(30);
      expect(m.statusRight).toBeLessThanOrEqual(m.paneRight + 0.5);
    }
    // ペインidバッジは省略されてもよいが、ステータスバッジの左側に収まっている。
    const idOverlap = await win.evaluate(() => [...document.querySelectorAll('.pane')].some((p) => {
      const idb = p.querySelector('.pane-id-badge').getBoundingClientRect();
      const st = p.querySelector('.pane-status').getBoundingClientRect();
      return idb.right > st.left + 0.5;
    }));
    expect(idOverlap).toBe(false);
    // パス側が省略（scrollWidth > clientWidth）されるペインが少なくとも1つある
    // = 狭さで実際に省略が起きる条件になっている。
    const anyCwdClipped = await win.evaluate(() => [...document.querySelectorAll('.pane .pane-cwd')]
      .some((el) => el.scrollWidth > el.clientWidth));
    expect(anyCwdClipped).toBe(true);
  } finally {
    await closeApp(launched);
  }
});
