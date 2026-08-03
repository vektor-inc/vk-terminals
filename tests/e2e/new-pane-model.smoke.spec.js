const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #310 / PR #311: POST /api/new-pane の model 指定を実 Electron で統合確認する。
// HTTP の入力検証だけでなく、renderer への引き渡し、PTY へ書かれたコマンドまで通す。

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

// 一時 PATH の先頭へ置く偽 claude。実 Claude Code や認証状態に依存せず、PTY のシェルが
// 受け取った引数だけを JSON Lines で記録する。モデル文字列が単一引数になったことも確認できる。
function createFakeClaude(root) {
  const binDir = path.join(root, 'bin');
  const capturePath = path.join(root, 'claude-calls.jsonl');
  const executablePath = path.join(binDir, 'claude');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(executablePath, `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(process.env.VK_TERMINALS_E2E_CLAUDE_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
`, { mode: 0o755 });
  return { binDir, capturePath };
}

async function waitForClaudeCalls(capturePath, expected, timeoutMs = 10_000) {
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
  throw new Error(`fake claude was not called ${expected} time(s)`);
}

test('POST /api/new-pane は model を安全に検証し、正常値と省略時の起動コマンドを渡す', async () => {
  const port = await getFreePort();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-model-fixture-'));
  const { binDir, capturePath } = createFakeClaude(fixtureRoot);
  const pwnedPath = path.join(os.tmpdir(), `vk-pwned-${process.pid}-${Date.now()}`);
  let launched = null;

  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-model-',
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        VK_TERMINALS_E2E_CLAUDE_CAPTURE: capturePath,
      },
    });

    // 起動直後の既定ペインが states に載るまで待ち、以降の「増えていない」の基準にする。
    await waitForPaneCount(port, 1);

    // セミコロンと空白を含むコマンド注入候補は 400。ペインもファイルも作られない。
    const injection = await postNewPane(port, { model: `sonnet; touch ${pwnedPath}` });
    expect(injection).toEqual({ status: 400, body: { error: 'invalid model' } });
    expect(await getPaneCount(port)).toBe(1);
    expect(fs.existsSync(pwnedPath)).toBe(false);

    // ハイフン始まりは claude 自身のオプションに化けるため拒否する。
    const optionLike = await postNewPane(port, { model: '--dangerously-skip-permissions' });
    expect(optionLike).toEqual({ status: 400, body: { error: 'invalid model' } });
    expect(await getPaneCount(port)).toBe(1);

    // model は文字列のみ。数値は文字列化せず拒否し、ペインを増やさない。
    const nonString = await postNewPane(port, { model: 12345 });
    expect(nonString).toEqual({ status: 400, body: { error: 'invalid model' } });
    expect(await getPaneCount(port)).toBe(1);

    // 依頼どおり model だけを指定した通常リクエストが成功し、ペインが 1 枚増える。
    const accepted = await postNewPane(port, { model: 'sonnet' });
    expect(accepted.status).toBe(200);
    expect(accepted.body && accepted.body.ok).toBe(true);
    expect(String(accepted.body.termId)).toBeTruthy();
    await waitForPaneCount(port, 2);

    // model 省略時も従来どおり成功し、さらに 1 枚増える。
    const omitted = await postNewPane(port, {});
    expect(omitted.status).toBe(200);
    expect(omitted.body && omitted.body.ok).toBe(true);
    expect(String(omitted.body.termId)).toBeTruthy();
    await waitForPaneCount(port, 3);

    // 起動ヘルパーは安全のため --no-claude だが、明示 noClaude:false は API の既存仕様で
    // 優先される。一時の偽 claude を使い、実 PTY に書かれたコマンドの引数を観測する。
    const modeledLaunch = await postNewPane(port, { model: 'sonnet', noClaude: false });
    expect(modeledLaunch.status).toBe(200);
    await waitForPaneCount(port, 4);
    let calls = await waitForClaudeCalls(capturePath, 1);
    expect(calls[0]).toEqual(['--model', 'sonnet']);

    // model 省略時は素の `claude` が書かれるため、偽 claude が引数なしで呼ばれる。
    const defaultLaunch = await postNewPane(port, { noClaude: false });
    expect(defaultLaunch.status).toBe(200);
    await waitForPaneCount(port, 5);
    calls = await waitForClaudeCalls(capturePath, 2);
    expect(calls[1]).toEqual([]);
    expect(fs.existsSync(pwnedPath)).toBe(false);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    // テスト失敗時も注入確認用パスを残さない（作られていた場合は assertion が先に FAIL する）。
    fs.rmSync(pwnedPath, { force: true });
  }
});
