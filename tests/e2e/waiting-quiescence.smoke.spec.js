const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// issue vektor-inc/vk-orchestrator#212 / PR #264:
//   「入力待ち」バッジの判定を「PTY 出力が静止した時点」に変更し、
//   解除経路として「出力が流れている最中の非マッチ」を追加した変更の e2e。
//   waiting-exclude-cwd.smoke.spec.js は「除外設定」側の検証なので、こちらは
//   PR #264 の本題である
//     1. 本物の確認待ちを（静止後に）検知すること      … 陽性
//     2. 第三者宛ての進捗ナレーションで検知しないこと  … 陰性（誤検知しない）
//     3. 点灯後に出力を流し続けると自動解除されること  … 張り付き回帰
//   を Electron 上で確認する。
//
//   日本語文字列は Playwright のキーボード入力（IME）に依存すると不安定なため、
//   既存 spec と同様に「スクリプトに出力させる」方式を使う。タイプするコマンド行は
//   スクリプトのパスだけ（ASCII）なので、入力による waiting クリアの影響を受けない。

const repoRoot = path.resolve(__dirname, '..', '..');

// 出力がバッファ（lastLines）へ到達したことを確認するための後続マーカー。
// タイプするコマンド行には現れず、スクリプトの出力にのみ現れる。
const READY_MARKER = 'RXREADYMARK';
// 出力が静止してから判定されるまでの時間（renderer/waitingState.js の
// WAITING_QUIESCENCE_MS = 1500ms）。「waiting にならないこと」を確かめる側は、
// 判定前に見て通ってしまわないよう、静止時間より十分長く待ってから確認する。
const QUIESCENCE_SETTLE_MS = 4000;

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

// 一時 HOME を用意する（loadUserConfig() は HOME 配下の .vk-terminals/config.json を読むため、
// HOME を一時化して実ユーザー設定に依存させない）。
function makeTempHome() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  fs.mkdirSync(configDir, { recursive: true });
  return { tmpRoot, tmpHome, configPath: path.join(configDir, 'config.json') };
}

// 一時 HOME 配下へ config.json を書き出す。
// waitingExcludeCwdPatterns には「絶対に一致しない」値を入れ、cwd 除外が
// 発動しない（＝ waiting 判定が素通しで効く）状況を明示的に作る。
function writeConfig(configPath, extraConfig) {
  fs.writeFileSync(configPath, JSON.stringify({
    apiHost: '127.0.0.1',
    initialCommand: '',
    agentroom: false,
    additionalPanes: [],
    waitingExcludeCwdPatterns: ['__never_matches_this_path_zzz__'],
    ...extraConfig,
  }), 'utf8');
}

