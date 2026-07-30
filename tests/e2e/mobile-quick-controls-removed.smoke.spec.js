const { test, expect, chromium } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #181 / PR #182: モバイル版ターミナルカード下部の未使用クイック入力ボタン群
// （1/2/3/↵ Enter, Yes(y↵)/No(n↵)/Esc/Ctrl-C）を削除した変更の end-to-end 確認。
//   削除確認: .actions 内にクイックボタン（kill を除く button.k）が 1 つも無いこと。
//   残存確認: 自由入力欄（.sendrow の input + 送信ボタン）・改行トグル
//             （.nl-toggle）・終了ボタン（button.k.kill）が従来どおり存在すること。
// 起動パターンは close-pane.smoke.spec.js 等のモバイル系 smoke を踏襲する。

// GET /api/states を叩き、terminals（paneId -> state）を返す。
async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return json.terminals || {};
}

// states 内に存在する termId の一覧（文字列）を返す。
function termIdsOf(states) {
  return Object.values(states)
    .map((t) => (t && t.termId != null ? String(t.termId) : null))
    .filter(Boolean);
}

// 指定 termId が states に現れるまで短くリトライして待つ。
// report-states は renderer 側で 2 秒ごとに送られるため、猶予を持って待機する。
async function waitForTermId(port, termId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      const ids = termIdsOf(states);
      lastSeen = ids;
      if (ids.includes(String(termId))) return ids;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`termId ${termId} did not appear in time. last states: ${JSON.stringify(lastSeen)}`);
}

// 一時 HOME を用意して Electron を素のシェル（--no-claude）で起動する。
async function launchQuickControlsApp(port) {
  return await launchApp({ port, prefix: 'vk-terminals-e2e-quick-' });
}

// ─── 削除確認: クイック入力ボタン群がカード内に 1 つも存在しないこと ───
test('モバイル: 未使用クイック入力ボタン（1/2/3/Enter, Yes/No/Esc/Ctrl-C）が削除されている', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchQuickControlsApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    // 起動直後の最初のペインのカードが描画されるまで待つ。
    const card = page.locator('.card', { hasText: 'Terminal 1' });
    await expect(card).toBeVisible({ timeout: 15_000 });

    // .actions 内のクイックボタン（kill を除く button.k）が 0 個であること。
    // 旧実装では .actions > .row > button.k として 8 個描画されていた。
    const quickButtons = card.locator('.actions button.k:not(.kill)');
    await expect(quickButtons).toHaveCount(0);

    // 削除したボタンのラベルが 1 つも UI 上に存在しないこと（テキストベースの保険）。
    const removedLabels = ['1', '2', '3', '↵ Enter', 'Yes (y↵)', 'No (n↵)', 'Esc', 'Ctrl-C'];
    for (const label of removedLabels) {
      await expect(
        card.locator('.actions button', { hasText: new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) })
      ).toHaveCount(0);
    }

    // 旧クイックボタン専用の様式クラスも残っていないこと。
    await expect(card.locator('.actions button.k.yes')).toHaveCount(0);
    await expect(card.locator('.actions button.k.no')).toHaveCount(0);
    await expect(card.locator('.actions button.k.stop')).toHaveCount(0);
  } finally {
    await browser.close();
    await closeApp({ app, tmpRoot });
  }
});

// ─── 残存確認: 自由入力欄・改行トグル・終了ボタンが従来どおり存在すること ───
test('モバイル: 自由入力欄・改行トグル・終了ボタンは残存し、レイアウトが崩れていない', async () => {
  const port = await getFreePort();
  const { app, tmpRoot } = await launchQuickControlsApp(port);
  const browser = await chromium.launch();
  try {
    await waitForTermId(port, '1');

    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 390, height: 844 },
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`);

    const card = page.locator('.card', { hasText: 'Terminal 1' });
    await expect(card).toBeVisible({ timeout: 15_000 });

    // (1) 自由入力欄: .sendrow の input（placeholder=コマンド/テキスト）と送信ボタン。
    const sendInput = card.locator('.sendrow input');
    await expect(sendInput).toBeVisible();
    await expect(sendInput).toHaveAttribute('placeholder', 'コマンド/テキスト');
    const sendBtn = card.locator('.sendrow button');
    await expect(sendBtn).toBeVisible();
    await expect(sendBtn).toHaveText('送信');

    // (2) 改行トグル: 既定でチェック済みのチェックボックス + ラベル文言。
    const nlToggle = card.locator('.nl-toggle input[type="checkbox"]');
    await expect(nlToggle).toBeVisible();
    await expect(nlToggle).toBeChecked();
    await expect(card.locator('.nl-toggle')).toContainText('末尾に改行(↵)を付ける');

    // (3) 終了ボタン: 破壊的操作の全幅赤ボタン（button.k.kill）。
    const killBtn = card.locator('button.k.kill');
    await expect(killBtn).toBeVisible();
    await expect(killBtn).toHaveText('✕ ターミナルを終了');

    // レイアウト確認: 残存要素が縦方向に重ならず順序どおり（入力欄 → トグル → 終了ボタン）に並ぶ。
    const inputBox = await sendInput.boundingBox();
    const toggleBox = await card.locator('.nl-toggle').boundingBox();
    const killBox = await killBtn.boundingBox();
    expect(inputBox && toggleBox && killBox).toBeTruthy();
    // 入力欄の下端 <= トグルの上端付近（多少の重なり許容なし: 縦積み順を担保）。
    expect(toggleBox.y).toBeGreaterThanOrEqual(inputBox.y);
    expect(killBox.y).toBeGreaterThanOrEqual(toggleBox.y);
    // 終了ボタンはカード幅いっぱいに近い全幅であること（極端に潰れていない）。
    const cardBox = await card.boundingBox();
    expect(killBox.width).toBeGreaterThan(cardBox.width * 0.6);
  } finally {
    await browser.close();
    await closeApp({ app, tmpRoot });
  }
});
