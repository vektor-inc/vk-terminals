const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..', '..');

async function getFreePort() {
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

async function launchApp(port, config = {}) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-sidebar-'));
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

test('tasksFile 設定時はタスクセクションを表示し、status グループ順とファイル更新を反映する', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-data-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      { id: 3, title: '実行待ちタスク', status: 'ready', assignee: null, createdAt: freshDate(-20 * 60 * 1000) },
      { id: 1, title: '実行中タスク', status: 'in-progress', assignee: 'kurudrive', startedAt: freshDate(-3 * 60 * 1000) },
      { id: 2, title: '入力待ちタスク', status: 'waiting-input', assignee: 'wada', startedAt: freshDate(-80 * 60 * 1000) },
      { id: 4, title: '未知ステータスタスク', status: 'custom-status', startedAt: freshDate(-5 * 60 * 1000) },
      { id: 5, status: 'failed', startedAt: freshDate(-5 * 60 * 1000) },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section).toContainText('実行中タスク');
    await expect(section).toContainText('入力待ちタスク');
    await expect(section).toContainText('実行待ちタスク');
    await expect(section).toContainText('未知ステータスタスク');
    await expect(section).not.toContainText('undefined');

    // グループ見出しは推奨順（in-progress → waiting-input → ready → unknown）で並ぶ。
    const groupTitles = await section.locator('.task-list-group-title').evaluateAll((els) => els.map((el) => el.textContent));
    expect(groupTitles).toEqual(['実行中', '入力待ち', '実行待ち', 'custom-status']);
    await expect(section.locator('.task-status[data-status="in-progress"]').first()).toHaveText('実行中');
    await expect(section.locator('.task-item-assignee').first()).toContainText('kurudrive');
    await expect(section.locator('.task-item-elapsed').first()).toContainText('分');

    // fs.watch / polling 経由で書き換え後の snapshot が renderer に push されることを確認する。
    writeJson(tasksFile, {
      updatedAt: freshDate(),
      tasks: [
        { id: 6, title: '監視更新後タスク', status: 'in-progress', assignee: 'kurudrive', startedAt: freshDate(-60 * 1000) },
      ],
    });
    await expect(section).toContainText('監視更新後タスク', { timeout: 10_000 });
    await expect(section).not.toContainText('実行待ちタスク');
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('tasks-view.json の updatedAt が古い場合は orchestrator 停止中を表示する', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-stale-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(-5 * 60 * 1000),
    tasks: [
      { id: 7, title: '古いスナップショットのタスク', status: 'ready', createdAt: freshDate(-10 * 60 * 1000) },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section.locator('.task-list-stale')).toBeVisible();
    await expect(section.locator('.task-list-stale')).toHaveText('orchestrator 停止中');
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('tasksFile 未設定時はタスクセクションを表示しない', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp(port);
  try {
    await win.waitForSelector('#task-list', { state: 'attached' });
    const section = win.locator('#task-list');
    await expect(section).toHaveAttribute('hidden', '');
    await expect(section).toBeHidden();
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
