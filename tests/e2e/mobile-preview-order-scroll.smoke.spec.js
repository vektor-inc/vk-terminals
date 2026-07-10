const { test, expect, _electron, chromium } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// PR #131 / issue #130: モバイル版ペインプレビューの検証。
//
// 修正の本丸は sanitize の処理順の入れ替え。従来は「末尾1400文字に切り詰め →
// 装飾行除去」だったため、Claude Code TUI のプロンプト枠（罫線）の再描画が
// 末尾に大量に溜まると、切り詰め窓が罫線だらけになり sanitize 後に読める行が
// ほぼ残らなかった。修正後は「ANSI 除去 → 装飾行除去 → 空行圧縮 → 末尾4000文字」の
// 順にしたため、罫線が末尾に溜まっても読める本文が残る。
//
// あわせて表示高さの拡大（max-height 240px → min(50vh, 520px)）と、末尾追従
// スクロール（最下部付近だけ新着に追従 / 上スクロール中は位置保持 / 展開時に
// 最下部表示）を追加している。
//
// 検証手法は既存の mobile-preview-cr-redraw.smoke.spec.js を踏襲する。
// 一時 HOME + `--no-claude` で Electron を起動し、VK_TERMINALS_API_PORT で
// 空きポートを指定、Playwright の page.route で /api/states 応答を差し替えて
// 任意の lastLines を注入 → 実ブラウザで mobile.html の実描画を検証する。

const repoRoot = path.resolve(__dirname, '..', '..');

async function getFreePort() {
  // OS に空きポートを割り当てさせ、取得後に閉じて Electron 側で再利用する。
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((err) => {
        if (err) { reject(err); return; }
        if (!port) { reject(new Error('failed to allocate a free port')); return; }
        resolve(port);
      });
    });
  });
}

async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return json.terminals || {};
}

function termIdsOf(states) {
  return Object.values(states)
    .map((t) => (t && t.termId != null ? String(t.termId) : null))
    .filter(Boolean);
}

async function waitForTermId(port, termId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      const ids = termIdsOf(states);
      lastSeen = ids;
      if (ids.includes(String(termId))) return ids;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`termId ${termId} did not appear in time. last states: ${JSON.stringify(lastSeen)}`);
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
async function launchApp(port) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-order-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    apiHost: '127.0.0.1',
    initialCommand: '',
    agentroom: false,
    additionalPanes: [],
  }), 'utf8');

  const app = await _electron.launch({
    args: ['.', '--no-claude'],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      VK_TERMINALS_API_PORT: String(port),
    },
  });
  await app.firstWindow();
  return { app, tmpRoot };
}

// Claude Code TUI のプロンプト枠（罫線）の再描画が末尾に溜まった状態を模した
// lastLines を組み立てる。先頭に読める本文を置き、その後に罫線 / スピナー行だけを
// 大量に連ねる（合計で旧切り詰め窓 1400 文字を大きく超える量）。
function buildRedrawHeavyLastLines() {
  const readable = [
    '実行結果: ビルドに成功しました',
    'Build completed successfully in 3.2s',
    'テスト 42 件がすべてパスしました',
    'Next step: デプロイを実行してください',
  ];
  // 罫線 + スピナーのみの装飾行ブロック（読める文字を含まない）。
  const decorativeBlock = [
    '╭────────────────────────────────────────────────────╮',
    '│ >                                                    │',
    '╰────────────────────────────────────────────────────╯',
    '✻ Compacting conversation…',
    '·······································',
  ];
  const lines = readable.slice();
  // 装飾ブロックを繰り返して末尾窓を罫線だらけにする。
  for (let i = 0; i < 60; i++) {
    for (const l of decorativeBlock) lines.push(l);
  }
  return lines.join('\n');
}

