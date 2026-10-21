const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #456: セットアップ状況の一覧パネル。
//   - 組み込み用の入口（embedded.js）から getSetupStatus / setupPane を渡して起動したときだけ出る。
//   - electron . で起動したとき（zip 版）は IPC も画面の要素も作らず、今と同じ画面のまま。
// 組み込み側の代わりに tests/fixtures/embeddedSetupLauncher.js を入口にして起動する。
// doctor の結果はファイル（VK_TEST_SETUP_STATUS_FILE）から呼ばれるたびに読むので、テストの途中で書き換えて状態を変える。

const launcherPath = path.resolve(__dirname, '..', 'fixtures', 'embeddedSetupLauncher.js');

function requirement(overrides = {}) {
  return {
    id: 'node',
    group: 'tools',
    label: 'Node.js',
    required: true,
    ok: true,
    current: 'v22',
    hint: 'Node.js を入れてください',
    target: 'external',
    ...overrides,
  };
}

function buildStatus(requirements) {
  const missing = requirements.filter((r) => r.required && !r.ok);
  return {
    requirements,
    summary: {
      total: requirements.length,
      okCount: requirements.filter((r) => r.ok).length,
      requiredCount: requirements.filter((r) => r.required).length,
      requiredOkCount: requirements.filter((r) => r.required && r.ok).length,
      missingRequired: missing.map((r) => r.id),
      allRequiredOk: missing.length === 0,
    },
  };
}

const CLAUDE_MISSING = buildStatus([
  requirement({ id: 'claude', label: 'Claude Code', ok: false, hint: 'Claude Code を入れてください' }),
  requirement({ id: 'gh-auth', label: 'GitHub CLI のログイン', ok: false, hint: 'gh auth login' }),
  requirement({ id: 'cfg', label: '設定ファイル', ok: false, target: 'B', hint: 'config.yml の task.engine を書き換える' }),
  requirement({ id: 'node', label: 'Node.js', ok: true, current: 'v22' }),
]);
const CLAUDE_OK = buildStatus([
  requirement({ id: 'claude', label: 'Claude Code', ok: true, current: '2.0.14' }),
  requirement({ id: 'gh-auth', label: 'GitHub CLI のログイン', ok: false, hint: 'gh auth login' }),
  requirement({ id: 'cfg', label: '設定ファイル', ok: false, target: 'B', hint: 'config.yml の task.engine を書き換える' }),
]);
const WITH_COMMANDS = buildStatus([
  requirement({
    id: 'claude',
    label: 'Claude Code',
    ok: false,
    reason: 'not-on-path',
    commands: [{ command: 'npm install -g @anthropic-ai/claude-code', os: 'macOS' }],
  }),
  requirement({ id: 'gh-auth', label: 'GitHub CLI のログイン', ok: false, reason: 'not-authenticated', hint: 'gh auth login を実行してください' }),
]);
const ALL_OK = buildStatus([
  requirement({ id: 'claude', label: 'Claude Code', ok: true, current: '2.0.14' }),
]);

async function launchEmbedded({ initialStatus, prefix }) {
  const port = await getFreePort();
  const statusDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-setup-status-'));
  const statusFile = path.join(statusDir, 'status.json');
  const setupCwd = path.join(statusDir, 'setup-cwd');
  fs.mkdirSync(setupCwd);
  fs.writeFileSync(statusFile, JSON.stringify(initialStatus));
  const launched = await launchAppAndWait({
    port,
    prefix,
    entry: launcherPath,
    env: { VK_TEST_SETUP_STATUS_FILE: statusFile, VK_TEST_SETUP_CWD: setupCwd },
  });
  const setStatus = (value) => fs.writeFileSync(statusFile, JSON.stringify(value));
  const cleanup = async () => {
    try {
      await closeApp(launched);
    } finally {
      fs.rmSync(statusDir, { recursive: true, force: true });
    }
  };
  return { ...launched, setStatus, cleanup, setupCwd };
}

