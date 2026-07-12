const { test, expect, _electron, chromium } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// issue #132 / PR #133: モバイル版ペインプレビューで、Claude Code の TUI が行う
// CSI カーソル位置指定による全画面再描画（`\x1b[row;colH` で各行の先頭へ移動し
// `\x1b[2K` で行を消してから本文を書く）を扱えず、位置移動を無視したまま同一の
// 内部行を消し続けて「最後の入力ボックス相当の1行」だけになる不具合の
// end-to-end 確認。
//
// 検証手法は既存の mobile-preview-cr-redraw / mobile-preview-order-scroll の
// smoke spec を踏襲する。一時 HOME + `--no-claude` で Electron を起動し、
// VK_TERMINALS_API_PORT で空きポートを指定、Playwright の page.route で
// /api/states 応答を差し替えて任意の lastLines を注入 → 実ブラウザで mobile.html の
// 実描画（実物の stripAnsi / sanitizeMobilePreviewText を経由した DOM）を検証する。

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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-csi-'));
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

// Claude Code 風の CSI カーソル位置指定再描画フレームを組み立てる。
// 各行を `\x1b[row;1H`（絶対位置指定）→ `\x1b[2K`（行消去）→ 本文 の順で書く。
// 修正前はこの位置移動を無視して同一内部行を消し続けるため、本文がほぼ残らず
// 最終行だけになっていた。修正後は row/col バッファへ反映され、各本文行が
// 別々の行として復元される。
function buildClaudeCodeCsiRedrawFrame() {
  return [
    '\x1b[1;1H\x1b[2K実装内容を確認しています',
    '\x1b[2;1H\x1b[2K- renderer/mobile.html のモバイルプレビューを調査',
    '\x1b[3;1H\x1b[2K- sanitize の処理順と CSS 高さを確認',
    '\x1b[4;1H\x1b[2K- 直近の本文出力を最低10行見えるように修正',
    '\x1b[5;1H\x1b[2Knpm test を実行して回帰を確認します',
    '\x1b[6;1H\x1b[2K変更後は本文行が消えないことを検証します',
  ].join('');
}

test('モバイルプレビュー: CSI 位置指定再描画で直近の本文行が複数行として復元される', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    const context = await browser.newContext();
    const page = await context.newPage();

    const injectedLastLines = buildClaudeCodeCsiRedrawFrame();

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

    // (1) 本文行の復元: 位置指定再描画でも直近の本文行が複数行として残る。
    //     修正前は位置移動を無視して同一行を消し続けるため、本文はほぼ残らず
    //     1 行程度しか表示されなかった。
    const text = await pre.textContent();
    expect(text).toContain('実装内容を確認しています');
    expect(text).toContain('renderer/mobile.html のモバイルプレビューを調査');
    expect(text).toContain('sanitize の処理順と CSS 高さを確認');
    expect(text).toContain('直近の本文出力を最低10行見えるように修正');
    expect(text).toContain('npm test を実行して回帰を確認します');
    expect(text).toContain('変更後は本文行が消えないことを検証します');

    // 本文が 1 行に潰れず、複数行（≒注入した本文行数）として描画されている。
    const nonEmptyLineCount = text.split('\n').filter((l) => l.trim()).length;
    expect(nonEmptyLineCount).toBeGreaterThanOrEqual(5);

    // (2) 最低高さ: 内容が短くてもプレビュー枠が約7行分（min-height: 140px）を確保する。
    const minHeightPx = await pre.evaluate((el) => parseFloat(getComputedStyle(el).minHeight));
    expect(minHeightPx).toBeGreaterThanOrEqual(130);
    // 実効の描画高さも約140px以上（短い内容で枠が潰れない）。
    const clientHeightPx = await pre.evaluate((el) => el.clientHeight);
    expect(clientHeightPx).toBeGreaterThanOrEqual(130);
  } finally {
    await browser.close();
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
