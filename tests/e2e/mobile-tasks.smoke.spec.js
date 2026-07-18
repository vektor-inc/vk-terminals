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

    // 許可外の遷移は API レベルで拒否され、commands.jsonl も増えない。
    const disallowed = await fetchJson(`${base}/api/tasks/set-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ taskId: '200', expected: 'in-progress', to: 'ready' }),
    });
    expect(disallowed.res.status).toBe(400);
    expect(disallowed.json).toMatchObject({ ok: false, error: 'disallowed-transition' });
    expect(fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n')).toHaveLength(1);

    // 異なる Origin 付き POST は CSRF ガードで 403 になり、ヘルパーへ到達しない。
    const csrf = await fetchJson(`${base}/api/tasks/set-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://example.test' },
      body: JSON.stringify({ taskId: '199', expected: 'awaiting-approval', to: 'ready' }),
    });
    expect(csrf.res.status).toBe(403);
    expect(csrf.json).toEqual({ error: 'forbidden origin' });
    expect(fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n')).toHaveLength(1);
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
