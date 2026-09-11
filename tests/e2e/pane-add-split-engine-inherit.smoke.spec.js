const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #394: 「Codex のペインから追加・分割すると、新しいペインが Claude Code で
// 起動してしまう」不具合の e2e。desktop の ＋ / 分割ボタン、空グリッドの
// 「新規ペインを追加」ボタン、モバイルの「ペインを追加」ボタン（POST /api/new-pane に
// useDefaults: true のみを渡す経路）のいずれでも、操作元または現在選択中のペインの
// engine を新しいペインへ引き継ぐことを確認する。あわせて、
//   - noClaude（AI を自動起動しない設定）は engine 引き継ぎと無関係に維持されること
//   - HTTP API で engine を明示した場合は引き継ぎより明示指定が優先されること
//   - useDefaults を伴わない（＝ inherit の対象外の）呼び出しは従来どおり
//     engine 省略時に claude を起動すること（既存呼び出し元の互換性）
// も確認する。
//
// 実バイナリ・認証状態に依存しないよう、tests/e2e/new-pane-engine.smoke.spec.js と
// 同じ手法（一時 PATH の先頭に置いた偽 claude / 偽 codex が、実際に呼ばれた引数を
// JSON Lines で記録する）を使う。

// GET /api/states を取得する。
async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return json.terminals || {};
}

function termIdsOf(states) {
  return Object.values(states)
    .map((t) => (t && t.termId != null ? String(t.termId) : null))
    .filter(Boolean);
}

// 指定 termId が states に現れる / 消えるまで待つ（report-states は 2 秒間隔）。
async function waitForTermId(port, termId, shouldExist, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const ids = termIdsOf(await getStates(port));
      lastSeen = ids;
      if (ids.includes(String(termId)) === shouldExist) return ids;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`termId ${termId} did not reach exists=${shouldExist} in time. last: ${JSON.stringify(lastSeen)}`);
}

// 指定 termId に対応する paneId（DOM の data-id）を states から逆引きする。
async function waitForPaneIdForTermId(port, termId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const states = await getStates(port);
    for (const [paneId, t] of Object.entries(states)) {
      if (t && String(t.termId) === String(termId)) return paneId;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`paneId for termId ${termId} not found in time`);
}

async function postJson(port, pathname, payload) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch (_e) { /* 非 JSON 応答も診断のため許容 */ }
  return { status: res.status, body };
}

// 一時 PATH の先頭へ置く偽 claude / 偽 codex。実バイナリや認証状態に依存せず、PTY の
// シェルが受け取った引数だけを JSON Lines で記録する（new-pane-engine.smoke.spec.js と同じ手法）。
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

function readCalls(capturePath) {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function waitForCallCount(capturePath, expected, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const calls = readCalls(capturePath);
    if (calls.length >= expected) return calls;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`fake executable (${capturePath}) was not called ${expected} time(s); last count: ${readCalls(capturePath).length}`);
}

// 「呼ばれていないこと」を確認する側の待ち。呼ばれないことの証明はできない
// （いつまでも待てない）ため、他の非同期処理が確実に先に終わる程度の猶予をおいて
// 件数が増えていないことだけを確認する。
async function assertCallCountStaysAt(capturePath, expected, quietMs = 1500) {
  await new Promise((r) => setTimeout(r, quietMs));
  expect(readCalls(capturePath).length).toBe(expected);
}

function setupFakeEngines() {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-pane-engine-inherit-'));
  const fakeClaude = createFakeExecutable(fixtureRoot, 'claude', 'VK_TERMINALS_E2E_CLAUDE_CAPTURE');
  const fakeCodex = createFakeExecutable(fixtureRoot, 'codex', 'VK_TERMINALS_E2E_CODEX_CAPTURE');
  return {
    fixtureRoot,
    fakeClaude,
    fakeCodex,
    env: {
      PATH: `${fakeClaude.binDir}${path.delimiter}${fakeCodex.binDir}${path.delimiter}${process.env.PATH || ''}`,
      VK_TERMINALS_E2E_CLAUDE_CAPTURE: fakeClaude.capturePath,
      VK_TERMINALS_E2E_CODEX_CAPTURE: fakeCodex.capturePath,
    },
  };
}

