const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { getFreePort, launchApp, closeApp } = require('./helpers/electron-app');

// issue #617: サイドバーのタスク一覧の見出し行に置いた再取得ボタンの end-to-end 確認。
// tasks-widget.json の最上位に refreshCommand があるときだけボタンを出し、押すと
// commands.jsonl へ { id, action:"refresh-tasks", requestedAt } を 1 行追記する。
// 押した時刻より新しい updatedAt の一覧が届くまでは取得中（aria-busy）で、連打しても追記は 1 行のみ。
//
// 起動は 1 回に共有し、各テストの先頭で widgetFile を書き換えて /api/widgets へ反映されたことを
// 確かめてから reload する（widget-declarative.smoke.spec.js と同じ待ち方）。

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

// GitHub モード（rel:"queue" リンクあり・viewer 判明）の宣言。担当者プルダウンが出る。
function buildGithubWidget(overrides = {}) {
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
            title: '再取得ボタン確認用のタスク',
            assignee: 'kurudrive',
            updatedAt: freshDate(),
            editable: false,
            badges: [],
            links: [{ rel: 'queue', url: 'https://github.com/vektor-inc/task-queue/issues/301', label: 'issue #301' }],
            controls: [],
          },
        ],
      },
    ],
    ...overrides,
  };
}

// ローカルキュー運用の宣言（queue リンク無し・viewer 不明）。担当者プルダウンは出ない。
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
          { id: '401', title: 'ローカルのタスク', updatedAt: freshDate(), editable: false, badges: [], links: [], controls: [] },
        ],
      },
    ],
    ...overrides,
  };
}

