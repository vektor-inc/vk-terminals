const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { getFreePort, launchApp } = require('./helpers/electron-app');

// PR #235 / issue #229: サイドバー／モバイルのタスク UI を、外部（vk-orchestrator）が書き出す
// 宣言 JSON（tasks-widget.json）を読んで描画する汎用ウィジェットビューアへ刷新したことの
// end-to-end 確認。旧 /api/tasks・tasks:set-* ではなく、新 widgetFile → widgets:update（IPC）／
// GET /api/widgets（モバイル）→ 共有レンダラ（widgetView.js）→ commands.jsonl 中継（widgets:command /
// POST /api/widgets/command）の経路を実 Electron 上で検証する。
//
// 既存の旧タスク仕様スペック（tasks-sidebar / tasks-status-actions / mobile-tasks / sidebar-task-link 等）は
// 旧 tasksFile（tasks-view.json）とタスク語彙にべったり依存しており、この刷新で陳腐化している。
// 本スペックは「新実装が正しく動くこと」を担保するために新規追加した（麗美 / e2e 担当）。

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function freshDate(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

function readCommands(commandsPath) {
  if (!fs.existsSync(commandsPath)) return [];
  const raw = fs.readFileSync(commandsPath, 'utf8').trim();
  if (!raw) return [];
  return raw.split('\n').map((line) => JSON.parse(line));
}

function expectApplyBatchCommand(command) {
  expect(command).toMatchObject({
    taskId: '301',
    action: 'apply-batch',
    ops: [
      {
        action: 'set-status',
        to: 'awaiting-approval',
        expected: 'in-progress',
      },
    ],
  });
  expect(command.ops).toHaveLength(1);
  expect(command.ops[0]).not.toHaveProperty('taskId');
  expect(typeof command.id).toBe('string');
  expect(command.id.length).toBeGreaterThan(0);
  expect(Number.isNaN(Date.parse(command.requestedAt))).toBe(false);
}

// GitHub モード（rel:"queue" の http(s) リンクを持つ）＋ viewer 判明＋編集可能な宣言を組み立てる。
// viewer=kurudrive、全アイテム assignee=kurudrive にして、既定フィルタ（自分のみ）でも表示される状態にする。
function buildWidget(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'task-list',
    lang: 'ja',
    updatedAt: freshDate(),
    viewer: 'kurudrive',
    staleThresholdMs: 120000,
    emptyText: 'タスクはありません',
    groups: [
      {
        id: 'in-progress',
        label: '実行中',
        tone: 'progress',
        order: 0,
        items: [
          {
            id: '301',
            title: '宣言ウィジェットの実行中タスク',
            assignee: 'kurudrive',
            updatedAt: freshDate(),
            editable: true,
            emphasis: 'attention',
            badges: [{ label: '高', tone: 'warning' }],
            links: [
              { rel: 'queue', url: 'https://github.com/vektor-inc/vk-orchestrator/issues/301', label: 'issue #301' },
              { rel: 'pr', url: 'https://github.com/vektor-inc/vk-terminals/pull/301', label: 'PR #301' },
            ],
            controls: [
              {
                type: 'select',
                field: 'status',
                label: 'ステータス',
                ariaLabel: 'ステータス',
                current: 'in-progress',
                options: [
                  { value: 'in-progress', label: '実行中' },
                  {
                    value: 'awaiting-approval',
                    label: '承認待ち',
                    command: { action: 'set-status', taskId: '301', to: 'awaiting-approval', expected: 'in-progress' },
                    confirm: { title: 'ステータスを「承認待ち」に変更しますか？', body: '再承認で二重起動につながる可能性があります。' },
                  },
                  { value: 'done', label: '完了', disabled: true, disabledReason: 'PR のマージが必要です' },
                ],
              },
            ],
          },
        ],
      },
    ],
    ...overrides,
  };
}

