const { test, expect } = require('@playwright/test');
const childProcess = require('child_process');
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
// タスク用ポリシー（issue #428）の確認用に、起動時の CODEX_HOME も別ファイルへ残す。
fs.appendFileSync(process.env.${captureEnvVar} + '.codex-home', JSON.stringify(process.env.CODEX_HOME || null) + '\\n');
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

test('POST /api/new-pane は engine を許可リストで検証し、codex を安全に起動する', async () => {
  const port = await getFreePort();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-engine-fixture-'));
  const fakeClaude = createFakeExecutable(fixtureRoot, 'claude', 'VK_TERMINALS_E2E_CLAUDE_CAPTURE');
  const fakeCodex = createFakeExecutable(fixtureRoot, 'codex', 'VK_TERMINALS_E2E_CODEX_CAPTURE');
  const markerPath = path.join(os.tmpdir(), `vk-codex-pwned-${process.pid}-${Date.now()}`);
  // タスク用ポリシーは作業フォルダの Git リポジトリに操作を拘束するため、cwd に使う空のリポジトリを用意する。
  const repoDir = path.join(fixtureRoot, 'repo');
  fs.mkdirSync(repoDir);
  childProcess.execFileSync('git', ['init', '-q'], { cwd: repoDir });
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
        VK_TERMINALS_E2E_GITHUB_REACHABILITY: 'ok',
      },
    });
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

    // engine: "codex" が実 PTY で共有 daemon を使わない codex コマンドを起動する。
    const codexLaunch = await postNewPane(port, {
      engine: 'codex', noClaude: false, approvalPolicy: 'never', sandboxMode: 'workspace-write',
    });
    expect(codexLaunch.status).toBe(200);
    expect(codexLaunch.body && codexLaunch.body.ok).toBe(true);
    await waitForPaneCount(port, 2);
    const codexCalls = await waitForCalls(fakeCodex.capturePath, 1);
    expect(codexCalls[0]).toEqual([
      '--no-daemon', '--ask-for-approval', 'never', '--sandbox', 'workspace-write',
    ]);

    const unsafeSandbox = await postNewPane(port, {
      engine: 'codex', sandboxMode: 'danger-full-access',
    });
    expect(unsafeSandbox).toEqual({ status: 400, body: { error: 'invalid sandboxMode' } });
    const claudeOptions = await postNewPane(port, { engine: 'claude', approvalPolicy: 'never' });
    expect(claudeOptions).toEqual({
      status: 400, body: { error: 'Codex options require engine "codex"' },
    });

    // Codex の model も起動コマンドへ入るため、シェルメタ文字を含む値は 400 で拒否し、
    // ペインも偽実行ファイルの呼び出しも増えないことを確認する。
    const codexWithInjectedModel = await postNewPane(port, {
      engine: 'codex',
      model: `gpt-5.6-sol; touch ${markerPath}`,
      noClaude: false,
    });
    expect(codexWithInjectedModel).toEqual({ status: 400, body: { error: 'invalid model' } });
    expect(await getPaneCount(port)).toBe(2);
    expect((await waitForCalls(fakeCodex.capturePath, 1)).length).toBe(1);
    expect(fs.existsSync(markerPath)).toBe(false);

    // 文字列以外の model も同じく拒否する。
    const codexWithNonStringModel = await postNewPane(port, {
      engine: 'codex',
      model: 12345,
      noClaude: false,
    });
    expect(codexWithNonStringModel).toEqual({ status: 400, body: { error: 'invalid model' } });
    expect(await getPaneCount(port)).toBe(2);

    // 正常な Codex model は --model の独立した引数として実 PTY へ渡る。
    const codexWithModel = await postNewPane(port, {
      engine: 'codex',
      model: 'gpt-5.6-sol',
      noClaude: false,
    });
    expect(codexWithModel.status).toBe(200);
    await waitForPaneCount(port, 3);
    const codexCallsWithModel = await waitForCalls(fakeCodex.capturePath, 2);
    expect(codexCallsWithModel[1]).toEqual(['--no-daemon', '--model', 'gpt-5.6-sol']);

    // engine 未指定は従来どおり claude が起動する（既存呼び出し元は非影響）。
    const defaultEngine = await postNewPane(port, { noClaude: false });
    expect(defaultEngine.status).toBe(200);
    await waitForPaneCount(port, 4);
    const claudeCalls = await waitForCalls(fakeClaude.capturePath, 1);
    expect(claudeCalls[0]).toEqual([]);

    // engine: "claude" を明示した場合も model が有効（従来の #310 仕様と両立）。
    const explicitClaudeWithModel = await postNewPane(port, {
      engine: 'claude',
      model: 'opus',
      noClaude: false,
    });
    expect(explicitClaudeWithModel.status).toBe(200);
    await waitForPaneCount(port, 5);
    const claudeCallsWithModel = await waitForCalls(fakeClaude.capturePath, 2);
    expect(claudeCallsWithModel[1]).toEqual(['--model', 'opus']);

    // タスク用ポリシー（issue #428）: 未知キー・不正値・Claude 指定は 400 でペインを増やさない。
    for (const [payload, error] of [
      [{ engine: 'codex', codexPolicy: { preset: 'orchestrated-task', args: ['--add-dir', '/'] } }, 'unknown codexPolicy key: args'],
      [{ engine: 'codex', codexPolicy: { preset: 'full-access' } }, 'invalid codexPolicy preset'],
      [{ engine: 'codex', codexPolicy: 'orchestrated-task' }, 'invalid codexPolicy'],
      [{ engine: 'claude', codexPolicy: { preset: 'orchestrated-task' } }, 'Codex options require engine "codex"'],
      [{ engine: 'codex', codexPolicy: { preset: 'orchestrated-task' } }, 'codexPolicy requires cwd'],
    ]) {
      expect(await postNewPane(port, payload)).toEqual({ status: 400, body: { error } });
    }
    expect(await getPaneCount(port)).toBe(5);

    // 正常なポリシーは専用 CODEX_HOME 付きで起動し、sandbox を明示する。ポリシー無しの起動には CODEX_HOME が付かない。
    const policyLaunch = await postNewPane(port, {
      engine: 'codex', noClaude: false, approvalPolicy: 'never', codexPolicy: { preset: 'orchestrated-task' }, cwd: repoDir,
    });
    expect(policyLaunch.status).toBe(200);
    await waitForPaneCount(port, 6);
    const policyCalls = await waitForCalls(fakeCodex.capturePath, 3);
    expect(policyCalls[2]).toEqual(['--no-daemon', '--ask-for-approval', 'never', '--sandbox', 'workspace-write']);
    const codexHomes = (await waitForCalls(`${fakeCodex.capturePath}.codex-home`, 3)).map((line) => line);
    expect(codexHomes[0]).toBeNull();
    expect(codexHomes[1]).toBeNull();
    expect(codexHomes[2]).toMatch(/\.vk-terminals\/codex-task-policy\/orchestrated-task\/[0-9a-f]{24}$/);
    expect(fs.readFileSync(path.join(codexHomes[2], 'config.toml'), 'utf8')).toContain('network_access = false');
    expect(fs.readdirSync(codexHomes[2]).sort()).toEqual(['AGENTS.md', 'config.toml', 'gh', 'gitconfig', 'rules', 'vk-task-ops', 'vk-task-ops.js']);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    // テスト失敗時も注入確認用パスを残さない（作られていた場合は assertion が先に FAIL する）。
    fs.rmSync(markerPath, { force: true });
  }
});