// widgetFile を書き換え、GET /api/widgets がその updatedAt を返すまで待つ。
async function waitWidgetReflected(port, widgetFile, widget) {
  writeJson(widgetFile, widget);
  const deadline = Date.now() + 20_000;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/widgets`);
      if (res.status === 200) {
        last = await res.json();
        if (last?.widget?.updatedAt === widget.updatedAt) return;
      }
    } catch (_e) {
      // 起動直後の失敗は同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`widgetFile の更新が /api/widgets へ反映されなかった: ${JSON.stringify(last)}`);
}

// 宣言を差し替えて再読み込みし、commands.jsonl を空にした状態から始める。
async function setupWidget(win, port, widgetFile, widget, commandsPath) {
  await waitWidgetReflected(port, widgetFile, widget);
  if (fs.existsSync(commandsPath)) fs.rmSync(commandsPath);
  await win.evaluate(() => localStorage.clear());
  await win.reload();
  await win.waitForSelector('#sidebar', { state: 'attached' });
  await expect(win.locator('#task-list')).toBeVisible({ timeout: 10_000 });
}

test.describe.serial('タスク一覧の再取得ボタン（issue #617）', () => {
  let app;
  let win;
  let tmpRoot;
  let port;
  let dataRoot;
  let widgetFile;
  let commandsPath;

  test.beforeAll(async () => {
    port = await getFreePort();
    dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-task-refresh-'));
    widgetFile = path.join(dataRoot, 'tasks-widget.json');
    commandsPath = path.join(dataRoot, 'commands.jsonl');
    writeJson(widgetFile, buildGithubWidget());
    ({ app, win, tmpRoot } = await launchApp({ port, prefix: 'vk-terminals-e2e-task-refresh-app-', config: { widgetFile, commandsPath } }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
    fs.rmSync(dataRoot, { recursive: true, force: true });
  });

  test('refreshCommand が無い宣言ではボタンを出さない', async () => {
    await setupWidget(win, port, widgetFile, buildGithubWidget(), commandsPath);
    const section = win.locator('#task-list');
    await expect(section.locator('.task-list-assignee-filter')).toBeVisible();
    await expect(section.locator('button.task-list-refresh')).toBeHidden();
  });

  test('refreshCommand があると担当者プルダウンのすぐ左に、名前とツールチップ付きで出す', async () => {
    await setupWidget(win, port, widgetFile, buildGithubWidget({ refreshCommand: { action: 'refresh-tasks' } }), commandsPath);
    const section = win.locator('#task-list');
    const button = section.locator('.sidebar-section-header button.task-list-refresh');
    const filter = section.locator('.task-list-assignee-filter');
    await expect(button).toBeVisible();
    await expect(button).toHaveAccessibleName('タスクを今すぐ再取得');
    await expect(button).toHaveAttribute('title', 'タスクを今すぐ再取得');
    await expect(button).toHaveAttribute('type', 'button');
    // DOM 上でプルダウンの直前にあり、見た目でも左に並ぶ。
    // 再取得ボタンが出ているときだけ、担当者プルダウンの最大幅からその分を差し引く。
    const filterMaxWidth = () => filter.evaluate((el) => getComputedStyle(el).maxWidth);
    const withButton = await filterMaxWidth();
    await button.evaluate((el) => { el.hidden = true; });
    const withoutButton = await filterMaxWidth();
    await button.evaluate((el) => { el.hidden = false; });
    expect(withButton).not.toBe(withoutButton);
    const nextIsFilter = await button.evaluate((el) => el.nextElementSibling?.classList.contains('task-list-assignee-filter'));
    expect(nextIsFilter).toBe(true);
    const buttonBox = await button.boundingBox();
    const filterBox = await filter.boundingBox();
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(filterBox.x);
    expect(Math.abs((buttonBox.y + buttonBox.height / 2) - (filterBox.y + filterBox.height / 2))).toBeLessThanOrEqual(1);
  });

  test('200px 幅でも見出し・再取得ボタン・プルダウン・開閉ボタンが 1 行でサイドバー内に収まる', async () => {
    await setupWidget(win, port, widgetFile, buildGithubWidget({ refreshCommand: { action: 'refresh-tasks' } }), commandsPath);
    const sidebar = win.locator('#sidebar');
    const header = win.locator('#task-list .sidebar-section-header');
    const original = await sidebar.evaluate((el) => el.style.getPropertyValue('--vktm-sidebar-width'));
    try {
      await sidebar.evaluate((el) => el.style.setProperty('--vktm-sidebar-width', '200px'));
      await expect(header.locator('button.task-list-refresh')).toBeVisible();
      const rects = await header.evaluate((el) => {
        const menu = document.querySelector('.sidebar-menu').getBoundingClientRect();
        const pick = (sel) => el.querySelector(sel).getBoundingClientRect().toJSON();
        return {
          menu: menu.toJSON(),
          label: pick('.sidebar-section-label'),
          controls: ['.task-list-refresh', '.task-list-assignee-filter', '.sidebar-section-toggle'].map(pick),
        };
      });
      expect(rects.label.width).toBeGreaterThanOrEqual(48);
      for (const r of [rects.label, ...rects.controls]) {
        expect(r.left).toBeGreaterThanOrEqual(rects.menu.left);
        expect(r.right).toBeLessThanOrEqual(rects.menu.right);
        // 折り返さず、見出しラベルと同じ行に並ぶ。
        expect(Math.abs((r.top + r.height / 2) - (rects.label.top + rects.label.height / 2))).toBeLessThanOrEqual(1);
      }
    } finally {
      await sidebar.evaluate((el, value) => {
        if (value) el.style.setProperty('--vktm-sidebar-width', value);
        else el.style.removeProperty('--vktm-sidebar-width');
      }, original);
    }
  });

  test('担当者プルダウンが出ないローカル運用でも見出し行の右側に出す', async () => {
    await setupWidget(win, port, widgetFile, buildLocalWidget({ refreshCommand: { action: 'refresh-tasks' } }), commandsPath);
    const section = win.locator('#task-list');
    const header = section.locator('.sidebar-section-header');
    const button = header.locator('button.task-list-refresh');
    await expect(section.locator('.task-list-assignee-filter')).toBeHidden();
    await expect(button).toBeVisible();
    // 見出しラベルより右、開閉ボタンの左に並ぶ。
    const labelBox = await header.locator('.task-list-title-text').boundingBox();
    const toggleBox = await header.locator('.sidebar-section-toggle').boundingBox();
    const buttonBox = await button.boundingBox();
    expect(buttonBox.x).toBeGreaterThan(labelBox.x + labelBox.width);
    expect(buttonBox.x + buttonBox.width).toBeLessThanOrEqual(toggleBox.x);
  });

  test('押すと commands.jsonl に依頼を 1 行書き、取得中は連打しても増えず、新しい一覧で解除される', async () => {
    await setupWidget(win, port, widgetFile, buildGithubWidget({ refreshCommand: { action: 'refresh-tasks' } }), commandsPath);
    const button = win.locator('#task-list button.task-list-refresh');
    await expect(button).toBeVisible();
    await expect(button).toHaveAttribute('aria-busy', 'false');

    const before = Date.now();
    await button.click();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toHaveAttribute('aria-disabled', 'true');
    // 取得中は読み上げ名とツールチップを同じ文言に切り替える。
    await expect(button).toHaveAccessibleName('タスクを再取得しています');
    await expect(button).toHaveAttribute('title', 'タスクを再取得しています');
    // 押した直後もフォーカスはボタンに残る（disabled にしていない）。
    await expect(button).toBeFocused();
    // 押せない間はホバーしても明るくならない。
    await button.hover({ force: true });
    const hoverStyle = await button.evaluate((el) => {
      const style = getComputedStyle(el);
      return { matches: el.matches(':hover'), background: style.backgroundColor, color: style.color };
    });
    expect(hoverStyle).toEqual({ matches: true, background: 'rgba(0, 0, 0, 0)', color: 'rgb(139, 148, 158)' });

    await expect.poll(() => readCommands(commandsPath).length).toBe(1);
    const [line] = readCommands(commandsPath);
    expect(Object.keys(line).sort()).toEqual(['action', 'id', 'requestedAt']);
    expect(line.action).toBe('refresh-tasks');
    expect(line.id).toMatch(/^refresh-.+/);
    const requestedAtMs = Date.parse(line.requestedAt);
    expect(Number.isNaN(requestedAtMs)).toBe(false);
    expect(requestedAtMs).toBeGreaterThanOrEqual(before - 1000);

    // 取得中の連打（マウス・キーボード）は追記しない。aria-disabled のボタンは Playwright が
    // 押せない扱いにするため、force で実際にクリックを届ける。
    await expect(button).toBeDisabled();
    await button.click({ force: true });
    await button.click({ force: true });
    await win.keyboard.press('Enter');
    await win.keyboard.press('Space');
    await win.waitForTimeout(500);
    expect(readCommands(commandsPath)).toHaveLength(1);

    // 押した時刻より古い updatedAt の一覧では解除しない。
    await waitWidgetReflected(port, widgetFile, buildGithubWidget({ refreshCommand: { action: 'refresh-tasks' }, updatedAt: new Date(before - 60_000).toISOString() }));
    await win.waitForTimeout(300);
    await expect(button).toHaveAttribute('aria-busy', 'true');

    // 押した時刻より新しい updatedAt の一覧が届くと解除する。
    await waitWidgetReflected(port, widgetFile, buildGithubWidget({ refreshCommand: { action: 'refresh-tasks' }, updatedAt: freshDate() }));
    await expect(button).toHaveAttribute('aria-busy', 'false', { timeout: 10_000 });
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
    await expect(button).toHaveAccessibleName('タスクを今すぐ再取得');
    await expect(button).toHaveAttribute('title', 'タスクを今すぐ再取得');
    // 送信は成功しているので失敗のトーストは出ない。
    await expect(win.locator('.vk-toast:not([hidden]) .vk-toast-message', { hasText: 'タスクの再取得を依頼できませんでした' })).toHaveCount(0);

    // 解除後はもう一度押せる。
    await button.click();
    await expect.poll(() => readCommands(commandsPath).length).toBe(2);
    const ids = readCommands(commandsPath).map((c) => c.id);
    expect(new Set(ids).size).toBe(2);
  });

  test('押しても commands.jsonl に書けないときは、すぐ取得中を解除してトーストで知らせる', async () => {
    await setupWidget(win, port, widgetFile, buildGithubWidget({ refreshCommand: { action: 'refresh-tasks' } }), commandsPath);
    // 追記先をディレクトリにして、追記を失敗させる。
    fs.mkdirSync(commandsPath, { recursive: true });
    try {
      const button = win.locator('#task-list button.task-list-refresh');
      await button.click();
      await expect(win.locator('.vk-toast .vk-toast-message')).toHaveText('タスクの再取得を依頼できませんでした');
      await expect(button).toHaveAttribute('aria-busy', 'false');
      await expect(button).toHaveAccessibleName('タスクを今すぐ再取得');
    } finally {
      fs.rmSync(commandsPath, { recursive: true, force: true });
    }
  });

  test('取得中に refreshCommand が無い一覧へ変わるとボタンを隠す', async () => {
    await setupWidget(win, port, widgetFile, buildGithubWidget({ refreshCommand: { action: 'refresh-tasks' } }), commandsPath);
    const button = win.locator('#task-list button.task-list-refresh');
    await button.click();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await waitWidgetReflected(port, widgetFile, buildGithubWidget());
    await expect(button).toBeHidden({ timeout: 10_000 });
  });
});
