const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #419: config.json の initialEngine / initialCodexModel で、起動時の最初のペインの
// AI エンジン・モデルを選べることを実 Electron で確認する。実バイナリや認証状態に依存しないよう、
// 一時 PATH の先頭に置いた偽 claude / 偽 codex が受け取った引数を JSON Lines で記録して観測する
// （new-pane-engine.smoke.spec.js と同じ手法）。

function createFakeExecutable(root, binName, captureEnvVar) {
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

function setupFakeEngines() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-initial-engine-'));
  const fakeClaude = createFakeExecutable(root, 'claude', 'VK_TERMINALS_E2E_CLAUDE_CAPTURE');
  const fakeCodex = createFakeExecutable(root, 'codex', 'VK_TERMINALS_E2E_CODEX_CAPTURE');
  return {
    root,
    fakeClaude,
    fakeCodex,
    env: {
      PATH: `${fakeClaude.binDir}${path.delimiter}${fakeCodex.binDir}${path.delimiter}${process.env.PATH || ''}`,
      VK_TERMINALS_E2E_CLAUDE_CAPTURE: fakeClaude.capturePath,
      VK_TERMINALS_E2E_CODEX_CAPTURE: fakeCodex.capturePath,
    },
  };
}

async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  return (await res.json()).terminals || {};
}

// 最初のペインの engine が期待値で報告されるまで待つ（report-states は定期報告のため）。
async function waitForFirstPaneEngine(port, expected, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const states = Object.values(await getStates(port));
      last = states.map((t) => t && t.engine);
      if (states.length > 0 && states[0].engine === expected) return;
    } catch (_e) {
      // HTTP サーバー起動前の fetch 失敗は同じ待機ループで吸収する。
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`first pane engine did not become ${expected}; last: ${JSON.stringify(last)}`);
}

async function runWithConfig(config, verify) {
  const port = await getFreePort();
  const fixture = setupFakeEngines();
  let launched = null;
  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-initial-engine-app-',
      env: fixture.env,
      config,
      launchAi: true,
    });
    await verify({ port, fixture, win: launched.win });
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

test('initialEngine / initialCodexModel が未設定なら最初のペインは従来どおり claude を起動する', async () => {
  await runWithConfig({}, async ({ port, fixture }) => {
    const calls = await waitForCallCount(fixture.fakeClaude.capturePath, 1);
    expect(calls[0]).toEqual([]);
    await waitForFirstPaneEngine(port, 'claude');
    expect(readCalls(fixture.fakeCodex.capturePath)).toEqual([]);
  });
});

test('initialEngine: codex なら最初のペインで codex を起動し、claude は起動しない', async () => {
  await runWithConfig({ initialEngine: 'codex' }, async ({ port, fixture }) => {
    const calls = await waitForCallCount(fixture.fakeCodex.capturePath, 1);
    expect(calls[0]).toEqual([]);
    await waitForFirstPaneEngine(port, 'codex');
    expect(readCalls(fixture.fakeClaude.capturePath)).toEqual([]);
  });
});

test('initialCodexModel を指定すると codex --model で起動し、追加ペインも codex を引き継ぐ', async () => {
  await runWithConfig({ initialEngine: 'codex', initialCodexModel: 'gpt-5.5', newPaneAutoLaunchClaude: true }, async ({ port, fixture, win }) => {
    const calls = await waitForCallCount(fixture.fakeCodex.capturePath, 1);
    expect(calls[0]).toEqual(['--model', 'gpt-5.5']);
    await waitForFirstPaneEngine(port, 'codex');

    // 最初のペインの「＋」から追加したペインも、モデル指定なしの codex として起動する。
    await win.locator('.pane .btn-split').first().click();
    const afterSplit = await waitForCallCount(fixture.fakeCodex.capturePath, 2);
    expect(afterSplit[1]).toEqual([]);
    expect(readCalls(fixture.fakeClaude.capturePath)).toEqual([]);
  });
});

test('initialEngine が不正値なら claude へ倒れ、initialCodexModel も無視される', async () => {
  await runWithConfig({ initialEngine: 'gemini', initialCodexModel: 'gpt-5.5' }, async ({ port, fixture }) => {
    const calls = await waitForCallCount(fixture.fakeClaude.capturePath, 1);
    expect(calls[0]).toEqual([]);
    await waitForFirstPaneEngine(port, 'claude');
    expect(readCalls(fixture.fakeCodex.capturePath)).toEqual([]);
  });
});

test('initialEngine が claude のときは initialCodexModel を指定しても claude に --model を渡さない', async () => {
  await runWithConfig({ initialEngine: 'claude', initialCodexModel: 'gpt-5.5' }, async ({ fixture }) => {
    const calls = await waitForCallCount(fixture.fakeClaude.capturePath, 1);
    expect(calls[0]).toEqual([]);
  });
});
