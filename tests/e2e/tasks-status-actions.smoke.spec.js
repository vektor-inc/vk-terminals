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

function readCommands(commandsPath) {
  if (!fs.existsSync(commandsPath)) return [];
  const raw = fs.readFileSync(commandsPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
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

async function clickWithDialog(page, button, accept) {
  const dialogPromise = page.waitForEvent('dialog');
  const clickPromise = button.click();
  const dialog = await dialogPromise;
  const message = dialog.message();
  if (accept) {
    await dialog.accept();
  } else {
    await dialog.dismiss();
  }
  await clickPromise;
  return message;
}

test('承認待ちタスクの編集パネル保存で commands.jsonl に set-status を 1 行追記する', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-status-data-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: '198',
        title: '承認待ちのタスク',
        status: 'awaiting-approval',
        assignee: 'wada',
        priority: 'medium',
        sequential: false,
        createdAt: freshDate(-10 * 60 * 1000),
      },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const task = section.locator('.task-item').filter({ hasText: '承認待ちのタスク' });
    await expect(task.locator('.task-status-label')).toHaveText('承認待ち');

    await task.getByRole('button', { name: '編集' }).click();
    const statusSelect = task.getByLabel('ステータス');
    await expect(statusSelect).toHaveValue('awaiting-approval');

    // パネル内 select は常に 7 ステータスを同じライフサイクル順で持ち、遷移不可 option は disabled にする。
    await expect(statusSelect.locator('option')).toHaveText([
      '承認待ち',
      '実行待ち',
      '実行中',
      '入力待ち',
      'マージ待ち',
      '完了',
      '失敗',
    ]);
    const disabledByValue = await statusSelect.locator('option').evaluateAll((options) => (
      Object.fromEntries(options.map((option) => [option.value, option.disabled]))
    ));
    expect(disabledByValue).toMatchObject({
      'awaiting-approval': false,
      ready: false,
      'in-progress': true,
      'waiting-input': true,
      'waiting-merge': true,
      done: true,
      failed: true,
    });

    // 変更だけでは送信せず、保存で反映待ちラベルを出す。
    await statusSelect.selectOption('ready');
    expect(readCommands(commandsPath)).toHaveLength(0);
    await task.getByRole('button', { name: '保存' }).click();
    await expect(task.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect(task.locator('.task-edit-panel')).toHaveCount(0);
    await expect.poll(() => readCommands(commandsPath), { timeout: 5000 }).toHaveLength(1);

    const [command] = readCommands(commandsPath);
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

test('commandsPath 未設定時はステータスラベルを表示するが編集できない', async () => {
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
    const task = section.locator('.task-item').filter({ hasText: '表示だけの承認待ちタスク' });
    await expect(task.locator('.task-status-label')).toHaveText('承認待ち');
    await expect(task.getByRole('button', { name: '編集' })).toHaveCount(0);
    await expect(section.getByRole('button', { name: '承認' })).toHaveCount(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('編集パネルは保存まで優先度と実行方式を送信せず、保存時に変更分だけ送信する', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-edit-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: '203',
        title: '編集できる承認待ちタスク',
        status: 'awaiting-approval',
        assignee: 'wada',
        priority: 'high',
        sequential: true,
        createdAt: freshDate(-10 * 60 * 1000),
      },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const task = section.locator('.task-item').filter({ hasText: '編集できる承認待ちタスク' });
    await expect(task.locator('.task-priority-badge')).toHaveText('高');
    await expect(task.locator('.task-sequential-chip')).toHaveText('直列');
    await expect(task.getByRole('button', { name: '承認' })).toHaveCount(0);

    await task.getByRole('button', { name: '編集' }).click();
    await expect(task.locator('.task-edit-panel')).toBeVisible();
    await expect(task.locator('.task-edit-label')).toHaveText(['ステータス', '優先度', '実行方式']);

    const prioritySelect = task.getByLabel('優先度');
    await prioritySelect.focus();
    await prioritySelect.selectOption('low');
    await task.getByRole('button', { name: '並列' }).click();
    expect(readCommands(commandsPath)).toHaveLength(0);
    await task.getByRole('button', { name: '保存' }).click();
    await expect(task.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect(task.locator('.task-edit-panel')).toHaveCount(0);

    await expect.poll(() => readCommands(commandsPath), { timeout: 5000 }).toHaveLength(2);
    const [priorityCommand, sequentialCommand] = readCommands(commandsPath);
    expect(priorityCommand).toMatchObject({
      taskId: 203,
      action: 'set-priority',
      to: 'low',
      expected: 'high',
    });
    expect(sequentialCommand).toMatchObject({
      taskId: 203,
      action: 'set-sequential',
      to: 'parallel',
      expected: 'sequential',
    });
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('編集パネルのキャンセルは変更を破棄して送信しない', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-edit-cancel-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: '207',
        title: 'キャンセルする承認待ちタスク',
        status: 'awaiting-approval',
        assignee: 'wada',
        priority: 'high',
        sequential: true,
        createdAt: freshDate(-10 * 60 * 1000),
      },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const task = section.locator('.task-item').filter({ hasText: 'キャンセルする承認待ちタスク' });
    await task.getByRole('button', { name: '編集' }).click();

    await task.getByLabel('ステータス').selectOption('ready');
    await task.getByLabel('優先度').selectOption('low');
    await task.getByRole('button', { name: '並列' }).click();
    await task.getByRole('button', { name: 'キャンセル' }).click();

    await expect(task.locator('.task-edit-panel')).toHaveCount(0);
    await expect(task.locator('.task-status-label')).toHaveText('承認待ち');
    await expect(task.locator('.task-priority-badge')).toHaveText('高');
    await expect(task.locator('.task-sequential-chip')).toHaveText('直列');
    expect(readCommands(commandsPath)).toHaveLength(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('旧契約の実行中タスクはステータスラベルのみ表示し編集パネルを表示しない', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-status-in-progress-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      { id: '202', title: '実行中の旧契約タスク', status: 'in-progress', assignee: 'wada', startedAt: freshDate(-60 * 1000) },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const task = section.locator('.task-item').filter({ hasText: '実行中の旧契約タスク' });
    await expect(task.locator('.task-status-label')).toHaveText('実行中');
    await expect(task.getByRole('button', { name: '編集' })).toHaveCount(0);
    await expect(task.locator('.task-item-pending')).toHaveCount(0);
    expect(readCommands(commandsPath)).toHaveLength(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PR 付きマージ待ちタスクを完了へ変更する確認はキャンセル時に送信しない', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-status-merge-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: '204',
        title: 'PR 付きのマージ待ちタスク',
        status: 'waiting-merge',
        assignee: 'wada',
        priority: 'medium',
        sequential: false,
        prUrl: 'https://github.com/vektor-inc/vk-terminals/pull/204',
        updatedAt: freshDate(-60 * 1000),
      },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const task = section.locator('.task-item').filter({ hasText: 'PR 付きのマージ待ちタスク' });
    await task.getByRole('button', { name: '編集' }).click();
    const statusSelect = task.getByLabel('ステータス');
    await statusSelect.selectOption('done');

    const cancelMessage = await clickWithDialog(win, task.getByRole('button', { name: '保存' }), false);
    expect(cancelMessage).toContain('ステータスを「完了」に変更しますか？');
    expect(cancelMessage).toContain('PR のマージは行われません（PR は開いたまま残ります）。');
    await expect(statusSelect).toHaveValue('done');
    await expect(task.locator('.task-edit-panel')).toBeVisible();
    await expect(task.locator('.task-item-pending')).toHaveCount(0);
    expect(readCommands(commandsPath)).toHaveLength(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('PR 付きマージ待ちタスクを完了へ変更すると反映待ちを表示する', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-status-merge-accept-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: '206',
        title: '完了へ進める PR 付きマージ待ちタスク',
        status: 'waiting-merge',
        assignee: 'wada',
        priority: 'medium',
        sequential: false,
        prUrl: 'https://github.com/vektor-inc/vk-terminals/pull/206',
        updatedAt: freshDate(-60 * 1000),
      },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const task = section.locator('.task-item').filter({ hasText: '完了へ進める PR 付きマージ待ちタスク' });
    await task.getByRole('button', { name: '編集' }).click();
    const statusSelect = task.getByLabel('ステータス');
    await statusSelect.selectOption('done');

    const acceptMessage = await clickWithDialog(win, task.getByRole('button', { name: '保存' }), true);
    expect(acceptMessage).toContain('ステータスを「完了」に変更しますか？');
    expect(acceptMessage).toContain('PR のマージは行われません（PR は開いたまま残ります）。');
    await expect(task.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect(task.locator('.task-edit-panel')).toHaveCount(0);
    await expect.poll(() => readCommands(commandsPath), { timeout: 5000 }).toHaveLength(1);
    const [command] = readCommands(commandsPath);
    expect(command).toMatchObject({
      taskId: 206,
      action: 'set-status',
      to: 'done',
      expected: 'waiting-merge',
    });
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('承認待ちへ戻す遷移では二重起動警告を表示する', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-tasks-status-return-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: '205',
        title: '差し戻し相当の実行中タスク',
        status: 'in-progress',
        assignee: 'wada',
        priority: 'medium',
        sequential: false,
        startedAt: freshDate(-60 * 1000),
      },
    ],
  });

  const { app, win, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const task = section.locator('.task-item').filter({ hasText: '差し戻し相当の実行中タスク' });
    await task.getByRole('button', { name: '編集' }).click();
    const statusSelect = task.getByLabel('ステータス');
    await statusSelect.selectOption('awaiting-approval');

    const message = await clickWithDialog(win, task.getByRole('button', { name: '保存' }), true);
    expect(message).toContain('ステータスを「承認待ち」に変更しますか？');
    expect(message).toContain('再承認で二重起動につながる可能性があります。');
    await expect(task.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect.poll(() => readCommands(commandsPath), { timeout: 5000 }).toHaveLength(1);
    const [command] = readCommands(commandsPath);
    expect(command).toMatchObject({
      taskId: 205,
      action: 'set-status',
      to: 'awaiting-approval',
      expected: 'in-progress',
    });
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
