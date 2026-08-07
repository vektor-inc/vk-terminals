const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');
// 静止ゲートの長さは実装（renderer/waitingState.js）から直接引く。spec 側に数値を
// 書き写すと、実装を変えたときにテストだけが古い前提のまま通ってしまうため（issue #270）。
const { WAITING_QUIESCENCE_MS } = require('../../renderer/waitingState');

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

// 出力がバッファ（lastLines）へ到達したことを確認するための後続マーカー。
// タイプするコマンド行には現れず、スクリプトの出力にのみ現れる。
const READY_MARKER = 'RXREADYMARK';
// 出力が静止してから判定されるまでの時間（renderer/waitingState.js の
// WAITING_QUIESCENCE_MS = 1500ms）。「waiting にならないこと」を確かめる側は、
// 判定前に見て通ってしまわないよう、静止時間より十分長く待ってから確認する。
const QUIESCENCE_SETTLE_MS = 4000;

// 現在画面に出ているペインの termId を /api/states から引き直す。
// win.reload() のたびに renderer は initApp() で terminal:create をやり直すが、
// main.js の nextId（main.js:1261）はモジュール変数で単調増加しリセットされない。
// また reload 前の PTY は terminal:kill されずに main の ptys に孤児として残るため、
// 固定値 '1' を使うと 2 回目以降の reload 後は「今は存在しない古い PTY」を指してしまい、
// しかもそれが孤児として残っている間は /api/set-status が 200 を返し続ける
// （404 分岐を通らない）ため、テスト側は気づけない。
async function currentTermId(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  const ids = Object.values(json.terminals || {})
    .map((t) => (t && t.termId != null ? String(t.termId) : null))
    .filter(Boolean);
  if (ids.length !== 1) throw new Error(`ペインが 1 枚である前提が崩れた: ${JSON.stringify(ids)}`);
  return ids[0];
}

