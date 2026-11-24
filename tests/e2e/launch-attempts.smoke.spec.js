const { test, expect } = require('@playwright/test');
const childProcess = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
const {
  fakeEngineStayAliveSource,
  fakeCodexRolloutSource,
  FAKE_CODEX_NO_ROLLOUT_MARK,
  FAKE_CODEX_EXIT_EARLY_MARK,
} = require('./helpers/fake-engine');

// issue #657: 起動試行（attemptId）の API（POST /api/launch-attempts・GET /api/launch-attempts/<attemptId>）。
// 実 Electron・実 PTY で、偽 codex（受け取った初期指示を rollout へ書く）を起動し、次を確かめる。
//   - 長文・日本語・改行・引用符・シェル記号を含む本文が欠けずに渡り、要約値が一致して received になる
//   - 応答前に通信を切ってから送り直しても、同時に 2 本届いても、ペインと偽 codex の起動はそれぞれ 1 回
//   - 受領の前にペインを入れ替えた・閉じた場合と、起動直後に終了した場合は unknown（自動再試行しない）
//   - 帳簿を保存できないときは処理前に拒否し、同じ attemptId で送り直せる。書く前に止まった記録は rejected
// node-pty（tmux を使わない直接起動）と tmux 保持の構成の両方で動かす。

const CODEX_EARLY_EXIT_WINDOW_MS = 5000;
const holderLauncherPath = path.resolve(__dirname, '..', 'fixtures', 'embeddedHolderLauncher.js');
const CODEX_POLICY = { preset: 'orchestrated-task' };

async function requestJson(port, method, pathname, payload, { signal } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
    signal,
  });
  return { status: res.status, body: await res.json() };
}

// 画面側が持つペインの数（端末が結び付いたものだけ）。tmux 保持の構成でも同じ数え方にする。
let activeWin = null;
async function getPaneCount() {
  return activeWin.evaluate(() => Object.values(terminals).filter((t) => t.termId).length);
}

