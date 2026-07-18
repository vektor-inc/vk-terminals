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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-status-'));
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

test('awaiting-approval タスクの承認ボタンで commands.jsonl に set-status を 1 行追記する', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-status-data-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      { id: '198', title: '承認待ちのタスク', status: 'awaiting-approval', assignee: 'wada', createdAt: freshDate(-10 * 60 * 1000) },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const task = section.locator('.task-item').filter({ hasText: '承認待ちのタスク' });
    await expect(task.getByRole('button', { name: '承認' })).toBeVisible();

    // クリック後は renderer 側の pending 表示に切り替わり、main 側では JSONL が追記される。
    await task.getByRole('button', { name: '承認' }).click();
    await expect(task.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect.poll(() => fs.existsSync(commandsPath) ? fs.readFileSync(commandsPath, 'utf8') : '', {
      timeout: 5000,
    }).not.toBe('');

    const lines = fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const command = JSON.parse(lines[0]);
    expect(command).toMatchObject({
      taskId: 198,
      action: 'set-status',
      to: 'ready',
      expected: 'awaiting-approval',
    });
    expect(typeof command.id).toBe('string');
    expect(command.id.length).toBeGreaterThan(0);
    expect(typeof command.requestedAt).toBe('string');
    expect(command.requestedAt.length).toBeGreaterThan(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('commandsPath 未設定時はステータス操作ボタンを表示しない', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-status-readonly-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      { id: '201', title: '表示だけの承認待ちタスク', status: 'awaiting-approval', createdAt: freshDate(-5 * 60 * 1000) },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section).toContainText('表示だけの承認待ちタスク');
    await expect(section.getByRole('button', { name: '承認' })).toHaveCount(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('in-progress タスクには commandsPath 設定時でも操作ボタンを表示しない', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-status-in-progress-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      { id: '202', title: '実行中のタスク', status: 'in-progress', assignee: 'wada', startedAt: freshDate(-60 * 1000) },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const task = section.locator('.task-item').filter({ hasText: '実行中のタスク' });
    await expect(task).toBeVisible();
    await expect(task.locator('.task-item-action')).toHaveCount(0);
    await expect(task.locator('.task-item-pending')).toHaveCount(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
