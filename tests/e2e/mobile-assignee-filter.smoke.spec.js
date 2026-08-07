const { test, expect, chromium } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { getFreePort, launchApp } = require('./helpers/electron-app');

// issue #232 / PR #253: モバイル版タスク一覧に GitHub モード時の担当者フィルタと
// 「表示中 / 全体」件数表示を追加した変更の end-to-end 確認。
//
// 共有レイヤ（widgetContract.js / widgetView.js）・main.js は無改修で、mobile 側 chrome が
//   - getFilterMode を localStorage（vkt.taskAssigneeFilter）参照に変え
//   - controller.render() の戻り値で select 表示と件数バッジ（#task-list-count）を更新する
// のが本 PR の肝。既存の widget-declarative スペックと同じく、実プロダクションの経路
// （widgetFile → GET /api/widgets → 実ブラウザの mobile.html が fetch → 共有レンダラ）を
// そのまま使い、注入は tasks-widget.json（config の widgetFile）経由で行う。
//
// 確認ポイント:
//   1. GitHub モード＋viewer 判明時のみ select が表示され、既定で「自分のみ(self)」が選択される。
//   2. 件数バッジがフィルタ有効時「表示中 / 全体（例: 2 / 4件）」形式になる。
//      フィルタ無効時（ローカルモード/viewer 不明）は select 非表示・全件のみ。
//   3. select で選択を変えると絞り込み・件数が追従し、選択が localStorage に記憶される。
//   4. select 操作中（フォーカス中）に自動更新（poll 約2秒）が来ても select が勝手に作り直されない。
//   5. 開閉トグル（全幅ボタン）が従来どおり動作する（回帰）。
//
// issue #348: 4 テストとも config が { widgetFile } のみで同一のため、Electron の起動を
// 1 回に共有する。widget-declarative.smoke.spec.js と同じ理由で、widgetFile を書き換えた
// 直後は main.js の widget watcher（fs.watch + 150ms デバウンス）がまだキャッシュへ反映して
// いない可能性があるため、書き換え後に十分な余裕（600ms）を空けてから GET /api/widgets を
// 叩く。chromium の browser / context / page は元コードのとおり各テストで新規作成しており、
// localStorage 等のブラウザ側状態はテスト間で最初から共有されない（Electron 側の
// widgetFile の内容だけが共有される状態）。

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function freshDate(offsetMs = 0) {
  return new Date(Date.now() + offsetMs).toISOString();
}

// GitHub モード（rel:"queue" の http(s) リンクを持つ）＋ viewer=kurudrive の宣言を組み立てる。
// 担当者を混在させる: 自分(kurudrive)×2 / 他人(wada)×1 / 担当なし×1 = 全 4 件。
// 既定フィルタ（自分のみ）では 2 件表示になり、「2 / 4件」を検証できる。
function buildGithubWidget(overrides = {}) {
  const queueLink = (n) => ([
    { rel: 'queue', url: `https://github.com/vektor-inc/vk-orchestrator/issues/${n}`, label: `issue #${n}` },
  ]);
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
          { id: '501', title: '自分の実行中タスクA', assignee: 'kurudrive', updatedAt: freshDate(), editable: false, badges: [], links: queueLink(501), controls: [] },
          { id: '502', title: '自分の実行中タスクB', assignee: 'kurudrive', updatedAt: freshDate(), editable: false, badges: [], links: queueLink(502), controls: [] },
          { id: '503', title: '他人担当（wada）のタスク', assignee: 'wada', updatedAt: freshDate(), editable: false, badges: [], links: queueLink(503), controls: [] },
          { id: '504', title: '担当なしのタスク', updatedAt: freshDate(), editable: false, badges: [], links: queueLink(504), controls: [] },
        ],
      },
    ],
    ...overrides,
  };
}

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
          { id: '601', title: 'ローカルモードのタスク1', updatedAt: freshDate(), editable: false, badges: [], links: [], controls: [] },
          { id: '602', title: 'ローカルモードのタスク2', updatedAt: freshDate(), editable: false, badges: [], links: [], controls: [] },
        ],
      },
    ],
    ...overrides,
  };
}

async function launchMobileFilterApp(port, config = {}) {
  return await launchApp({
    port,
    prefix: 'vk-terminals-e2e-mobile-filter-',
    config,
  });
}

