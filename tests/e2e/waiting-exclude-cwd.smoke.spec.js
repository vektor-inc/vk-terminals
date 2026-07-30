const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #183 / PR #185:
//   ユーザー設定 waitingExcludeCwdPatterns（文字列配列）に部分一致する cwd のペインは、
//   ローカル PTY 出力からの「入力待ち（waiting）」判定の対象外になる。
//   このスペックは、実際に Electron を起動し、シェルへ入力待ちパターンを「出力」させて
//   （タイプするコマンド行そのものにはパターンを含めない）、除外設定の有無で waiting 表示が
//   どう変わるかを検証する。externalWaiting（POST /api/set-status 由来）の経路は本 PR で不変。

// 入力待ちとして検知させる ASCII パターン。WAITING_PATTERNS の /Proceed\?/i に一致する。
// 日本語パターンだと Playwright のキーボード入力（IME）に依存するため、判定は
// ASCII の "Proceed?" を「スクリプトの出力」として発生させることで安定させる。
const WAITING_MARKER = 'Proceed?';
// 出力が waiting 判定の入力（lastLines）まで到達したことを確認するための後続マーカー。
// タイプするコマンド行には現れず、スクリプトの出力にのみ現れる。
const READY_MARKER = 'RXREADYMARK';
// waiting 判定は「最後の PTY 出力から一定時間静止したら」行われる
// （renderer/waitingState.js の WAITING_QUIESCENCE_MS = 1500ms /
//  issue vektor-inc/vk-orchestrator#212）。
// 「waiting にならないこと」を確かめる側は、判定が走る前に見て通ってしまわないよう、
// 静止時間より十分長く待ってから確認する。
const QUIESCENCE_SETTLE_MS = 4000;

