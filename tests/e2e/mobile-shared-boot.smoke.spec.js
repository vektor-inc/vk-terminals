const { test, expect, chromium } = require('@playwright/test');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');
const { buildMobileCsp } = require('../../utils/csp');

// issue #348: 元々別ファイルだった以下 10 spec を統合したもの。
//   mobile-csp / mobile-card-head-focus-ring / mobile-app-version / mobile-css-external /
//   mobile-preview-cr-redraw / mobile-preview-csi-redraw / mobile-preview-order-scroll /
//   mobile-quick-controls-removed / mobile-title-link / mobile-codex-usage
//
// 統合の根拠: 全テストが launchApp を env / config の指定なしで呼び、Electron 起動後は
// chromium で別途 mobile.html を開いて実描画を確認するだけで、Electron 側の win
// （デスクトップ #sidebar）は一切触らない。起動時の設定値・環境変数を変えて確かめる
// spec ではないため、Electron の起動 1 回を全テストで共有できる。
//
// 隔離について:
//   - chromium の browser / context / page はテストごとに新規作成しており、
//     localStorage 等のブラウザ側状態はテスト間で最初から共有されない
//     （browser.newContext() はプロファイルを分離する）。
//   - 唯一 Electron 側（HTTP サーバーの背後にある実ペイン状態）に残るのは
//     POST /api/set-title によるタイトルの書き換え（旧 mobile-title-link 相当）。
//     他のテストは既定タイトル「Terminal 1」を前提にしている
//     （renderer/mobile.js: label が空文字なら "Terminal " + termId にフォールバック）ため、
//     各テストの先頭で set-title を空文字で呼び直し、既定表示へ戻す。
//   - 実行順序を入れ替えても通ることを --repeat-each / 手動の並び替えで確認済み（PR 参照）。

const repoRoot = path.resolve(__dirname, '..', '..');
const pkgVersion = require(path.join(repoRoot, 'package.json')).version;

// GET /api/states を叩き、terminals（paneId -> state）を返す。
async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return json.terminals || {};
}

// states 内に存在する termId の一覧（文字列）を返す。
function termIdsOf(states) {
  return Object.values(states)
    .map((t) => (t && t.termId != null ? String(t.termId) : null))
    .filter(Boolean);
}

// 指定 termId が states に現れるまで短くリトライして待つ。
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

// HTTP サーバーが起きて / が 200 を返せるようになるまで待つ。
async function waitForServer(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`);
      if (res.status === 200) return;
    } catch (_e) { /* 起動前の失敗は吸収 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('HTTP server did not become ready in time');
}

// /api/states が version を返し始めるまで短くリトライして待つ。
async function waitForStatesWithVersion(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastJson = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/states`);
      if (res.status === 200) {
        const json = await res.json();
        lastJson = json;
        if (typeof json.version === 'string' && json.version) return json;
      }
    } catch (_e) {
      // 起動前の fetch 失敗は同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`/api/states did not return version in time. last json: ${JSON.stringify(lastJson)}`);
}

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

// termId='1' のタイトルを空文字に戻し、「Terminal 1」という既定表示へ戻す
// （renderer/mobile.js の displayTitle フォールバック）。
async function resetPaneTitle(port) {
  await postJson(port, '/api/set-title', { termId: '1', title: '' });
}

