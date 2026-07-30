const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// PR #117 / issue #112: サイドバー格納ペインのヘッダーを2段化
// （1段目=タイトル行 / 2段目=ステータスバッジ＋操作アイコン行）し、
// 格納カードにも PR リンク・タイトルリンクを表示するようにした変更の e2e 確認。
//   - 格納カードのヘッダーが2段になっているか（タイトル行と操作行が別要素か）
//   - prUrl 設定時に PR バッジが出るか
//   - url 設定時にタイトルがリンク化されるか
//   - 既存の操作ボタン（↑↓／xterm開閉／グリッドへ戻す／閉じる）が機能するか（デグレ確認）

async function postJson(port, pathname, payload) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch (_e) { /* 非 JSON 応答も診断のため許容 */ }
  return { status: res.status, body };
}

async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return json.terminals || {};
}

function termIdsOf(states) {
  return Object.values(states)
    .map((t) => (t && t.termId != null ? String(t.termId) : null))
    .filter(Boolean);
}

async function waitForTermId(port, termId, shouldExist, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      const ids = termIdsOf(states);
      lastSeen = ids;
      const exists = ids.includes(String(termId));
      if (exists === shouldExist) return ids;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `termId ${termId} did not reach exists=${shouldExist} in time. last states: ${JSON.stringify(lastSeen)}`
  );
}