async function postSetStatus(port, waiting) {
  // termId "1" は起動時に renderer が作る最初のペインの PTY。
  const response = await fetch(`http://127.0.0.1:${port}/api/set-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId: '1', waiting }),
  });
  let body = null;
  try { body = await response.json(); } catch (_e) { /* 非 JSON も許容 */ }
  return { response, body };
}

async function waitForPtyRegistration(port) {
  // PTY 登録前は main が 404 を返すため、200 になるまで短くリトライする。
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const result = await postSetStatus(port, true);
      if (result.response.status === 200) return;
      if (result.response.status !== 404) {
        throw new Error(`unexpected status ${result.response.status}: ${JSON.stringify(result.body)}`);
      }
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(result.body)}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('terminal 1 was not registered in time');
}

// 入力待ちパターンを「出力」させるためのシェルスクリプトを書き出す。
// タイプするコマンドはこのスクリプトのパスだけ（= WAITING_MARKER を含まない）なので、
// 入力時の waiting クリアや echo 混入の影響を受けず、出力による検知だけを純粋に見られる。
function writeTriggerScript(tmpRoot) {
  const scriptPath = path.join(tmpRoot, 'trigger.sh');
  fs.writeFileSync(scriptPath, `#!/bin/sh\nprintf '${WAITING_MARKER}\\n'\nprintf '${READY_MARKER}\\n'\n`, 'utf8');
  return scriptPath;
}

// 一時 HOME（loadUserConfig() が読む .vk-terminals/config.json の置き場）の用意と、
// claude の有無に依存させない素のシェル（--no-claude）での起動はヘルパーが行う。
// 実行環境から継承される VK_TERMINALS_SETTINGS（vk-orchestrator 等の外部ディスクリプタ）の
// 打ち消しもヘルパーの既定なので、常に vk-terminals 組み込みディスクリプタが使われる。
async function launchWaitingApp(port, config) {
  return await launchApp({
    port,
    // 元は共通の 'vk-terminals-e2e-' だったが、失敗時に取り残しの出どころが分かるよう
    // spec 名を含む接頭辞にしている。
    prefix: 'vk-terminals-e2e-waiting-exclude-',
    config,
  });
}

// 最初のペインを準備完了状態にし、externalWaiting をクリアしてローカル判定だけの初期状態にする。
async function prepareFirstPane(win, port) {
  await waitForPtyRegistration(port); // このプローブは externalWaiting=true を立てる
  // externalWaiting をクリアして、以降 waiting 表示はローカル PTY 検知だけに由来させる。
  const cleared = await postSetStatus(port, false);
  expect(cleared.response.status).toBe(200);

  const pane = win.locator('.pane').first();
  const status = win.locator('.pane .pane-status').first();
  // 起点は「入力待ちではない」ことを確認しておく。
  await expect(pane).not.toHaveClass(/\bwaiting\b/);
  await expect(status).not.toHaveAttribute('data-status', 'waiting');
  return { pane, status };
}

// 端末へフォーカスし、スクリプトを実行して入力待ちパターンを「出力」させる。
async function fireWaitingOutput(win, scriptPath) {
  const screen = win.locator('.pane .xterm-screen').first();
  await expect(screen).toBeVisible();
  await screen.click(); // xterm の隠し textarea へフォーカスを移す
  await win.keyboard.type(`sh ${scriptPath}`);
  await win.keyboard.press('Enter');
}

test('除外パターンに一致する cwd のペインは、入力待ち出力でも waiting にならない', async () => {
  const port = await getFreePort();
  // 最初のペインの cwd は HOME（= tmpHome）。その一意な一部（一時ディレクトリ名）を
  // 除外パターンに指定することで、シンボリックリンク解決（/tmp→/private/tmp 等）が
  // 起きても部分一致が成立する。ディレクトリ名は mkdtemp が決めるため、config は
  // 生成後のパスを受け取る関数で渡す。
  const { app, win, tmpRoot } = await launchWaitingApp(port, ({ tmpRoot }) => ({
    waitingExcludeCwdPatterns: [path.basename(tmpRoot)],
  }));
  const scriptPath = writeTriggerScript(tmpRoot);
  try {
    const { pane } = await prepareFirstPane(win, port);

    await fireWaitingOutput(win, scriptPath);

    // 出力（Proceed? → RXREADYMARK）が端末に届いたことを確認する。
    const rows = win.locator('.pane .xterm-rows').first();
    await expect(rows).toContainText(READY_MARKER, { timeout: 15_000 });
    // 出力が静止してから判定が走るため、その時間を過ぎるまで待ってから確認する。
    await win.waitForTimeout(QUIESCENCE_SETTLE_MS);

    // 除外設定が効いていれば、入力待ちパターンを出力しても waiting にならない。
    const status = win.locator('.pane .pane-status').first();
    await expect(pane).not.toHaveClass(/\bwaiting\b/);
    await expect(status).not.toHaveAttribute('data-status', 'waiting');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('除外パターンに一致しない cwd のペインは、従来どおり入力待ち出力で waiting になる', async () => {
  const port = await getFreePort();
  // HOME（ペイン cwd）に含まれないパターンにして、除外が発動しない状況をつくる。
  const { app, win, tmpRoot } = await launchWaitingApp(port, {
    waitingExcludeCwdPatterns: ['__never_matches_this_path_zzz__'],
  });
  const scriptPath = writeTriggerScript(tmpRoot);
  try {
    const { pane, status } = await prepareFirstPane(win, port);

    await fireWaitingOutput(win, scriptPath);

    // 除外に該当しないため、出力の入力待ちパターンを検知して waiting になる（デグレ確認）。
    await expect(pane).toHaveClass(/\bwaiting\b/, { timeout: 15_000 });
    await expect(status).toHaveAttribute('data-status', 'waiting');
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('設定 GUI に「入力待ち判定から除外する cwd パターン」の入力欄が表示されない', async () => {
  const port = await getFreePort();
  // VK_TERMINALS_SETTINGS は指定しない（ヘルパーが空文字へ中和する）ので、main は
  // 組み込みディスクリプタ（自身の config.json 編集）を使う。
  // 事前に値を書いておき、config.json に既存値があっても GUI 項目としては表示されないことを確認する。
  const { app, win, tmpRoot } = await launchWaitingApp(port, {
    waitingExcludeCwdPatterns: ['/Users/foo/excluded-project', 'sandbox'],
  });
  try {
    await waitForPtyRegistration(port); // 起動完了を待つ

    // 歯車ボタンから設定モーダルを開く。
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-overlay')).toBeVisible();

    // waitingExcludeCwdPatterns は config.json 直編集専用なので、該当ラベルの設定行は描画されない。
    const row = win.locator('.settings-row', { hasText: '入力待ち判定から除外する cwd パターン' });
    await expect(row).toHaveCount(0);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
