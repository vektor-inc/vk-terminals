const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// PR #163 / issue #161: グリッドペインのタスクタイトル（.pane-task-title）に
// PR ボタン（.pane-task-title-pr）が同居するとき、タイトル（末尾 ↗ アイコン含む）と
// 右端 PR ボタンが密着して見えていた表示崩れの修正確認。
// 修正は renderer/style.css の `.pane-task-title.has-pr { gap: 10px; }` の追加。
//   1. .pane-task-title.has-pr の computed gap が 10px であること
//   2. 長いタイトルでタイトルが省略されても、タイトル右端と PR ボタン左端の
//      座標差（余白）が概ね 10px 確保されること
//   3. 短いタイトルでも PR ボタンは右寄せ（margin-left: auto）のままで、
//      タイトルと PR ボタンの間に最小 10px の余白が空くこと
//   4. PR URL を持たないペインには has-pr が付かず gap も付与されないこと（デグレ確認）

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
      const result = await postJson(port, '/api/set-title', { termId: '1', title: '' });
      if (result.status === 200) return;
      if (result.status !== 404) {
        throw new Error(`unexpected status ${result.status}: ${JSON.stringify(result.body)}`);
      }
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(result.body)}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastError || new Error('terminal 1 was not registered in time');
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
async function launchPrGapApp(port) {
  return await launchApp({ port, prefix: 'vk-terminals-e2e-pr-gap-' });
}

test('グリッドペイン: PR ボタン同居時にタイトルと PR ボタンの間へ 10px の余白が空く', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchPrGapApp(port);
  try {
    await waitForPtyRegistration(port);

    const prUrl = `http://127.0.0.1:${port}/?pr=163`;
    const paneDomId = 'pane-1';
    const titleEl = win.locator(`.pane[data-id="${paneDomId}"] .pane-task-title`);
    const prBadge = titleEl.locator('.pane-task-title-pr');

    // ─── (1) 長いタイトル + PR URL → has-pr が付き gap が 10px、実測余白も約 10px ───
    // ペインはウィンドウ全幅で広いため、タイトルが利用可能幅を完全に使い切って
    // 省略が発生するくらい長くする（このとき初めて flex gap が両者の間隔を決める）。
    const longTitle = 'とても長いタスクタイトルで省略が発生するケースの表示確認'.repeat(20);
    const longRes = await postJson(port, '/api/set-title', {
      termId: '1',
      title: longTitle,
      // url も渡してタイトルをリンク化（.pane-task-title-link + 末尾 ↗ アイコン）する。
      url: 'https://github.com/vektor-inc/vk-terminals',
      prUrl,
    });
    expect(longRes.status).toBe(200);

    await expect(titleEl).toHaveClass(/\bhas-pr\b/);
    await expect(prBadge).toBeVisible();

    // computed style の gap が 10px であること。
    const gapLong = await titleEl.evaluate((el) => getComputedStyle(el).columnGap || getComputedStyle(el).gap);
    expect(gapLong).toBe('10px');

    // タイトル（リンク要素 = 末尾 ↗ アイコン含む）右端と PR ボタン左端の座標差を実測する。
    const measureLong = await win.evaluate((id) => {
      const t = document.querySelector(`.pane[data-id="${id}"] .pane-task-title .pane-task-title-link`);
      const pr = document.querySelector(`.pane[data-id="${id}"] .pane-task-title .pane-task-title-pr`);
      const tr = t.getBoundingClientRect();
      const pr2 = pr.getBoundingClientRect();
      return { titleRight: tr.right, prLeft: pr2.left };
    }, paneDomId);
    const gapPxLong = measureLong.prLeft - measureLong.titleRight;
    console.log(`[gap] 長いタイトル時の実測余白: ${gapPxLong.toFixed(2)}px / computed gap: ${gapLong}`);
    // flex gap は最小 10px を保証する。丸め誤差を見込んで 9〜12px を許容する。
    expect(gapPxLong).toBeGreaterThanOrEqual(9);
    expect(gapPxLong).toBeLessThanOrEqual(12);

    // ─── (2) 短いタイトル → PR ボタンは右寄せ、タイトルとの余白は 10px 以上 ───
    const shortRes = await postJson(port, '/api/set-title', {
      termId: '1',
      title: 'PR',
      url: 'https://github.com/vektor-inc/vk-terminals',
      prUrl,
    });
    expect(shortRes.status).toBe(200);
    await expect(titleEl).toHaveClass(/\bhas-pr\b/);

    const measureShort = await win.evaluate((id) => {
      const wrap = document.querySelector(`.pane[data-id="${id}"] .pane-task-title`);
      const t = wrap.querySelector('.pane-task-title-link');
      const pr = wrap.querySelector('.pane-task-title-pr');
      const wr = wrap.getBoundingClientRect();
      const tr = t.getBoundingClientRect();
      const pr2 = pr.getBoundingClientRect();
      return {
        titleRight: tr.right,
        prLeft: pr2.left,
        prRight: pr2.right,
        wrapRight: wr.right,
        wrapPaddingRight: parseFloat(getComputedStyle(wrap).paddingRight),
      };
    }, paneDomId);
    // 短いタイトルでもタイトル右端と PR ボタン左端の間に最小 10px 空く。
    const gapPxShort = measureShort.prLeft - measureShort.titleRight;
    console.log(`[gap] 短いタイトル時のタイトル〜PR間: ${gapPxShort.toFixed(2)}px / 右端余白: ${(measureShort.wrapRight - measureShort.prRight).toFixed(2)}px (padding-right: ${measureShort.wrapPaddingRight}px)`);
    expect(gapPxShort).toBeGreaterThanOrEqual(10);
    // PR ボタンは margin-left: auto で右寄せ（padding 分の右端に接する）を維持している。
    const rightSpace = measureShort.wrapRight - measureShort.prRight;
    expect(Math.abs(rightSpace - measureShort.wrapPaddingRight)).toBeLessThanOrEqual(1.5);

    // ─── (3) PR URL 無し → has-pr が外れ、gap も付与されない（デグレ確認） ───
    const noPrRes = await postJson(port, '/api/set-title', {
      termId: '1',
      title: 'PR ボタン無しのタイトル',
      url: 'https://github.com/vektor-inc/vk-terminals',
      prUrl: '',
    });
    expect(noPrRes.status).toBe(200);
    await expect(titleEl).not.toHaveClass(/\bhas-pr\b/);
    await expect(prBadge).toHaveCount(0);
    const gapNone = await titleEl.evaluate((el) => getComputedStyle(el).columnGap || getComputedStyle(el).gap);
    // has-pr が無いので gap は既定（normal / 0px）に戻る。
    expect(gapNone === 'normal' || gapNone === '0px').toBe(true);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
