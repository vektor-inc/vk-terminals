const { test, expect, _electron, chromium } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// issue #103 / PR #108: モバイル版でペインのタイトル（.card-title）を、
// 状態 apiUrl が安全な http(s) URL のときだけ
// <a target="_blank" rel="noopener noreferrer"> にしてリンク化する変更の end-to-end 確認。
//   A: 安全な https(http) URL があるとタイトルが url へ href 付きリンク（.is-link）になり、
//      独立 PR ボタンは prUrl へリンクする。
//      タイトルタップでは折りたたみがトグルせず新規タブ（popup）が開く。
//   B: URL が無いとタイトルは href を持たず、タイトルタップで従来どおり折りたたみがトグルする。
//   C: apiUrl が javascript: の場合はリンク化されない（renderer 側 isSafeHttpUrl のガード）。
//      ※ API 側 /api/set-title は javascript: を 400 で弾くため、C は /api/states を
//        差し替えて renderer のガード単体を検証する。

const repoRoot = path.resolve(__dirname, '..', '..');

async function getFreePort() {
  // OS に空きポートを割り当てさせ、取得後に閉じて Electron 側で再利用する。
  // 既定ポート 13847 を避け、開発中の通常起動インスタンスと衝突させない。
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
// report-states は renderer 側で 2 秒ごとに送られるため、猶予を持って待機する。
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

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
async function launchApp(port) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-title-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  // 実ユーザーの ~/.vk-terminals/config.json に依存しないよう HOME を一時化する。
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

// ─── A: 安全な URL でタイトルが apiUrl へリンク化され、タップで折りたたみをトグルしない ───
test('モバイル: apiUrl が安全な URL のときタイトルがリンク化され、PR ボタンは apiPrUrl にリンクする', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    // issue URL / PR URL を自前サーバー（同一オリジン）に向けておく。
    //   - isSafeHttpUrl / API バリデーションを通る http(s) URL であること
    //   - 外部ネットワークに出ず popup が即座に読み込めること
    // を両立させるため、mobile.html を配信する自サーバーの URL を使う。
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

    // モバイル Web UI を実ブラウザで開く。タッチ操作と popup 検知のため context を明示する。
    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    // 対象カードのタイトル要素。set-title → report-states → poll 反映を待つ。
    const card = page.locator('.card', { hasText: 'PR #103 タイトルリンク' });
    const title = card.locator('a.card-title');
    await expect(title).toBeVisible({ timeout: 15_000 });

    // タイトルがリンク化されている（.is-link ＋ 属性一式）ことを確認する。
    await expect(title).toHaveClass(/\bis-link\b/, { timeout: 15_000 });
    await expect(title).toHaveAttribute('href', issueUrl);
    await expect(title).toHaveAttribute('target', '_blank');
    await expect(title).toHaveAttribute('rel', 'noopener noreferrer');

    // 独立 PR ボタンは従来どおり prUrl にリンクする。
    const prLink = card.locator('a.pr-link');
    await expect(prLink).toBeVisible();
    await expect(prLink).toHaveAttribute('href', prUrl);
    await expect(prLink).toHaveAttribute('target', '_blank');
    await expect(prLink).toHaveAttribute('rel', 'noopener noreferrer');

    // クリック前は折りたたまれていないこと（既定状態）。
    await expect(card).not.toHaveClass(/\bcollapsed\b/);

    // タイトルを tap → issue URL の新規タブ（popup）が開き、かつ折りたたみはトグルしない。
    const [popup] = await Promise.all([
      context.waitForEvent('page'),
      title.tap(),
    ]);
    // popup が対象 URL を開いていること（別タブ遷移が起きている）。
    await popup.waitForLoadState('domcontentloaded');
    expect(popup.url()).toContain('issue=103');
    await popup.close();

    // 元のカードは折りたたまれていない（リンククリックでトグルしないのが本変更の肝）。
    await expect(card).not.toHaveClass(/\bcollapsed\b/);
  } finally {
    await browser.close();
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── #174: issue URL（apiUrl）だけでもタイトルがリンク化される ───
test('モバイル: apiUrl のみでもタイトルがリンク化され、タップで新規タブが開き折りたたみしない', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    // issue URL 相当の url だけを設定する。prUrl は渡さない。
    // 自サーバー URL を使い、外部ネットワークに出ず http(s) の安全 URL 条件だけを満たす。
    const issueUrl = `http://127.0.0.1:${port}/?issue=174`;
    const setTitle = await postJson(port, '/api/set-title', {
      termId: '1',
      title: 'Issue #174 タイトルリンク',
      url: issueUrl,
    });
    expect(setTitle.status).toBe(200);
    expect(setTitle.body && setTitle.body.url).toBe(issueUrl);

    // タッチ操作で再現するため、モバイル相当 viewport + hasTouch の context を使う。
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

    // url があれば prUrl が無くてもタイトルは issue URL へリンク化される。
    await expect(title).toHaveClass(/\bis-link\b/);
    await expect(title).toHaveAttribute('href', issueUrl);
    await expect(title).toHaveAttribute('target', '_blank');
    await expect(title).toHaveAttribute('rel', 'noopener noreferrer');

    // onHeadToggle の a[href] ガードに入り、tap でも折りたたみはトグルしない。
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
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── B: URL 無しではリンク化されず、タイトルタップで折りたたみがトグルする（従来挙動）───
test('モバイル: apiUrl 無しではタイトルは href を持たず、タップで折りたたみがトグルする', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    // URL は付けずにタイトルだけ設定する（url を送らない = タイトルリンクなし扱い）。
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

    // href を持たず、.is-link も付いていないこと。
    await expect(title).not.toHaveClass(/\bis-link\b/);
    await expect(title).not.toHaveAttribute('href', /.+/);

    // 既定は非折りたたみ。
    await expect(card).not.toHaveClass(/\bcollapsed\b/);

    // タイトルタップ 1 回目 → 折りたたまれる（従来挙動＝デグレ無し）。
    await title.tap();
    await expect(card).toHaveClass(/\bcollapsed\b/);

    // タイトルタップ 2 回目 → 展開に戻る（トグル動作）。
    await title.tap();
    await expect(card).not.toHaveClass(/\bcollapsed\b/);
  } finally {
    await browser.close();
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── C: javascript: スキームはリンク化されない（renderer 側 isSafeHttpUrl ガード）───
test('モバイル: apiUrl が javascript: の場合はタイトルがリンク化されない', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    const context = await browser.newContext();
    const page = await context.newPage();

    // /api/states を差し替え、apiUrl に javascript: を注入する。
    // API 側 /api/set-title は javascript: を 400 で弾くため、この不正 URL は
    // 本来 renderer に到達しないが、多層防御として renderer 単体のガードを検証する。
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

    // javascript: はリンク化されない（href 無し・.is-link 無し）。
    await expect(title).not.toHaveClass(/\bis-link\b/);
    await expect(title).not.toHaveAttribute('href', /.+/);
    // 保険: href 属性自体が存在しないこと。
    const href = await title.getAttribute('href');
    expect(href).toBeNull();
  } finally {
    await browser.close();
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('モバイル: マージ済み PR リンクは紫表示とチェックアイコンに切り替わり、通常状態へ戻る', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
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

    // /api/states を差し替え、モバイル renderer に apiPrMerged: true を直接流す。
    // POST /api/set-title と renderer の間の状態反映は既存テストで担保済みなので、
    // ここでは mobile.html の render() が states の apiPrMerged を UI に反映するかへ絞る。
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

    // apiPrMerged: true のときは PC 版 PR バッジと同じ意味論（.merged + ✓ + 専用 aria-label）。
    await expect(prLink).toHaveClass(/\bmerged\b/);
    await expect(prLink).toHaveAttribute('aria-label', 'マージ済みのプルリクエストを開く');
    await expect(prLink.locator('.pr-icon')).toHaveText('✓');

    // 次の描画で未マージ／URL 無効になった場合、古い merged 表示が残らないことも確認する。
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
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
