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

// 編集パネル内の select に値をセットして change を発火し、ドラフトへ反映させる。
async function setSelectValue(select, value) {
  await select.evaluate((el, nextValue) => {
    el.value = nextValue;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

// 「保存」クリックで確認ダイアログが出る操作用。ダイアログ文言を返し、accept/dismiss を選べる。
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

// タスク項目の「編集」ボタンを押して編集パネルを開く。
async function openTaskEditPanel(task) {
  const editButton = task.locator('button[data-task-control="edit-toggle"]');
  await editButton.click();
  await expect(editButton).toHaveAttribute('aria-expanded', 'true');
  return task.locator('.task-edit-panel');
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

test('モバイル UI: 編集パネルのステータス変更で確認キャンセルと反映待ちを検証する', async ({ page }) => {
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

    // ステータスはラベル表示になり、初期状態では編集パネルは閉じている（PC 同型）。
    await expect(task.locator('.task-status-label')).toHaveText('マージ待ち');
    await expect(task.locator('.task-edit-panel')).toHaveCount(0);

    // 「編集」ボタンでパネルを展開する（テスト観点 a）。
    const panel = await openTaskEditPanel(task);
    await expect(panel).toBeVisible();
    const statusSelect = panel.locator('select[data-task-control="status-select"]');
    await expect(statusSelect).toHaveValue('waiting-merge');

    // 全ステータスを同じ順で描画し、API が返す actions だけで disabled を決める。
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

    const saveButton = panel.locator('button[data-task-control="edit-save"]');

    // 危険遷移（マージ待ち→完了）は保存時に確認ダイアログでガードされる。キャンセルすると送信しない。
    await setSelectValue(statusSelect, 'done');
    const cancelMessage = await clickWithDialog(page, saveButton, false);
    expect(cancelMessage).toContain('ステータスを「完了」に変更しますか？');
    expect(cancelMessage).toContain('PR のマージは行われません（PR は開いたまま残ります）。');
    expect(fs.existsSync(commandsPath)).toBe(false);
    // ダイアログをキャンセルしてもパネルは開いたまま。
    await expect(panel).toBeVisible();

    // 確認を承認すると set-status が commands.jsonl に追記され、反映待ちが表示される（観点 b）。
    const acceptMessage = await clickWithDialog(page, saveButton, true);
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

test('モバイル UI: 編集パネルで優先度・実行方式・複数項目の保存と契約有無を検証する', async ({ page }) => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-mobile-tasks-editor-data-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      // priority=null（契約あり）。複数項目同時変更と expected="none" の検証に使う。
      {
        id: '401',
        title: '優先度なしの承認待ちタスク',
        status: 'awaiting-approval',
        assignee: 'wada',
        priority: null,
        sequential: false,
        createdAt: freshDate(-10 * 60 * 1000),
      },
      // priority=low（契約あり）。優先度のみ変更の検証に使う。
      {
        id: '402',
        title: '優先度ありの実行待ちタスク',
        status: 'ready',
        priority: 'low',
        sequential: false,
      },
      // sequential 変更の検証に使う。
      {
        id: '403',
        title: '実行方式を変える実行待ちタスク',
        status: 'ready',
        priority: 'high',
        sequential: false,
      },
      // priority プロパティ欠如（契約なし）。優先度・実行方式エディタが出ないことを検証。
      {
        id: '404',
        title: '優先度契約のない実行中タスク',
        status: 'in-progress',
        assignee: 'tsukasa',
      },
      // 編集不可ステータス（done）。編集ボタンが出ないことを検証。
      {
        id: '405',
        title: '完了済みで編集できないタスク',
        status: 'done',
        priority: 'medium',
        sequential: true,
      },
    ],
  });

  const { app, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    await waitForTasks(port);
    await page.goto(`http://127.0.0.1:${port}/`);

    const taskA = page.locator('.task-item').filter({ hasText: '優先度なしの承認待ちタスク' });
    await expect(taskA).toBeVisible({ timeout: 10_000 });

    // 観点 h: 編集不可ステータス（done）のタスクには編集ボタンが出ない。
    const taskDone = page.locator('.task-item').filter({ hasText: '完了済みで編集できないタスク' });
    await expect(taskDone.locator('button[data-task-control="edit-toggle"]')).toHaveCount(0);

    // 観点 g: priority 契約のないタスクは編集ボタンは出るが、優先度・実行方式エディタは出ない。
    const taskNoContract = page.locator('.task-item').filter({ hasText: '優先度契約のない実行中タスク' });
    const panelNoContract = await openTaskEditPanel(taskNoContract);
    await expect(panelNoContract.locator('select[data-task-control="status-select"]')).toHaveCount(1);
    await expect(panelNoContract.locator('select[data-task-control="priority-select"]')).toHaveCount(0);
    await expect(panelNoContract.locator('[data-task-control="sequential-segment"]')).toHaveCount(0);

    // 観点 e + i: priority=null のタスクで、ステータス・優先度・実行方式を同時に変更して保存する。
    const panelA = await openTaskEditPanel(taskA);
    await setSelectValue(panelA.locator('select[data-task-control="status-select"]'), 'ready');
    await setSelectValue(panelA.locator('select[data-task-control="priority-select"]'), 'high');
    await panelA.locator('button[data-task-control="sequential-segment"][data-value="sequential"]').click();
    // awaiting-approval→ready は確認ダイアログなし。保存で 3 件が順に送られる。
    await panelA.locator('button[data-task-control="edit-save"]').click();
    await expect(taskA.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect
      .poll(() => (fs.existsSync(commandsPath) ? fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n').length : 0), { timeout: 5000 })
      .toBe(3);
    const multi = fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(multi[0]).toMatchObject({ taskId: 401, action: 'set-status', to: 'ready', expected: 'awaiting-approval' });
    // 観点 e: priority=null のタスクは expected="none" で送られる。
    expect(multi[1]).toMatchObject({ taskId: 401, action: 'set-priority', to: 'high', expected: 'none' });
    expect(multi[2]).toMatchObject({ taskId: 401, action: 'set-sequential', to: 'sequential', expected: 'parallel' });

    // 観点 c: 優先度だけを変更して保存すると set-priority だけが送られる。
    const taskB = page.locator('.task-item').filter({ hasText: '優先度ありの実行待ちタスク' });
    const panelB = await openTaskEditPanel(taskB);
    await setSelectValue(panelB.locator('select[data-task-control="priority-select"]'), 'high');
    await panelB.locator('button[data-task-control="edit-save"]').click();
    await expect(taskB.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect
      .poll(() => fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n').length, { timeout: 5000 })
      .toBe(4);
    const afterB = fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(afterB[3]).toMatchObject({ taskId: 402, action: 'set-priority', to: 'high', expected: 'low' });

    // 観点 d: 実行方式だけを変更して保存すると set-sequential だけが送られる。
    const taskC = page.locator('.task-item').filter({ hasText: '実行方式を変える実行待ちタスク' });
    const panelC = await openTaskEditPanel(taskC);
    await panelC.locator('button[data-task-control="sequential-segment"][data-value="sequential"]').click();
    await panelC.locator('button[data-task-control="edit-save"]').click();
    await expect(taskC.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect
      .poll(() => fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n').length, { timeout: 5000 })
      .toBe(5);
    const afterC = fs.readFileSync(commandsPath, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l));
    expect(afterC[4]).toMatchObject({ taskId: 403, action: 'set-sequential', to: 'sequential', expected: 'parallel' });
  } finally {
    if (app) await app.close();
    fs.rmSync(appTmpRoot, { recursive: true, force: true });
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('モバイル UI: 反映待ちが新しい view の到着で解除される（pending 一般化の回帰確認）', async ({ page }) => {
  const port = await getFreePort();
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-mobile-tasks-pending-data-'));
  const tasksFile = path.join(tmpRoot, 'tasks-view.json');
  const commandsPath = path.join(tmpRoot, 'commands.jsonl');
  // priority だけを変える。status は変わらないため、旧モデルでは pending が永久に残る（地雷）。
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: '501',
        title: '優先度だけ変える実行待ちタスク',
        status: 'ready',
        priority: 'low',
        sequential: false,
      },
    ],
  });

  const { app, tmpRoot: appTmpRoot } = await launchApp(port, { tasksFile, commandsPath });
  try {
    await waitForTasks(port);
    await page.goto(`http://127.0.0.1:${port}/`);
    const task = page.locator('.task-item').filter({ hasText: '優先度だけ変える実行待ちタスク' });
    await expect(task).toBeVisible({ timeout: 10_000 });

    const panel = await openTaskEditPanel(task);
    await setSelectValue(panel.locator('select[data-task-control="priority-select"]'), 'high');
    await panel.locator('button[data-task-control="edit-save"]').click();

    // 送信直後は反映待ちが表示される。
    await expect(task.locator('.task-item-pending')).toHaveText('反映待ち');
    await expect
      .poll(() => (fs.existsSync(commandsPath) ? fs.readFileSync(commandsPath, 'utf8') : ''), { timeout: 5000 })
      .not.toBe('');

    // 新しい view（priority=high 反映済み）が届くと、status 非依存で pending が解除される。
    writeJson(tasksFile, {
      updatedAt: freshDate(),
      tasks: [
        {
          id: '501',
          title: '優先度だけ変える実行待ちタスク',
          status: 'ready',
          priority: 'high',
          sequential: false,
        },
      ],
    });

    // ポーリング（2秒間隔）で新 view を取得し、反映待ちが消えることを確認する。
    await expect(task.locator('.task-item-pending')).toHaveCount(0, { timeout: 15_000 });
    // 優先度バッジも高に更新されている。
    await expect(task.locator('.task-priority-badge')).toHaveText('高');
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
