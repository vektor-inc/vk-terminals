const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// issue #113 / PR #114: POST /api/set-title に prMerged を渡すと、ペイン上部の
// PR バッジ（.pane-task-title-pr）がマージ済み表示（紫 + ✓ アイコン + 専用 aria-label）
// に切り替わることの end-to-end 確認。
//   A: prMerged: true → .merged クラスが付き、アイコンが ✓、aria-label がマージ済み文言になる
//   B: prMerged 省略 → 従来どおり緑（.merged 無し、アイコン ↗、従来 aria-label）
//   C: prMerged が boolean 以外（文字列 "true" 等）→ 厳密な === true 判定により緑のまま
//      （main.js 側で `parsed?.prMerged === true` により既に boolean へ矯正されるため、
//        HTTP API 経由ではここまでで多くのケースを検証できる）
//   D: renderer 側の型ガード自体（IPC 経由で main の矯正をバイパスした場合）も
//      多層防御として直接確認する（VKIpc.on の `typeof prMerged === 'boolean'` ガード）。

const repoRoot = path.resolve(__dirname, '..', '..');

async function getFreePort() {
  // OS に空きポートを割り当てさせ、取得後に閉じて Electron 側で再利用する。
  // 既定ポート 13847 を避けることで、開発中の通常起動インスタンスと衝突させない。
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!port) {
          reject(new Error('failed to allocate a free port'));
          return;
        }
        resolve(port);
      });
    });
  });
}

