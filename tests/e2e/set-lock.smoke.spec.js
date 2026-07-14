const { test, expect, _electron } = require('@playwright/test');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

// issue #173: オーケストレーター専用ペインを誤操作で閉じないための
// close ロックを、HTTP API → IPC → renderer UI → closePane 防御まで統合確認する。

const repoRoot = path.resolve(__dirname, '..', '..');

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

function findPaneIdByTermId(states, termId) {
  return Object.keys(states).find((paneId) => String(states[paneId]?.termId) === String(termId)) || null;
}

async function waitForTermId(port, termId, shouldExist, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      const ids = termIdsOf(states);
      lastSeen = ids;
      const exists = ids.includes(String(termId));
      if (exists === shouldExist) return states;
    } catch (_e) {
      // HTTP サーバー起動前は fetch が失敗する。同じ待機ループで吸収する。
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `termId ${termId} did not reach exists=${shouldExist} in time. last states: ${JSON.stringify(lastSeen)}`
  );
}

async function postJson(port, pathname, payload) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let body = null;
  try { body = await res.json(); } catch (_e) { /* 非 JSON 応答も診断用に許容 */ }
  return { status: res.status, body };
}

async function launchApp(port) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-lock-'));
  const tmpHome = path.join(tmpRoot, 'home');
  const configDir = path.join(tmpHome, '.vk-terminals');
  const configPath = path.join(configDir, 'config.json');
  fs.mkdirSync(configDir, { recursive: true });

  // 実ユーザーの ~/.vk-terminals/config.json に依存せず、起動時は素のシェルにする。
  fs.writeFileSync(configPath, JSON.stringify({
    apiHost: '127.0.0.1',
    initialCommand: '',
    agentroom: false,
    additionalPanes: [],
  }), 'utf8');

  const app = await _electron.launch({
    args: ['.', '--no-claude'],
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      VK_TERMINALS_API_PORT: String(port),
    },
  });
  const win = await app.firstWindow();
  return { app, win, tmpRoot };
}

test('close ロック中のペインは UI で閉じられず、/api/close-pane では閉じられる', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp(port);

  try {
    // 起動直後の最初のペインが登録されるまで待ってから、検証対象の追加ペインを作る。
    await waitForTermId(port, '1', true);
    const created = await postJson(port, '/api/new-pane', { noClaude: true });
    expect(created.status).toBe(200);
    expect(created.body && created.body.ok).toBe(true);
    const targetTermId = String(created.body.termId);

    const statesWithTarget = await waitForTermId(port, targetTermId, true);
    const targetPaneId = findPaneIdByTermId(statesWithTarget, targetTermId);
    expect(targetPaneId).toBeTruthy();

    const pane = win.locator(`.pane[data-id="${targetPaneId}"]`);
    const closeBtn = pane.locator('.btn-close');
    await expect(closeBtn).toBeVisible({ timeout: 10_000 });

    // HTTP API で close ロックを入れる。renderer は IPC 受信後にボタン属性を局所更新する。
    const locked = await postJson(port, '/api/set-lock', { termId: targetTermId, lock: { close: false } });
    expect(locked.status).toBe(200);
    expect(locked.body && locked.body.ok).toBe(true);

    await expect(closeBtn).toHaveAttribute('aria-disabled', 'true');
    await expect(closeBtn).toHaveClass(/\bis-locked\b/);
    await expect(closeBtn).toHaveAttribute('aria-label', 'このペインは保護されています（閉じられません）');

    // UI クリックは JS ハンドラと closePane の二重防御で無視され、対象ペインは残る。
    await closeBtn.click({ force: true });
    await win.waitForTimeout(1500);
    await expect(pane).toHaveCount(1);
    expect(termIdsOf(await getStates(port))).toContain(targetTermId);

    // 一方で HTTP API からの明示的 close は force 経路なので、ロック中でも閉じられる。
    const closed = await postJson(port, '/api/close-pane', { termId: targetTermId });
    expect(closed.status).toBe(200);
    expect(closed.body && closed.body.ok).toBe(true);
    await waitForTermId(port, targetTermId, false);
    await expect(pane).toHaveCount(0);
  } finally {
    if (app) await app.close();
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