test('モバイルプレビュー: 末尾に罫線再描画が大量に溜まっても直近の読める本文が残り、最新（末尾）まで表示される', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    const context = await browser.newContext();
    const page = await context.newPage();

    const injectedLastLines = buildRedrawHeavyLastLines();
    // 注入する罫線ブロックだけで旧切り詰め窓（1400 文字）を超えていることを前提確認。
    const decorativeTailLen = injectedLastLines.length -
      injectedLastLines.indexOf('╭'); // 最初の罫線以降の長さ
    expect(decorativeTailLen).toBeGreaterThan(1400);

    await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
      const injected = {
        terminals: {
          '1': {
            termId: '1',
            status: 'idle',
            displayTitle: null,
            lastLines: injectedLastLines,
          },
        },
        updatedAt: Date.now(),
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(injected),
      });
    });

    await page.goto(`http://127.0.0.1:${port}/`);

    const card = page.locator('.card', { hasText: 'Terminal 1' });
    const pre = card.locator('pre.lines');
    await expect(pre).toBeVisible({ timeout: 15_000 });

    // (1) 修正の本丸: 末尾が罫線だらけでも、読める本文が残っている。
    //     修正前は tail(1400) が末尾の罫線窓だけを掴み、sanitize 後にほぼ空だった。
    const text = await pre.textContent();
    expect(text).toContain('ビルドに成功しました');
    expect(text).toContain('テスト 42 件がすべてパスしました');
    // 罫線・スピナー行は sanitize で除去されているので表示に含まれない。
    expect(text).not.toContain('╭');
    expect(text).not.toContain('│');
    expect(text).not.toContain('✻');

    // (2) 表示高さの拡大: max-height が 240px 固定でない（min(50vh, 520px) 相当）。
    const maxHeightPx = await pre.evaluate((el) => {
      return parseFloat(getComputedStyle(el).maxHeight);
    });
    expect(maxHeightPx).not.toBe(240);
    expect(maxHeightPx).toBeGreaterThan(240);

    // (3) 長いコンテンツ注入時、初回描画でプレビューが最下部（最新）まで
    //     スクロールされている（scrollTop + clientHeight ≒ scrollHeight）。
    const metrics = await pre.evaluate((el) => ({
      scrollTop: el.scrollTop,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    }));
    // そもそもスクロール可能な高さがあること（拡大高さでも収まりきらない本文量）。
    expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
    const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
    expect(distanceFromBottom).toBeLessThanOrEqual(24);
  } finally {
    await browser.close();
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('モバイルプレビュー: 上スクロール中は更新で位置が引き戻されず、折り畳み→展開で最下部が表示される', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    const context = await browser.newContext();
    const page = await context.newPage();

    // route ハンドラが参照する可変の lastLines。テスト中に内容を差し替えて
    // 2 秒ポーリングでの再描画をシミュレートする。
    let currentLastLines = buildRedrawHeavyLastLines();

    await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
      const injected = {
        terminals: {
          '1': {
            termId: '1',
            status: 'idle',
            displayTitle: null,
            lastLines: currentLastLines,
          },
        },
        updatedAt: Date.now(),
      };
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(injected),
      });
    });

    await page.goto(`http://127.0.0.1:${port}/`);

    const card = page.locator('.card', { hasText: 'Terminal 1' });
    const pre = card.locator('pre.lines');
    await expect(pre).toBeVisible({ timeout: 15_000 });

    // 前提: スクロール可能な本文量があること。
    await expect.poll(async () => pre.evaluate((el) => el.scrollHeight - el.clientHeight))
      .toBeGreaterThan(24);

    // プレビューを一番上までスクロールして「古い出力を読んでいる」状態にする。
    await pre.evaluate((el) => { el.scrollTop = 0; });

    // 内容を変えて（末尾に本文を追記）、次の 2 秒ポーリングでの再描画を待つ。
    // 内容が変わるので DOM は更新されるが、上スクロール中なので stick=false となり
    // scrollTop は最下部へ引き戻されないはず。
    currentLastLines = currentLastLines + '\n追加の新しい出力行です new appended output line';

    // ポーリング（2秒間隔）で scrollTop が引き戻されないことを確認する。
    // 3 秒ほど観測し続けて、その間ずっと上部（引き戻されていない）に留まること。
    let maxScrollTopSeen = 0;
    const observeDeadline = Date.now() + 3500;
    while (Date.now() < observeDeadline) {
      const st = await pre.evaluate((el) => el.scrollTop);
      if (st > maxScrollTopSeen) maxScrollTopSeen = st;
      await new Promise((r) => setTimeout(r, 300));
    }
    // 引き戻されていれば scrollTop は scrollHeight 付近まで飛ぶ。上部に留まっていれば 24px 以内。
    expect(maxScrollTopSeen).toBeLessThanOrEqual(24);

    // 追記した本文が反映されている（＝この間に再描画は走っている）ことも確認。
    const textAfter = await pre.textContent();
    expect(textAfter).toContain('new appended output line');

    // 折り畳み → 展開で最下部（最新）が表示されること。
    // card-head のタップで折りたたみをトグルする（既存挙動）。
    const head = card.locator('.card-head');
    await head.click(); // 折り畳み
    await expect(card).toHaveClass(/collapsed/);
    await head.click(); // 展開
    await expect(card).not.toHaveClass(/collapsed/);

    // 展開直後は最下部（最新）にスクロールされている。
    await expect.poll(async () => pre.evaluate((el) =>
      el.scrollHeight - el.scrollTop - el.clientHeight
    )).toBeLessThanOrEqual(24);
  } finally {
    await browser.close();
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