// このスペックは共通ヘルパーの closeApp を使わず、独自の強制終了付き後始末を使う。
// app.close() が返ってこないケース（widget watcher を抱えた状態での終了）に備えて
// 5 秒で SIGKILL へ切り替える措置を PR #253 から引き継いでいるため。
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
    if (!closed && proc && !proc.killed) proc.kill('SIGKILL');
    if (!closed) {
      await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 1000))]);
    }
  } finally {
    if (tmpRoot) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

// GET /api/widgets が非 null の widget を返すまで待つ（API サーバー起動＋widgetFile 読込完了の保証）。
async function waitForWidgetReady(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/widgets`);
      if (res.status === 200) {
        const json = await res.json();
        last = json;
        if (json && json.widget) return json;
      }
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`/api/widgets did not return a widget in time. last: ${JSON.stringify(last)}`);
}

// widgetFile を新しい内容へ書き換え、main.js の widget watcher（fs.watch + 150ms
// デバウンス）がキャッシュへ反映するまでの余裕を空ける。
async function setupWidget(widgetFile, widget) {
  writeJson(widgetFile, widget);
  await new Promise((r) => setTimeout(r, 600));
}

// モバイル相当の context（タッチ・モバイル viewport）を開く。
// API サーバー＋widget の準備完了を待ってから goto する（ERR_CONNECTION_REFUSED 回避）。
async function openMobile(browser, port) {
  await waitForWidgetReady(port);
  const context = await browser.newContext({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  return { context, page };
}

test.describe.serial('モバイル版タスク一覧の担当者フィルタ（issue #232 / #348 で起動共有）', () => {
  let app;
  let tmpRoot;
  let port;
  let widgetFile;

  test.beforeAll(async () => {
    port = await getFreePort();
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-mobile-filter-data-'));
    widgetFile = path.join(dataRoot, 'tasks-widget.json');
    writeJson(widgetFile, buildGithubWidget());
    ({ app, tmpRoot } = await launchMobileFilterApp(port, { widgetFile }));
  });

  test.afterAll(async () => {
    await closeAppForcefully({ app, tmpRoot });
  });

  // ─── 1 & 2 & 3: GitHub モード＋viewer で select 表示・既定 self・件数「表示中/全体」・切替と永続化 ───
  test('モバイル: GitHub モード＋viewer で担当者フィルタが表示され、既定 self で「表示中/全体」件数を出し、切替が localStorage に記憶される', async () => {
    await setupWidget(widgetFile, buildGithubWidget());
    const browser = await chromium.launch();
    try {
      const { context, page } = await openMobile(browser, port);

      const section = page.locator('#task-list');
      await expect(section).toBeVisible({ timeout: 15_000 });

      // 1: GitHub モード＋viewer 判明なので select が表示され、既定は「自分のみ(self)」。
      const filter = page.locator('#task-list-assignee-filter');
      await expect(filter).toBeVisible({ timeout: 15_000 });
      await expect(filter).toHaveValue('self');

      // 選択肢: self / all / kurudrive / wada / none（担当なしアイテムがあるため）。
      const optionValues = await filter.locator('option').evaluateAll((els) => els.map((o) => o.value));
      expect(optionValues).toEqual(['self', 'all', 'kurudrive', 'wada', 'none']);

      // 既定 self では自分（kurudrive）担当の 2 件だけ表示。
      await expect(section).toContainText('自分の実行中タスクA');
      await expect(section).toContainText('自分の実行中タスクB');
      await expect(section).not.toContainText('他人担当（wada）のタスク');
      await expect(section).not.toContainText('担当なしのタスク');

      // 2: 件数バッジは「表示中 / 全体」= 2 / 4件。
      const count = page.locator('#task-list-count');
      await expect(count).toHaveText('2 / 4件');

      // 3: 「全員」に切り替えると全 4 件表示・件数が 4 / 4件・選択が localStorage に保存される。
      await filter.selectOption('all');
      await expect(section).toContainText('他人担当（wada）のタスク');
      await expect(section).toContainText('担当なしのタスク');
      await expect(count).toHaveText('4 / 4件');
      let stored = await page.evaluate(() => localStorage.getItem('vkt.taskAssigneeFilter'));
      expect(stored).toBe('all');

      // 「担当なし(none)」→ 担当なしの 1 件だけ・件数 1 / 4件。
      await filter.selectOption('none');
      await expect(section).toContainText('担当なしのタスク');
      await expect(section).not.toContainText('自分の実行中タスクA');
      await expect(count).toHaveText('1 / 4件');

      // 個別担当者（wada）→ wada 担当の 1 件だけ・件数 1 / 4件。
      await filter.selectOption('wada');
      await expect(section).toContainText('他人担当（wada）のタスク');
      await expect(section).not.toContainText('担当なしのタスク');
      await expect(count).toHaveText('1 / 4件');
      stored = await page.evaluate(() => localStorage.getItem('vkt.taskAssigneeFilter'));
      expect(stored).toBe('wada');

      // 3(続き): 再読み込みしても選択（wada）が保持される。
      await page.reload();
      await expect(page.locator('#task-list-assignee-filter')).toBeVisible({ timeout: 15_000 });
      await expect(page.locator('#task-list-assignee-filter')).toHaveValue('wada');
      await expect(page.locator('#task-list-count')).toHaveText('1 / 4件');

      await context.close();
    } finally {
      await browser.close();
    }
  });

  // ─── 2(裏): ローカルモード（queue リンク無し／viewer 不明）では select 非表示・件数は全件のみ ───
  test('モバイル: ローカルモード（GitHub モードでない／viewer 不明）では担当者フィルタを出さず件数は全件のみ', async () => {
    await setupWidget(widgetFile, buildLocalWidget());
    const browser = await chromium.launch();
    try {
      const { context, page } = await openMobile(browser, port);

      const section = page.locator('#task-list');
      await expect(section).toBeVisible({ timeout: 15_000 });

      // アイテムは描画される。
      await expect(section).toContainText('ローカルモードのタスク1');
      await expect(section).toContainText('ローカルモードのタスク2');

      // GitHub モードでない＝担当者フィルタは非表示。
      await expect(page.locator('#task-list-assignee-filter')).toBeHidden();

      // 件数は「表示中/全体」形式ではなく全件のみ（2件）。
      await expect(page.locator('#task-list-count')).toHaveText('2件');

      await context.close();
    } finally {
      await browser.close();
    }
  });

  // ─── 4: select フォーカス中は poll（約2秒）による再描画で select が作り直されない ───
  test('モバイル: 担当者フィルタにフォーカス中は poll 再描画で select が作り直されない（ネイティブピッカーが閉じない）', async () => {
    await setupWidget(widgetFile, buildGithubWidget());
    const browser = await chromium.launch();
    try {
      const { context, page } = await openMobile(browser, port);

      const filter = page.locator('#task-list-assignee-filter');
      await expect(filter).toBeVisible({ timeout: 15_000 });

      // select にフォーカスを当て、フォーカス中は再描画スキップ対象になることを確認する。
      await filter.focus();
      expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('task-list-assignee-filter');

      // フォーカス中に widget を書き換え、担当者(new-dev)を 1 人増やす（選択肢が変わる更新）。
      const updated = buildGithubWidget();
      updated.groups[0].items.push({
        id: '505', title: '新担当のタスク', assignee: 'new-dev', updatedAt: freshDate(),
        editable: false, badges: [], links: [{ rel: 'queue', url: 'https://github.com/vektor-inc/vk-orchestrator/issues/505', label: 'issue #505' }], controls: [],
      });
      writeJson(widgetFile, updated);

      // poll 2 周期以上（約5秒）待っても、フォーカス中は再描画がスキップされ選択肢は増えない。
      await page.waitForTimeout(5000);
      expect(await page.evaluate(() => document.activeElement && document.activeElement.id)).toBe('task-list-assignee-filter');
      let optionValues = await filter.locator('option').evaluateAll((els) => els.map((o) => o.value));
      expect(optionValues).toEqual(['self', 'all', 'kurudrive', 'wada', 'none']);

      // フォーカスを外し poll を1回明示的に走らせると、最新の選択肢（new-dev 追加）へ更新される。
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await page.evaluate(() => poll());
      await expect.poll(async () => filter.locator('option').evaluateAll((els) => els.map((o) => o.value)))
        .toEqual(['self', 'all', 'kurudrive', 'new-dev', 'wada', 'none']);

      await context.close();
    } finally {
      await browser.close();
    }
  });

  // ─── 5: 開閉トグル（全幅ボタン）が従来どおり動作し、状態が localStorage に保存される（回帰） ───
  test('モバイル: タスク一覧の開閉トグル（全幅ボタン）が従来どおり動作し、状態が localStorage に保存される', async () => {
    await setupWidget(widgetFile, buildGithubWidget());
    const browser = await chromium.launch();
    try {
      const { context, page } = await openMobile(browser, port);

      const section = page.locator('#task-list');
      await expect(section).toBeVisible({ timeout: 15_000 });
      const head = page.locator('#task-list-head');
      const body = page.locator('#task-list-body');

      // 初期は展開。
      await expect(body).toBeVisible();
      await expect(head).toHaveAttribute('aria-expanded', 'true');
      await expect(section).not.toHaveClass(/\bcollapsed\b/);

      // タップで折り畳み。見出しは残り本体は隠れ、localStorage に保存される。
      await head.tap();
      await expect(body).toBeHidden();
      await expect(head).toHaveAttribute('aria-expanded', 'false');
      await expect(section).toHaveClass(/\bcollapsed\b/);
      expect(await page.evaluate(() => localStorage.getItem('vkt.taskListCollapsed'))).toBe('1');

      // 再タップで展開に戻る。
      await head.tap();
      await expect(body).toBeVisible();
      await expect(head).toHaveAttribute('aria-expanded', 'true');
      expect(await page.evaluate(() => localStorage.getItem('vkt.taskListCollapsed'))).toBe('0');

      await context.close();
    } finally {
      await browser.close();
    }
  });
});
