const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// issue #183 / PR #185:
//   ユーザー設定 waitingExcludeCwdPatterns（文字列配列）に部分一致する cwd のペインは、
//   ローカル PTY 出力からの「入力待ち（waiting）」判定の対象外になる。
//   このスペックは、実際に Electron を起動し、シェルへ入力待ちパターンを「出力」させて
//   （タイプするコマンド行そのものにはパターンを含めない）、除外設定の有無で waiting 表示が
//   どう変わるかを検証する。externalWaiting（POST /api/set-status 由来）の経路は本 PR で不変。

const repoRoot = path.resolve(__dirname, '..', '..');

// 入力待ちとして検知させる ASCII パターン。WAITING_PATTERNS の /Proceed\?/i に一致する。
// 日本語パターンだと Playwright のキーボード入力（IME）に依存するため、判定は
// ASCII の "Proceed?" を「スクリプトの出力」として発生させることで安定させる。
const WAITING_MARKER = 'Proceed?';
// 出力が checkWaiting まで到達したことを確認するための後続マーカー。
// タイプするコマンド行には現れず、スクリプトの出力にのみ現れるため、
// これが端末に見えた時点で "Proceed?" も評価済みだと断定できる。
const READY_MARKER = 'RXREADYMARK';

async function getFreePort() {
  // OS に空きポートを割り当てさせ、取得後に閉じて Electron 側で再利用する。
  // 既定ポートを避け、開発中の通常起動インスタンスと衝突させない。
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

// 一時 HOME を用意する（config.json はまだ書かない）。
// loadUserConfig() は os.homedir()（= HOME 環境変数）配下の .vk-terminals/config.json を読むため、
// HOME を一時化することで実ユーザー設定に依存しない。
function makeTempHome() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  fs.mkdirSync(configDir, { recursive: true });
  return { tmpRoot, tmpHome, configPath: path.join(configDir, 'config.json') };
}

// 一時 HOME 配下へ config.json を書き出す。
function writeConfig(configPath, extraConfig) {
  fs.writeFileSync(configPath, JSON.stringify({
    apiHost: '127.0.0.1',
    initialCommand: '',
    agentroom: false,
    additionalPanes: [],
    ...extraConfig,
  }), 'utf8');
}

// 入力待ちパターンを「出力」させるためのシェルスクリプトを書き出す。
// タイプするコマンドはこのスクリプトのパスだけ（= WAITING_MARKER を含まない）なので、
// 入力時の waiting クリアや echo 混入の影響を受けず、出力による検知だけを純粋に見られる。
function writeTriggerScript(tmpRoot) {
  const scriptPath = path.join(tmpRoot, 'trigger.sh');
  fs.writeFileSync(scriptPath, `#!/bin/sh\nprintf '${WAITING_MARKER}\\n'\nprintf '${READY_MARKER}\\n'\n`, 'utf8');
  return scriptPath;
}

async function launchApp(tmpHome, port, extraEnv) {
  return await _electron.launch({
    // claude の有無に依存させないため素のシェルで開く。
    args: ['.', '--no-claude'],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      VK_TERMINALS_API_PORT: String(port),
      // 実行環境から継承される VK_TERMINALS_SETTINGS（vk-orchestrator 等の外部ディスクリプタ）を
      // 打ち消し、常に vk-terminals 組み込みディスクリプタ（本 PR がフィールドを追加した対象）を使わせる。
      VK_TERMINALS_SETTINGS: '',
      ...extraEnv,
    },
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
  const { tmpRoot, tmpHome, configPath } = makeTempHome();
  // 最初のペインの cwd は HOME（= tmpHome）。その一意な一部（一時ディレクトリ名）を
  // 除外パターンに指定することで、シンボリックリンク解決（/tmp→/private/tmp 等）が
  // 起きても部分一致が成立する。
  writeConfig(configPath, { waitingExcludeCwdPatterns: [path.basename(tmpRoot)] });
  const scriptPath = writeTriggerScript(tmpRoot);
  let app;
  try {
    app = await launchApp(tmpHome, port);
    const win = await app.firstWindow();
    const { pane } = await prepareFirstPane(win, port);

    await fireWaitingOutput(win, scriptPath);

    // 出力（Proceed? → RXREADYMARK）が端末に届いたことを確認する。
    // RXREADYMARK が見えた時点で checkWaiting は Proceed? を評価済み。
    const rows = win.locator('.pane .xterm-rows').first();
    await expect(rows).toContainText(READY_MARKER, { timeout: 15_000 });

    // 除外設定が効いていれば、入力待ちパターンを出力しても waiting にならない。
    const status = win.locator('.pane .pane-status').first();
    await expect(pane).not.toHaveClass(/\bwaiting\b/);
    await expect(status).not.toHaveAttribute('data-status', 'waiting');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('除外パターンに一致しない cwd のペインは、従来どおり入力待ち出力で waiting になる', async () => {
  const port = await getFreePort();
  const { tmpRoot, tmpHome, configPath } = makeTempHome();
  // HOME（ペイン cwd）に含まれないパターンにして、除外が発動しない状況をつくる。
  writeConfig(configPath, { waitingExcludeCwdPatterns: ['__never_matches_this_path_zzz__'] });
  const scriptPath = writeTriggerScript(tmpRoot);
  let app;
  try {
    app = await launchApp(tmpHome, port);
    const win = await app.firstWindow();
    const { pane, status } = await prepareFirstPane(win, port);

    await fireWaitingOutput(win, scriptPath);

    // 除外に該当しないため、出力の入力待ちパターンを検知して waiting になる（デグレ確認）。
    await expect(pane).toHaveClass(/\bwaiting\b/, { timeout: 15_000 });
    await expect(status).toHaveAttribute('data-status', 'waiting');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('設定 GUI に「入力待ち判定から除外する cwd パターン」の入力欄が表示される', async () => {
  const port = await getFreePort();
  // VK_TERMINALS_SETTINGS を指定しないので、main は組み込みディスクリプタ（自身の config.json 編集）を使う。
  // 事前に値を書いておき、その値が入力欄（textarea）に反映されることも合わせて確認する。
  const configured = ['/Users/foo/excluded-project', 'sandbox'];
  const { tmpRoot, tmpHome, configPath } = makeTempHome();
  writeConfig(configPath, { waitingExcludeCwdPatterns: configured });
  let app;
  try {
    app = await launchApp(tmpHome, port);
    const win = await app.firstWindow();
    await waitForPtyRegistration(port); // 起動完了を待つ

    // 歯車ボタンから設定モーダルを開く。
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-overlay')).toBeVisible();

    // 該当ラベルを持つ設定行の textarea を特定する（'lines' 型は textarea としてレンダリングされる）。
    const row = win.locator('.settings-row', { hasText: '入力待ち判定から除外する cwd パターン' });
    const textarea = row.locator('textarea');
    await expect(textarea).toBeVisible();

    // config.json の値が改行区切りで復元されていることを確認する。
    await expect(textarea).toHaveValue(configured.join('\n'));
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