async function waitFor(check, description, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await check();
      if (last.done) return last.value;
    } catch (error) {
      last = { error: error.message };
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${description} did not happen; last: ${JSON.stringify(last)}`);
}

const waitForPaneCount = (port, expected) => waitFor(async () => {
  const count = await getPaneCount(port);
  return { done: count === expected, value: count, count };
}, `pane count ${expected}`);

const waitForPhase = (port, attemptId, phase, timeoutMs) => waitFor(async () => {
  const { status, body } = await requestJson(port, 'GET', `/api/launch-attempts/${attemptId}`);
  return { done: status === 200 && body.phase === phase, value: body, body };
}, `attempt ${attemptId} phase ${phase}`, timeoutMs);

// 受け取った引数を記録し、rollout を書く偽 codex（helpers/fake-engine.js）。
function createFakeCodex(root) {
  const binDir = path.join(root, 'bin');
  const capturePath = path.join(root, 'codex-calls.jsonl');
  fs.mkdirSync(binDir, { recursive: true });
  for (const binName of ['claude', 'codex']) {
    fs.writeFileSync(path.join(binDir, binName), `#!/usr/bin/env node
const fs = require('fs');
if (${JSON.stringify(binName)} === 'codex') fs.appendFileSync(process.env.VK_TERMINALS_E2E_CODEX_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
${fakeCodexRolloutSource(binName)}
${fakeEngineStayAliveSource(binName)}`, { mode: 0o755 });
  }
  return { binDir, capturePath };
}

function readCalls(capturePath) {
  if (!fs.existsSync(capturePath)) return [];
  return fs.readFileSync(capturePath, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}
const promptOf = (call) => call[call.indexOf('--') + 1];
const callsWithMark = (capturePath, mark) => readCalls(capturePath).filter((call) => promptOf(call)?.includes(mark));
const sha256 = (text) => `sha256:${crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')}`;

// 長文・日本語・改行・引用符・シェル記号・タブを含む本文。"- " で始まり、`--` の後ろで本文として渡ることも確かめる。
function buildTrickyPrompt(markerPath) {
  const line = '日本語の行です。"double" \'single\' $HOME ${PATH} `echo bt` $(touch ' + markerPath + ') !! !$ \\backslash\ttab & | ; < > * ? ~ #';
  return `- 箇条書きで始まる初期指示\n${Array.from({ length: 120 }, (_, index) => `${index}: ${line}`).join('\n')}\n末尾の行`;
}

// 書く前にアプリが止まった記録（受け付け済み・起動の意図なし）を、起動前の HOME に置く。
function seedInterruptedAttempt(tmpHome, attemptId) {
  const ledgerDir = path.join(tmpHome, '.vk-terminals', 'launch-attempts');
  const attemptDir = path.join(ledgerDir, attemptId);
  fs.mkdirSync(attemptDir, { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(tmpHome, '.vk-terminals'), 0o700);
  fs.chmodSync(ledgerDir, 0o700);
  fs.chmodSync(attemptDir, 0o700);
  const acceptedAt = Date.now() - 60_000;
  const record = {
    version: 1, attemptId, agent: 'codex', promptDigest: sha256('interrupted'), fingerprint: 'sha256:0', phase: 'awaiting-receipt',
    milestones: { requestAccepted: acceptedAt, launchWritten: null, receiptConfirmed: null },
    binding: { termId: null, paneGeneration: null, sessionId: null },
    requestAcceptedAt: acceptedAt, launchIntentAt: null, earlyExitAt: null, codexHome: null, error: null, updatedAt: acceptedAt,
  };
  fs.writeFileSync(path.join(attemptDir, 'record.json'), JSON.stringify(record), { mode: 0o600 });
  fs.writeFileSync(path.join(attemptDir, 'prompt.txt'), 'interrupted', { mode: 0o600 });
}

function findTmux() {
  return (process.env.PATH || '').split(path.delimiter).map((dir) => path.join(dir, 'tmux')).find((candidate) => fs.existsSync(candidate)) || null;
}

for (const mode of ['node-pty', 'tmux']) {
  // @title 起動試行の API は、初期指示を一体で渡して受領まで追跡し、送り直しても Codex を 1 つしか起動しない（${mode}）
  test(`起動試行の API は、初期指示を一体で渡して受領まで追跡し、送り直しても Codex を 1 つしか起動しない（${mode}）`, async () => {
    const tmux = findTmux();
    test.skip(mode === 'tmux' && !tmux, 'tmux is unavailable');
    test.setTimeout(180_000);
    const port = await getFreePort();
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-launch-attempts-'));
    const fake = createFakeCodex(fixtureRoot);
    const repoDir = path.join(fixtureRoot, 'repo');
    fs.mkdirSync(repoDir);
    childProcess.execFileSync('git', ['init', '-q'], { cwd: repoDir });
    // 保持役のソケットは、短い実パスのフォルダに置く（helpers と同じく、このテスト専用）。
    const runDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vk-la-')));
    const markerPath = path.join(fixtureRoot, 'shell-expanded-marker');
    const interruptedId = crypto.randomUUID();
    let launched = null;
    let tmpHome = null;
    const body = (overrides = {}) => ({ attemptId: crypto.randomUUID(), agent: 'codex', cwd: repoDir, prompt: 'hello', codexPolicy: CODEX_POLICY, approvalPolicy: 'never', ...overrides });

    try {
      // @step 受け取った初期指示を rollout へ書く偽 Codex を使い、書く前に止まった記録を置いてアプリを起動する
      launched = await launchAppAndWait({
        port,
        prefix: `vk-terminals-e2e-launch-attempts-${mode}-`,
        ...(mode === 'tmux' ? { entry: holderLauncherPath } : {}),
        seedHome: ({ tmpHome: home }) => { tmpHome = home; seedInterruptedAttempt(home, interruptedId); },
        env: {
          PATH: `${fake.binDir}${path.delimiter}${process.env.PATH || ''}`,
          VK_TERMINALS_E2E_CODEX_CAPTURE: fake.capturePath,
          VK_TERMINALS_E2E_CODEX_ROLLOUT: '1',
          VK_TERMINALS_E2E_GITHUB_REACHABILITY: 'ok',
          ...(mode === 'tmux' ? { VK_TERMINALS_HOLDER_RUN_DIR: runDir } : {}),
        },
      });
      activeWin = launched.win;
      let panes = await waitForPaneCount(port, 1);

      // @check 帳簿を保存できないときは処理前に 503（retry: allowed）で拒否し、ペインを作らない
      const ledgerDir = path.join(tmpHome, '.vk-terminals', 'launch-attempts');
      fs.chmodSync(ledgerDir, 0o755);
      const unsaved = body();
      const unavailable = await requestJson(port, 'POST', '/api/launch-attempts', unsaved);
      expect(unavailable.status).toBe(503);
      expect(unavailable.body.phase).toBe('rejected');
      expect(unavailable.body.error).toMatchObject({ code: 'LEDGER_UNAVAILABLE', retry: 'allowed' });
      expect(await getPaneCount(port)).toBe(panes);
      fs.chmodSync(ledgerDir, 0o700);

      // @check 対応機能の照会に launchAttempts（契約の版・codex・本文の上限・受領判定の方式・帳簿の識別子）が載る
      const capabilities = await requestJson(port, 'GET', '/api/codex-task-capabilities');
      expect(capabilities.status).toBe(200);
      const capability = capabilities.body.capabilities.launchAttempts;
      expect(capability).toMatchObject({ available: true, contractVersion: 1, agents: ['codex'], maxPromptBytes: 65536, receiptMethods: ['codex-rollout-v1'] });
      expect(capability.ledgerId).toMatch(/^[0-9a-f-]{36}$/);

      // @check 書く前にアプリが止まった記録は、再起動後に rejected（Codex 未起動）になる
      const interrupted = await requestJson(port, 'GET', `/api/launch-attempts/${interruptedId}`);
      expect(interrupted.status).toBe(200);
      expect(interrupted.body).toMatchObject({ phase: 'rejected', error: { code: 'APP_RESTARTED_BEFORE_LAUNCH', retry: 'not-useful' } });

      // @check 知らない項目は 400 UNKNOWN_FIELD で拒否し、帳簿に無い attemptId の照会は 200 の attempt-not-found
      const unknownField = await requestJson(port, 'POST', '/api/launch-attempts', body({ noClaude: false }));
      expect(unknownField.status).toBe(400);
      expect(unknownField.body.error).toMatchObject({ code: 'UNKNOWN_FIELD', retry: 'not-useful' });
      const missingId = crypto.randomUUID();
      const missing = await requestJson(port, 'GET', `/api/launch-attempts/${missingId}`);
      expect(missing).toEqual({ status: 200, body: { attemptId: missingId, ledgerId: capability.ledgerId, phase: 'unknown', reason: 'attempt-not-found', error: { code: 'ATTEMPT_NOT_FOUND', retry: 'forbidden', message: 'attempt not found in this ledger' } } });
      expect(await getPaneCount(port)).toBe(panes);

      // @step 保存できなかった attemptId を、帳簿を直してから同じ本文で送り直す
      const resent = await requestJson(port, 'POST', '/api/launch-attempts', unsaved);
      expect([200, 202]).toContain(resent.status);
      expect(resent.body.ledgerId).toBe(capability.ledgerId);
      panes = await waitForPaneCount(port, panes + 1);
      await waitForPhase(port, unsaved.attemptId, 'received');

      // @step 長文・日本語・改行・引用符・シェル記号を含む本文で起動試行を送る
      const tricky = body({ prompt: buildTrickyPrompt(markerPath) });
      const trickyResponse = await requestJson(port, 'POST', '/api/launch-attempts', tricky);
      expect(trickyResponse.status).toBe(200);
      expect(trickyResponse.body.phase).toBe('awaiting-receipt');
      expect(trickyResponse.body.milestones.requestAccepted).toBeTruthy();
      expect(trickyResponse.body.milestones.launchWritten).toBeTruthy();
      panes = await waitForPaneCount(port, panes + 1);
      // @check rollout の発言の要約値が一致して received になり、セッション ID とペインが結び付く
      const received = await waitForPhase(port, tricky.attemptId, 'received');
      // @check 偽 Codex が受け取った本文は一字一句同じで、シェルに展開されていない
      const trickyCalls = readCalls(fake.capturePath).filter((call) => promptOf(call) === tricky.prompt);
      expect(trickyCalls).toHaveLength(1);
      expect(fs.existsSync(markerPath)).toBe(false);
      expect(received.binding.promptDigest).toBe(sha256(tricky.prompt));
      expect(received.binding.sessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(received.binding.termId).toBe(trickyResponse.body.binding.termId);
      expect(received.binding.paneGeneration).toBe(1);
      expect(received.milestones.receiptConfirmed).toBeTruthy();
      expect(JSON.stringify(received)).not.toContain('日本語の行です');
      // 本文ファイルは受領後に消え、要約値だけが残る。
      expect(fs.existsSync(path.join(ledgerDir, tricky.attemptId, 'prompt.txt'))).toBe(false);
      // @check 同じ attemptId で本文が違えば 409 ATTEMPT_CONFLICT で、ペインを増やさない
      const conflict = await requestJson(port, 'POST', '/api/launch-attempts', { ...tricky, prompt: 'different' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toMatchObject({ code: 'ATTEMPT_CONFLICT', retry: 'not-useful' });

      // @step 応答の前に通信を切ってから、同じ要求を送り直す
      const abortMark = `abort-${crypto.randomUUID()}`;
      const aborted = body({ prompt: `送り直しの確認 ${abortMark}` });
      const controller = new AbortController();
      const firstTry = requestJson(port, 'POST', '/api/launch-attempts', aborted, { signal: controller.signal }).catch((error) => error);
      setTimeout(() => controller.abort(), 100);
      expect(await firstTry).toBeInstanceOf(Error);
      const retried = await requestJson(port, 'POST', '/api/launch-attempts', aborted);
      expect([200, 202]).toContain(retried.status);
      await waitForPhase(port, aborted.attemptId, 'received');
      // @check ペインと偽 Codex の起動はそれぞれ 1 回だけ
      panes = await waitForPaneCount(port, panes + 1);
      expect(callsWithMark(fake.capturePath, abortMark)).toHaveLength(1);

      // @step 同じ attemptId の要求を同時に 2 本送る
      const raceMark = `race-${crypto.randomUUID()}`;
      const race = body({ prompt: `同時送信の確認 ${raceMark}` });
      const raced = await Promise.all([0, 1].map(() => requestJson(port, 'POST', '/api/launch-attempts', race)));
      for (const result of raced) expect([200, 202]).toContain(result.status);
      await waitForPhase(port, race.attemptId, 'received');
      // @check 同時に届いても、ペインと偽 Codex の起動はそれぞれ 1 回だけ
      panes = await waitForPaneCount(port, panes + 1);
      await new Promise((resolve) => setTimeout(resolve, 1000));
      expect(await getPaneCount(port)).toBe(panes);
      expect(callsWithMark(fake.capturePath, raceMark)).toHaveLength(1);

      // @step 受領を確認できない Codex を起動し、受領の前にペインの AI を再起動（入れ替え）する
      const replaced = body({ prompt: `入れ替えの確認 ${FAKE_CODEX_NO_ROLLOUT_MARK}` });
      const replacedResponse = await requestJson(port, 'POST', '/api/launch-attempts', replaced);
      expect(replacedResponse.status).toBe(200);
      panes = await waitForPaneCount(port, panes + 1);
      const replacedTermId = replacedResponse.body.binding.termId;
      const restart = await requestJson(port, 'POST', '/api/restart-agent', {
        termId: replacedTermId, expectedGeneration: 1, engine: 'codex', cwd: repoDir, codexPolicy: CODEX_POLICY, approvalPolicy: 'never',
      });
      expect(restart.status).toBe(200);
      // @check 受領の前にペインが入れ替わったら unknown（PANE_REPLACED・自動で送り直さない）
      const replacedResult = await waitForPhase(port, replaced.attemptId, 'unknown');
      expect(replacedResult.error).toMatchObject({ code: 'PANE_REPLACED', retry: 'forbidden' });

      // @step 受領を確認できない Codex を起動し、受領の前にペインを閉じる
      const closed = body({ prompt: `閉じる確認 ${FAKE_CODEX_NO_ROLLOUT_MARK}` });
      const closedResponse = await requestJson(port, 'POST', '/api/launch-attempts', closed);
      expect(closedResponse.status).toBe(200);
      panes = await waitForPaneCount(port, panes + 1);
      const closeResult = await requestJson(port, 'POST', '/api/close-pane', { termId: closedResponse.body.binding.termId });
      expect(closeResult.status).toBe(200);
      panes = await waitForPaneCount(port, panes - 1);
      // @check 受領の前にペインが閉じられたら unknown（PANE_CLOSED・自動で送り直さない）
      const closedResult = await waitForPhase(port, closed.attemptId, 'unknown');
      expect(closedResult.error).toMatchObject({ code: 'PANE_CLOSED', retry: 'forbidden' });

      // @step 起動直後に終了する Codex を起動する
      const earlyMark = `early-${crypto.randomUUID()}`;
      const early = body({ prompt: `起動直後の終了 ${earlyMark} ${FAKE_CODEX_EXIT_EARLY_MARK}` });
      const earlyResponse = await requestJson(port, 'POST', '/api/launch-attempts', early);
      expect(earlyResponse.status).toBe(200);
      panes = await waitForPaneCount(port, panes + 1);
      // @check 受領の記録が無ければ unknown（AGENT_EXITED_EARLY・自動で送り直さない）
      // 起動直後の終了は、AI 本体の生死の追跡（utils/agentLifecycle.js）で検知する。負荷が高く、その追跡が
      // 取得の時間切れ（750ms）で打ち切られた場合だけは終了を検知できない（既存の制約。そのときは受領確認の
      // 時間切れで unknown になる）。その場合は追跡が打ち切られたことを確かめ、起動し直さないことだけを見る。
      const earlyTermId = earlyResponse.body.binding.termId;
      const earlyOutcome = await waitFor(async () => {
        const { body: attempt } = await requestJson(port, 'GET', `/api/launch-attempts/${early.attemptId}`);
        if (attempt.phase === 'unknown') return { done: true, value: { attempt } };
        const { body: states } = await requestJson(port, 'GET', '/api/states');
        const pane = Object.values(states.terminals || {}).find((t) => t && String(t.termId) === String(earlyTermId));
        const trackingLost = Boolean(pane) && pane.agentCommandState == null && Date.now() - Date.parse(attempt.milestones.launchWritten) > CODEX_EARLY_EXIT_WINDOW_MS + 2000;
        return { done: trackingLost, value: { attempt, trackingLost }, attempt };
      }, `attempt ${early.attemptId} early exit`, CODEX_EARLY_EXIT_WINDOW_MS + 15_000);
      if (earlyOutcome.trackingLost) {
        test.info().annotations.push({ type: 'note', description: 'agent lifecycle tracking timed out under load; early exit was not observable' });
        expect(earlyOutcome.attempt.phase).toBe('awaiting-receipt');
      } else {
        expect(earlyOutcome.attempt.error).toMatchObject({ code: 'AGENT_EXITED_EARLY', retry: 'forbidden' });
      }
      // @check 初期指示が二重に渡らないよう、起動し直さない（偽 Codex の起動は 1 回のまま）
      await new Promise((resolve) => setTimeout(resolve, CODEX_EARLY_EXIT_WINDOW_MS + 1500));
      expect(callsWithMark(fake.capturePath, earlyMark)).toHaveLength(1);
    } finally {
      if (launched) await closeApp(launched);
      if (mode === 'tmux' && findTmux()) childProcess.spawnSync(findTmux(), ['-S', path.join(runDir, 'tmux.sock'), 'kill-server'], { stdio: 'ignore' });
      fs.rmSync(runDir, { recursive: true, force: true });
      fs.rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });
}