test('desktop: ペイン単位の「＋」（分割）ボタンは操作元ペインの engine を新ペインへ引き継ぐ', async () => {
  const port = await getFreePort();
  const { fixtureRoot, fakeClaude, fakeCodex, env } = setupFakeEngines();
  let launched = null;

  try {
    // newPaneAutoLaunchClaude: true にして、＋ボタンでの追加が noClaude:false
    // （＝実際に AI を起動する）で作られるようにする（既定は false = 素のシェル）。
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-pane-engine-inherit-',
      env,
      config: { newPaneAutoLaunchClaude: true },
    });
    const { win } = launched;

    // 初期ペイン（--no-claude 起動のため AI は起動していない）。
    await waitForTermId(port, '1', true);

    // Codex のペインを 1 枚 API 経由で作る（engine を明示）。
    const codexCreated = await postJson(port, '/api/new-pane', { engine: 'codex', noClaude: false });
    expect(codexCreated.status).toBe(200);
    const codexTermId = String(codexCreated.body.termId);
    await waitForTermId(port, codexTermId, true);
    await waitForCallCount(fakeCodex.capturePath, 1);
    const codexPaneId = await waitForPaneIdForTermId(port, codexTermId);

    // その Codex ペインの「＋」（.btn-split）をクリック → 新ペインも Codex で起動する。
    const beforeSplit = termIdsOf(await getStates(port));
    await win.locator(`.pane[data-id="${codexPaneId}"] .btn-split`).click();
    const afterSplit = await (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const ids = termIdsOf(await getStates(port));
        if (ids.length > beforeSplit.length) return ids;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('split did not create a new pane in time');
    })();
    expect(afterSplit.length).toBe(beforeSplit.length + 1);
    // 新しく増えた termId で codex が呼ばれ、claude は一度も呼ばれていないこと。
    await waitForCallCount(fakeCodex.capturePath, 2);
    expect(readCalls(fakeClaude.capturePath).length).toBe(0);

    // Claude Code のペインを 1 枚 API 経由で作る（engine 省略＝従来どおり claude）。
    const claudeCreated = await postJson(port, '/api/new-pane', { noClaude: false });
    expect(claudeCreated.status).toBe(200);
    const claudeTermId = String(claudeCreated.body.termId);
    await waitForTermId(port, claudeTermId, true);
    await waitForCallCount(fakeClaude.capturePath, 1);
    const claudePaneId = await waitForPaneIdForTermId(port, claudeTermId);

    // その Claude Code ペインの「＋」をクリック → 新ペインも従来どおり Claude Code で起動する。
    const beforeSplit2 = termIdsOf(await getStates(port));
    await win.locator(`.pane[data-id="${claudePaneId}"] .btn-split`).click();
    const afterSplit2 = await (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const ids = termIdsOf(await getStates(port));
        if (ids.length > beforeSplit2.length) return ids;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('split did not create a new pane in time');
    })();
    expect(afterSplit2.length).toBe(beforeSplit2.length + 1);
    await waitForCallCount(fakeClaude.capturePath, 2);
    // codex の呼び出し回数は増えていない（さっきの分割で確定した 2 回のまま）。
    expect(readCalls(fakeCodex.capturePath).length).toBe(2);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('desktop: 空グリッドの「新規ペインを追加」は直前まで選択していたペインの engine を引き継ぐ', async () => {
  const port = await getFreePort();
  const { fixtureRoot, fakeClaude, fakeCodex, env } = setupFakeEngines();
  let launched = null;

  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-pane-engine-inherit-empty-',
      env,
      config: { newPaneAutoLaunchClaude: true },
    });
    const { win } = launched;

    await waitForTermId(port, '1', true);
    const initialPaneId = await waitForPaneIdForTermId(port, '1');

    // Codex のペインを 1 枚作る。addPane() 内の focusPane() により、このペインが
    // 「現在選択中のペイン」になる。
    const codexCreated = await postJson(port, '/api/new-pane', { engine: 'codex', noClaude: false });
    expect(codexCreated.status).toBe(200);
    const codexTermId = String(codexCreated.body.termId);
    await waitForTermId(port, codexTermId, true);
    await waitForCallCount(fakeCodex.capturePath, 1);
    const codexPaneId = await waitForPaneIdForTermId(port, codexTermId);

    // 初期ペイン→Codex ペインの順にサイドバーへ格納し、グリッドを空にする。
    // 最後（Codex ペイン）を格納する時点でそれが focusedPaneId のため、
    // stashPane() は「格納後もそのペインを focusedPaneId のまま保持する」
    // （renderer/app.js の stashPane 参照）。
    await win.locator(`.pane[data-id="${initialPaneId}"] .btn-stash`).click();
    await win.locator(`.pane[data-id="${codexPaneId}"] .btn-stash`).click();

    // グリッドが空になり、プレースホルダの「新規ペインを追加」ボタンが出る。
    const emptyAddBtn = win.locator('[aria-label="新規ペインを追加"]');
    await expect(emptyAddBtn).toBeVisible({ timeout: 10_000 });

    const beforeAdd = termIdsOf(await getStates(port));
    await emptyAddBtn.click();
    const afterAdd = await (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const ids = termIdsOf(await getStates(port));
        if (ids.length > beforeAdd.length) return ids;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('add did not create a new pane in time');
    })();
    expect(afterAdd.length).toBe(beforeAdd.length + 1);

    // 新ペインは Codex で起動する（claude は一度も呼ばれない）。
    await waitForCallCount(fakeCodex.capturePath, 2);
    expect(readCalls(fakeClaude.capturePath).length).toBe(0);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('desktop: AI を自動起動しない設定（noClaude）は engine 引き継ぎと無関係に維持される', async () => {
  const port = await getFreePort();
  const { fixtureRoot, fakeClaude, fakeCodex, env } = setupFakeEngines();
  let launched = null;

  try {
    // newPaneAutoLaunchClaude: false（既定）のまま。＋/分割ボタンは
    // { noClaude: !newPaneAutoLaunchClaude } = { noClaude: true } で作られる。
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-pane-engine-inherit-noclaude-',
      env,
      config: { newPaneAutoLaunchClaude: false },
    });
    const { win } = launched;

    await waitForTermId(port, '1', true);

    // Codex のペインを 1 枚 API 経由で作る（明示的に noClaude: false で起動させる）。
    const codexCreated = await postJson(port, '/api/new-pane', { engine: 'codex', noClaude: false });
    expect(codexCreated.status).toBe(200);
    const codexTermId = String(codexCreated.body.termId);
    await waitForTermId(port, codexTermId, true);
    await waitForCallCount(fakeCodex.capturePath, 1);
    const codexPaneId = await waitForPaneIdForTermId(port, codexTermId);

    // その Codex ペインを分割 → engine は codex を引き継ぐはずだが、
    // newPaneAutoLaunchClaude:false により noClaude:true が優先されるため、
    // 新ペインでは codex も claude もいずれも起動しない。
    const beforeSplit = termIdsOf(await getStates(port));
    await win.locator(`.pane[data-id="${codexPaneId}"] .btn-split`).click();
    const afterSplit = await (async () => {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        const ids = termIdsOf(await getStates(port));
        if (ids.length > beforeSplit.length) return ids;
        await new Promise((r) => setTimeout(r, 250));
      }
      throw new Error('split did not create a new pane in time');
    })();
    expect(afterSplit.length).toBe(beforeSplit.length + 1);

    // codex の呼び出し回数（分割前の 1 回）から増えていないこと（=起動していない）。
    await assertCallCountStaysAt(fakeCodex.capturePath, 1);
    expect(readCalls(fakeClaude.capturePath).length).toBe(0);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('HTTP API: useDefaults:true（モバイルの「ペインを追加」ボタンと同じ経路）は engine 省略時に対象ペインの engine を引き継ぎ、明示指定・useDefaults 無しは従来どおり', async () => {
  const port = await getFreePort();
  const { fixtureRoot, fakeClaude, fakeCodex, env } = setupFakeEngines();
  let launched = null;

  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-pane-engine-inherit-mobile-',
      env,
      config: { newPaneAutoLaunchClaude: true },
    });

    await waitForTermId(port, '1', true);

    // Codex のペインを 1 枚作り、初期ペイン（"1"）は閉じて、Codex ペインだけを残す。
    // これにより「表示面積が最大のペイン」（terminal:request-new-pane の targetPaneId）
    // が一意に Codex ペインへ定まる。
    const codexCreated = await postJson(port, '/api/new-pane', { engine: 'codex', noClaude: false });
    expect(codexCreated.status).toBe(200);
    const codexTermId = String(codexCreated.body.termId);
    await waitForTermId(port, codexTermId, true);
    await waitForCallCount(fakeCodex.capturePath, 1);

    const closed = await postJson(port, '/api/close-pane', { termId: '1' });
    expect(closed.status).toBe(200);
    await waitForTermId(port, '1', false);

    // (1) useDefaults: true・engine 省略 → 唯一残っている Codex ペインの engine を
    //     引き継いで Codex が起動する（issue #394。モバイルの「ペインを追加」ボタンと
    //     同一のリクエストボディ）。
    const mobileLikeAdd = await postJson(port, '/api/new-pane', { useDefaults: true });
    expect(mobileLikeAdd.status).toBe(200);
    await waitForTermId(port, String(mobileLikeAdd.body.termId), true);
    await waitForCallCount(fakeCodex.capturePath, 2);
    expect(readCalls(fakeClaude.capturePath).length).toBe(0);

    // (2) useDefaults: true でも engine を明示すればそちらが優先される
    //     （「API で engine が明示された場合の既存挙動は変えない」）。
    const explicitOverUseDefaults = await postJson(port, '/api/new-pane', { useDefaults: true, engine: 'claude' });
    expect(explicitOverUseDefaults.status).toBe(200);
    await waitForTermId(port, String(explicitOverUseDefaults.body.termId), true);
    await waitForCallCount(fakeClaude.capturePath, 1);
    // codex の呼び出し回数は (1) で確定した 2 回のまま増えない。
    expect(readCalls(fakeCodex.capturePath).length).toBe(2);

    // (3) useDefaults を伴わない・engine も省略した呼び出し（vk-orchestrator 等、
    //     既存の外部呼び出し元を想定）は、Codex ペインが存在していても引き継がず、
    //     従来どおり claude を起動する（互換性維持）。
    const legacyCall = await postJson(port, '/api/new-pane', { noClaude: false });
    expect(legacyCall.status).toBe(200);
    await waitForTermId(port, String(legacyCall.body.termId), true);
    await waitForCallCount(fakeClaude.capturePath, 2);
    expect(readCalls(fakeCodex.capturePath).length).toBe(2);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