async function launchWidgetApp(port, config = {}) {
  return await launchApp({ port, prefix: 'vk-terminals-e2e-widget-decl-', config });
}

// このスペックは共通ヘルパーの closeApp を使わず、独自の強制終了付き後始末を使う。
// app.close() が返ってこないケース（widget watcher を抱えた状態での終了）に備えて
// 5 秒で SIGKILL へ切り替える措置を PR #249 から引き継いでいるため。
// 一時ディレクトリの削除は close の成否に関わらず finally で必ず行う。
async function closeAppForcefully({ app, tmpRoot }) {
  try {
    if (!app) return;
    const proc = app.process();
    const closePromise = app.close().then(() => true).catch(() => true);
    const closed = await Promise.race([
      closePromise,
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!closed && proc && !proc.killed) {
      proc.kill('SIGKILL');
    }
    if (!closed) {
      await Promise.race([
        closePromise,
        new Promise((resolve) => setTimeout(resolve, 1000)),
      ]);
    }
  } finally {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// ─── 1: サイドバー: 宣言を共有レンダラで描画し、バッジ・タイトルリンク・見出しリンク・フィルタを出す ───
test('サイドバー: widgetFile の宣言でグループ／アイテム／バッジ／タイトルリンク／見出しリンク／担当者フィルタを描画する', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-data-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  writeJson(widgetFile, buildWidget());

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });

    // グループ構造（tone 反映）とアイテムが描画される。
    const group = section.locator('.task-list-group[data-group-id="in-progress"]');
    await expect(group).toHaveAttribute('data-tone', 'progress');
    await expect(group.locator('.task-list-group-head')).toHaveCount(0);
    const item = section.locator('.task-item[data-id="301"]');
    await expect(item).toBeVisible();
    const itemTitleLink = item.locator('a.task-item-title');
    await expect(itemTitleLink.locator('.task-item-title-text')).toHaveText('宣言ウィジェットの実行中タスク');
    await expect(itemTitleLink).toHaveAttribute('role', 'link');
    await expect(itemTitleLink).toHaveAttribute('aria-label', '宣言ウィジェットの実行中タスク（外部ブラウザで開く）');
    await expect(itemTitleLink).toHaveAttribute('title', /https:\/\/github\.com\/vektor-inc\/vk-orchestrator\/issues\/301/m);
    // emphasis は意味属性として data-emphasis に載る。
    await expect(item).toHaveAttribute('data-emphasis', 'attention');

    // ステータス→優先度の順でバッジ（tone 付き）を出す。
    const badges = item.locator('.widget-badge');
    await expect(badges).toHaveText(['実行中', '高']);
    await expect(badges.nth(0)).toHaveAttribute('data-tone', 'progress');
    await expect(badges.nth(1)).toHaveAttribute('data-tone', 'warning');

    // queue はタイトルリンクへ移し、PR だけを a.widget-link で描画する。
    const links = item.locator('.task-item-links a.widget-link');
    await expect(links).toHaveCount(1);
    await expect(item.locator('a.widget-link[data-rel="queue"]')).toHaveCount(0);
    await expect(item.locator('a.widget-link[data-rel="pr"]')).toHaveAttribute('aria-label', /PR #301（外部ブラウザで開く）/);

    // GitHub モードでは見出し「タスク」が issue 一覧への外部リンクになる（末尾 /301 を落とす）。
    const titleLink = section.locator('.task-list-title-text a.task-list-title-link');
    await expect(titleLink).toHaveCount(1);
    await expect(titleLink).toHaveAttribute('aria-label', 'タスク一覧（外部ブラウザで開く）');
    await expect(titleLink).toHaveAttribute('title', /https:\/\/github\.com\/vektor-inc\/vk-orchestrator\/issues$/m);

    // viewer 判明＋GitHub モードなので担当者フィルタが表示され、既定は「自分のみ」。
    const filter = section.locator('.task-list-assignee-filter');
    await expect(filter).toBeVisible();
    await expect(filter).toHaveValue('self');

    // fresh なので stale 注記は出ない。
    await expect(section.locator('.task-list-stale')).toBeHidden();

    // editable なタスクは既定では select を畳み、編集ボタンだけを表示する。
    const editButton = item.locator('button.task-item-edit');
    await expect(editButton).toBeVisible();
    await expect(editButton).toHaveText('編集');
    await expect(editButton).toHaveAttribute('aria-expanded', 'false');
    await expect(editButton).toHaveAttribute('aria-controls', 'task-edit-panel-301');
    await expect(editButton).toHaveAttribute('aria-label', '「宣言ウィジェットの実行中タスク」を編集');
    await expect(item.locator('select[data-field="status"]')).toHaveCount(0);

    // 展開後のステータス select は現在値 in-progress。無効選択肢（done）は disabledReason を末尾ラベルへ併記する。
    await editButton.click();
    await expect(editButton).toHaveAttribute('aria-expanded', 'true');
    const panel = item.locator('.task-edit-panel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('button.task-edit-save')).toBeDisabled();
    const statusSelect = item.locator('select[data-field="status"]');
    await expect(statusSelect).toHaveValue('in-progress');
    const doneOption = statusSelect.locator('option[value="done"]');
    // option 要素の disabled は Playwright の toBeDisabled が拾いにくいため DOM プロパティで確認する。
    expect(await doneOption.evaluate((o) => o.disabled)).toBe(true);
    await expect(doneOption).toHaveText('完了（PR のマージが必要です）');
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 2: サイドバー: 編集パネルで下書き保存→確認→IPC widgets:command 経由で commands.jsonl に 1 行追記 ───
test('サイドバー: 編集パネルの保存で確認後 commands.jsonl に apply-batch を中継し反映待ちを表示する', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-cmd-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  const commandsPath = path.join(dataRoot, 'commands.jsonl');
  writeJson(widgetFile, buildWidget());

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const item = section.locator('.task-item[data-id="301"]');
    const editButton = item.locator('button.task-item-edit');
    await editButton.click();
    const panel = item.locator('.task-edit-panel');
    await expect(panel).toBeVisible();
    const statusSelect = item.locator('select[data-field="status"]');
    await expect(statusSelect).toHaveValue('in-progress');
    const saveButton = panel.locator('button.task-edit-save');
    await expect(saveButton).toBeDisabled();

    // select 変更は下書き更新だけ。confirm も送信もまだ発生しない。
    let unexpectedDialogs = 0;
    const unexpectedDialogHandler = async (dialog) => {
      unexpectedDialogs += 1;
      await dialog.dismiss();
    };
    win.on('dialog', unexpectedDialogHandler);
    await statusSelect.selectOption('awaiting-approval');
    win.off('dialog', unexpectedDialogHandler);
    expect(unexpectedDialogs).toBe(0);
    await expect(saveButton).toBeEnabled();
    expect(readCommands(commandsPath)).toHaveLength(0);

    // 保存クリック時に confirm が出る。承認すると apply-batch 1 行だけを送信する。
    let dialogMessage = '';
    win.once('dialog', async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.accept();
    });
    await saveButton.click();
    expect(dialogMessage).toContain('ステータスを「承認待ち」に変更しますか？');
    expect(dialogMessage).toContain('再承認で二重起動につながる可能性があります。');

    // 反映待ちが表示される。
    await expect(item.locator('.task-item-pending')).toHaveText('保存中…（反映待ち）');

    // commands.jsonl に apply-batch 1 行（id / requestedAt はビューアが採番）。
    await expect.poll(() => readCommands(commandsPath), { timeout: 5000 }).toHaveLength(1);
    const [command] = readCommands(commandsPath);
    expectApplyBatchCommand(command);
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 3: サイドバー: 保存確認をキャンセルすると送信せず下書きを保持し、編集キャンセルで破棄する ───
test('サイドバー: 保存確認をキャンセルすると commands.jsonl に追記せず下書きを保持する', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-cancel-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  const commandsPath = path.join(dataRoot, 'commands.jsonl');
  writeJson(widgetFile, buildWidget());

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile, commandsPath });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const item = section.locator('.task-item[data-id="301"]');
    const editButton = item.locator('button.task-item-edit');
    await editButton.click();
    const panel = item.locator('.task-edit-panel');
    await expect(panel).toBeVisible();
    const statusSelect = item.locator('select[data-field="status"]');
    await expect(statusSelect).toHaveValue('in-progress');

    await statusSelect.selectOption('awaiting-approval');
    await expect(panel.locator('button.task-edit-save')).toBeEnabled();

    // 保存確認をキャンセル（dismiss）する。下書きは保持され、送信は行われない。
    win.once('dialog', async (dialog) => { await dialog.dismiss(); });
    await panel.locator('button.task-edit-save').click();
    await expect(statusSelect).toHaveValue('awaiting-approval');
    await expect(item.locator('.task-edit-panel')).toBeVisible();
    await expect(item.locator('.task-item-pending')).toHaveCount(0);
    expect(readCommands(commandsPath)).toHaveLength(0);

    // 編集キャンセルで破棄確認を承認すると、下書きを捨ててパネルを畳む。
    let discardMessage = '';
    win.once('dialog', async (dialog) => {
      discardMessage = dialog.message();
      await dialog.accept();
    });
    await panel.locator('button.task-edit-cancel').click();
    expect(discardMessage).toContain('編集中の変更を破棄しますか？');
    await expect(item.locator('.task-edit-panel')).toHaveCount(0);
    await expect(editButton).toHaveAttribute('aria-expanded', 'false');
    await expect(item.locator('.task-item-pending')).toHaveCount(0);
    expect(readCommands(commandsPath)).toHaveLength(0);
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 4: サイドバー: 担当者フィルタ（GitHub モード）で自分のみ／全員を切り替えられる ───
test('サイドバー: 担当者フィルタで自分のみ／全員を切り替え、localStorage に保存する', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-filter-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  // viewer=kurudrive。自分担当と他人担当（wada）を混在させる。
  const widget = buildWidget();
  widget.groups[0].items.push({
    id: '302',
    title: '他人担当の実行中タスク',
    assignee: 'wada',
    updatedAt: freshDate(),
    editable: false,
    badges: [],
    links: [{ rel: 'queue', url: 'https://github.com/vektor-inc/vk-orchestrator/issues/302', label: 'issue #302' }],
    controls: [],
  });
  writeJson(widgetFile, widget);

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const filter = section.locator('.task-list-assignee-filter');
    await expect(filter).toBeVisible();
    await expect(filter).toHaveValue('self');

    // 既定「自分のみ」→ 自分担当だけ表示。
    await expect(section).toContainText('宣言ウィジェットの実行中タスク');
    await expect(section).not.toContainText('他人担当の実行中タスク');

    // 「全員」で両方表示、選択は localStorage に保存される。
    await filter.selectOption('all');
    await expect(section).toContainText('他人担当の実行中タスク');
    const stored = await win.evaluate(() => localStorage.getItem('vkt.taskAssigneeFilter'));
    expect(stored).toBe('all');

    // 特定担当者（wada）に切り替えると wada 担当のみ。
    await filter.selectOption('wada');
    await expect(section).toContainText('他人担当の実行中タスク');
    await expect(section).not.toContainText('宣言ウィジェットの実行中タスク');
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 5: legacyNotice: 旧 tasksFile のみ設定（widgetFile 無し）→ 後方互換注記を出す ───
test('サイドバー: 旧 tasksFile のみ設定時はタスク語彙を復活させず後方互換注記を表示する', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-legacy-'));
  const tasksFile = path.join(dataRoot, 'tasks-view.json');
  // 旧フォーマットのファイルが存在するだけで legacyNotice が立つ（中身の語彙は描画しない）。
  writeJson(tasksFile, { updatedAt: freshDate(), tasks: [{ id: 1, title: '旧タスク', status: 'ready' }] });

  const { app, win, tmpRoot } = await launchWidgetApp(port, { tasksFile });
  try {
    await win.waitForSelector('#task-list', { state: 'attached' });
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });

    // 後方互換注記（data-kind="legacy"）が出て、旧タスクの語彙（タイトル）は描画されない。
    const notice = section.locator('.task-list-stale');
    await expect(notice).toBeVisible();
    await expect(notice).toHaveAttribute('data-kind', 'legacy');
    await expect(section).not.toContainText('旧タスク');
    await expect(section.locator('.task-item')).toHaveCount(0);
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 6: モバイル: GET /api/widgets 描画と POST /api/widgets/command 中継 ───
test('モバイル: /api/widgets の宣言を描画し、ステータス変更を POST /api/widgets/command で中継する', async ({ page }) => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-mobile-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  const commandsPath = path.join(dataRoot, 'commands.jsonl');
  writeJson(widgetFile, buildWidget());

  const { app, tmpRoot } = await launchWidgetApp(port, { widgetFile, commandsPath });
  try {
    const base = `http://127.0.0.1:${port}`;

    // GET /api/widgets は中継ペイロード（widget / legacyNotice / commandsConfigured）を返す。
    await expect.poll(async () => {
      try {
        const res = await fetch(`${base}/api/widgets`);
        if (res.status !== 200) return null;
        return await res.json();
      } catch (_e) { return null; }
    }, { timeout: 20_000 }).not.toBeNull();

    const payload = await (await fetch(`${base}/api/widgets`)).json();
    expect(payload.widget).not.toBeNull();
    expect(payload.widget.kind).toBe('task-list');
    expect(payload.commandsConfigured).toBe(true);

    // モバイルページを開き、共有レンダラで描画される（poll 2 秒周期）。
    await page.goto(`${base}/`);
    const item = page.locator('.task-item[data-id="301"]');
    await expect(item).toBeVisible({ timeout: 10_000 });
    await expect(item.locator('.task-item-title-text')).toHaveText('宣言ウィジェットの実行中タスク');

    // ステータス変更は編集パネル内の下書き更新だけ。保存時に confirm 承認→POST 経由で commands.jsonl へ追記。
    const editButton = item.locator('button.task-item-edit');
    await editButton.click();
    const panel = item.locator('.task-edit-panel');
    await expect(panel).toBeVisible();
    const statusSelect = item.locator('select[data-field="status"]');
    const saveButton = panel.locator('button.task-edit-save');
    await expect(saveButton).toBeDisabled();
    await statusSelect.selectOption('awaiting-approval');
    await expect(saveButton).toBeEnabled();
    expect(readCommands(commandsPath)).toHaveLength(0);

    let dialogMessage = '';
    page.once('dialog', async (dialog) => {
      dialogMessage = dialog.message();
      await dialog.accept();
    });
    await saveButton.click();
    expect(dialogMessage).toContain('ステータスを「承認待ち」に変更しますか？');

    await expect(item.locator('.task-item-pending')).toHaveText('保存中…（反映待ち）');
    await expect.poll(() => readCommands(commandsPath), { timeout: 5000 }).toHaveLength(1);
    const [command] = readCommands(commandsPath);
    expectApplyBatchCommand(command);

    // 直接 POST でも 200 / ok:true で中継される（CSRF 同一 Origin）。
    const direct = await fetch(`${base}/api/widgets/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ action: 'set-status', taskId: '301', to: 'awaiting-approval', expected: 'in-progress' }),
    });
    expect(direct.status).toBe(200);
    expect((await direct.json()).ok).toBe(true);

    // 異なる Origin は CSRF ガードで 403。
    const csrf = await fetch(`${base}/api/widgets/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'http://example.test' },
      body: JSON.stringify({ action: 'set-status', taskId: '301', to: 'awaiting-approval', expected: 'in-progress' }),
    });
    expect(csrf.status).toBe(403);
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 以下は旧タスク UI スペック（tasks-sidebar / sidebar-task-link 等）から、新 widget モデルでも
//     有効な観点だけを移植したもの。旧スペックは陳腐化のため削除し、ここへ集約する。 ───

// ローカルモード用の宣言（rel:"queue" リンク無し＝GitHub モードでない、viewer 不明）。
function buildLocalWidget(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'task-list',
    lang: 'ja',
    updatedAt: freshDate(),
    viewer: null,
    staleThresholdMs: 120000,
    emptyText: 'タスクはありません',
    groups: [
      {
        id: 'ready',
        label: '実行待ち',
        tone: 'info',
        order: 0,
        items: [
          {
            id: '401',
            title: 'ローカルモードのタスク',
            updatedAt: freshDate(),
            editable: false,
            badges: [],
            links: [],
            controls: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ─── 7: ローカルモード: 担当者フィルタ非表示・見出しはプレーンテキスト（旧 sidebar-task-list-title-link 相当） ───
test('サイドバー: ローカルモード（queue リンク無し／viewer 不明）では担当者フィルタを出さず見出しもリンク化しない', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-local-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  writeJson(widgetFile, buildLocalWidget());

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    // アイテムは描画される。
    await expect(section.locator('.task-item[data-id="401"] .task-item-title')).toHaveText('ローカルモードのタスク');
    await expect(section.locator('.task-item[data-id="401"] a.task-item-title')).toHaveCount(0);
    // GitHub モードでないので担当者フィルタは非表示。
    await expect(section.locator('.task-list-assignee-filter')).toBeHidden();
    // 見出しはリンク化されずプレーンテキスト「タスク」。
    await expect(section.locator('.task-list-title-text a.task-list-title-link')).toHaveCount(0);
    await expect(section.locator('.task-list-title-text')).toHaveText('タスク');
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 8: self フィルタで自分の担当が無いとき self 用の空文言を出す（旧 tasks-sidebar 相当） ───
test('サイドバー: GitHub モードで自分に割り当てが無い場合は self 用の空文言を表示する', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-selfempty-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  // viewer=kurudrive だが唯一のアイテムは他人（wada）担当にする。既定フィルタ（自分のみ）で 0 件。
  const widget = buildWidget();
  widget.groups[0].items[0].assignee = 'wada';
  writeJson(widgetFile, widget);

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const filter = section.locator('.task-list-assignee-filter');
    await expect(filter).toBeVisible();
    await expect(filter).toHaveValue('self');
    // 自分担当が無いので self 用の空文言、アイテムは非表示。
    await expect(section.locator('.task-list-empty')).toHaveText('自分に割り当てられたタスクはありません');
    await expect(section.locator('.task-item[data-id="301"]')).toHaveCount(0);
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 9: コールド起動で updatedAt が古い（stale）ときはセクションを表示しない（旧 tasks-sidebar 相当） ───
test('サイドバー: コールド起動で widget の updatedAt が古い場合はセクションを表示しない', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-coldstale-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  // updatedAt を staleThreshold(120s) より十分過去にする。新鮮な view を一度も見ていないので非表示。
  writeJson(widgetFile, buildWidget({ updatedAt: freshDate(-5 * 60 * 1000) }));

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile });
  try {
    await win.waitForSelector('#task-list', { state: 'attached' });
    const section = win.locator('#task-list');
    await expect(section).toBeHidden();
    await expect(section).not.toContainText('宣言ウィジェットの実行中タスク');
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 10: fresh 表示後に stale 化したら「Orchestrator 停止中」を出す（旧 tasks-sidebar 相当） ───
test('サイドバー: fresh 表示後に widget が stale 化した場合は Orchestrator 停止中を表示する', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-stalelatch-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  writeJson(widgetFile, buildWidget());

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section.locator('.task-list-stale')).toBeHidden();

    // fresh でラッチを立てた後、updatedAt だけを十分過去にして watcher から stale な宣言を push させる。
    writeJson(widgetFile, buildWidget({ updatedAt: freshDate(-5 * 60 * 1000) }));
    const notice = section.locator('.task-list-stale');
    await expect(notice).toBeVisible({ timeout: 10_000 });
    await expect(notice).toHaveText('Orchestrator 停止中');
    await expect(notice).toHaveAttribute('data-kind', 'stale');
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 11: widgetFile 未設定（かつ legacy も無し）ならセクションを表示しない（旧 tasks-sidebar 相当） ───
test('サイドバー: widgetFile 未設定かつ legacy 無しならセクションを表示しない', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchWidgetApp(port, {});
  try {
    await win.waitForSelector('#task-list', { state: 'attached' });
    const section = win.locator('#task-list');
    await expect(section).toBeHidden();
  } finally {
    await closeAppForcefully({ app, tmpRoot });
  }
});

// ─── 12: 折り畳みトグルで一覧を開閉し、状態を localStorage に保存する（旧 tasks-sidebar 相当） ───
test('サイドバー: 右端トグルで一覧を折り畳み・展開でき、状態が localStorage に保存される', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-collapse-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  writeJson(widgetFile, buildWidget());

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const toggle = section.locator('.sidebar-section-toggle');
    const body = section.locator('.task-list-body');

    // 初期は展開。
    await expect(body).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');

    // クリックで折り畳み。見出し（タスク）は残り本体だけ隠れ、localStorage に保存される。
    await toggle.click();
    await expect(body).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(section).toContainText('タスク');
    expect(await win.evaluate(() => JSON.parse(
      localStorage.getItem('vkt.sidebarSectionsCollapsed')
    )['task-list'])).toBe(true);

    // 再クリックで展開に戻る。
    await toggle.click();
    await expect(body).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(await win.evaluate(() => JSON.parse(
      localStorage.getItem('vkt.sidebarSectionsCollapsed')
    )['task-list'])).toBe(false);
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});

// ─── 13: 長いメニュー見出しでも下限幅でトグルを可視・操作可能に保つ ───
test('サイドバー: 長いメニュー見出しは 200px 幅で省略し、トグルを可視領域内に保つ', async () => {
  const port = await getFreePort();
  const longTitle = 'これは二十文字を超えるとても長い外部連携メニューの見出しです';
  const menuItems = [
    {
      title: longTitle,
      items: [
        {
          id: 'long-title-item',
          label: '長い見出しの項目',
          icon: '🧪',
          action: { type: 'open-settings' },
        },
      ],
    },
  ];
  const { app, win, tmpRoot } = await launchWidgetApp(port, { menuItems });
  const sidebar = win.locator('#sidebar');
  let originalWidth = null;
  try {
    const menuInner = win.locator('.sidebar-menu-inner');
    const section = menuInner.locator('.sidebar-section-card').filter({ hasText: longTitle });
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section).toHaveAttribute('id', 'sidebar-menu-section-config-0');
    await expect(section.locator('.sidebar-section-label')).toHaveAttribute('title', longTitle);

    // title を持たない組み込み「設定」は、カードや見出しを足さず直下のプレーン ul に保つ。
    const plainList = menuInner.locator(':scope > .sidebar-menu-list').filter({ hasText: '設定' });
    await expect(plainList).toHaveCount(1);
    await expect(menuInner.getByText('メニュー', { exact: true })).toHaveCount(0);

    originalWidth = await sidebar.evaluate((element) => ({
      value: element.style.getPropertyValue('--vktm-sidebar-width'),
      priority: element.style.getPropertyPriority('--vktm-sidebar-width'),
    }));
    await sidebar.evaluate((element) => {
      element.style.setProperty('--vktm-sidebar-width', '200px');
    });

    const toggle = section.locator('.sidebar-section-toggle');
    await expect(toggle).toBeVisible();
    const sidebarMenu = win.locator('.sidebar-menu');
    const bounds = await Promise.all([
      sidebarMenu.evaluate((element) => element.getBoundingClientRect().toJSON()),
      toggle.evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    expect(bounds[1].left).toBeGreaterThanOrEqual(bounds[0].left);
    expect(bounds[1].right).toBeLessThanOrEqual(bounds[0].right);
    expect(bounds[1].top).toBeGreaterThanOrEqual(bounds[0].top);
    expect(bounds[1].bottom).toBeLessThanOrEqual(bounds[0].bottom);

    // カード内と無題リスト内で、実際に見える項目のアイコン列を揃える。
    const itemIconBounds = await Promise.all([
      section.locator('.sidebar-menu-icon').first().evaluate((element) => element.getBoundingClientRect().toJSON()),
      plainList.locator('.sidebar-menu-icon').first().evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    // カードだけが持つ 1px の border 分は、視覚上無視できる許容差とする。
    expect(Math.abs(itemIconBounds[1].left - itemIconBounds[0].left)).toBeLessThanOrEqual(1);

    await toggle.click();
    await expect(section.locator('.sidebar-section-body')).toBeHidden();
    expect(await win.evaluate(() => JSON.parse(
      localStorage.getItem('vkt.sidebarSectionsCollapsed')
    )['sidebar-menu-section-config-0'])).toBe(true);
  } finally {
    if (originalWidth) {
      await sidebar.evaluate((element, previous) => {
        if (previous.value) {
          element.style.setProperty('--vktm-sidebar-width', previous.value, previous.priority);
        } else {
          element.style.removeProperty('--vktm-sidebar-width');
        }
      }, originalWidth).catch(() => {});
    }
    await closeAppForcefully({ app, tmpRoot });
  }
});

// ─── 14: 担当者フィルタ表示時も下限幅でラベルとトグルを保つ ───
test('サイドバー: 200px 幅で担当者フィルタ表示時もタスク見出しとトグルを可視・操作可能に保つ', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-widget-decl-narrow-filter-'));
  const widgetFile = path.join(dataRoot, 'tasks-widget.json');
  writeJson(widgetFile, buildWidget());

  const { app, win, tmpRoot } = await launchWidgetApp(port, { widgetFile });
  try {
    const sidebar = win.locator('#sidebar');
    const sidebarMenu = win.locator('.sidebar-menu');
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await sidebar.evaluate((element) => {
      element.style.setProperty('--vktm-sidebar-width', '200px');
    });

    const label = section.locator('.sidebar-section-label');
    const filter = section.locator('.task-list-assignee-filter');
    const toggle = section.locator('.sidebar-section-toggle');
    await expect(label).toContainText('タスク');
    await expect(label).not.toHaveAttribute('title', /.+/);
    await expect(filter).toBeVisible();
    await expect(toggle).toBeVisible();

    const bounds = await Promise.all([
      sidebarMenu.evaluate((element) => element.getBoundingClientRect().toJSON()),
      label.evaluate((element) => element.getBoundingClientRect().toJSON()),
      filter.evaluate((element) => element.getBoundingClientRect().toJSON()),
      toggle.evaluate((element) => element.getBoundingClientRect().toJSON()),
    ]);
    for (const controlBounds of bounds.slice(1)) {
      expect(controlBounds.left).toBeGreaterThanOrEqual(bounds[0].left);
      expect(controlBounds.right).toBeLessThanOrEqual(bounds[0].right);
    }
    expect(bounds[1].width).toBeGreaterThanOrEqual(48);

    await toggle.click();
    await expect(section.locator('.sidebar-section-body')).toBeHidden();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  } finally {
    await closeAppForcefully({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  }
});