test.describe('セットアップ状況の一覧（組み込み用の入口から起動したとき）', () => {
  test.describe.configure({ mode: 'serial' });

  let ctx;

  test.beforeAll(async () => {
    ctx = await launchEmbedded({ initialStatus: CLAUDE_MISSING, prefix: 'vk-terminals-e2e-setup-panel-' });
  });

  test.afterAll(async () => {
    if (ctx) await ctx.cleanup();
  });

  test('初めて未完了と判定されたときは、起動時のペインがセットアップ用ペインになり、パネルが並ぶ（2 枚目は作らない）', async () => {
    const { win, tmpHome } = ctx;
    const panel = win.locator('.setup-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel).toHaveAttribute('data-mode', 'side');
    await expect(win.locator('.pane')).toHaveCount(1);
    // 記録は VK Terminals のデータフォルダに残る。
    expect(fs.existsSync(path.join(tmpHome, '.vk-terminals', 'setup-auto-open.json'))).toBe(true);
    // Claude Code が無いので、開いたのは Claude 無しのシェル。「信頼しますか」の案内ではなく、入れる案内を出す。
    await expect(panel.getByText('このペインで Claude Code を入れてください。入れたら「もう一度確認」を押してください。')).toBeVisible();
    await expect(panel.getByText('このフォルダを信頼しますか')).toHaveCount(0);
    // 「セットアップ用のペインを表示」には変わらず、「セットアップを始める」は押せない状態のまま。
    await expect(panel.getByRole('button', { name: 'セットアップ用のペインを表示' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'セットアップを始める' })).toHaveAttribute('aria-disabled', 'true');
  });

  test('サイドバーのタスク欄は隠れず、停止理由と「セットアップ状況を見る」リンクが出る', async () => {
    const { win } = ctx;
    const section = win.locator('#task-list');
    await expect(section).toBeVisible();
    const notice = section.locator('.task-list-stale');
    await expect(notice).toContainText('セットアップ未完了のため停止中');
    await expect(notice.getByRole('button', { name: 'セットアップ状況を見る' })).toBeVisible();
  });

  test('一覧は「自分で入れるもの」が先、「セットアップで設定するもの」が後。必須と任意は見出しで分け、充足済みは件数だけ', async () => {
    const { win } = ctx;
    const titles = await win.locator('.setup-group-title').allTextContents();
    expect(titles).toEqual(['自分で入れるもの', 'セットアップで設定するもの']);
    await expect(win.locator('.setup-kind-title').first()).toHaveText('必須（残り 2 件）');
    await expect(win.locator('.setup-lead')).toHaveText('あと 3 件で使えるようになります。上から順に進めてください。');
    await expect(win.locator('.setup-satisfied > summary')).toHaveText('そろっている項目 1 件');
    // Claude Code の行が先頭で「まずここから」。
    const firstItem = win.locator('.setup-group').first().locator('.setup-item').first();
    await expect(firstItem).toContainText('Claude Code');
    await expect(firstItem).toContainText('まずここから');
    // 「セットアップで設定するもの」は固定の案内で、元の hint は「詳しく」の中。
    const setupItem = win.locator('.setup-group').nth(1).locator('.setup-item').first();
    await expect(setupItem).toContainText('「セットアップを始める」で設定します。');
    await expect(setupItem.locator('details')).not.toHaveAttribute('open', '');
  });

  test('コマンド欄・理由欄が無いときは、コマンド枠もコピーボタンも状態の文言も出さず、説明文だけを出す', async () => {
    const { win } = ctx;
    await expect(win.locator('.setup-cmd')).toHaveCount(0);
    await expect(win.locator('.setup-item-state')).toHaveCount(0);
    await expect(win.locator('.setup-item-hint', { hasText: 'Claude Code を入れてください' })).toBeVisible();
  });

  test('Claude 無しで開いたペインのまま Claude Code が入ったら、「セットアップを始める」で Claude 付きのペインを開ける', async () => {
    const { win, setStatus } = ctx;
    const panel = win.locator('.setup-panel');
    setStatus(CLAUDE_OK);
    await panel.getByRole('button', { name: 'もう一度確認' }).click();
    await expect(panel.locator('.setup-lead')).toHaveText('あと 2 件で使えるようになります。上から順に進めてください。');
    // 入れる案内は消え、始められる。
    await expect(panel.getByText('このペインで Claude Code を入れてください。入れたら「もう一度確認」を押してください。')).toHaveCount(0);
    const start = panel.getByRole('button', { name: 'セットアップを始める' });
    await expect(start).not.toHaveAttribute('aria-disabled', 'true');
    await start.click();
    await expect(win.locator('.pane')).toHaveCount(2);
    await expect(panel.getByRole('button', { name: 'セットアップ用のペインを表示' })).toBeVisible();
    await expect(panel.getByText('Claude Code が「このフォルダを信頼しますか」と聞いてきたら、Enter で進めてください。')).toBeVisible();
    // 以降のケースのために、Claude Code が無い状態へ戻す。
    setStatus(CLAUDE_MISSING);
    await panel.getByRole('button', { name: 'もう一度確認' }).click();
    await expect(panel.locator('.setup-lead')).toHaveText('あと 3 件で使えるようになります。上から順に進めてください。');
  });

  test('ペインを閉じると「並べる」から「主役」に戻り、Claude Code が無いと「セットアップを始める」は押せない', async () => {
    const { win } = ctx;
    // 起動時のペイン（セットアップ用）を閉じるため、いったん再読み込みして最初の状態に戻す。
    await win.reload();
    const panel = win.locator('.setup-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    // 2 回目以降は自動で開かない（記録がある）。
    await expect(panel).toHaveAttribute('data-mode', 'main');
    await expect(win.locator('.pane')).toHaveCount(1);
    const start = panel.getByRole('button', { name: 'セットアップを始める' });
    await expect(start).toHaveAttribute('aria-disabled', 'true');
    await expect(panel.getByText('先に Claude Code を入れてください')).toBeVisible();
    // aria-disabled のボタンは Playwright が「押せない」と見なすため、force で実際にクリックして何も起きないことを確かめる。
    await start.click({ force: true });
    // 押せないので、ペインは増えない。
    await expect(win.locator('.pane')).toHaveCount(1);
  });

  test('「もう一度確認」: 確認中は「確認しています…」で一覧は残り、結果が変わると表示も変わる。Claude Code が入ると始められる', async () => {
    const { win, setStatus } = ctx;
    const panel = win.locator('.setup-panel');
    setStatus({ __hang: true });
    await panel.getByRole('button', { name: 'もう一度確認' }).click();
    const checking = panel.getByRole('button', { name: '確認しています…' });
    await expect(checking).toHaveAttribute('aria-disabled', 'true');
    await expect(panel.locator('.setup-body')).toHaveAttribute('aria-busy', 'true');
    // 一覧は消えずに残る。
    await expect(panel.locator('.setup-group')).toHaveCount(2);
    // 確認が終わらないまま上限（20 秒）に達すると、確認できなかった表示になる。
    await expect(panel.locator('.setup-unavailable-title')).toHaveText('セットアップ状況を確認できませんでした', { timeout: 30_000 });
    // 結果の変化は role="status" でも伝える。
    await expect(panel.locator('[role="status"]').first()).toHaveText('セットアップ状況を確認できませんでした');
    await expect(panel.getByText('確認に 20 秒以上かかったため、途中で止めました。')).toBeVisible();
    // 失敗しても直近に確認できた一覧は消さず、薄くして残す。最終確認の時刻も残る。
    await expect(panel.locator('.setup-group')).toHaveCount(2);
    await expect(panel.locator('.setup-body')).toHaveClass(/is-checking/);
    await expect(panel.locator('.setup-checked')).toHaveText(/^最終確認 \d{2}:\d{2}$/);
    await expect(panel.getByRole('button', { name: '詳細をコピー' })).toBeVisible();
    // 失敗してもサイドバーの文言は変えない（セットアップ済みの表示に戻さない）。
    await expect(win.locator('#task-list .task-list-stale')).toContainText('セットアップ未完了のため停止中');

    setStatus(CLAUDE_OK);
    await panel.getByRole('button', { name: 'もう一度確認' }).click();
    await expect(panel.locator('.setup-lead')).toHaveText('あと 2 件で使えるようになります。上から順に進めてください。');
    await expect(panel.locator('.setup-checked')).toHaveText(/^最終確認 \d{2}:\d{2}$/);
    await expect(panel.getByText('先に Claude Code を入れてください')).toHaveCount(0);
    const start = panel.getByRole('button', { name: 'セットアップを始める' });
    await expect(start).not.toHaveAttribute('aria-disabled', 'true');
  });

  test('「セットアップを始める」でセットアップ用ペインが 1 枚開き、パネルは「並べる」になる。もう 1 度押しても増えない', async () => {
    const { win } = ctx;
    const panel = win.locator('.setup-panel');
    await panel.getByRole('button', { name: 'セットアップを始める' }).click();
    await expect(win.locator('.pane')).toHaveCount(2);
    await expect(panel).toHaveAttribute('data-mode', 'side');
    const show = panel.getByRole('button', { name: 'セットアップ用のペインを表示' });
    await expect(show).toBeVisible();
    await show.click();
    await expect(win.locator('.pane')).toHaveCount(2);
    // 並べる状態ではボタンを 2 段に積み、幅をそろえる。
    const rects = await panel.locator('.setup-actions-buttons .setup-btn').evaluateAll((buttons) => buttons.map((b) => b.getBoundingClientRect()));
    expect(rects).toHaveLength(2);
    expect(rects[1].top).toBeGreaterThan(rects[0].bottom - 1);
    expect(Math.abs(rects[0].width - rects[1].width)).toBeLessThan(1);
  });

  test('コマンド欄・理由欄があれば、状態の文言とコマンド枠とコピーボタンを出し、コピーしても実行はされない', async () => {
    const { app, win, setStatus } = ctx;
    const panel = win.locator('.setup-panel');
    setStatus(WITH_COMMANDS);
    await panel.getByRole('button', { name: 'もう一度確認' }).click();
    await expect(panel.locator('.setup-item-state').first()).toHaveText('入っていますが、見つかりません');
    await expect(panel.getByText('アプリを終了して開き直してください。それでも同じなら、入れた場所を確かめてください。')).toBeVisible();
    await expect(panel.getByText('まだ認証していません')).toBeVisible();
    const code = panel.locator('.setup-cmd-code');
    await expect(code).toHaveText('npm install -g @anthropic-ai/claude-code');
    // 折り返さず、枠の中で横スクロールできる。
    // 折り返して全文を見せる（見切れない）。
    expect(await code.evaluate((el) => getComputedStyle(el).whiteSpace)).toBe('pre-wrap');
    expect(await code.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    await expect(panel.getByRole('group', { name: 'Claude Codeの導入コマンド' })).toBeVisible();
    const copy = panel.locator('.setup-cmd-copy');
    await copy.click();
    await expect(copy).toHaveText('コピーしました');
    await expect(panel.locator('[role="status"]').first()).toHaveText('コピーしました');
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe('npm install -g @anthropic-ai/claude-code');
    // 項目の説明文（hint）にコマンドが入っていても、コマンド欄が無い行ではコマンド枠は出さない。
    await expect(panel.locator('.setup-cmd')).toHaveCount(1);
  });

  test('コマンド枠の文字と背景は 4.5:1 以上のコントラスト', async () => {
    const { win } = ctx;
    const ratio = await win.locator('.setup-cmd-code').evaluate((el) => {
      const parse = (css) => css.match(/[\d.]+/g).slice(0, 3).map(Number);
      const lum = ([r, g, b]) => {
        const f = (c) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const fg = lum(parse(getComputedStyle(el).color));
      const bg = lum(parse(getComputedStyle(el.parentElement).backgroundColor));
      const [hi, lo] = fg > bg ? [fg, bg] : [bg, fg];
      return (hi + 0.05) / (lo + 0.05);
    });
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test('ウィンドウが 1000px より狭いと自動で畳み、利用者が開けば広げ、広げ直すと元に戻る', async () => {
    const { app, win } = ctx;
    const setWidth = (width) => app.evaluate(({ BrowserWindow }, w) => {
      const [window] = BrowserWindow.getAllWindows();
      window.setSize(w, 800);
    }, width);
    try {
      await setWidth(900);
      await expect(win.locator('.setup-band')).toBeVisible();
      await expect(win.locator('.setup-panel')).toHaveCount(0);
      const paneWidth = () => win.locator('.grid').evaluate((el) => el.getBoundingClientRect().width);
      const foldedWidth = await paneWidth();
      await win.locator('.setup-band').getByRole('button', { name: '一覧を開く' }).click();
      await expect(win.locator('.setup-panel')).toBeVisible();
      // 開いたときでも、パネルが縮んでターミナルの幅を確保する（潰れない）。
      const openWidth = await paneWidth();
      expect(openWidth).toBeGreaterThanOrEqual(300);
      expect(foldedWidth).toBeGreaterThan(openWidth);
      await setWidth(1300);
      await expect(win.locator('.setup-panel')).toBeVisible();
      await expect(win.locator('.setup-band')).toHaveCount(0);
    } finally {
      await setWidth(1300);
    }
  });

  test('「閉じる」で上端の 1 行の帯に畳まれ、「一覧を開く」で戻って見出しにフォーカスが移る', async () => {
    const { win } = ctx;
    await win.locator('.setup-panel').getByRole('button', { name: '閉じる' }).click();
    const band = win.locator('.setup-band');
    await expect(band).toBeVisible();
    await expect(band).toContainText('セットアップ未完了（残り 2 件）');
    await expect(win.locator('.setup-panel')).toHaveCount(0);
    await band.getByRole('button', { name: '一覧を開く' }).click();
    await expect(win.locator('.setup-panel')).toBeVisible();
    await expect(win.locator('#setup-panel-title')).toBeFocused();
  });

  test('サイドバーの「セットアップ状況を見る」で、畳んだパネルが開き見出しにフォーカスが移る', async () => {
    const { win } = ctx;
    await win.locator('.setup-panel').getByRole('button', { name: '閉じる' }).click();
    await expect(win.locator('.setup-band')).toBeVisible();
    await win.locator('#task-list .task-list-setup-link').click();
    await expect(win.locator('.setup-panel')).toBeVisible();
    await expect(win.locator('#setup-panel-title')).toBeFocused();
  });

  test('セットアップが完了したら「セットアップが完了しました」を出し、「閉じる」で消える。サイドバーは今の表示に戻る', async () => {
    const { win, setStatus } = ctx;
    const panel = win.locator('.setup-panel');
    setStatus(ALL_OK);
    await panel.getByRole('button', { name: 'もう一度確認' }).click();
    await expect(panel.locator('.setup-lead')).toHaveText('セットアップが完了しました');
    await expect(panel.getByRole('button', { name: 'セットアップを始める' })).toHaveCount(0);
    await expect(win.locator('#task-list .task-list-setup-link')).toHaveCount(0);
    await panel.getByRole('button', { name: '閉じる' }).click();
    await expect(win.locator('.setup-panel')).toHaveCount(0);
    await expect(win.locator('.setup-band')).toHaveCount(0);
    // フォーカスは直前に使っていたターミナルへ戻る。
    await expect.poll(() => win.evaluate(() => !!document.activeElement?.closest?.('.xterm'))).toBe(true);
  });
});

test('確認に失敗したときは「確認できませんでした」と再試行・詳細のコピーを出し、セットアップ済みの扱いにはしない', async () => {
  const ctx = await launchEmbedded({ initialStatus: { __throw: 'spawn ENOENT' }, prefix: 'vk-terminals-e2e-setup-fail-' });
  try {
    const { app, win, setStatus } = ctx;
    const panel = win.locator('.setup-panel');
    await expect(panel).toBeVisible({ timeout: 20_000 });
    await expect(panel.getByText('セットアップ状況を確認できませんでした')).toBeVisible();
    await expect(panel.getByText('確認用のプログラムを起動できませんでした。')).toBeVisible();
    // 判定が出ていないので、サイドバーの停止表示の文言は変えない（セットアップ未完了とも言わない）。
    await expect(win.locator('#task-list .task-list-setup-link')).toHaveCount(0);
    // 失敗では自動オープンしない。
    await expect(win.locator('.pane')).toHaveCount(1);
    await panel.getByRole('button', { name: '詳細をコピー' }).click();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain('reason: error');
    expect(copied).toContain('spawn ENOENT');
    // 直ったら、もう一度確認で一覧に変わる。
    setStatus(CLAUDE_MISSING);
    await panel.getByRole('button', { name: 'もう一度確認' }).click();
    await expect(panel.locator('.setup-lead')).toBeVisible();
    await expect(win.locator('#task-list .task-list-setup-link')).toBeVisible();
  } finally {
    await ctx.cleanup();
  }
});

test('セットアップ済みなら一覧は組み立てず、今と同じ画面のまま', async () => {
  const ctx = await launchEmbedded({ initialStatus: ALL_OK, prefix: 'vk-terminals-e2e-setup-done-' });
  try {
    const { win, tmpHome } = ctx;
    // 起動時の確認が済むのを待つ（pane が出ていて、確認結果を取り込む時間を置く）。
    await expect(win.locator('.pane')).toHaveCount(1);
    await expect.poll(() => win.evaluate(() => document.querySelectorAll('.setup-panel, .setup-band').length), { timeout: 10_000 }).toBe(0);
    await expect(win.locator('#task-list')).toBeHidden();
    expect(fs.existsSync(path.join(tmpHome, '.vk-terminals', 'setup-auto-open.json'))).toBe(false);
  } finally {
    await ctx.cleanup();
  }
});

test('組み込みのオプションが無い起動（electron .）では、受け口も画面の要素も作らず今と同じ画面のまま', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-setup-absent-' });
  try {
    await expect(win.locator('.pane')).toHaveCount(1);
    const state = await win.evaluate(async () => {
      const config = await window.VKIpc.invoke('app:get-config');
      let checkRejected = false;
      try { await window.VKIpc.invoke('setup:check'); } catch (_e) { checkRejected = true; }
      let initialRejected = false;
      try { await window.VKIpc.invoke('setup:initial-pane'); } catch (_e) { initialRejected = true; }
      let setupPaneRejected = false;
      try { await window.VKIpc.invoke('terminal:create', null, { setupPane: true }); } catch (_e) { setupPaneRejected = true; }
      return {
        hasSetupKey: Object.prototype.hasOwnProperty.call(config, 'setupPanelEnabled'),
        checkRejected,
        initialRejected,
        setupPaneRejected,
        panelElements: document.querySelectorAll('.setup-panel, .setup-band, .setup-main-area, .task-list-setup-link').length,
        rootChildren: Array.from(document.getElementById('root').children).map((c) => c.id || c.className),
      };
    });
    expect(state.hasSetupKey).toBe(false);
    expect(state.checkRejected).toBe(true);
    expect(state.initialRejected).toBe(true);
    expect(state.setupPaneRejected).toBe(true);
    expect(state.panelElements).toBe(0);
    // #root の直下は、サイドバーとグリッドだけ（従来と同じ）。
    expect(state.rootChildren).toHaveLength(2);
    expect(state.rootChildren[0]).toBe('sidebar');
    // 「Orchestrator 停止中」の文言は従来のまま（セットアップ未完了の文言にならない）。
    const noticeText = await win.evaluate(() => document.querySelector('#task-list .task-list-stale')?.textContent || '');
    expect(noticeText).not.toContain('セットアップ');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
