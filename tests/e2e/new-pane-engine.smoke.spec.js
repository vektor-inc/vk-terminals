const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #367: POST /api/new-pane の engine 指定を実 Electron で統合確認する。
// HTTP の入力検証だけでなく、renderer への引き渡し、PTY へ書かれたコマンドまで通す。
// tests/e2e/new-pane-model.smoke.spec.js（偽 claude を使う既存 spec）と同じ手法で、
// 今回は偽 codex を PATH の先頭に置いて観測する。

// GET /api/states を叩き、現在のペイン数を返す。
async function getPaneCount(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return Object.keys(json.terminals || {}).length;
}

// API サーバー起動直後や renderer の定期報告待ちを吸収し、指定したペイン数になるまで待つ。
async function waitForPaneCount(port, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastCount = null;
  while (Date.now() < deadline) {
    try {
      lastCount = await getPaneCount(port);
      if (lastCount === expected) return;
    } catch (_e) {
      // HTTP サーバー起動前の fetch 失敗は同じ待機ループで吸収する。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`pane count did not become ${expected}; last count: ${lastCount}`);
}

async function postNewPane(port, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/api/new-pane`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// 一時 PATH の先頭へ置く偽 claude / 偽 codex。実バイナリや認証状態に依存せず、PTY の
// シェルが受け取った引数だけを JSON Lines で記録する。
function createFakeExecutable(root, binName, captureEnvVar) {
  const binDir = path.join(root, 'bin');
  const capturePath = path.join(root, `${binName}-calls.jsonl`);
  const executablePath = path.join(binDir, binName);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(executablePath, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.${captureEnvVar}, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o755 });
  return { binDir, capturePath };
}

async function waitForCalls(capturePath, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(capturePath)) {
      const calls = fs.readFileSync(capturePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      if (calls.length >= expected) return calls;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fake executable was not called ${expected} time(s)`);
}

// main プロセスの console 呼び出しを蓄積する（Playwright の
// electronApp.on('console')。ElectronApplication は main プロセス内の console API
// 呼び出しをこのイベントで中継する。renderer 側の window.on('console') とは別物）。
// 安藤の指摘（必須3）: HTTP 受け口が model を無視したときに実際に console.warn が
// 出ることを、main.js を直接 require できない e2e 環境で確認するために使う。
function captureMainProcessConsole(app) {
  const lines = [];
  app.on('console', (msg) => {
    try {
      lines.push(`[${msg.type()}] ${msg.text()}`);
    } catch (_e) {
      // ConsoleMessage の読み取り自体が失敗しても spec を落とさない（無視）。
    }
  });
  return { text: () => lines.join('\n') };
}

// captureMainProcessConsole が蓄積したテキストのうち、pattern（g フラグ付き）に
// 一致する件数を返す純粋関数。
function countConsoleMatches(capture, pattern) {
  return (capture.text().match(pattern) || []).length;
}

// 一致件数が expectedMinimum 以上になるまで待つ。
//
// 単純な「含まれるか（includes）」判定にしない理由（安藤の指摘・修正2）: このテストは
// 同じ警告文言（"model is ignored for engine 'codex'"）を複数のリクエストで繰り返し
// 検証する。captureMainProcessConsole は起動から今までの全 console 出力を蓄積し続ける
// ため、「含まれるか」だけを見ると、1つ前のリクエストで既に出た警告がバッファに残って
// いるだけで無条件に true になり、「今回のリクエストで新たに警告が出たか」を判定
// できない（植草の指摘：非文字列 model のケースの回帰テストとして機能していなかった）。
// 呼び出し側がリクエスト送信前の件数を記録し、送信後に「件数が +1 以上になったか」を
// 確認する形にすることで、各リクエストごとに新規の警告が出たことを保証する。
async function waitForConsoleMatchCountAtLeast(capture, pattern, expectedMinimum, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (countConsoleMatches(capture, pattern) >= expectedMinimum) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

// "model is ignored for engine 'codex'" 警告の出現回数を数えるための g フラグ付きパターン。
const MODEL_IGNORED_FOR_CODEX_PATTERN = /model is ignored for engine 'codex'/g;

test('POST /api/new-pane は engine を許可リストで検証し、codex を安全に起動する', async () => {
  const port = await getFreePort();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-engine-fixture-'));
  const fakeClaude = createFakeExecutable(fixtureRoot, 'claude', 'VK_TERMINALS_E2E_CLAUDE_CAPTURE');
  const fakeCodex = createFakeExecutable(fixtureRoot, 'codex', 'VK_TERMINALS_E2E_CODEX_CAPTURE');
  // engine: "codex" のときに model が無視されることの証明用マーカー（安藤の指摘・必須4）。
  // 他 spec（new-pane-model.smoke.spec.js）のマーカーと衝突しないよう専用の接頭辞を使う。
  const injectionMarkerPath = path.join(os.tmpdir(), `vk-pwned-engine-${process.pid}-${Date.now()}`);
  let launched = null;

  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-engine-',
      env: {
        // 偽 claude と偽 codex を同じ PATH に共存させる（どちらのディレクトリも先頭側）。
        PATH: `${fakeClaude.binDir}${path.delimiter}${fakeCodex.binDir}${path.delimiter}${process.env.PATH || ''}`,
        VK_TERMINALS_E2E_CLAUDE_CAPTURE: fakeClaude.capturePath,
        VK_TERMINALS_E2E_CODEX_CAPTURE: fakeCodex.capturePath,
      },
    });
    const consoleCapture = captureMainProcessConsole(launched.app);

    // 起動直後の既定ペインが states に載るまで待ち、以降の「増えていない」の基準にする。
    await waitForPaneCount(port, 1);

    // 許可リストに無い値は 400。ペインは作られない。
    const invalidEngine = await postNewPane(port, { engine: 'gemini' });
    expect(invalidEngine).toEqual({
      status: 400,
      body: { error: 'invalid engine (allowed: "claude", "codex")' },
    });
    expect(await getPaneCount(port)).toBe(1);

    // 空文字も拒否。
    const emptyEngine = await postNewPane(port, { engine: '' });
    expect(emptyEngine).toEqual({
      status: 400,
      body: { error: 'invalid engine (allowed: "claude", "codex")' },
    });
    expect(await getPaneCount(port)).toBe(1);

    // 文字列以外も拒否。
    const nonStringEngine = await postNewPane(port, { engine: 42 });
    expect(nonStringEngine).toEqual({
      status: 400,
      body: { error: 'invalid engine (allowed: "claude", "codex")' },
    });
    expect(await getPaneCount(port)).toBe(1);

    // engine: "codex" が実 PTY で素の codex コマンド（引数なし）を起動する。
    const codexLaunch = await postNewPane(port, { engine: 'codex', noClaude: false });
    expect(codexLaunch.status).toBe(200);
    expect(codexLaunch.body && codexLaunch.body.ok).toBe(true);
    await waitForPaneCount(port, 2);
    const codexCalls = await waitForCalls(fakeCodex.capturePath, 1);
    expect(codexCalls[0]).toEqual([]);

    // ★中心リスク（安藤の指摘・必須4）: engine が codex のときに model がただ「無視
    // される」だけでなく、シェルメタ文字を含む危険な値が実際に捨てられている（起動
    // コマンドへ一切混入しない）ことを実 PTY で証明する。正当な値（'sonnet' 等）だけの
    // 確認では、危険な値が捨てられることの証明にはならない。
    const injectionPayload = `sonnet; touch ${injectionMarkerPath}`;
    const warningCountBeforeInjection = countConsoleMatches(consoleCapture, MODEL_IGNORED_FOR_CODEX_PATTERN);
    const codexWithInjectedModel = await postNewPane(port, {
      engine: 'codex',
      model: injectionPayload,
      noClaude: false,
    });
    // 400 にはしない（★ユーザー承認済みの中心仕様）。
    expect(codexWithInjectedModel.status).toBe(200);
    expect(codexWithInjectedModel.body && codexWithInjectedModel.body.ok).toBe(true);
    await waitForPaneCount(port, 3);
    const codexCallsAfterInjection = await waitForCalls(fakeCodex.capturePath, 2);
    // 2回目の呼び出しも引数なし＝model の中身（危険な値を含む）が起動コマンドへ一切
    // 混入していないこと。
    expect(codexCallsAfterInjection[1]).toEqual([]);
    // シェルに渡っていれば実行されたはずの `touch` が実行されていないこと。
    expect(fs.existsSync(injectionMarkerPath)).toBe(false);
    // model が codex の引数として渡っていないこと（誤って claude 用の --model が付かない）。
    expect(fs.existsSync(fakeClaude.capturePath)).toBe(false);
    // 安藤・植草の指摘（必須2・必須3）: HTTP 受け口は model を無視した時点で
    // console.warn を出す（terminal:create の modelIgnored 判定とは別に、ここで
    // 即座に出ることを確認する）。今回のリクエストで新たに警告が1件以上増えたことを
    // 出現回数で確認する（修正2：単純な includes 判定だと後続ケースが無条件に true に
    // なってしまうため）。
    expect(await waitForConsoleMatchCountAtLeast(
      consoleCapture,
      MODEL_IGNORED_FOR_CODEX_PATTERN,
      warningCountBeforeInjection + 1,
    )).toBe(true);

    // 植草の指摘（必須2・必須3）: model が文字列以外（数値）でも、型を問わず
    // 警告ログが出ることを確認する。旧実装は `typeof parsed.model === 'string'` の
    // ときしか requestedModel に載らず、非文字列だと警告が一切出ないバグがあった。
    const warningCountBeforeNonString = countConsoleMatches(consoleCapture, MODEL_IGNORED_FOR_CODEX_PATTERN);
    const codexWithNonStringModel = await postNewPane(port, {
      engine: 'codex',
      model: 12345,
      noClaude: false,
    });
    expect(codexWithNonStringModel.status).toBe(200);
    await waitForPaneCount(port, 4);
    const codexCallsAfterNonString = await waitForCalls(fakeCodex.capturePath, 3);
    expect(codexCallsAfterNonString[2]).toEqual([]);
    // ここが修正2の本題: 直前の注入ケースで既にバッファへ残っている同じ警告文言に
    // 引きずられず、このリクエスト固有の新規警告が出たことを出現回数で確認する。
    expect(await waitForConsoleMatchCountAtLeast(
      consoleCapture,
      MODEL_IGNORED_FOR_CODEX_PATTERN,
      warningCountBeforeNonString + 1,
    )).toBe(true);

    // engine 未指定は従来どおり claude が起動する（既存呼び出し元は非影響）。
    const defaultEngine = await postNewPane(port, { noClaude: false });
    expect(defaultEngine.status).toBe(200);
    await waitForPaneCount(port, 5);
    const claudeCalls = await waitForCalls(fakeClaude.capturePath, 1);
    expect(claudeCalls[0]).toEqual([]);

    // engine: "claude" を明示した場合も model が有効（従来の #310 仕様と両立）。
    const explicitClaudeWithModel = await postNewPane(port, {
      engine: 'claude',
      model: 'opus',
      noClaude: false,
    });
    expect(explicitClaudeWithModel.status).toBe(200);
    await waitForPaneCount(port, 6);
    const claudeCallsWithModel = await waitForCalls(fakeClaude.capturePath, 2);
    expect(claudeCallsWithModel[1]).toEqual(['--model', 'opus']);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    // テスト失敗時も注入確認用マーカーを残さない（作られていた場合は assertion が
    // 先に FAIL する）。
    fs.rmSync(injectionMarkerPath, { force: true });
  }
});
