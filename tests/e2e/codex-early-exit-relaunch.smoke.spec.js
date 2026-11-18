const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #621: Codex が起動直後に終了したら、VK Terminals は 1 回だけ起動し直す。
// 実 Electron と実 PTY で、記録してすぐ終了する偽 codex を起動し、
// 「起動し直しが 1 回だけ起き、2 回目は起きない」ことを呼び出し回数で確かめる。
// 他の spec の偽 codex は起動したまま残る（helpers/fake-engine.js）が、この spec だけは
// 起動直後の終了を再現するため、あえてすぐ終了させる。

// Codex が起動直後に終了したとみなす時間（main.js の CODEX_EARLY_EXIT_WINDOW_MS）。
const CODEX_EARLY_EXIT_WINDOW_MS = 5000;

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

// 受け取った引数を JSON Lines で記録して、すぐ終了する偽の実行ファイル。
function createImmediatelyExitingExecutable(root, binName, captureEnvVar) {
  const binDir = path.join(root, 'bin');
  const capturePath = path.join(root, `${binName}-calls.jsonl`);
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, binName), `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.${captureEnvVar}, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o755 });
  return { binDir, capturePath };
}

function readCalls(capturePath) {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function waitForCallCount(capturePath, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const calls = readCalls(capturePath);
    if (calls.length >= expected) return calls;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`fake executable (${capturePath}) was not called ${expected} time(s); last count: ${readCalls(capturePath).length}`);
}

// @title Codex が起動直後に終了したら 1 回だけ起動し直し、2 回目は起動し直さない
test('Codex が起動直後に終了したら 1 回だけ起動し直し、2 回目は起動し直さない', async () => {
  const port = await getFreePort();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-codex-relaunch-'));
  const fakeClaude = createImmediatelyExitingExecutable(fixtureRoot, 'claude', 'VK_TERMINALS_E2E_CLAUDE_CAPTURE');
  const fakeCodex = createImmediatelyExitingExecutable(fixtureRoot, 'codex', 'VK_TERMINALS_E2E_CODEX_CAPTURE');
  let launched = null;

  try {
    // @step 起動してすぐ終了する偽の Codex を使う設定でアプリを起動する
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-codex-relaunch-',
      env: {
        // 偽 claude と偽 codex を PATH の先頭側に置く。
        PATH: `${fakeClaude.binDir}${path.delimiter}${fakeCodex.binDir}${path.delimiter}${process.env.PATH || ''}`,
        VK_TERMINALS_E2E_CLAUDE_CAPTURE: fakeClaude.capturePath,
        VK_TERMINALS_E2E_CODEX_CAPTURE: fakeCodex.capturePath,
        VK_TERMINALS_E2E_GITHUB_REACHABILITY: 'ok',
      },
    });
    await waitForPaneCount(port, 1);

    // @step Codex のペインを 1 枚追加する
    const codexLaunch = await postNewPane(port, { engine: 'codex', noClaude: false });
    expect(codexLaunch.status).toBe(200);
    expect(codexLaunch.body && codexLaunch.body.ok).toBe(true);
    await waitForPaneCount(port, 2);

    // @check Codex がすぐ終了すると、同じ引数でもう 1 回だけ起動し直される
    const calls = await waitForCallCount(fakeCodex.capturePath, 2);
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(calls[0]);

    // @check 起動し直した Codex がまたすぐ終了しても、それ以上は起動し直さない
    // （起動し直し後の終了も「起動直後」とみなされる時間を過ぎるまで待ち、件数が増えないことを見る）
    await new Promise((resolve) => setTimeout(resolve, CODEX_EARLY_EXIT_WINDOW_MS + 1500));
    expect(readCalls(fakeCodex.capturePath)).toHaveLength(2);

    // @check 起動し直しの間もペインは閉じずに残る
    expect(await getPaneCount(port)).toBe(2);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
