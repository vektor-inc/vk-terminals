const { test, expect, _electron, chromium } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// issue #121 / PR #122: モバイル版ペインプレビューで、TUI の再描画に伴う裸の \r
// （キャリッジリターン。行頭復帰＝現在行を上書きするのが本来の意味）を、
// 数文字ごとの改行として誤って表示してしまう不具合の end-to-end 確認。
//
// 実際の PTY 出力（Claude Code 等の TUI 再描画）で本症状を発火させるのは、
// vk-terminals に「任意の生バイト列を PTY 経由で描画させる」ための安定した
// 手段が無く（tput/printf の挙動は環境依存でフレーキーになりやすい）現実的でない。
// そこで、実プロダクションが使う経路（GET /api/states → 実ブラウザの mobile.html
// が fetch → 実物の stripAnsi/sanitizeMobilePreviewText を実行 → DOM 描画）は
// そのまま使い、/api/states の応答だけを page.route で差し替えて
// lastLines に生の \r を注入する。これは既存の
// tests/e2e/mobile-title-link.smoke.spec.js の「apiPrUrl に javascript: を注入」
// テストと同じ手法（正規の API 経路は別テストで担保済みなので、注入対象は
// レンダラー単体の描画ロジックに絞る）。

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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-cr-'));
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

test('モバイルプレビュー: 生 CR で再描画された日本語行が数文字ごとの改行にならず1行に表示される', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    const context = await browser.newContext();
    const page = await context.newPage();

    // TUI が同一行を繰り返し上書き再描画する典型パターン（プログレス表示等）を
    // 生の \r で再現し、/api/states 応答の lastLines に注入する。
    // CRLF ではなく裸の \r のみを使う点が本 issue の再現条件（CRLF は元々 LF 扱いで問題なし）。
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

    // 修正前の挙動（CR を無条件 LF 変換）なら、各断片が改行区切りで
    // 全部残ってしまう（"ペイン\nペインの\n..." のような複数行）。
    // 修正後は CR を「現在行の上書き」として扱うため、最終的に上書きされた
    // 1 行だけが残る。
    await expect(pre).toHaveText('ペインのリンク付きの部分、B');

    // 回帰確認: 上書き前の断片文字列が残存していないこと（数文字ごとの改行になっていない）。
    const text = await pre.textContent();
    expect(text).not.toContain('ペイン\n');
    expect((text.match(/\n/g) || []).length).toBe(0);
  } finally {
    await browser.close();
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