async function postSetTitle(port, payload) {
  const response = await fetch(`http://127.0.0.1:${port}/api/set-title`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  let body = null;
  try {
    body = await response.json();
  } catch (_e) {
    // 失敗時の診断用に本文が JSON でないケースも許容する。
  }

  return { response, body };
}

async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      // termId "1" は起動時に renderer が作る最初のペインの PTY。
      // PTY 登録前は main 側が 404 を返すため、200 になるまで短くリトライする。
      const result = await postSetTitle(port, { termId: '1', title: '' });
      if (result.response.status === 200) return;
      if (result.response.status !== 404) {
        throw new Error(`unexpected status ${result.response.status}: ${JSON.stringify(result.body)}`);
      }
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(result.body)}`);
    } catch (e) {
      // HTTP サーバー起動前は fetch 自体が失敗するため、同じ待機ループで吸収する。
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw lastError || new Error('terminal 1 was not registered in time');
}

test('POST /api/set-title の prMerged が renderer の PR バッジへ反映される', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-pr-merged-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  const configPath = path.join(configDir, 'config.json');
  let app;

  fs.mkdirSync(configDir, { recursive: true });

  // loadUserConfig() は HOME 配下の config.json を読むため、HOME 自体を一時化して
  // 実ユーザーの ~/.vk-terminals/config.json（Tailscale IP 等）に依存しないようにする。
  fs.writeFileSync(configPath, JSON.stringify({
    apiHost: '127.0.0.1',
    initialCommand: '',
    agentroom: false,
    additionalPanes: [],
  }), 'utf8');

  try {
    app = await _electron.launch({
      // このテストは HTTP API と renderer 反映の統合パスだけを見る。
      // Claude CLI の有無に依存させないため、起動時は素のシェルにしておく。
      args: ['.', '--no-claude'],
      cwd: repoRoot,
      env: {
        ...process.env,
        HOME: tmpHome,
        USERPROFILE: tmpHome,
        VK_TERMINALS_API_PORT: String(port),
      },
    });

    const win = await app.firstWindow();

    await waitForPtyRegistration(port);

    // prUrl は http(s) の schema・new URL() parse・2048 文字以内であればよく、
    // 実際にネットワークへ出る必要はない（クリックしない）ため自サーバーの URL を使う。
    const prUrl = `http://127.0.0.1:${port}/?pr=113`;

    const prBadge = win.locator('.pane .pane-task-title-pr').first();
    const prIcon = prBadge.locator('.pane-task-title-pr-icon');

    // ─── A: prMerged: true → 紫（.merged）・✓・マージ済み aria-label ───
    const mergedResult = await postSetTitle(port, {
      termId: '1',
      title: 'PR #113 マージ済みバッジ確認',
      prUrl,
      prMerged: true,
    });
    expect(mergedResult.response.status).toBe(200);
    expect(mergedResult.body && mergedResult.body.prMerged).toBe(true);

    await expect(prBadge).toBeVisible();
    await expect(prBadge).toHaveClass(/\bmerged\b/);
    await expect(prBadge).toHaveAttribute('aria-label', 'マージ済みのプルリクエストを開く（外部ブラウザ）');
    await expect(prIcon).toHaveText('✓');

    // ─── B: prMerged 省略 → 従来どおり緑（.merged 無し・↗・従来 aria-label） ───
    const omittedResult = await postSetTitle(port, {
      termId: '1',
      title: 'PR #113 省略時は緑のまま',
      prUrl,
    });
    expect(omittedResult.response.status).toBe(200);
    expect(omittedResult.body && omittedResult.body.prMerged).toBe(false);

    await expect(prBadge).not.toHaveClass(/\bmerged\b/);
    await expect(prBadge).toHaveAttribute('aria-label', 'プルリクエストを開く（外部ブラウザ）');
    await expect(prIcon).toHaveText('↗');

    // ─── C: prMerged が boolean 以外（文字列 "true"）→ 厳密な === true 判定で緑のまま ───
    // 先に一度 merged: true にしてから非 boolean を送り、緑へ戻ることを確認する
    // （「非 boolean は無視されて直前の状態を維持する」誤りではなく、明示的に false 扱いになることを見る）。
    await postSetTitle(port, { termId: '1', title: 'PR #113 一旦マージ済みに', prUrl, prMerged: true });
    await expect(prBadge).toHaveClass(/\bmerged\b/);

    const nonBooleanResult = await postSetTitle(port, {
      termId: '1',
      title: 'PR #113 非 boolean は緑扱い',
      prUrl,
      prMerged: 'true',
    });
    expect(nonBooleanResult.response.status).toBe(200);
    expect(nonBooleanResult.body && nonBooleanResult.body.prMerged).toBe(false);

    await expect(prBadge).not.toHaveClass(/\bmerged\b/);
    await expect(prBadge).toHaveAttribute('aria-label', 'プルリクエストを開く（外部ブラウザ）');
    await expect(prIcon).toHaveText('↗');

    // ─── D: 多層防御 — renderer 側 `typeof prMerged === 'boolean'` ガード自体の確認 ───
    // main.js は HTTP 経由では常に prMerged を boolean へ矯正して IPC 送信するため、
    // 上記 A〜C だけでは renderer 側ガードの分岐を直接踏めない。
    // ここでは main プロセス側から直接 'terminal:title' を送出し、
    // 矯正前の非 boolean（文字列）が来た場合でも renderer が無視して
    // 直前の apiPrMerged（true）を維持することを確認する。
    await postSetTitle(port, { termId: '1', title: 'PR #113 IPC 直接テスト前準備', prUrl, prMerged: true });
    await expect(prBadge).toHaveClass(/\bmerged\b/);

    await app.evaluate(({ BrowserWindow }, injectedPrUrl) => {
      const target = BrowserWindow.getAllWindows()[0];
      // 非 boolean（文字列 'true'）を第5引数に直接送出し、main.js の矯正を経由しない
      // renderer 側ガード単体を突く。prUrl には非空文字列を渡し PR バッジ自体は表示され続けるようにする。
      target.webContents.send('terminal:title', '1', 'PR #113 IPC 直接非 boolean', '', injectedPrUrl, 'true');
    }, prUrl);

    // renderer 実装（app.js の VKIpc.on('terminal:title', ...)）は
    // `typeof prMerged === 'boolean'` のときだけ apiPrMerged を上書きする。
    // 文字列 'true' は boolean ではないため上書きされず、直前の apiPrMerged（true）が
    // そのまま維持される＝ .merged クラスが付いたままになるはず。
    // ここが崩れて「非 boolean を merged 判定に使ってしまう」実装に変わっていないかを確認する。
    await expect(prBadge).toHaveClass(/\bmerged\b/);
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
