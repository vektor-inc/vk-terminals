const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// PR #224 / issue #177: サイドバー「タスク一覧」で、GitHub モード時にタスクタイトル（issue 名）を
// task-queue issue への外部リンク（<a class="task-item-title-link"> ＋ 末尾に ↗ の
// .task-item-title-icon）にする変更の end-to-end 確認。
//   - GitHub モード（queueIssueUrl が https の実 URL）→ タイトルが a.task-item-title-link で描画され、
//     role="link" / aria-label / ↗ アイコンを持つ。クリックで shell.openExternal に実 URL が渡る。
//   - ローカルモード（queueIssueUrl が local://... または無し）→ プレーンテキスト（リンク化しない）。
//   - 多行折り返し時に ↗ が孤立しないよう、アイコン span はタイトル本文 span 内に内包され、
//     先頭に WORD JOINER(U+2060) を持つ。
//
// tasks-sidebar.smoke.spec.js と同じく tasksFile 設定でタスクスナップショット（tasks-view.json 相当）を
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-sidebar-task-link-'));
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

// ─── 1: GitHub モード → タイトルが issue へのリンク（↗ アイコン + a11y 属性）になる ───
test('GitHub モード: タスクタイトルが a.task-item-title-link で描画され ↗ アイコン・role/aria を持つ', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-sidebar-task-link-data-'));
  const tasksFile = path.join(dataRoot, 'tasks-view.json');
  const issueUrl = 'https://github.com/vektor-inc/vk-orchestrator/issues/177';
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: 177,
        title: 'GitHub モードのリンクタスク',
        status: 'in-progress',
        assignee: 'kurudrive',
        startedAt: freshDate(-3 * 60 * 1000),
        queueIssueUrl: issueUrl,
      },
    ],
  });

  const { app, win, tmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section).toContainText('GitHub モードのリンクタスク');

    // タイトルが <a class="task-item-title-link"> として描画されていること。
    const link = section.locator('a.task-item-title-link');
    await expect(link).toHaveCount(1);
    await expect(link).toBeVisible();

    // アクセシビリティ属性: role="link" と aria-label（タイトル + 外部で開く旨）が付く。
    await expect(link).toHaveAttribute('role', 'link');
    await expect(link).toHaveAttribute('aria-label', 'GitHub モードのリンクタスク（外部ブラウザで開く）');

    // 末尾の ↗ アイコン span を含むこと。
    const icon = link.locator('.task-item-title-icon');
    await expect(icon).toHaveCount(1);
    await expect(icon).toContainText('↗');
    // 装飾アイコンなので aria-hidden。
    await expect(icon).toHaveAttribute('aria-hidden', 'true');

    // href は実 URL を直接持たず "#"（クリックで openExternalUrlSafe を呼ぶ方式）。
    await expect(link).toHaveAttribute('href', '#');

    // ツールチップ（title 属性）にタイトルと URL が集約されていること。
    await expect(link).toHaveAttribute('title', new RegExp(issueUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    // スクリーンショット（GitHub モード = リンク + ↗）。
    await section.screenshot({ path: path.join(dataRoot, 'after-github-mode.png') });
    console.log(`[screenshot] GitHub モード: ${path.join(dataRoot, 'after-github-mode.png')}`);
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── 2: WORD JOINER(U+2060) 対応 → ↗ アイコンがタイトル本文 span 内に内包される ───
test('GitHub モード: ↗ アイコンはタイトル本文 span 内にあり先頭に WORD JOINER(U+2060) を持つ', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-sidebar-task-link-wj-'));
  const tasksFile = path.join(dataRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: 178,
        title: 'とても長いタスクタイトルで多行折り返しが発生するケースの表示確認'.repeat(2),
        status: 'in-progress',
        assignee: 'wada',
        startedAt: freshDate(-3 * 60 * 1000),
        queueIssueUrl: 'https://github.com/vektor-inc/vk-orchestrator/issues/178',
      },
    ],
  });

  const { app, win, tmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });

    const link = section.locator('a.task-item-title-link');
    await expect(link).toHaveCount(1);

    // DOM 構造と WORD JOINER の検証:
    //   a.task-item-title-link > span.task-item-title-text > (テキスト + span.task-item-title-icon)
    // アイコンがタイトル本文 span（.task-item-title-text）の子孫であること、
    // かつアイコン textContent の先頭に U+2060(WORD JOINER) があることを確認する。
    const domCheck = await link.evaluate((a) => {
      const textSpan = a.querySelector('.task-item-title-text');
      const icon = a.querySelector('.task-item-title-icon');
      return {
        hasTextSpan: !!textSpan,
        iconInsideTextSpan: !!(textSpan && icon && textSpan.contains(icon)),
        iconStartsWithWordJoiner: !!(icon && icon.textContent.charCodeAt(0) === 0x2060),
        iconText: icon ? icon.textContent : null,
      };
    });
    expect(domCheck.hasTextSpan).toBe(true);
    expect(domCheck.iconInsideTextSpan).toBe(true);
    expect(domCheck.iconStartsWithWordJoiner).toBe(true);
    // アイコンは WORD JOINER + ↗ の 2 文字。
    expect(domCheck.iconText).toBe('⁠↗');
    console.log(`[word-joiner] iconText codepoints: ${[...domCheck.iconText].map((c) => 'U+' + c.codePointAt(0).toString(16).toUpperCase()).join(' ')}`);
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── 3: クリックで shell.openExternal に実 URL が渡り、アプリ内ウィンドウが増えない ───
test('GitHub モード: タイトルクリックで shell.openExternal に issue URL が渡り、内部ウィンドウは増えない', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-sidebar-task-link-click-'));
  const tasksFile = path.join(dataRoot, 'tasks-view.json');
  const issueUrl = 'https://github.com/vektor-inc/vk-orchestrator/issues/199';
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: 199,
        title: 'クリックで外部ブラウザを開くタスク',
        status: 'ready',
        createdAt: freshDate(-5 * 60 * 1000),
        queueIssueUrl: issueUrl,
      },
    ],
  });

  const { app, win, tmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    const link = section.locator('a.task-item-title-link');
    await expect(link).toHaveCount(1);

    // renderer は require('electron').shell.openExternal を通じて OS 既定ブラウザを開く。
    // openExternalUrlSafe が参照する shell オブジェクトはモジュールキャッシュと同一なので、
    // require('electron').shell.openExternal を差し替えれば呼び出しを捕捉できる（実ブラウザは開かない）。
    await win.evaluate(() => {
      const { shell } = require('electron');
      window.__openedUrls = [];
      shell.openExternal = (url) => {
        window.__openedUrls.push(url);
        return Promise.resolve(true);
      };
    });

    // クリック前の内部ウィンドウ数。
    const windowsBefore = app.windows().length;

    await link.click();

    // openExternal に実 issue URL が渡ったこと。
    await expect
      .poll(async () => win.evaluate(() => window.__openedUrls || []), { timeout: 5_000 })
      .toEqual([issueUrl]);

    // アプリ内に新規ウィンドウ（BrowserWindow）は開かれていないこと。
    // shell.openExternal は OS ブラウザに委譲するため、Electron のウィンドウは増えない。
    await win.waitForTimeout(300);
    const windowsAfter = app.windows().length;
    expect(windowsAfter).toBe(windowsBefore);
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── 4: ローカルモード → プレーンテキスト（リンク化しない）───
test('ローカルモード: queueIssueUrl が local:// のときタイトルはリンク化されずプレーンテキスト', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-sidebar-task-link-local-'));
  const tasksFile = path.join(dataRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: 200,
        title: 'ローカルモードのプレーンタスク',
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
    await expect(section).toContainText('ローカルモードのプレーンタスク');

    // リンクは描画されない（local:// は resolveQueueIssueUrl で弾かれる）。
    await expect(section.locator('a.task-item-title-link')).toHaveCount(0);
    await expect(section.locator('.task-item-title-icon')).toHaveCount(0);

    // タイトルはプレーンテキストの .task-item-title として描画され、title 属性を持つ。
    const title = section.locator('.task-item-title');
    await expect(title).toHaveCount(1);
    await expect(title).toHaveText('ローカルモードのプレーンタスク');
    await expect(title).toHaveAttribute('title', 'ローカルモードのプレーンタスク');

    // スクリーンショット（ローカルモード = プレーン）。
    await section.screenshot({ path: path.join(dataRoot, 'after-local-mode.png') });
    console.log(`[screenshot] ローカルモード: ${path.join(dataRoot, 'after-local-mode.png')}`);
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

// ─── 5: queueIssueUrl 無し → プレーンテキスト（デグレ確認） ───
test('queueIssueUrl 無し: タイトルはリンク化されずプレーンテキスト', async () => {
  const port = await getFreePort();
  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-sidebar-task-link-none-'));
  const tasksFile = path.join(dataRoot, 'tasks-view.json');
  writeJson(tasksFile, {
    updatedAt: freshDate(),
    tasks: [
      {
        id: 201,
        title: 'URL 無しのタスク',
        status: 'ready',
        createdAt: freshDate(-5 * 60 * 1000),
      },
    ],
  });

  const { app, win, tmpRoot } = await launchApp(port, { tasksFile });
  try {
    const section = win.locator('#task-list');
    await expect(section).toBeVisible({ timeout: 10_000 });
    await expect(section).toContainText('URL 無しのタスク');
    await expect(section.locator('a.task-item-title-link')).toHaveCount(0);
    const title = section.locator('.task-item-title');
    await expect(title).toHaveText('URL 無しのタスク');
    await expect(title).toHaveAttribute('title', 'URL 無しのタスク');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
