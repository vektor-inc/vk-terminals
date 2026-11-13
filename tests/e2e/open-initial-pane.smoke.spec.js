const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

async function start(config = {}, options = {}) {
  const port = await getFreePort();
  const launched = await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-empty-', config: { openInitialPane: false, ...config }, ...options });
  return { ...launched, port };
}

test('空画面から追加したペインには初期コマンドを送信しない', async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-initial-command-'));
  const binDir = path.join(fixtureRoot, 'bin');
  const capturePath = path.join(fixtureRoot, 'input.txt');
  fs.mkdirSync(binDir);
  // 偽 Claude が ready 表示後の標準入力を記録し、初期コマンドの誤送信を観測する。
  fs.writeFileSync(path.join(binDir, 'claude'), `#!/usr/bin/env node
const fs = require('fs');
process.stdout.write('Welcome to Claude\\n');
process.stdin.on('data', (chunk) => fs.appendFileSync(process.env.VK_E2E_INPUT_CAPTURE, chunk));
`, { mode: 0o755 });
  let launched;
  try {
    launched = await start({ initialCommand: 'INITIAL_COMMAND_MARKER', newPaneAutoLaunchClaude: true }, {
      launchAi: true,
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        VK_E2E_INPUT_CAPTURE: capturePath,
      },
    });
    await launched.win.locator('.grid-empty-btn').click();
    await expect(launched.win.locator('.pane')).toHaveCount(1);
    await expect(launched.win.locator('.pane')).toContainText('Welcome to Claude');
    await launched.win.waitForTimeout(1500);
    expect(fs.existsSync(capturePath) ? fs.readFileSync(capturePath, 'utf8') : '').not.toContain('INITIAL_COMMAND_MARKER');
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

async function post(port, pathname, payload) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

test('既定では空画面からボタンで最初のペインを追加できる', async () => {
  const launched = await start();
  try {
    expect(await launched.win.evaluate(() => window.VKIpc.invoke('app:get-config').then(c => c.openInitialPane))).toBe(false);
    await expect(launched.win.locator('.grid-empty-title')).toHaveText('開いているペインはありません');
    await expect(launched.win.locator('.grid-empty-desc')).toHaveCount(0);
    await expect(launched.win.locator('.grid-empty-btn-secondary')).toHaveCount(0);
    await expect(launched.win.locator('.grid-empty-btn')).not.toBeFocused();
    await launched.win.locator('.grid-empty-btn').click();
    await expect(launched.win.locator('.pane')).toHaveCount(1);
  } finally { await closeApp(launched); }
});

test('0 枚から API で追加し、最後のペインを閉じると空画面に戻る', async () => {
  const launched = await start();
  try {
    const created = await post(launched.port, '/api/new-pane', { noClaude: true });
    expect(created.status).toBe(200);
    expect(created.body.termId).toBeTruthy();
    await expect(launched.win.locator('.pane')).toHaveCount(1);
    const closed = await post(launched.port, '/api/close-pane', { termId: created.body.termId });
    expect(closed.status).toBe(200);
    await expect(launched.win.locator('.grid-empty-title')).toHaveText('開いているペインはありません');
    await expect(launched.win.locator('.grid-empty-btn')).toBeFocused();
  } finally { await closeApp(launched); }
});

test('追加ペインは最初のペインが無くても開く', async () => {
  const launched = await start({ additionalPanes: [{ cwd: process.cwd(), noClaude: true }] });
  try { await expect(launched.win.locator('.pane')).toHaveCount(1); }
  finally { await closeApp(launched); }
});

test('格納中のペインがあれば復帰の導線を表示する', async () => {
  const launched = await start({ openInitialPane: true, confirmClose: 'never' });
  try {
    const created = await post(launched.port, '/api/new-pane', { noClaude: true, stashed: true });
    expect(created.status).toBe(200);
    await launched.win.locator('.pane .btn-close').first().click();
    await expect(launched.win.locator('.grid-empty-title')).toHaveText('すべてのペインを格納中です');
    await expect(launched.win.locator('.grid-empty-btn-secondary')).toBeVisible();
  } finally { await closeApp(launched); }
});
