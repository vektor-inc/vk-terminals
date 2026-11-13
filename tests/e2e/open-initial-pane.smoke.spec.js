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

async function expectEmptyButtonsFit(win) {
  const measurements = await win.locator('.grid-empty-btn').evaluateAll(buttons => buttons.map(button => {
    const grid = button.closest('.grid');
    const buttonRect = button.getBoundingClientRect();
    const gridRect = grid.getBoundingClientRect();
    const style = getComputedStyle(button);
    return {
      height: buttonRect.height,
      fontSize: parseFloat(style.fontSize),
      verticalSpace: parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth),
      whiteSpace: style.whiteSpace,
      left: buttonRect.left - gridRect.left,
      right: gridRect.right - buttonRect.right,
    };
  }));
  expect(measurements.length).toBeGreaterThan(0);
  for (const button of measurements) {
    expect(button.whiteSpace).toBe('nowrap');
    expect(button.height).toBeLessThanOrEqual(button.fontSize * 1.6 + button.verticalSpace + 1);
    expect(button.left).toBeGreaterThanOrEqual(0);
    expect(button.right).toBeGreaterThanOrEqual(0);
  }
}

test('狭いペイン領域でも空画面のボタンは折り返さず収まる', async () => {
  const launched = await start();
  try {
    // アプリの最小幅をテスト中だけ解除し、実際に狭いペイン領域を作る。
    await launched.app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(0, 0);
      window.setSize(520, 640);
    });
    await expect.poll(() => launched.win.locator('.grid').evaluate(grid => grid.getBoundingClientRect().width)).toBeLessThanOrEqual(200);
    await expect(launched.win.locator('.grid-empty-btn')).toBeVisible();
    await expectEmptyButtonsFit(launched.win);

    const created = await post(launched.port, '/api/new-pane', { noClaude: true, stashed: true });
    expect(created.status).toBe(200);
    await expect(launched.win.locator('.grid-empty-btn-secondary')).toBeVisible();
    await expectEmptyButtonsFit(launched.win);
    // 縦に積んだボタンの左右端が揃うことを確認する。
    const narrowRects = await launched.win.locator('.grid-empty-btn').evaluateAll(buttons => buttons.map(button => {
      const rect = button.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
    }));
    expect(narrowRects).toHaveLength(2);
    expect(narrowRects[1].top).toBeGreaterThanOrEqual(narrowRects[0].bottom);
    expect(Math.abs(narrowRects[0].left - narrowRects[1].left)).toBeLessThanOrEqual(1);
    expect(Math.abs(narrowRects[0].right - narrowRects[1].right)).toBeLessThanOrEqual(1);

    // 広い画面では主操作の文字サイズと左右余白を維持する。
    await launched.app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1280, 640));
    const wideStyles = await launched.win.locator('.grid-empty-btn').first().evaluate(button => {
      const style = getComputedStyle(button);
      return { fontSize: style.fontSize, paddingLeft: style.paddingLeft, paddingRight: style.paddingRight };
    });
    expect(wideStyles).toEqual({ fontSize: '13px', paddingLeft: '16px', paddingRight: '16px' });
  } finally { await closeApp(launched); }
});

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
