const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// issue #123 / PR #124: ペインタイトル行（背景 #101015）の PR バッジ配色を
// 暗背景で WCAG 2.1 AA を満たすよう再調整した件の実描画確認。
//   getComputedStyle で renderer に実際にレンダリングされた
//   color / border-color / background-color を取得し、CSS の想定値と一致するか検証する。
//   - open  base : color #3fb950 / border #3fb950 / bg rgba(63,185,80,0.15)
//   - open  hover: color #56d364 / border #56d364 / bg rgba(63,185,80,0.25)
//   - merged base: color #a371f7 / border #a371f7 / bg rgba(130,80,223,0.15)
//   - merged hover: color #b083f8 / border #b083f8 / bg rgba(130,80,223,0.25)

const repoRoot = path.resolve(__dirname, '..', '..');

async function getFreePort() {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : null;
      server.close((err) => {
        if (err) return reject(err);
        if (!port) return reject(new Error('failed to allocate a free port'));
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
  try { body = await response.json(); } catch (_e) { /* 非 JSON 許容 */ }
  return { response, body };
}

async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await postSetTitle(port, { termId: '1', title: '' });
      if (result.response.status === 200) return;
      if (result.response.status !== 404) {
        throw new Error(`unexpected status ${result.response.status}`);
      }
      lastError = new Error('terminal 1 not ready');
    } catch (e) {
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw lastError || new Error('terminal 1 was not registered in time');
}

// 要素の描画済みスタイルを取得（color / border-top-color / background-color）
async function readBadgeStyle(badge) {
  return await badge.evaluate((el) => {
    const s = getComputedStyle(el);
    return {
      color: s.color,
      border: s.borderTopColor,
      background: s.backgroundColor,
    };
  });
}

// color/border/background の transition（0.12s）完了を待ってから想定値と一致確認する。
// 遷移中の中間色を拾わないよう expect.poll でスタイルが落ち着くまでリトライする。
async function expectBadgeStyle(badge, expected, label) {
  await expect.poll(
    async () => await readBadgeStyle(badge),
    { message: label, timeout: 5000 }
  ).toEqual(expected);
}

test('PR バッジの再調整後の色が renderer に想定どおり描画される', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-pr-contrast-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  const configPath = path.join(configDir, 'config.json');
  let app;

  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify({
    apiHost: '127.0.0.1', initialCommand: '', agentroom: false, additionalPanes: [],
  }), 'utf8');

  try {
    app = await _electron.launch({
      args: ['.', '--no-claude'],
      cwd: repoRoot,
      env: { ...process.env, HOME: tmpHome, USERPROFILE: tmpHome, VK_TERMINALS_API_PORT: String(port) },
    });
    const win = await app.firstWindow();
    await waitForPtyRegistration(port);

    const prUrl = `http://127.0.0.1:${port}/?pr=123`;
    const prBadge = win.locator('.pane .pane-task-title-pr').first();

    // ─── open（未マージ）base ───
    await postSetTitle(port, { termId: '1', title: 'open PR バッジ', prUrl });
    await expect(prBadge).toBeVisible();
    await expect(prBadge).not.toHaveClass(/\bmerged\b/);
    await expectBadgeStyle(prBadge, {
      color: 'rgb(63, 185, 80)',            // #3fb950
      border: 'rgb(63, 185, 80)',           // #3fb950
      background: 'rgba(63, 185, 80, 0.15)',
    }, 'open base');

    // ─── open hover ───
    await prBadge.hover();
    await expectBadgeStyle(prBadge, {
      color: 'rgb(86, 211, 100)',           // #56d364
      border: 'rgb(86, 211, 100)',          // #56d364
      background: 'rgba(63, 185, 80, 0.25)',
    }, 'open hover');
    // hover 解除（タイトル左端へマウスを退避）
    await win.locator('.pane-task-title').first().hover({ position: { x: 2, y: 2 } });

    // ─── merged base ───
    await postSetTitle(port, { termId: '1', title: 'merged PR バッジ', prUrl, prMerged: true });
    await expect(prBadge).toHaveClass(/\bmerged\b/);
    await expectBadgeStyle(prBadge, {
      color: 'rgb(163, 113, 247)',          // #a371f7
      border: 'rgb(163, 113, 247)',         // #a371f7
      background: 'rgba(130, 80, 223, 0.15)',
    }, 'merged base');

    // ─── merged hover ───
    await prBadge.hover();
    await expectBadgeStyle(prBadge, {
      color: 'rgb(176, 131, 248)',          // #b083f8
      border: 'rgb(176, 131, 248)',         // #b083f8
      background: 'rgba(130, 80, 223, 0.25)',
    }, 'merged hover');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
