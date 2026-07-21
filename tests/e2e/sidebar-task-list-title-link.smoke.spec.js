const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// PR #233 / issue #233: サイドバー「タスク一覧」の見出しラベル「タスク」を、GitHub モード時だけ
// task-queue の issue 一覧ページ（.../issues）への外部リンクにする変更の end-to-end 確認。
//   - GitHub モード（queueIssueUrl が https の実 URL）→ 見出しが a.task-list-title-link で描画され、
//     role="link" / aria-label / ↗ アイコンを持つ。href は "#"、クリックで shell.openExternal に
//     一覧 URL（末尾の /N を落としたもの）が渡る。
//   - ローカルモード（queueIssueUrl が local://...）→ 見出しはプレーンテキスト「タスク」（リンク化しない）。
//
// sidebar-task-link.smoke.spec.js と同じく tasksFile 設定でタスクスナップショット（tasks-view.json 相当）を
// 注入する方式。BrowserWindow は nodeIntegration: true / contextIsolation: false のため、
// win.evaluate から require('electron').shell を差し替えて openExternal 呼び出しを検証できる。

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

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function freshDate(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
// config には tasksFile を渡し、サイドバーのタスクセクションを有効化する。
async function launchApp(port, config = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-task-title-link-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(configPath, {
    apiHost: '127.0.0.1',
    initialCommand: '',
    agentroom: false,
    additionalPanes: [],
    ...config,
  });

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
  const win = await app.firstWindow();
  return { app, win, tmpRoot };
}

// ─── 1: GitHub モード → 見出し「タスク」が issue 一覧へのリンク（↗ / a11y 属性）になる ───
test('GitHub モード: 見出しが a.task-list-title-link で描画され ↗ アイコン・role/aria を持つ', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-task-title-link-gh-'));
  const tasksFile = path.join(dataRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: 480,
        title: 'GitHub モードのタスク',
        status: 'in-progress',
        assignee: 'kurudrive',
        startedAt: freshDate(-3 * 60 * 1000),
        queueIssueUrl: 'https://github.com/vektor-inc/vk-orchestrator/issues/480',
      },
    ],
  });

  const { app, win, tmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });

    // 見出しラベル（.task-list-title-text）が <a class="task-list-title-link"> を内包すること。
    const link = section.locator('.task-list-title-text a.task-list-title-link');
    await expect(link).toHaveCount(1);
    await expect(link).toBeVisible();
    await expect(link).toContainText('タスク');

    // アクセシビリティ属性: role="link" と aria-label（外部で開く旨）。
    await expect(link).toHaveAttribute('role', 'link');
    await expect(link).toHaveAttribute('aria-label', 'タスク一覧（外部ブラウザで開く）');

    // 末尾の ↗ アイコン span を含み、装飾なので aria-hidden。
    const icon = link.locator('.task-list-title-link-icon');
    await expect(icon).toHaveCount(1);
    await expect(icon).toContainText('↗');
    await expect(icon).toHaveAttribute('aria-hidden', 'true');

    // href は実 URL を直接持たず "#"。ツールチップ（title 属性）に一覧 URL が集約されていること。
    await expect(link).toHaveAttribute('href', '#');
    await expect(link).toHaveAttribute(
      'title',
      new RegExp('https://github\\.com/vektor-inc/vk-orchestrator/issues$', 'm'),
    );
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── 2: クリックで shell.openExternal に一覧 URL（/N を落としたもの）が渡る ───
test('GitHub モード: 見出しクリックで shell.openExternal に issue 一覧 URL が渡る', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-task-title-link-click-'));
  const tasksFile = path.join(dataRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: 481,
        title: 'クリック確認タスク',
        status: 'ready',
        createdAt: freshDate(-5 * 60 * 1000),
        queueIssueUrl: 'https://github.com/vektor-inc/vk-orchestrator/issues/481',
      },
    ],
  });

  const { app, win, tmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const link = section.locator('.task-list-title-text a.task-list-title-link');
    await expect(link).toHaveCount(1);

    // require('electron').shell.openExternal を差し替えて呼び出しを捕捉する（実ブラウザは開かない）。
    await win.evaluate(() => {
      const { shell } = require('electron');
      window.__openedUrls = [];
      shell.openExternal = (url) => {
        window.__openedUrls.push(url);
        return Promise.resolve(true);
      };
    });

    const windowsBefore = app.windows().length;
    await link.click();

    // openExternal には個別 issue の /481 を落とした一覧 URL が渡る。
    await expect
      .poll(async () => win.evaluate(() => window.__openedUrls || []), { timeout: 5_000 })
      .toEqual(['https://github.com/vektor-inc/vk-orchestrator/issues']);

    // アプリ内に新規ウィンドウは開かれていないこと（OS ブラウザへ委譲するため）。
    await win.waitForTimeout(300);
    expect(app.windows().length).toBe(windowsBefore);
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── 3: ローカルモード → 見出しはプレーンテキスト（リンク化しない）───
test('ローカルモード: queueIssueUrl が local:// のとき見出しはリンク化されずプレーンテキスト', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-task-title-link-local-'));
  const tasksFile = path.join(dataRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: 482,
        title: 'ローカルモードのタスク',
        status: 'in-progress',
        assignee: 'kurudrive',
        startedAt: freshDate(-2 * 60 * 1000),
        queueIssueUrl: 'local://queue/abc123',
      },
    ],
  });

  const { app, win, tmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });

    // 見出しはリンク化されず、プレーンテキスト「タスク」のまま。
    await expect(section.locator('a.task-list-title-link')).toHaveCount(0);
    const label = section.locator('.task-list-title-text');
    await expect(label).toHaveCount(1);
    await expect(label).toHaveText('タスク');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