// キーボード由来のフォーカスでないと :focus-visible は当たらない
// （settings-focus-ring.smoke.spec.js の focusByKeyboard と同じ手法）。
async function focusByKeyboard(page, selector) {
  await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} が見つからない`);
    el.scrollIntoView({ block: 'center' });
    el.focus();
  }, selector);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  await expect(page.locator(selector).first()).toBeFocused();
  expect(
    await page.evaluate((sel) => document.querySelector(sel).matches(':focus-visible'), selector),
    `${selector} が :focus-visible にならない`
  ).toBe(true);
}

test.describe.serial('モバイル版 HTTP 描画の確認（起動共有・issue #348）', () => {
  let app;
  let tmpRoot;
  let port;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, tmpRoot } = await launchApp({ port, prefix: 'vk-terminals-e2e-mobile-shared-' }));
    // --no-claude で起動すると素のシェルのペインが termId='1' で 1 枚だけ作られる。
    await waitForTermId(port, '1');
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await resetPaneTitle(port);
  });

  // ─── 旧 mobile-csp.smoke.spec.js（issue #324） ───────────────────────────
  test('GET /（mobile.html）は buildMobileCsp() と一致する Content-Security-Policy ヘッダーを返す', async () => {
    await waitForServer(port);

    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    const csp = res.headers.get('content-security-policy');

    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("default-src 'none'");
    expect(csp).toBe(buildMobileCsp());
  });

  // ─── 旧 mobile-card-head-focus-ring.smoke.spec.js（issue #302） ──────────
  test('モバイル版のペインカードの見出し（.card-head）は、キーボードフォーカス時に内側オフセットの個別上書きが効く（issue #302）', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const page = await (await browser.newContext()).newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      const cardHead = page.locator('.card-head').first();
      await expect(cardHead).toBeVisible();

      await focusByKeyboard(page, '.card-head');

      const style = await page.evaluate(() => {
        const el = document.querySelector('.card-head');
        const s = getComputedStyle(el);
        return {
          color: s.outlineColor,
          style: s.outlineStyle,
          width: s.outlineWidth,
          offset: s.outlineOffset,
        };
      });

      expect(style, '.card-head のフォーカスリング').toEqual({
        color: 'rgb(88, 166, 255)',
        style: 'solid',
        width: '2px',
        offset: '-2px',
      });
    } finally {
      await browser.close();
    }
  });

  // ─── 旧 mobile-app-version.smoke.spec.js（issue #135 / PR #136） ─────────
  test('GET /api/states のレスポンスに version が含まれ、既存フィールドも維持されている', async () => {
    const json = await waitForStatesWithVersion(port);

    expect(json.version).toBe(pkgVersion);
    expect(json).toHaveProperty('updatedAt');
    expect(typeof json.updatedAt).toBe('string');
    expect(json).toHaveProperty('terminals');
    expect(json.terminals && typeof json.terminals).toBe('object');
    expect(json).toHaveProperty('usage');
  });

  test('モバイル: 最下部の #app-version-footer に VK Terminals v<version> が表示され可視になる', async () => {
    const browser = await chromium.launch();
    try {
      await waitForStatesWithVersion(port);

      const context = await browser.newContext();
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      const footer = page.locator('#app-version-footer');
      await expect(footer).toBeVisible({ timeout: 15_000 });
      await expect(footer).toHaveClass(/\bshow\b/, { timeout: 15_000 });
      await expect(footer).toHaveText(`VK Terminals v${pkgVersion}`);
      await expect(footer).toHaveCSS('text-align', 'center');

      const listBottom = await page.locator('#list').evaluate((el) => el.getBoundingClientRect().bottom);
      const footerTop = await footer.evaluate((el) => el.getBoundingClientRect().top);
      expect(footerTop).toBeGreaterThanOrEqual(listBottom - 1);
    } finally {
      await browser.close();
    }
  });

  // ─── 旧 mobile-css-external.smoke.spec.js（PR #153） ─────────────────────
  test('GET /mobile.css が HTTP 200 かつ Content-Type: text/css で返る', async () => {
    await waitForServer(port);

    const res = await fetch(`http://127.0.0.1:${port}/mobile.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);

    const body = await res.text();
    expect(body).toContain('.card');
    expect(body.length).toBeGreaterThan(1000);
  });

  test('GET /shared.css が HTTP 200 かつ Content-Type: text/css で返る', async () => {
    await waitForServer(port);

    const res = await fetch(`http://127.0.0.1:${port}/shared.css`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/css/);

    const body = await res.text();
    expect(body).toContain('.task-list [data-tone="warning"]');
    expect(body).toContain('--wtone-fg');
  });

  test('モバイルページを実ブラウザで開くと外部 CSS が適用される', async () => {
    const browser = await chromium.launch();
    try {
      await waitForServer(port);

      const context = await browser.newContext();
      const page = await context.newPage();

      const cssResponses = [];
      page.on('response', (r) => {
        if (r.url().endsWith('/mobile.css')) cssResponses.push(r.status());
      });

      await page.goto(`http://127.0.0.1:${port}/`);
      await page.waitForLoadState('networkidle');

      expect(cssResponses.length).toBeGreaterThan(0);
      expect(cssResponses).toContain(200);

      const bodyBg = await page.locator('body').evaluate(
        (el) => getComputedStyle(el).backgroundColor
      );
      expect(bodyBg).toBe('rgb(20, 23, 28)');

      const headerPosition = await page.locator('header').evaluate(
        (el) => getComputedStyle(el).position
      );
      expect(headerPosition).toBe('sticky');
    } finally {
      await browser.close();
    }
  });

  // ─── 旧 mobile-preview-cr-redraw.smoke.spec.js（issue #121 / PR #122） ───
  test('モバイルプレビュー: 生 CR で再描画された日本語行が数文字ごとの改行にならず1行に表示される', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const context = await browser.newContext();
      const page = await context.newPage();

      const redrawnLine = [
        'ペイン',
        'ペインの',
        'ペインのリンク付き',
        'ペインのリンク付きの部分、B',
      ].join('\r');

      await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
        const injected = {
          terminals: {
            '1': {
              termId: '1',
              status: 'idle',
              displayTitle: null,
              lastLines: redrawnLine,
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

      await expect(pre).toHaveText('ペインのリンク付きの部分、B');

      const text = await pre.textContent();
      expect(text).not.toContain('ペイン\n');
      expect((text.match(/\n/g) || []).length).toBe(0);
    } finally {
      await browser.close();
    }
  });

  // ─── 旧 mobile-preview-csi-redraw.smoke.spec.js（issue #132 / PR #133） ──
  test('モバイルプレビュー: CSI 位置指定再描画で直近の本文行が複数行として復元される', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const context = await browser.newContext();
      const page = await context.newPage();

      const injectedLastLines = [
        '\x1b[1;1H\x1b[2K実装内容を確認しています',
        '\x1b[2;1H\x1b[2K- renderer/mobile.html のモバイルプレビューを調査',
        '\x1b[3;1H\x1b[2K- sanitize の処理順と CSS 高さを確認',
        '\x1b[4;1H\x1b[2K- 直近の本文出力を最低10行見えるように修正',
        '\x1b[5;1H\x1b[2Knpm test を実行して回帰を確認します',
        '\x1b[6;1H\x1b[2K変更後は本文行が消えないことを検証します',
      ].join('');

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

      const text = await pre.textContent();
      expect(text).toContain('実装内容を確認しています');
      expect(text).toContain('renderer/mobile.html のモバイルプレビューを調査');
      expect(text).toContain('sanitize の処理順と CSS 高さを確認');
      expect(text).toContain('直近の本文出力を最低10行見えるように修正');
      expect(text).toContain('npm test を実行して回帰を確認します');
      expect(text).toContain('変更後は本文行が消えないことを検証します');

      const nonEmptyLineCount = text.split('\n').filter((l) => l.trim()).length;
      expect(nonEmptyLineCount).toBeGreaterThanOrEqual(5);

      const minHeightPx = await pre.evaluate((el) => parseFloat(getComputedStyle(el).minHeight));
      expect(minHeightPx).toBeGreaterThanOrEqual(130);
      const clientHeightPx = await pre.evaluate((el) => el.clientHeight);
      expect(clientHeightPx).toBeGreaterThanOrEqual(130);
    } finally {
      await browser.close();
    }
  });

  // ─── 旧 mobile-preview-order-scroll.smoke.spec.js（PR #131 / issue #130） ─
  test('モバイルプレビュー: 末尾に罫線再描画が大量に溜まっても直近の読める本文が残り、最新（末尾）まで表示される', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const context = await browser.newContext();
      const page = await context.newPage();

      const readable = [
        '実行結果: ビルドに成功しました',
        'Build completed successfully in 3.2s',
        'テスト 42 件がすべてパスしました',
        'Next step: デプロイを実行してください',
      ];
      const decorativeBlock = [
        '╭────────────────────────────────────────────────────╮',
        '│ >                                                    │',
        '╰────────────────────────────────────────────────────╯',
        '✻ Compacting conversation…',
        '·······································',
      ];
      const lines = readable.slice();
      for (let i = 0; i < 60; i++) {
        for (const l of decorativeBlock) lines.push(l);
      }
      const injectedLastLines = lines.join('\n');

      const decorativeTailLen = injectedLastLines.length -
        injectedLastLines.indexOf('╭');
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

      const text = await pre.textContent();
      expect(text).toContain('ビルドに成功しました');
      expect(text).toContain('テスト 42 件がすべてパスしました');
      expect(text).not.toContain('╭');
      expect(text).not.toContain('│');
      expect(text).not.toContain('✻');

      const maxHeightPx = await pre.evaluate((el) => parseFloat(getComputedStyle(el).maxHeight));
      expect(maxHeightPx).not.toBe(240);
      expect(maxHeightPx).toBeGreaterThan(240);

      const minHeightPx = await pre.evaluate((el) => parseFloat(getComputedStyle(el).minHeight));
      expect(minHeightPx).toBeGreaterThanOrEqual(130);

      const metrics = await pre.evaluate((el) => ({
        scrollTop: el.scrollTop,
        clientHeight: el.clientHeight,
        scrollHeight: el.scrollHeight,
      }));
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      const distanceFromBottom = metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight;
      expect(distanceFromBottom).toBeLessThanOrEqual(24);
    } finally {
      await browser.close();
    }
  });

  test('モバイルプレビュー: 上スクロール中は更新で位置が引き戻されず、折り畳み→展開で最下部が表示される', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const context = await browser.newContext();
      const page = await context.newPage();

      const decorativeBlock = [
        '╭────────────────────────────────────────────────────╮',
        '│ >                                                    │',
        '╰────────────────────────────────────────────────────╯',
        '✻ Compacting conversation…',
        '·······································',
      ];
      const buildLines = () => {
        const readable = [
          '実行結果: ビルドに成功しました',
          'Build completed successfully in 3.2s',
          'テスト 42 件がすべてパスしました',
          'Next step: デプロイを実行してください',
        ];
        const lines = readable.slice();
        for (let i = 0; i < 60; i++) {
          for (const l of decorativeBlock) lines.push(l);
        }
        return lines.join('\n');
      };
      let currentLastLines = buildLines();

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

      await expect.poll(async () => pre.evaluate((el) => el.scrollHeight - el.clientHeight))
        .toBeGreaterThan(24);

      await pre.evaluate((el) => { el.scrollTop = 0; });

      currentLastLines = currentLastLines + '\n追加の新しい出力行です new appended output line';

      let maxScrollTopSeen = 0;
      const observeDeadline = Date.now() + 3500;
      while (Date.now() < observeDeadline) {
        const st = await pre.evaluate((el) => el.scrollTop);
        if (st > maxScrollTopSeen) maxScrollTopSeen = st;
        await new Promise((r) => setTimeout(r, 300));
      }
      expect(maxScrollTopSeen).toBeLessThanOrEqual(24);

      const textAfter = await pre.textContent();
      expect(textAfter).toContain('new appended output line');

      const head = card.locator('.card-head');
      await head.click();
      await expect(card).toHaveClass(/collapsed/);
      await head.click();
      await expect(card).not.toHaveClass(/collapsed/);

      await expect.poll(async () => pre.evaluate((el) =>
        el.scrollHeight - el.scrollTop - el.clientHeight
      )).toBeLessThanOrEqual(24);
    } finally {
      await browser.close();
    }
  });

  // ─── 旧 mobile-quick-controls-removed.smoke.spec.js（issue #181 / PR #182） ─
  test('モバイル: 未使用クイック入力ボタン（1/2/3/Enter, Yes/No/Esc/Ctrl-C）が削除されている', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const context = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      const card = page.locator('.card', { hasText: 'Terminal 1' });
      await expect(card).toBeVisible({ timeout: 15_000 });

      const quickButtons = card.locator('.actions button.k:not(.kill)');
      await expect(quickButtons).toHaveCount(0);

      const removedLabels = ['1', '2', '3', '↵ Enter', 'Yes (y↵)', 'No (n↵)', 'Esc', 'Ctrl-C'];
      for (const label of removedLabels) {
        await expect(
          card.locator('.actions button', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
        ).toHaveCount(0);
      }

      await expect(card.locator('.actions button.k.yes')).toHaveCount(0);
      await expect(card.locator('.actions button.k.no')).toHaveCount(0);
      await expect(card.locator('.actions button.k.stop')).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('モバイル: 自由入力欄・改行トグル・終了ボタンは残存し、レイアウトが崩れていない', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const context = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      const card = page.locator('.card', { hasText: 'Terminal 1' });
      await expect(card).toBeVisible({ timeout: 15_000 });

      const sendInput = card.locator('.sendrow input');
      await expect(sendInput).toBeVisible();
      await expect(sendInput).toHaveAttribute('placeholder', 'コマンド/テキスト');
      const sendBtn = card.locator('.sendrow button');
      await expect(sendBtn).toBeVisible();
      await expect(sendBtn).toHaveText('送信');

      const nlToggle = card.locator('.nl-toggle input[type="checkbox"]');
      await expect(nlToggle).toBeVisible();
      await expect(nlToggle).toBeChecked();
      await expect(card.locator('.nl-toggle')).toContainText('末尾に改行(↵)を付ける');

      const killBtn = card.locator('button.k.kill');
      await expect(killBtn).toBeVisible();
      await expect(killBtn).toHaveText('✕ ターミナルを終了');

      const inputBox = await sendInput.boundingBox();
      const toggleBox = await card.locator('.nl-toggle').boundingBox();
      const killBox = await killBtn.boundingBox();
      expect(inputBox && toggleBox && killBox).toBeTruthy();
      expect(toggleBox.y).toBeGreaterThanOrEqual(inputBox.y);
      expect(killBox.y).toBeGreaterThanOrEqual(toggleBox.y);
      const cardBox = await card.boundingBox();
      expect(killBox.width).toBeGreaterThan(cardBox.width * 0.6);
    } finally {
      await browser.close();
    }
  });

  // ─── 旧 mobile-title-link.smoke.spec.js（issue #103 / PR #108, #174） ────
  test('モバイル: apiUrl が安全な URL のときタイトルがリンク化され、PR ボタンは apiPrUrl にリンクする', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const issueUrl = `http://127.0.0.1:${port}/?issue=103`;
      const prUrl = `http://127.0.0.1:${port}/?pr=103`;
      const setTitle = await postJson(port, '/api/set-title', {
        termId: '1',
        title: 'PR #103 タイトルリンク',
        url: issueUrl,
        prUrl,
      });
      expect(setTitle.status).toBe(200);
      expect(setTitle.body && setTitle.body.url).toBe(issueUrl);
      expect(setTitle.body && setTitle.body.prUrl).toBe(prUrl);

      const context = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      const card = page.locator('.card', { hasText: 'PR #103 タイトルリンク' });
      const title = card.locator('a.card-title');
      await expect(title).toBeVisible({ timeout: 15_000 });

      await expect(title).toHaveClass(/\bis-link\b/, { timeout: 15_000 });
      await expect(title).toHaveAttribute('href', issueUrl);
      await expect(title).toHaveAttribute('target', '_blank');
      await expect(title).toHaveAttribute('rel', 'noopener noreferrer');

      const prLink = card.locator('a.pr-link');
      await expect(prLink).toBeVisible();
      await expect(prLink).toHaveAttribute('href', prUrl);
      await expect(prLink).toHaveAttribute('target', '_blank');
      await expect(prLink).toHaveAttribute('rel', 'noopener noreferrer');

      await expect(card).not.toHaveClass(/\bcollapsed\b/);

      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        title.tap(),
      ]);
      await popup.waitForLoadState('domcontentloaded');
      expect(popup.url()).toContain('issue=103');
      await popup.close();

      await expect(card).not.toHaveClass(/\bcollapsed\b/);
    } finally {
      await browser.close();
    }
  });

  test('モバイル: apiUrl のみでもタイトルがリンク化され、タップで新規タブが開き折りたたみしない', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const issueUrl = `http://127.0.0.1:${port}/?issue=174`;
      const setTitle = await postJson(port, '/api/set-title', {
        termId: '1',
        title: 'Issue #174 タイトルリンク',
        url: issueUrl,
      });
      expect(setTitle.status).toBe(200);
      expect(setTitle.body && setTitle.body.url).toBe(issueUrl);

      const context = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      const card = page.locator('.card', { hasText: 'Issue #174 タイトルリンク' });
      const title = card.locator('.card-title');
      await expect(title).toBeVisible({ timeout: 15_000 });

      await expect(title).toHaveClass(/\bis-link\b/);
      await expect(title).toHaveAttribute('href', issueUrl);
      await expect(title).toHaveAttribute('target', '_blank');
      await expect(title).toHaveAttribute('rel', 'noopener noreferrer');

      await expect(card).not.toHaveClass(/\bcollapsed\b/);
      const [popup] = await Promise.all([
        context.waitForEvent('page'),
        title.tap(),
      ]);
      await popup.waitForLoadState('domcontentloaded');
      expect(popup.url()).toContain('issue=174');
      await popup.close();
      await expect(card).not.toHaveClass(/\bcollapsed\b/);
    } finally {
      await browser.close();
    }
  });

  test('モバイル: apiUrl 無しではタイトルは href を持たず、タップで折りたたみがトグルする', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const setTitle = await postJson(port, '/api/set-title', {
        termId: '1',
        title: 'リンク無しタイトル',
      });
      expect(setTitle.status).toBe(200);

      const context = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();
      await page.goto(`http://127.0.0.1:${port}/`);

      const card = page.locator('.card', { hasText: 'リンク無しタイトル' });
      const title = card.locator('.card-title');
      await expect(title).toBeVisible({ timeout: 15_000 });

      await expect(title).not.toHaveClass(/\bis-link\b/);
      await expect(title).not.toHaveAttribute('href', /.+/);

      await expect(card).not.toHaveClass(/\bcollapsed\b/);

      await title.tap();
      await expect(card).toHaveClass(/\bcollapsed\b/);

      await title.tap();
      await expect(card).not.toHaveClass(/\bcollapsed\b/);
    } finally {
      await browser.close();
    }
  });

  test('モバイル: apiUrl が javascript: の場合はタイトルがリンク化されない', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const context = await browser.newContext();
      const page = await context.newPage();

      await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
        const injected = {
          terminals: {
            '1': {
              termId: '1',
              status: 'idle',
              displayTitle: 'JS スキームタイトル',
              // eslint-disable-next-line no-script-url
              apiUrl: 'javascript:alert(1)',
              lastLines: '',
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

      const card = page.locator('.card', { hasText: 'JS スキームタイトル' });
      const title = card.locator('.card-title');
      await expect(title).toBeVisible({ timeout: 15_000 });

      await expect(title).not.toHaveClass(/\bis-link\b/);
      await expect(title).not.toHaveAttribute('href', /.+/);
      const href = await title.getAttribute('href');
      expect(href).toBeNull();
    } finally {
      await browser.close();
    }
  });

  test('モバイル: マージ済み PR リンクは紫表示とチェックアイコンに切り替わり、通常状態へ戻る', async () => {
    const browser = await chromium.launch();
    try {
      await waitForTermId(port, '1');

      const prUrl = `http://127.0.0.1:${port}/?pr=137`;
      const context = await browser.newContext();
      const page = await context.newPage();
      let injectedTerm = {
        termId: '1',
        status: 'idle',
        displayTitle: 'PR #137 モバイル merged',
        apiPrUrl: prUrl,
        apiPrMerged: true,
        lastLines: '',
      };

      await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
        const injected = {
          terminals: {
            '1': injectedTerm,
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

      const card = page.locator('.card').first();
      await expect(card).toContainText('PR #137 モバイル merged', { timeout: 15_000 });
      const prLink = card.locator('a.pr-link');
      await expect(prLink).toBeVisible();

      await expect(prLink).toHaveClass(/\bmerged\b/);
      await expect(prLink).toHaveAttribute('aria-label', 'マージ済みのプルリクエストを開く');
      await expect(prLink.locator('.pr-icon')).toHaveText('✓');

      injectedTerm = {
        termId: '1',
        status: 'idle',
        displayTitle: 'PR #137 モバイル normal',
        apiPrUrl: prUrl,
        apiPrMerged: false,
        lastLines: '',
      };
      await page.evaluate(() => poll());

      await expect(prLink).not.toHaveClass(/\bmerged\b/);
      await expect(prLink).toHaveAttribute('aria-label', 'プルリクエストを開く');
      await expect(prLink.locator('.pr-icon')).toHaveText('↗');

      injectedTerm = {
        termId: '1',
        status: 'idle',
        displayTitle: 'PR #137 モバイル hidden',
        apiPrUrl: '',
        apiPrMerged: true,
        lastLines: '',
      };
      await page.evaluate(() => poll());

      await expect(prLink).not.toHaveClass(/\bmerged\b/);
      await expect(prLink).toHaveAttribute('aria-label', 'プルリクエストを開く');
      await expect(prLink.locator('.pr-icon')).toHaveText('↗');
    } finally {
      await browser.close();
    }
  });

  // ─── 旧 mobile-codex-usage.smoke.spec.js（issue #218） ───────────────────
  test('モバイル: codexUsage があると Codex 使用量カードにセッション/週間バーとトークン数が表示される', async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();

      await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
        const injected = {
          updatedAt: new Date().toISOString(),
          terminals: {},
          usage: null,
          codexUsage: {
            source: 'codex',
            session: { percent: 61, resetAtMs: Date.now() + 90 * 60 * 1000 },
            weekly: { percent: 12, resetAtMs: Date.now() + 4 * 24 * 60 * 60 * 1000 },
            tokens: { todayText: '12k', weeklyText: '345k' },
          },
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(injected),
        });
      });

      await waitForServer(port);
      await page.goto(`http://127.0.0.1:${port}/`);

      const card = page.locator('#codex-usage-card');
      await expect(card).toHaveClass(/\bshow\b/, { timeout: 15_000 });
      await expect(card).toHaveAttribute('role', 'group');
      await expect(card).toHaveAttribute('aria-labelledby', 'codex-usage-card-title');
      await expect(page.locator('#codex-usage-card-title')).toHaveText('Codex使用量');

      await expect(page.locator('#co-session-pct')).toHaveText('61% 使用済み');
      await expect(page.locator('#co-weekly-pct')).toHaveText('12% 使用済み');

      await expect(page.locator('#co-session-track')).toHaveAttribute('aria-valuenow', '61');
      await expect(page.locator('#co-weekly-track')).toHaveAttribute('aria-valuenow', '12');

      await expect(page.locator('#co-session-fill')).toHaveClass('u-fill');

      await expect(page.locator('#co-tokens-today')).toHaveText('今日 12k');
      await expect(page.locator('#co-tokens-weekly')).toHaveText('今週 345k トークン');
    } finally {
      await browser.close();
    }
  });

  test('モバイル: codexUsage が empty / null のとき Codex 使用量カードは非表示になる', async () => {
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({
        hasTouch: true,
        isMobile: true,
        viewport: { width: 390, height: 844 },
      });
      const page = await context.newPage();

      await page.route(`http://127.0.0.1:${port}/api/states`, async (route) => {
        const injected = {
          updatedAt: new Date().toISOString(),
          terminals: {},
          usage: null,
          codexUsage: { source: 'codex', session: null, weekly: null, tokens: null, empty: true },
        };
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify(injected),
        });
      });

      await waitForServer(port);
      await page.goto(`http://127.0.0.1:${port}/`);

      const card = page.locator('#codex-usage-card');
      await page.waitForTimeout(500);
      await expect(card).not.toHaveClass(/\bshow\b/);
      await expect(card).toBeHidden();

      await page.evaluate(() => window.renderCodexUsage(null));
      await expect(card).not.toHaveClass(/\bshow\b/);
      await expect(card).toBeHidden();
    } finally {
      await browser.close();
    }
  });
});