// サイドバーを確実に開いた状態にする。
// stashPane()（ペイン格納時）は自動でサイドバーを開くため、既に開いている状態で
// #menu-btn を無条件にクリックすると逆に閉じてしまう。現在の開閉状態を見てから
// 必要な場合だけクリックする。
async function ensureSidebarOpen(win) {
  const isOpen = await win.evaluate(() => document.getElementById('root').classList.contains('sidebar-open'));
  if (!isOpen) {
    await win.locator('#menu-btn').click();
  }
  await win.waitForFunction(() => document.getElementById('root').classList.contains('sidebar-open'));
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
async function launchStashHeaderApp(port) {
  return await launchApp({ port, prefix: 'vk-terminals-e2e-stash-header-', config: { confirmClose: 'never' } });
}

test('格納カードのヘッダーが2段（タイトル行/操作行）になり、PRバッジ・タイトルリンクが表示される', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchStashHeaderApp(port);
  try {
    // 起動直後の最初のペイン（termId "1"）が登録されるまで待つ。
    await waitForTermId(port, '1', true);

    // stashed: true を指定して格納状態のペインを作成する。
    const created = await postJson(port, '/api/new-pane', { noClaude: true, stashed: true });
    expect(created.status).toBe(200);
    expect(created.body?.ok).toBe(true);
    const termId = String(created.body.termId);
    await waitForTermId(port, termId, true);
    // renderer 内部の paneId は "pane-<termId>" 形式（li[data-id] はこちらを使う）。
    // /api/* が返す termId とは別の値なので、DOM セレクタでは変換して使う。
    const paneDomId = `pane-${termId}`;

    // タイトル・URL・PR URL を設定する。
    const setTitleRes = await postJson(port, '/api/set-title', {
      termId,
      title: 'テストタスク',
      url: 'https://example.com/task/1',
      prUrl: 'https://github.com/vektor-inc/vk-terminals/pull/117',
    });
    expect(setTitleRes.status).toBe(200);

    // renderer 側の反映を待つ（サイドバーを開いて格納カードを表示状態にする）。
    await ensureSidebarOpen(win);
    const stashItem = win.locator(`.stash-item[data-id="${paneDomId}"]`);
    await expect(stashItem).toBeVisible({ timeout: 10_000 });

    // ── (1) ヘッダーが2段構造か ─────────────────────────────
    // 1段目: タイトル行（.stash-item-title-row）
    // 2段目: 操作行（.stash-item-head、ステータスバッジ＋アクションボタン群）
    const titleRow = stashItem.locator('.stash-item-title-row');
    const actionHead = stashItem.locator('.stash-item-head');
    await expect(titleRow).toBeVisible();
    await expect(actionHead).toBeVisible();

    // 2つの行が別要素（DOM 上で兄弟）であり、同一要素に統合されていないことを確認する。
    const isSeparateRows = await win.evaluate((id) => {
      const li = document.querySelector(`.stash-item[data-id="${id}"]`);
      const t = li.querySelector('.stash-item-title-row');
      const h = li.querySelector('.stash-item-head');
      return !!(t && h && t !== h && t.parentElement === li && h.parentElement === li);
    }, paneDomId);
    expect(isSeparateRows).toBe(true);

    // タイトル行の bounding box が操作行より上にある（2段構造として視覚的にも上下に並んでいる）。
    const titleBox = await titleRow.boundingBox();
    const headBox = await actionHead.boundingBox();
    expect(titleBox).toBeTruthy();
    expect(headBox).toBeTruthy();
    expect(titleBox.y).toBeLessThan(headBox.y);

    // ── (2) タイトルがリンク化されているか ─────────────────────
    await expect(titleRow.locator('.pane-task-title-link')).toHaveCount(1);
    await expect(titleRow).toContainText('テストタスク');

    // ── (3) PR バッジが出るか ─────────────────────────────
    const prBadge = titleRow.locator('.pane-task-title-pr');
    await expect(prBadge).toHaveCount(1);
    await expect(prBadge).toContainText('PR');

    // ── (4) 操作行にステータスバッジと操作アイコンがあるか（従来どおり） ──
    await expect(actionHead.locator('.pane-status')).toHaveCount(1);
    await expect(actionHead.locator('.btn-stash-up')).toHaveCount(1);
    await expect(actionHead.locator('.btn-stash-down')).toHaveCount(1);
    await expect(actionHead.locator('.btn-stash-toggle')).toHaveCount(1);
    await expect(actionHead.locator('.btn-stash-restore')).toHaveCount(1);
    await expect(actionHead.locator('.btn-close')).toHaveCount(1);

    // ── (5) 操作ボタンのデグレ確認: xterm 開閉トグル ──────────────
    const toggleBtn = actionHead.locator('.btn-stash-toggle');
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'true');
    await expect(stashItem).toHaveClass(/\bstash-xterm-open\b/);
    await expect(stashItem.locator('.term-container')).toBeVisible();
    // 元に戻す。
    await toggleBtn.click();
    await expect(toggleBtn).toHaveAttribute('aria-expanded', 'false');
    await expect(stashItem.locator('.term-container')).toBeHidden();

    // ── (6) 操作ボタンのデグレ確認: グリッドへ戻す（→） ─────────────
    const restoreBtn = actionHead.locator('.btn-stash-restore');
    await restoreBtn.click();
    // 復帰後は格納カードとして存在しなくなる（グリッド側の .pane に変わる）。
    await expect(win.locator(`.stash-item[data-id="${paneDomId}"]`)).toHaveCount(0);
    await expect(win.locator(`.pane[data-id="${paneDomId}"]`)).toBeVisible({ timeout: 10_000 });

    // ── (7) 操作ボタンのデグレ確認: 閉じる（✕） ─────────────────
    // グリッド側の閉じるボタンから閉じ、states から消えることを確認する。
    const gridPane = win.locator(`.pane[data-id="${paneDomId}"]`);
    await gridPane.locator('.btn-close').click();
    await waitForTermId(port, termId, false);
    // 最初のペインは残っている。
    expect(termIdsOf(await getStates(port))).toContain('1');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('格納カード: マージ済み PR バッジは格納後も紫表示とチェックアイコンを維持する', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchStashHeaderApp(port);
  try {
    await waitForTermId(port, '1', true);

    const prUrl = 'https://github.com/vektor-inc/vk-terminals/pull/137';
    const setTitleRes = await postJson(port, '/api/set-title', {
      termId: '1',
      title: 'PR #137 マージ済み stash 確認',
      prUrl,
      prMerged: true,
    });
    expect(setTitleRes.status).toBe(200);
    expect(setTitleRes.body?.prMerged).toBe(true);

    // グリッド側でマージ済み表示になったペインを、実操作でサイドバーへ格納する。
    const paneDomId = 'pane-1';
    const gridPane = win.locator(`.pane[data-id="${paneDomId}"]`);
    await expect(gridPane.locator('.pane-task-title-pr')).toHaveClass(/\bmerged\b/);
    await gridPane.locator('.btn-stash').click();

    await ensureSidebarOpen(win);
    const stashItem = win.locator(`.stash-item[data-id="${paneDomId}"]`);
    await expect(stashItem).toBeVisible({ timeout: 10_000 });

    // renderStashItem() が apiPrMerged を渡し忘れると、ここで緑の通常 PR バッジに戻る。
    const prBadge = stashItem.locator('.stash-item-title-row .pane-task-title-pr');
    await expect(prBadge).toHaveClass(/\bmerged\b/);
    await expect(prBadge).toHaveAttribute('aria-label', 'マージ済みのプルリクエストを開く（外部ブラウザ）');
    await expect(prBadge.locator('.pane-task-title-pr-icon')).toHaveText('✓');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('格納カード: ↑↓で並べ替えできる（デグレ確認）', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchStashHeaderApp(port);
  try {
    await waitForTermId(port, '1', true);

    // 2件のペインを stashed で作成する。
    const created1 = await postJson(port, '/api/new-pane', { noClaude: true, stashed: true });
    const termId1 = String(created1.body.termId);
    await waitForTermId(port, termId1, true);
    const paneDomId1 = `pane-${termId1}`;

    const created2 = await postJson(port, '/api/new-pane', { noClaude: true, stashed: true });
    const termId2 = String(created2.body.termId);
    await waitForTermId(port, termId2, true);
    const paneDomId2 = `pane-${termId2}`;

    await ensureSidebarOpen(win);
    await expect(win.locator(`.stash-item[data-id="${paneDomId1}"]`)).toBeVisible({ timeout: 10_000 });
    await expect(win.locator(`.stash-item[data-id="${paneDomId2}"]`)).toBeVisible({ timeout: 10_000 });

    // 並び順を取得するヘルパー。
    const getOrder = () => win.evaluate(() => {
      return Array.from(document.querySelectorAll('.stash-item')).map((li) => li.dataset.id);
    });

    const before = await getOrder();
    const idx1 = before.indexOf(paneDomId1);
    const idx2 = before.indexOf(paneDomId2);
    expect(idx1).toBeGreaterThanOrEqual(0);
    expect(idx2).toBeGreaterThan(idx1); // termId2 は後から stashed されたので termId1 の下にいるはず

    // termId2（下側）を上へ移動する。
    await win.locator(`.stash-item[data-id="${paneDomId2}"] .btn-stash-up`).click();

    const after = await getOrder();
    expect(after.indexOf(paneDomId2)).toBeLessThan(after.indexOf(paneDomId1));
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
