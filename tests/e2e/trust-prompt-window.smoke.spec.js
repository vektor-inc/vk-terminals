const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #371: 信頼確認プロンプトへの自動 Enter 送信（main.js の promptWatcher。
// TRUST_PATTERN 一致で ptyProcess.write('\r') する処理）が、時間的な制限なく
// ペイン生存中いつでも発火できてしまっていた不具合の e2e 回帰テスト。
//
// utils/trustPromptGate.js（tests/trustPromptGate.test.js で単体テスト済み）が、
//   1. ペイン作成からの経過時間が TRUST_WINDOW_MS 以内であること
//   2. AI エンジンの起動完了（READY_PATTERN 一致）をまだ検知していないこと
// の両方を満たす間だけ自動 Enter 送信を許可するようになった。ここでは main.js への
// 配線（実際の PTY 出力で正しく発火・停止するか）を実 Electron で確認する。
//
// 実際の claude バイナリは使わず、new-pane-engine.smoke.spec.js と同じ手法で
// フェイク claude を PATH の先頭に置く。フェイク claude は次の順で出力する。
//   1) 起動直後: 信頼確認プロンプト相当の文言（TRUST_PATTERN の "Enter to confirm" に一致）
//   2) 少し待って: 起動完了相当の文言（CLAUDE_READY_PATTERN の "Welcome to Claude" に一致）
//   3) さらに待って: 信頼確認プロンプトと同じ文言をもう一度出す（ready 検知後の再現）
// 標準入力（自動 Enter）を受け取ったら "AUTO_ENTER_RECEIVED:<n>" を出力するため、
// xterm バッファのテキストだけで「自動 Enter が送られたか・何回か」を観測できる。

// フェイク claude 実行ファイルを一時ディレクトリに作る。
function createFakeClaudeTrustFlow(root) {
  const binDir = path.join(root, 'bin');
  const executablePath = path.join(binDir, 'claude');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(executablePath, `#!/usr/bin/env node
// issue #371 の e2e 用フェイク claude。
let receivedCount = 0;
if (process.stdin.isTTY) {
  try { process.stdin.setRawMode(true); } catch (_e) {}
}
process.stdin.resume();
process.stdin.on('data', () => {
  receivedCount += 1;
  process.stdout.write('AUTO_ENTER_RECEIVED:' + receivedCount + '\\r\\n');
});

// 1) 起動直後: 信頼確認プロンプト相当の文言。
process.stdout.write('Enter to confirm to continue\\r\\n');

// 2) 少し待って: 起動完了相当の文言。
setTimeout(() => {
  process.stdout.write('Welcome to Claude Code!\\r\\n');

  // 3) さらに待って: 信頼確認プロンプトと同じ文言を再度出す（ready 検知後）。
  setTimeout(() => {
    process.stdout.write('Enter to confirm to continue\\r\\n');
    process.stdout.write('POST_READY_TRUST_MARKER\\r\\n');
  }, 1000);
}, 1000);

// プロセスを保持し続ける（実際の対話型 CLI と同様、起動したまま待ち受ける）。
setInterval(() => {}, 1000);
`, { mode: 0o755 });
  return { binDir };
}

async function postNewPane(port, payload) {
  const res = await fetch(`http://127.0.0.1:${port}/api/new-pane`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// termId から renderer 側の paneId（terminals のキー。`.pane[data-id="…"]` に対応）を
// 逆引きする（renderer/app.js の各所と同じ `terminals[k]?.termId === id` パターン）。
async function waitForPaneIdForTermId(win, termId, timeoutMs = 15_000) {
  const handle = await win.waitForFunction((tid) => (
    Object.keys(terminals).find((k) => terminals[k] && String(terminals[k].termId) === String(tid)) || null
  ), termId, { timeout: timeoutMs });
  return handle.jsonValue();
}

// pane の可視バッファ（折り返しを含む全行）に needle を含む行が現れるまで待つ
// （terminal-link-open-url.smoke.spec.js の waitForBufferText と同じ考え方）。
async function waitForBufferText(win, needle, paneId, timeoutMs = 15_000) {
  await win.waitForFunction(({ u, id }) => {
    const t = terminals[id];
    if (!t) return false;
    const buf = t.term.buffer.active;
    for (let i = 0; i < t.term.rows; i += 1) {
      const line = buf.getLine(buf.viewportY + i);
      if (line && line.translateToString(true).includes(u)) return true;
    }
    return false;
  }, { u: needle, id: paneId }, { timeout: timeoutMs });
}

test('信頼確認プロンプトには起動直後だけ自動応答し、起動完了検知後の同じ文言には応答しない（issue #371）', async () => {
  const port = await getFreePort();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-trust-window-'));
  const fakeClaude = createFakeClaudeTrustFlow(fixtureRoot);
  let launched = null;

  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-trust-window-',
      env: {
        // フェイク claude を PATH の先頭に置く（実バイナリ・実認証状態には依存しない）。
        PATH: `${fakeClaude.binDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    });
    const { win } = launched;

    // engine 省略（既定 claude）・noClaude:false で新規ペインを作り、フェイク claude を
    // 実 PTY 上で起動する。起動時の既定ペインは --no-claude のため対象にしない。
    const created = await postNewPane(port, { noClaude: false });
    expect(created.status).toBe(200);
    expect(created.body && created.body.ok).toBe(true);
    const termId = created.body.termId;

    const paneId = await waitForPaneIdForTermId(win, termId);
    expect(paneId).not.toBeNull();

    // (1) 起動直後の信頼確認プロンプト相当の出力には自動 Enter が送られる
    //     （フェイク claude が標準入力を受け取り AUTO_ENTER_RECEIVED:1 を出力する）。
    await waitForBufferText(win, 'AUTO_ENTER_RECEIVED:1', paneId);

    // (2) 起動完了相当の出力（READY_PATTERN 一致）が検知される。
    await waitForBufferText(win, 'Welcome to Claude Code!', paneId);

    // (3) 起動完了検知後に同じ信頼確認文言が再び出ても、マーカーが出るまで待つ。
    await waitForBufferText(win, 'POST_READY_TRUST_MARKER', paneId);

    // マーカー出力後、念のため少し待ってから確認する（誤って自動応答が送られていれば
    // フェイク claude がこの間に AUTO_ENTER_RECEIVED:2 を出力するはず）。
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // (4) 起動完了検知後の同じ文言には自動応答していない（2 回目の自動 Enter が無い）。
    const bufferHasSecondAutoEnter = await win.evaluate((id) => {
      const t = terminals[id];
      if (!t) return false;
      const buf = t.term.buffer.active;
      for (let i = 0; i < t.term.rows; i += 1) {
        const line = buf.getLine(buf.viewportY + i);
        if (line && line.translateToString(true).includes('AUTO_ENTER_RECEIVED:2')) return true;
      }
      return false;
    }, paneId);
    expect(bufferHasSecondAutoEnter).toBe(false);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
