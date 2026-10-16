const { test, expect } = require('@playwright/test');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

async function postJson(port, pathname, payload) {
  const response = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}

async function getTerm(port, termId) {
  const response = await fetch(`http://127.0.0.1:${port}/api/states`);
  const body = await response.json();
  return Object.values(body.terminals || {}).find((term) => term && String(term.termId) === String(termId));
}

async function waitForValue(read, predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`condition timeout; last=${JSON.stringify(last)}`);
}

test.describe.serial('main所有のAIライフサイクル監視', () => {
  let launched;
  let fixtureRoot;
  let port;
  let pidFile;

  test.beforeAll(async () => {
    test.skip(process.platform === 'win32', 'process groupのテスト');
    port = await getFreePort();
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-agent-lifecycle-'));
    const binDir = path.join(fixtureRoot, 'bin');
    pidFile = path.join(fixtureRoot, 'pids');
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, 'claude'), `#!/usr/bin/env node
require('fs').appendFileSync(process.env.VK_AGENT_PID_FILE, process.pid + '\\n');
setInterval(() => {}, 1000);
`, { mode: 0o755 });
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-agent-lifecycle-',
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH || ''}`,
        VK_AGENT_PID_FILE: pidFile,
      },
    });
    await waitForValue(() => getTerm(port, '1'), Boolean);
  });

  test.afterAll(async () => {
    if (launched) await closeApp(launched);
    if (fixtureRoot) fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  for (const signal of ['SIGTERM', 'SIGKILL']) {
    test(`前景プロセスグループ全体への${signal}で、PTYを残したままrunningからexitedへ移る`, async () => {
      const created = await postJson(port, '/api/new-pane', { engine: 'claude', noClaude: false });
      expect(created.status).toBe(200);
      const termId = String(created.body.termId);
      await waitForValue(() => getTerm(port, termId), (term) => term?.agentCommandState === 'running');
      const pids = await waitForValue(
        async () => fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean) : [],
        (values) => values.length >= (signal === 'SIGTERM' ? 1 : 2)
      );
      const pid = Number(pids.at(-1));
      const pgid = Number(childProcess.execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim());
      process.kill(-pgid, signal);

      const state = await waitForValue(() => getTerm(port, termId), (term) => term?.agentCommandState === 'exited');
      expect(state.termId).toBe(termId);
      expect(state.agentCommandState).toBe('exited');
    });
  }
});
