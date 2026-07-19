const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

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

async function launchApp(port, config) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-mobile-tasks-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });
  // 実ユーザーの ~/.vk-terminals/config.json に依存しないよう HOME を一時化する。
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
  await app.firstWindow();
  return { app, tmpRoot };
}

async function fetchJson(url, options = {}) {
  const res = await fetch(url, options);
  const json = await res.json().catch(() => ({}));
  return { res, json };
}

async function waitForTasks(port, timeoutMs = 20_000) {
  // HTTP サーバー起動直後は fetch が失敗するため、/api/tasks が 200 を返すまで待つ。
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const { res, json } = await fetchJson(`http://127.0.0.1:${port}/api/tasks`);
      if (res.status === 200) return json;
      lastError = new Error(`/api/tasks returned ${res.status}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('/api/tasks did not become ready');
}

async function selectWithDialog(page, select, value, accept) {
  const dialogPromise = page.waitForEvent('dialog');
  const changePromise = select.evaluate((el, nextValue) => {
    el.value = nextValue;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  const dialog = await dialogPromise;
  const message = dialog.message();
  if (accept) {
    await dialog.accept();
  } else {
    await dialog.dismiss();
  }
  await changePromise;
  return message;
}

test('モバイル HTTP API: タスク一覧取得とステータス変更依頼を検証する', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-mobile-tasks-data-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  const updatedAt = freshDate();
  writeJson(tasksFile, {
    updatedAt,
    tasks: [
      {
        id: '199',
        title: 'モバイルから承認するタスク',
        status: 'awaiting-approval',
        assignee: 'wada',
        priority: null,
        sequential: false,
        prUrl: 'https://github.com/vektor-inc/vk-terminals/pull/199',
        createdAt: freshDate(-10 * 60 * 1000),
        internalPath: path.join(tmpRoot, 'private-worktree'),
      },
      {
        id: '200',
        title: '実行中で操作不可のタスク',
        status: 'in-progress',
        assignee: 'tsukasa',
        startedAt: freshDate(-60 * 1000),
      },
    ],
  });

  const { app, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    const base = `http://127.0.0.1:${port}`;
    const tasks = await waitForTasks(port);

    // GET /api/tasks は tasks-view.json の内容と commandsConfigured を返す。
    expect(tasks.updatedAt).toBe(updatedAt);
    expect(tasks.unavailable).toBe(false);
    expect(tasks.commandsConfigured).toBe(true);
    expect(tasks.tasks).toHaveLength(2);
    const awaitingTask = tasks.tasks.find((task) => task.id === '199');
    expect(awaitingTask).toMatchObject({
      title: 'モバイルから承認するタスク',
      status: 'awaiting-approval',
      assignee: 'wada',
      priority: null,
      sequential: false,
      prUrl: 'https://github.com/vektor-inc/vk-terminals/pull/199',
    });
    expect(awaitingTask).not.toHaveProperty('internalPath');
    // actions はサーバー側の共有ロジックで計算され、モバイル側はこの配列だけを描画に使う。
    expect(awaitingTask.actions).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: '承認', to: 'ready' }),
    ]));
    const runningTask = tasks.tasks.find((task) => task.id === '200');
    expect(runningTask.actions).toEqual([]);

    // 許可された awaiting-approval -> ready は commands.jsonl へ 1 行追記される。
    const allowed = await fetchJson(`${base}/api/tasks/set-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: '199', expected: 'awaiting-approval', to: 'ready' }),
    });
    expect(allowed.res.status).toBe(200);
    expect(allowed.json.ok).toBe(true);
    expect(typeof allowed.json.id).toBe('string');

    const lines = fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n');
    expect(lines).toHaveLength(1);
    const command = JSON.parse(lines[0]);
    expect(command).toMatchObject({
      taskId: 199,
      action: 'set-status',
      to: 'ready',
      expected: 'awaiting-approval',
    });
    expect(command.id).toBe(allowed.json.id);
    expect(typeof command.requestedAt).toBe('string');
    expect(Number.isNaN(Date.parse(command.requestedAt))).toBe(false);

    const priority = await fetchJson(`${base}/api/tasks/set-priority`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: '199', expected: 'none', to: 'high' }),
    });
    expect(priority.res.status).toBe(200);
    expect(priority.json.ok).toBe(true);

    const sequential = await fetchJson(`${base}/api/tasks/set-sequential`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: '199', expected: 'parallel', to: 'sequential' }),
    });
    expect(sequential.res.status).toBe(200);
    expect(sequential.json.ok).toBe(true);

    const commandLines = fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n').map((line) => JSON.parse(line));
    expect(commandLines).toHaveLength(3);
    expect(commandLines[1]).toMatchObject({
      taskId: 199,
      action: 'set-priority',
      to: 'high',
      expected: 'none',
    });
    expect(commandLines[2]).toMatchObject({
      taskId: 199,
      action: 'set-sequential',
      to: 'sequential',
      expected: 'parallel',
    });

    // 許可外の遷移は API レベルで拒否され、commands.jsonl も増えない。
    const disallowed = await fetchJson(`${base}/api/tasks/set-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: '200', expected: 'in-progress', to: 'ready' }),
    });
    expect(disallowed.res.status).toBe(400);
    expect(disallowed.json).toMatchObject({ ok: false, error: 'disallowed-transition' });
    expect(fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n')).toHaveLength(3);

    // 異なる Origin 付き POST は CSRF ガードで 403 になり、ヘルパーへ到達しない。
    const csrf = await fetchJson(`${base}/api/tasks/set-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://example.test' },
      body: JSON.stringify({ taskId: '199', expected: 'awaiting-approval', to: 'ready' }),
    });
    expect(csrf.res.status).toBe(403);
    expect(csrf.json).toEqual({ error: 'forbidden origin' });
    expect(fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n')).toHaveLength(3);
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('モバイル UI: ステータス select の確認キャンセルと反映待ち表示を検証する', async ({ page }) => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-mobile-tasks-ui-data-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: '301',
        title: 'モバイルの PR 付きマージ待ちタスク',
        status: 'waiting-merge',
        assignee: 'wada',
        priority: 'medium',
        sequential: false,
        prUrl: 'https://github.com/vektor-inc/vk-terminals/pull/301',
        updatedAt: freshDate(-60 * 1000),
      },
    ],
  });

  const { app, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    await waitForTasks(port);
    await page.goto(`http://127.0.0.1:${port}/`);
    const task = page.locator('.task-item').filter({ hasText: 'モバイルの PR 付きマージ待ちタスク' });
    await expect(task).toBeVisible({ timeout: 10_000 });
    const statusSelect = task.getByLabel('モバイルの PR 付きマージ待ちタスク の状態');
    await expect(statusSelect).toHaveValue('waiting-merge');

    // mobile.html も全ステータスを同じ順で描画し、API が返す actions だけで disabled を決める。
    await expect(statusSelect.locator('option')).toHaveText([
      '承認待ち',
      '実行待ち',
      '実行中',
      '入力待ち',
      'マージ待ち',
      '完了',
      '失敗',
    ]);
    const readyDisabled = await statusSelect.locator('option[value="ready"]').evaluate((option) => option.disabled);
    const doneDisabled = await statusSelect.locator('option[value="done"]').evaluate((option) => option.disabled);
    expect(readyDisabled).toBe(true);
    expect(doneDisabled).toBe(false);

    const cancelMessage = await selectWithDialog(page, statusSelect, 'done', false);
    expect(cancelMessage).toContain('ステータスを「完了」に変更しますか？');
    expect(cancelMessage).toContain('PR のマージは行われません（PR は開いたまま残ります）。');
    await expect(statusSelect).toHaveValue('waiting-merge');
    expect(fs.existsSync(commandsPath)).toBe(false);

    const acceptMessage = await selectWithDialog(page, statusSelect, 'done', true);
    expect(acceptMessage).toContain('ステータスを「完了」に変更しますか？');
    await expect(task.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect.poll(() => fs.existsSync(commandsPath) ? fs.readFileSync(commandsPath, 'utf8') : '', {
      timeout: 5000,
    }).not.toBe('');

    const [line] = fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n');
    expect(JSON.parse(line)).toMatchObject({
      taskId: 301,
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

test('モバイル HTTP API: 未知のステータス変更エラーは internal-error に丸める', async () => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-mobile-tasks-internal-error-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: '299',
        title: '書き込み失敗を検証するタスク',
        status: 'awaiting-approval',
        createdAt: freshDate(-10 * 60 * 1000),
      },
    ],
  });

  const { app, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath: tmpRoot });
  try {
    const base = `http://127.0.0.1:${port}`;
    await waitForTasks(port);

    const result = await fetchJson(`${base}/api/tasks/set-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: '299', expected: 'awaiting-approval', to: 'ready' }),
    });
    expect(result.res.status).toBe(500);
    expect(result.json).toEqual({ ok: false, error: 'internal-error' });
    expect(JSON.stringify(result.json)).not.toContain(tmpRoot);
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