// 任意の本文を「出力」させるシェルスクリプトを書き出す。
// 本文の後に READY_MARKER を出して、判定バッファまで到達したことを検知できるようにする。
function writeEchoScript(tmpRoot, name, bodyLines) {
  const scriptPath = path.join(tmpRoot, name);
  const body = bodyLines.map((line) => `printf '%s\\n' ${JSON.stringify(line)}`).join('\n');
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\nprintf '%s\\n' '${READY_MARKER}'\n`, 'utf8');
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
      // 実行環境から継承される VK_TERMINALS_SETTINGS を打ち消し、常に組み込みディスクリプタを使わせる。
      VK_TERMINALS_SETTINGS: '',
      ...extraEnv,
    },
  });
}

// 最初のペインを準備完了状態にし、externalWaiting をクリアしてローカル判定だけの初期状態にする。
async function prepareFirstPane(win, port) {
  await waitForPtyRegistration(port); // このプローブは externalWaiting=true を立てる
  const cleared = await postSetStatus(port, false);
  expect(cleared.response.status).toBe(200);

  const pane = win.locator('.pane').first();
  const status = win.locator('.pane .pane-status').first();
  // 起点は「入力待ちではない」ことを確認しておく。
  await expect(pane).not.toHaveClass(/\bwaiting\b/);
  await expect(status).not.toHaveAttribute('data-status', 'waiting');
  return { pane, status };
}

// 端末へフォーカスし、スクリプトを実行して本文を「出力」させる。
async function runScript(win, scriptPath) {
  const screen = win.locator('.pane .xterm-screen').first();
  await expect(screen).toBeVisible();
  await screen.click(); // xterm の隠し textarea へフォーカスを移す
  await win.keyboard.type(`sh ${scriptPath}`);
  await win.keyboard.press('Enter');
}

// レンダラ内で「READY_MARKER が画面に出た時刻」と「waiting が点灯した時刻」を
// 高頻度ポーリングして計測する。Playwright 側から locator を叩くと IPC 往復で
// 粒度が荒くなるため、ページコンテキストで測る。
async function measureWaitingOnset(win, timeoutMs = 20_000) {
  return await win.evaluate(async ({ readyMarker, timeoutMs }) => {
    const start = performance.now();
    let readyAt = null;
    let waitingAt = null;
    while (performance.now() - start < timeoutMs) {
      const pane = document.querySelector('.pane');
      const rows = document.querySelector('.pane .xterm-rows');
      if (readyAt === null && rows && rows.textContent.includes(readyMarker)) readyAt = performance.now();
      if (waitingAt === null && pane && pane.classList.contains('waiting')) waitingAt = performance.now();
      if (readyAt !== null && waitingAt !== null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    return {
      sawReady: readyAt !== null,
      sawWaiting: waitingAt !== null,
      // waiting が「READY_MARKER 表示から何 ms 後」に点いたか。静止ゲートが効いていれば
      // おおよそ WAITING_QUIESCENCE_MS（1500ms）になる。
      delayFromReadyMs: (readyAt !== null && waitingAt !== null) ? Math.round(waitingAt - readyAt) : null,
    };
  }, { readyMarker: READY_MARKER, timeoutMs });
}

test('本物の確認待ち（Proceed?）は、出力が静止してから waiting になる', async () => {
  const port = await getFreePort();
  const { tmpRoot, tmpHome, configPath } = makeTempHome();
  writeConfig(configPath, {});
  // WAITING_PATTERNS の /Proceed\?/i に一致する ASCII の確認待ち文言。
  const scriptPath = writeEchoScript(tmpRoot, 'prompt-ascii.sh', ['Proceed?']);
  let app;
  try {
    app = await launchApp(tmpHome, port);
    const win = await app.firstWindow();
    const { pane, status } = await prepareFirstPane(win, port);

    await runScript(win, scriptPath);

    // 出力の到達と waiting 点灯の時刻を同時に計測する。
    const measured = await measureWaitingOnset(win);
    expect(measured.sawReady).toBe(true);
    expect(measured.sawWaiting).toBe(true);
    // 静止ゲート（1500ms）が効いていること。出力到達と同時に点いていたら
    // 「出力のたびに判定」の旧挙動なので、下限を置いて退行を検出する。
    // 画面描画のわずかな遅れ（数十 ms）を見込んで下限は 1000ms に緩めてある。
    expect(measured.delayFromReadyMs).toBeGreaterThanOrEqual(1000);
    expect(measured.delayFromReadyMs).toBeLessThan(7000);

    await expect(pane).toHaveClass(/\bwaiting\b/);
    await expect(status).toHaveAttribute('data-status', 'waiting');
    // バッジの文言も確認する（橙の「入力待ち」表示）。
    await expect(status).toHaveText('入力待ち');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('本物の確認待ち（日本語「入力をお待ちしています。」）も waiting になる', async () => {
  const port = await getFreePort();
  const { tmpRoot, tmpHome, configPath } = makeTempHome();
  writeConfig(configPath, {});
  // 許可リスト方式の待ち対象名詞「入力」に一致するユーザー宛ての確認待ち文言。
  const scriptPath = writeEchoScript(tmpRoot, 'prompt-ja.sh', ['入力をお待ちしています。']);
  let app;
  try {
    app = await launchApp(tmpHome, port);
    const win = await app.firstWindow();
    const { pane, status } = await prepareFirstPane(win, port);

    await runScript(win, scriptPath);

    const rows = win.locator('.pane .xterm-rows').first();
    await expect(rows).toContainText(READY_MARKER, { timeout: 15_000 });
    // 静止してから判定が走るので、点灯まで最大 1.5 秒程度かかる。
    await expect(pane).toHaveClass(/\bwaiting\b/, { timeout: 15_000 });
    await expect(status).toHaveAttribute('data-status', 'waiting');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('第三者宛ての進捗ナレーション（「〜の修正を待っています。」）では waiting にならない', async () => {
  const port = await getFreePort();
  const { tmpRoot, tmpHome, configPath } = makeTempHome();
  writeConfig(configPath, {});
  // 待つ対象が「修正」= 第三者（サブエージェント）の成果物なので、
  // 許可リスト（入力・選択・承認…）に載っておらず一致してはいけない。
  const scriptPath = writeEchoScript(tmpRoot, 'narration.sh', [
    '麗美の分は受領済みです。和田の修正を待っています。',
    'CI の完了を待っています。',
    'サブエージェントの応答を待っています',
  ]);
  let app;
  try {
    app = await launchApp(tmpHome, port);
    const win = await app.firstWindow();
    const { pane, status } = await prepareFirstPane(win, port);

    await runScript(win, scriptPath);

    // 出力が判定バッファまで到達したことを確認する。
    const rows = win.locator('.pane .xterm-rows').first();
    await expect(rows).toContainText(READY_MARKER, { timeout: 15_000 });
    // 静止判定が走る時間を十分に過ぎるまで待ってから確認する。
    await win.waitForTimeout(QUIESCENCE_SETTLE_MS);

    await expect(pane).not.toHaveClass(/\bwaiting\b/);
    await expect(status).not.toHaveAttribute('data-status', 'waiting');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test('waiting 点灯後にユーザー入力なしで出力を流し続けると、出力量に依らず上限間隔で自動解除される', async () => {
  const port = await getFreePort();
  const { tmpRoot, tmpHome, configPath } = makeTempHome();
  writeConfig(configPath, {});
  // 「点灯 → 出力継続 → 自動解除」を **1 回のコマンド入力だけ** で再現する。
  // 途中でユーザーがキー入力すると markPaneInput() が waiting を即クリアしてしまい、
  // 「出力による自動解除」を検証したことにならないため、点灯待ちの sleep も
  // バーストもすべて同じスクリプトの中で行う。
  //
  // バーストの間隔について: **わざと遅い（0.2 秒間隔）バーストにしている**。
  // 上限評価が lastLines（80 行ウィンドウ）全体を見ていた頃は、点灯のもとになった
  // 「Proceed?」がウィンドウから押し出されるまで解除できず、この間隔だと 80 行 ≒ 16 秒
  // かかっていた（実測では 60 行流しても解除されないまま）。
  // 現在の実装は上限評価で「前回の評価以降に届いた出力」だけを見るため、解除までの
  // 時間は出力の行数レートに依存せず WAITING_MAX_EVAL_INTERVAL_MS（5 秒）で頭打ちになる。
  const BURST_INTERVAL_SEC = '0.2';
  const BURST_LINES = 80;
  // 解除の上限（ms）。押し出し依存だった頃は 16 秒以上かかっていたので、
  // ここを下回れば「行数レート依存ではない」ことの証明になる。
  const RELEASE_BUDGET_MS = 10_000;
  const scriptPath = path.join(tmpRoot, 'stick.sh');
  fs.writeFileSync(scriptPath, [
    '#!/bin/sh',
    "printf '%s\\n' 'Proceed?'",
    `printf '%s\\n' '${READY_MARKER}'`,
    'sleep 4',                       // 静止 → waiting 点灯
    "printf '%s\\n' 'BURSTSTART'",
    'i=1',
    `while [ "$i" -le ${BURST_LINES} ]; do printf 'line %s\\n' "$i"; sleep ${BURST_INTERVAL_SEC}; i=$((i+1)); done`,
    '',
  ].join('\n'), 'utf8');

  let app;
  try {
    app = await launchApp(tmpHome, port);
    const win = await app.firstWindow();
    const { pane, status } = await prepareFirstPane(win, port);

    await runScript(win, scriptPath);

    // まず sleep 中（出力が静止している間）に waiting が点灯することを確認する。
    await expect(pane).toHaveClass(/\bwaiting\b/, { timeout: 15_000 });
    await expect(status).toHaveAttribute('data-status', 'waiting');

    // ここから先はユーザー入力を一切行わない。バースト開始から解除までの時間を
    // ページコンテキストで測る（Playwright の locator 経由だと IPC 往復で粒度が荒い）。
    const released = await win.evaluate(async ({ timeoutMs }) => {
      const start = performance.now();
      let burstAt = null;
      let releasedAt = null;
      while (performance.now() - start < timeoutMs) {
        const pane = document.querySelector('.pane');
        const rows = document.querySelector('.pane .xterm-rows');
        if (burstAt === null && rows && rows.textContent.includes('BURSTSTART')) burstAt = performance.now();
        if (burstAt !== null && pane && !pane.classList.contains('waiting')) {
          releasedAt = performance.now();
          break;
        }
        await new Promise((r) => setTimeout(r, 25));
      }
      return {
        sawBurst: burstAt !== null,
        released: releasedAt !== null,
        releaseMs: (burstAt !== null && releasedAt !== null) ? Math.round(releasedAt - burstAt) : null,
      };
    }, { timeoutMs: 25_000 });

    expect(released.sawBurst).toBe(true);
    // 自動解除（張り付き回帰の本命）。旧実装ではユーザーが入力するまで解除されなかった。
    expect(released.released).toBe(true);
    // 解除までの時間が上限間隔で頭打ちになっていること（＝押し出し待ちではない）。
    expect(released.releaseMs).toBeLessThan(RELEASE_BUDGET_MS);

    await expect(pane).not.toHaveClass(/\bwaiting\b/);
    await expect(status).not.toHaveAttribute('data-status', 'waiting');
    // 出力が流れている最中の解除なので、idle ではなく running（実行中）へ戻る。
    await expect(status).toHaveAttribute('data-status', 'running');
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