async function postSetStatus(port, termId, waiting) {
  const response = await fetch(`http://127.0.0.1:${port}/api/set-status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId, waiting }),
  });
  let body = null;
  try { body = await response.json(); } catch (_e) { /* 非 JSON も許容 */ }
  return { response, body };
}

// 「現在のペインの PTY が /api/set-status に 200 を返す」まで待つ。
// 固定 termId で待つと、孤児化した旧 PTY にも 200 が返ってしまい待機が空振りする
// （現在のペインの登録を待ったことにならない）ため、termId 自体を states から
// 都度引き直しながら待つ形にしている。
async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const termId = await currentTermId(port);
      const result = await postSetStatus(port, termId, true);
      if (result.response.status === 200) return termId;
      lastError = new Error(`termId ${termId} not ready: ${result.response.status} ${JSON.stringify(result.body)}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('現在のペインの PTY が時間内に登録されなかった');
}

// config の waitingExcludeCwdPatterns には「絶対に一致しない」値を入れ、cwd 除外が
// 発動しない（＝ waiting 判定が素通しで効く）状況を明示的に作る。
const NO_CWD_EXCLUSION = { waitingExcludeCwdPatterns: ['__never_matches_this_path_zzz__'] };

// 任意の本文を「出力」させるシェルスクリプトを書き出す。
// 本文の後に READY_MARKER を出して、判定バッファまで到達したことを検知できるようにする。
function writeEchoScript(tmpRoot, name, bodyLines) {
  const scriptPath = path.join(tmpRoot, name);
  const body = bodyLines.map((line) => `printf '%s\\n' ${JSON.stringify(line)}`).join('\n');
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\nprintf '%s\\n' '${READY_MARKER}'\n`, 'utf8');
  return scriptPath;
}

// 一時 HOME（loadUserConfig() が読む .vk-terminals/config.json の置き場）の用意と、
// claude の有無に依存させない素のシェル（--no-claude）での起動はヘルパーが行う。
// 実行環境から継承される VK_TERMINALS_SETTINGS の打ち消しもヘルパーの既定なので、
// 常に組み込みディスクリプタが使われる。
async function launchWaitingApp(port) {
  return await launchApp({
    port,
    // 元は共通の 'vk-terminals-e2e-' だったが、失敗時に取り残しの出どころが分かるよう
    // spec 名を含む接頭辞にしている。
    prefix: 'vk-terminals-e2e-waiting-quiescence-',
    config: NO_CWD_EXCLUSION,
  });
}

// 現在のペインを準備完了状態にし、externalWaiting をクリアしてローカル判定だけの初期状態にする。
async function prepareFirstPane(win, port) {
  const termId = await waitForPtyRegistration(port); // このプローブは externalWaiting=true を立てる
  const cleared = await postSetStatus(port, termId, false);
  expect(cleared.response.status).toBe(200);

  const pane = win.locator('.pane').first();
  const status = win.locator('.pane .pane-status').first();
  // 起点は「入力待ちではない」ことを確認しておく。
  await expect(pane).not.toHaveClass(/\bwaiting\b/);
  await expect(status).not.toHaveAttribute('data-status', 'waiting');
  return { pane, status, termId };
}

// 端末へフォーカスし、スクリプトを実行して本文を「出力」させる。
async function runScript(win, scriptPath) {
  const screen = win.locator('.pane .xterm-screen').first();
  await expect(screen).toBeVisible();
  await screen.click(); // xterm の隠し textarea へフォーカスを移す
  await win.keyboard.type(`sh ${scriptPath}`);
  await win.keyboard.press('Enter');
}

// ─── 静止ゲートの検証（issue #270）─────────────────────────────────────────────
//
// レンダラは waiting が点灯した瞬間に、「点灯した時刻」と「その時点の最終出力時刻
// （静止ゲートのタイマーを張る起点）」を記録している（renderer/app.js の
// localWaitingOnset）。ここではその記録を読むだけで、**テスト側では時刻を一切計測しない**。
//
// なぜテスト側で測らないのか:
//   旧実装は「READY_MARKER が画面に出たのを見た時刻」と「waiting クラスが付いたのを
//   見た時刻」を 25ms ポーリングで測り、その差に下限 1000ms を置いていた。どちらも
//   「テストが観測した時刻」であって出力やゲートの時刻ではないため、高負荷（CI の
//   オーバーサブスクライブ）では次の理由で下限を割る。
//     - 計測は runScript() の後に始まる 1 本のループで、2 つの時刻を同じイテレーションで
//       判定する。最初の一周に入るまで（CDP 往復や 25ms タイマーの遅延で）1.5 秒以上
//       スタックすると、その一周で両方が同時に立って差は 0 になる。
//     - 取り得る最小値が 0 である以上、下限をいくつに置いても原理的に落ちうる。
//       「下限を緩める」対処では直らない（検出力が落ちるだけ）。
//   レンダラ内部の記録は、点灯そのものと同じクロックで、点灯の瞬間に確定した値なので、
//   観測開始の遅れにもポーリング粒度にも一切依存しない。
//
// ⚠ クロックを混ぜないこと。
//   記録されている 2 値はどちらも Date.now() 系（renderer/app.js の lastOutputTime は
//   Date.now() ベース）。ここに performance.now() を持ち込むと performance.timeOrigin
//   ぶん（数百万 ms）ずれ、「WAITING_QUIESCENCE_MS 以上」が常に真になって、
//   **落ちないまま無意味な検証になる**。差を取ってよいのはレンダラ由来の 2 値どうしだけ。

// 最初のペインの点灯記録を読む。未点灯なら null。
async function readLocalWaitingOnset(win) {
  return await win.evaluate(() => {
    const paneId = document.querySelector('.pane')?.dataset?.id;
    if (!paneId || typeof window.getLocalWaitingOnset !== 'function') return null;
    return window.getLocalWaitingOnset(paneId);
  });
}

// baseline より後に記録された点灯かどうか。baseline が null（まだ一度も点いていない）なら
// 記録が現れた時点で新しい。
function isNewerOnset(onset, baseline) {
  if (!onset) return false;
  if (!baseline) return true;
  return onset.at > baseline.at;
}

// baseline より新しい点灯記録が現れるまで待つ。時間切れなら null を返す。
// ここでの Date.now() は待ち時間の打ち切り用であって、検証する値の計測には使っていない
// （計測はレンダラ側で完結している）。
async function waitForLocalWaitingOnset(win, baseline, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const onset = await readLocalWaitingOnset(win);
    if (isNewerOnset(onset, baseline)) return onset;
    await win.waitForTimeout(50);
  }
  return null;
}

// issue #348: 4 テストとも同じ config（NO_CWD_EXCLUSION 固定）で launchApp を
// 呼んでいるため、起動を 1 回に共有する。各テストの先頭で win.reload() して
// #sidebar の再描画を待つが、これは renderer 側の DOM・JS 状態を初期化するだけで、
// main プロセス側の PTY の生死には影響しない点に注意（安藤のレビュー指摘）。
//
// win.reload() すると renderer は initApp() で新しい PTY を terminal:create するが、
// main.js の nextId（main.js:1261）はモジュール変数で単調増加してリセットされないため、
// termId は '1' → '2' → '3' … と reload ごとに進む。しかも reload 前の PTY は
// terminal:kill されずに main の ptys に「孤児」として残る（renderer 側の破棄ループは
// reload 後の空の terminals に対して回るため、古い PTY には触れない）。孤児は
// closeApp() の cleanupPtys() で最終的に回収されるが、テスト実行中は生き続け、
// /api/set-status のような termId 指定 API は孤児の termId にも 200 を返してしまう
// （main.js:1972 の 404 分岐は「ptys に存在しない」ときだけ通るため）。
// したがって termId を固定値で扱うテストは、孤児の PTY を誤って掴んでも気づけない
// （postSetStatus は 200 を返すが、renderer 側の受け口は該当ペインが無いので黙って
// 握り潰す）。そのため各操作の直前で currentTermId() / waitForPtyRegistration() を
// 使って /api/states から「今画面に出ているペイン」の termId を都度引き直している。
test.describe.serial('入力待ちの静止判定・自動解除（issue vektor-inc/vk-orchestrator#212 / PR #264）', () => {
  let app;
  let win;
  let tmpRoot;
  let port;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchWaitingApp(port));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  test('本物の確認待ち（Proceed?）は、出力が静止してから waiting になる', async () => {
    // WAITING_PATTERNS の /Proceed\?/i に一致する ASCII の確認待ち文言。
    const scriptPath = writeEchoScript(tmpRoot, 'prompt-ascii.sh', ['Proceed?']);
    const { pane, status } = await prepareFirstPane(win, port);

    // スクリプトを流す前に既存の点灯記録を控える。起動直後のシェルプロンプトが偶然
    // WAITING_PATTERNS に一致して一度点灯・解除していた場合に、その古い記録を掴んで
    // しまわないようにするため、ベースラインは必ず runScript() の前に取る。
    const baseline = await readLocalWaitingOnset(win);

    await runScript(win, scriptPath);

    // 点灯が来ること自体の検証は、この待機がタイムアウトしないことで足りる。
    const onset = await waitForLocalWaitingOnset(win, baseline);
    expect(onset, '待機時間内にローカル判定の点灯が記録されなかった').not.toBeNull();

    // 静止ゲートが効いていること。点灯時刻とその時点の最終出力時刻の差が
    // WAITING_QUIESCENCE_MS 以上なら、「出力が静止してから点いた」ことになる。
    // 出力のたびに判定していた旧挙動なら、この差はほぼ 0 になるので確実に落ちる。
    // 高負荷ではタイマーの発火が遅れて差は**大きくなる側にしか動かない**ため、
    // この下限は負荷に依らず成立する（上限を置かないのはこのため。上限を残すと
    // 今度は負荷で伸びた側で落ちる）。
    //
    // ⚠ この主張が正当に落ちうるケース: 極端な負荷で PTY のチャンク配送が 3.5 秒以上に
    //   伸びると、静止（1.5 秒）に到達する前に上限評価（WAITING_MAX_EVAL_INTERVAL_MS =
    //   5 秒）が先に走る。上限評価でもマッチすれば点灯する（waitingState.js の
    //   nextWaitingState）ので、その瞬間の差は定義上 1.5 秒未満になる。もしこれが
    //   観測されたら、対処は「下限を緩める」ではなく「シナリオをより静かにする」
    //   （Enter 前後に流れる出力を減らし、出力が一息に届くようにする）こと。
    const quiescenceGapMs = onset.at - onset.lastOutputTime;
    expect(
      quiescenceGapMs,
      `点灯時刻 ${onset.at} / 点灯時点の最終出力時刻 ${onset.lastOutputTime}`,
    ).toBeGreaterThanOrEqual(WAITING_QUIESCENCE_MS);

    await expect(pane).toHaveClass(/\bwaiting\b/);
    await expect(status).toHaveAttribute('data-status', 'waiting');
    // バッジの文言も確認する（橙の「入力待ち」表示）。
    await expect(status).toHaveText('入力待ち');
  });

  test('本物の確認待ち（日本語「入力をお待ちしています。」）も waiting になる', async () => {
    // 許可リスト方式の待ち対象名詞「入力」に一致するユーザー宛ての確認待ち文言。
    const scriptPath = writeEchoScript(tmpRoot, 'prompt-ja.sh', ['入力をお待ちしています。']);
    const { pane, status } = await prepareFirstPane(win, port);

    await runScript(win, scriptPath);

    const rows = win.locator('.pane .xterm-rows').first();
    await expect(rows).toContainText(READY_MARKER, { timeout: 15_000 });
    // 静止してから判定が走るので、点灯まで最大 1.5 秒程度かかる。
    await expect(pane).toHaveClass(/\bwaiting\b/, { timeout: 15_000 });
    await expect(status).toHaveAttribute('data-status', 'waiting');
  });

  test('第三者宛ての進捗ナレーション（「〜の修正を待っています。」）では waiting にならない', async () => {
    // 待つ対象が「修正」= 第三者（サブエージェント）の成果物なので、
    // 許可リスト（入力・選択・承認…）に載っておらず一致してはいけない。
    const scriptPath = writeEchoScript(tmpRoot, 'narration.sh', [
      '麗美の分は受領済みです。和田の修正を待っています。',
      'CI の完了を待っています。',
      'サブエージェントの応答を待っています',
    ]);
    const { pane, status } = await prepareFirstPane(win, port);

    await runScript(win, scriptPath);

    // 出力が判定バッファまで到達したことを確認する。
    const rows = win.locator('.pane .xterm-rows').first();
    await expect(rows).toContainText(READY_MARKER, { timeout: 15_000 });
    // 静止判定が走る時間を十分に過ぎるまで待ってから確認する。
    await win.waitForTimeout(QUIESCENCE_SETTLE_MS);

    await expect(pane).not.toHaveClass(/\bwaiting\b/);
    await expect(status).not.toHaveAttribute('data-status', 'waiting');
  });

  test('waiting 点灯後にユーザー入力なしで出力を流し続けると、出力量に依らず上限間隔で自動解除される', async () => {
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
  });
});
