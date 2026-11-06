const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// POST /api/restart-agent の cwd を、実物のシェルと偽の claude で確認する。
async function postRestart(port, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/api/restart-agent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function readGeneration(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`).catch(() => null);
  if (!res || res.status !== 200) return undefined;
  const { terminals } = await res.json();
  return Object.values(terminals || {}).find((t) => String(t?.termId) === '1')?.agentGeneration;
}

test('判定できないシェルでは cwd 付きの再起動を断り、世代を進めない', async () => {
  test.skip(!fs.existsSync('/bin/tcsh'), 'tcsh が無い環境では確認できない');
  const port = await getFreePort();
  const { app, tmpRoot } = await launchAppAndWait({
    port,
    prefix: 'vk-terminals-e2e-restart-cwd-tcsh-',
    env: { SHELL: '/bin/tcsh' },
  });
  try {
    await expect.poll(() => readGeneration(port), { timeout: 15_000 }).toEqual(expect.any(Number));
    const generation = await readGeneration(port);
    const response = await postRestart(port, { termId: '1', expectedGeneration: generation, cwd: tmpRoot });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid cwd');
    expect(await readGeneration(port)).toBe(generation);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});

test('引用符を含むフォルダへ移動してから AI を起動する', async () => {
  const port = await getFreePort();
  const fakeRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'vk-terminals-e2e-fake-claude-'));
  const binDir = path.join(fakeRoot, 'bin');
  const capturePath = path.join(fakeRoot, 'cwd.jsonl');
  const targetDir = path.join(fakeRoot, "it's a dir");
  fs.mkdirSync(binDir);
  fs.mkdirSync(targetDir);
  fs.writeFileSync(path.join(binDir, 'claude'), `#!/usr/bin/env node
require('fs').appendFileSync(process.env.VK_E2E_CWD_CAPTURE, JSON.stringify(process.cwd()) + '\\n');
`, { mode: 0o755 });
  const { app, tmpRoot } = await launchAppAndWait({
    port,
    prefix: 'vk-terminals-e2e-restart-cwd-',
    env: {
      PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
      VK_E2E_CWD_CAPTURE: capturePath,
    },
  });
  try {
    await expect.poll(() => readGeneration(port), { timeout: 15_000 }).toEqual(expect.any(Number));
    const generation = await readGeneration(port);
    const response = await postRestart(port, { termId: '1', expectedGeneration: generation, cwd: targetDir });
    expect(response.status).toBe(200);
    await expect.poll(() => (
      fs.existsSync(capturePath)
        ? fs.readFileSync(capturePath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
        : []
    ), { timeout: 15_000 }).toContain(fs.realpathSync(targetDir));
  } finally {
    await closeApp({ app, tmpRoot });
    fs.rmSync(fakeRoot, { recursive: true, force: true });
  }
});
