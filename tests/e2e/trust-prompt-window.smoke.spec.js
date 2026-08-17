const { test, expect } = require('@playwright/test');
const fs = require('fs');
const os = require('os');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
const { CLAUDE_CURRENT_TRUST_PROMPT } = require('../fixtures/trustPrompts');

// issue #371: 信頼確認プロンプトへの自動 Enter 送信（main.js の promptWatcher。
// 信頼確認の文脈一致で ptyProcess.write('\r') する処理）が、時間的な制限なく
// ペイン生存中いつでも発火できてしまっていた不具合の e2e 回帰テスト。
//
// utils/trustPromptGate.js（tests/trustPromptGate.test.js で単体テスト済み）が、
//   1. ペイン作成からの経過時間が TRUST_WINDOW_MS 以内であること
//   2. AI エンジンの起動完了（READY_PATTERN 一致）を検知してから READY_GRACE_MS を
//      超えて経っていないこと
// の両方を満たす間だけ自動 Enter 送信を許可するようになった。ここでは main.js への
// 配線（実際の PTY 出力で正しく発火・停止するか）を実 Electron で確認する。
//
// 実際の claude バイナリは使わず、new-pane-engine.smoke.spec.js と同じ手法で
// フェイク claude を PATH の先頭に置く。標準入力（自動 Enter）を受け取ったら
// "AUTO_ENTER_RECEIVED:<n>" を出力するため、xterm バッファのテキストだけで
// 「自動 Enter が送られたか・何回か」を観測できる。
//
// main.js は VK_TERMINALS_TRUST_WINDOW_MS / VK_TERMINALS_READY_GRACE_MS の2つの
// 環境変数で時間窓・猶予を「短縮」できる（安藤の指摘・必須2）。既定値より大きい値は
// 既定値へクランプされ「延長」はできない（安藤の指摘・MEDIUM・必須1。
// utils/trustPromptGate.js の resolvePositiveFiniteMs / tests/trustPromptGate.test.js
// 参照）。実時間で 30 秒（既定の TRUST_WINDOW_MS）待つテストを避けるため、ここでは
// 短縮した値を使う。
//
// このファイルには4本の e2e がある。
//
//   1) 起動完了検知の猶予を過ぎてから届く信頼確認プロンプトには自動応答しない
//   2) 自動応答の時間窓を過ぎてから届く信頼確認プロンプトには自動応答しない
//   3) 時間窓の内側でも、信頼確認ではない一般的な確認画面には自動応答しない
//   4) 起動完了バナーと実機採取した信頼確認ダイアログが別チャンクで届いても、猶予内であれば自動応答する（正常系）
//
// 【1・2 が「修正前のコードでも通る」ことにならないよう、出力の組み立てに注意】
// 単に「trust → ready → trust」の順で出すと、1回目の trust で修正前（1ペイン1回だけの
// 単純な回数ガード）の実装も trustHandled を消費してしまい、2回目の trust に応答しない
// のは修正前後で同じになる（＝どちらの実装でも同じ結果になり、回帰を検知できない）。
// そこで 1・2 は、どちらも「唯一の trust 出現が、修正前の実装なら応答してしまうはずの
// 状況（ready 検知から猶予を過ぎた後 / 時間窓を過ぎた後）でだけ出る」形にしている。
// 修正前の実装（1ペイン1回だけの単純な回数ガード。ready・経過時間を一切見ない）なら
// この唯一の trust にも応答してしまうため、このテストは FAIL するはず。
// 実際に修正前のコード（コミット 011a41d の main.js。utils/trustPromptGate.js 導入前）へ
// main.js だけを一時的に差し替えて実行し、1・2 が FAIL する（修正後のコードに戻すと
// PASS する）ことを確認済み。
//
// 【4（正常系）が無いと、ゲートを常に false にした実装でも 1〜3 は通ってしまう点に注意】
// 1〜3 はどれも「自動応答が送られないこと」しか見ていないため、canAutoRespond が
// 常に false を返す実装に壊れていてもすべて PASS してしまう。4 はここを埋めるために
// 「送られるべき場面で実際に送られること」を固定する。実際に canAutoRespond を
// 一時的に `return false;` へ差し替えて実行し、4 だけが FAIL する（1〜3 は
// 「送られないこと」の確認なので、この壊し方では引き続き PASS する）ことを確認済み。

// フェイク claude 実行ファイルを一時ディレクトリに作る。source には生成する
// フェイクスクリプトの本体（JS ソース文字列）を渡す。
function createFakeClaude(root, source) {
  const binDir = path.join(root, 'bin');
  const executablePath = path.join(binDir, 'claude');
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(executablePath, `#!/usr/bin/env node\n${source}`, { mode: 0o755 });
  return { binDir };
}

// 標準入力（自動 Enter）を受け取るたびに "AUTO_ENTER_RECEIVED:<n>" を出力する
// 共通の前置き部分。setRawMode で入力をそのままバイト単位で受け取る（TTY の
// 行バッファリング・エコーに依存しない）。
const STDIN_ECHO_PREAMBLE = `
let receivedCount = 0;
if (process.stdin.isTTY) {
  try { process.stdin.setRawMode(true); } catch (_e) {}
}
process.stdin.resume();
process.stdin.on('data', () => {
  receivedCount += 1;
  process.stdout.write('AUTO_ENTER_RECEIVED:' + receivedCount + '\\r\\n');
});
// プロセスを保持し続ける（実際の対話型 CLI と同様、起動したまま待ち受ける）。
setInterval(() => {}, 1000);
`;

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

// pane の可視バッファに needle を含む行があるかを、待たずに一度だけ調べる。
async function bufferContains(win, needle, paneId) {
  return win.evaluate(({ u, id }) => {
    const t = terminals[id];
    if (!t) return false;
    const buf = t.term.buffer.active;
    for (let i = 0; i < t.term.rows; i += 1) {
      const line = buf.getLine(buf.viewportY + i);
      if (line && line.translateToString(true).includes(u)) return true;
    }
    return false;
  }, { u: needle, id: paneId });
}

test('起動完了検知の猶予を過ぎてから届く信頼確認プロンプトには自動応答しない（issue #371・旧実装からの回帰検知）', async () => {
  const port = await getFreePort();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-trust-grace-'));
  // READY_GRACE_MS を短縮し、実時間の待ちを短く保つ。
  const readyGraceMs = 300;
  // ★ trust 文言は「ready の後、猶予を過ぎてから」の1回だけしか出さない。事前に
  // 別の trust 出現を挟むと（例えば「起動直後の trust → ready → trust」の順にすると）、
  // 修正前の実装（1ペイン1回だけの単純な回数ガード）は最初の trust で早々に
  // 消費されてしまい、2回目の trust に応答しないのは修正前でも同じになる＝
  // 回帰を検知できない（安藤の指摘・必須3）。この唯一の trust 出現だけで、
  // 修正前の実装なら応答してしまう状況を作る。
  const fakeClaude = createFakeClaude(fixtureRoot, `${STDIN_ECHO_PREAMBLE}
// 1) 起動直後: 起動完了相当の文言（CLAUDE_READY_PATTERN の "Welcome to Claude" に一致）。
process.stdout.write('Welcome to Claude Code!\\r\\n');

// 2) READY_GRACE_MS（${readyGraceMs}ms）を確実に超えてから、信頼確認プロンプト相当の
//    文言を初めて（唯一）出す。この trust 出現は「ready 検知から猶予を過ぎた後」にしか
//    現れないため、修正前の実装（ready・時間を見ない単純な回数ガード）なら応答して
//    しまうはずの状況になっている。
setTimeout(() => {
  process.stdout.write('Do you trust the files in this folder?  Enter to confirm\\r\\n');
  process.stdout.write('POST_GRACE_TRUST_MARKER\\r\\n');
}, ${readyGraceMs * 5});
`);
  let launched = null;

  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-trust-grace-',
      env: {
        // フェイク claude を PATH の先頭に置く（実バイナリ・実認証状態には依存しない）。
        PATH: `${fakeClaude.binDir}${path.delimiter}${process.env.PATH || ''}`,
        VK_TERMINALS_READY_GRACE_MS: String(readyGraceMs),
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

    // (1) 起動完了相当の出力（READY_PATTERN 一致）が検知される。
    await waitForBufferText(win, 'Welcome to Claude Code!', paneId);

    // (2) 猶予を過ぎてから届いた、唯一の信頼確認文言（マーカーが出るまで待つ）。
    await waitForBufferText(win, 'POST_GRACE_TRUST_MARKER', paneId);

    // マーカー出力後、念のため少し待ってから確認する（誤って自動応答が送られていれば
    // フェイク claude がこの間に AUTO_ENTER_RECEIVED:1 を出力するはず）。
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // (3) 猶予を過ぎた後の信頼確認には自動応答していない（自動 Enter が一度も無い）。
    expect(await bufferContains(win, 'AUTO_ENTER_RECEIVED:', paneId)).toBe(false);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('自動応答の時間窓を過ぎてから届く信頼確認プロンプトには自動応答しない（issue #371・旧実装からの回帰検知）', async () => {
  const port = await getFreePort();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-trust-timewindow-'));
  // TRUST_WINDOW_MS（既定 30 秒）を短縮し、実時間で 30 秒待つことを避ける。
  const trustWindowMs = 500;
  const fakeClaude = createFakeClaude(fixtureRoot, `${STDIN_ECHO_PREAMBLE}
// TRUST_WINDOW_MS（${trustWindowMs}ms）を確実に超えてから、信頼確認プロンプト相当の
// 文言を一度だけ出す。この trust 出現は「ペイン作成から時間窓を過ぎた後」にしか
// 現れないため、修正前の実装（経過時間を一切見ない単純な回数ガード）なら応答して
// しまうはずの状況になっている（ready は一切出さない＝猶予の影響を受けない）。
setTimeout(() => {
  process.stdout.write('Do you trust the files in this folder?  Enter to confirm\\r\\n');
  process.stdout.write('POST_WINDOW_TRUST_MARKER\\r\\n');
}, ${trustWindowMs * 4});
`);
  let launched = null;

  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-trust-timewindow-',
      env: {
        PATH: `${fakeClaude.binDir}${path.delimiter}${process.env.PATH || ''}`,
        VK_TERMINALS_TRUST_WINDOW_MS: String(trustWindowMs),
      },
    });
    const { win } = launched;

    const created = await postNewPane(port, { noClaude: false });
    expect(created.status).toBe(200);
    expect(created.body && created.body.ok).toBe(true);
    const termId = created.body.termId;

    const paneId = await waitForPaneIdForTermId(win, termId);
    expect(paneId).not.toBeNull();

    // (1) 時間窓を過ぎてから届いた信頼確認文言（マーカーが出るまで待つ）。
    await waitForBufferText(win, 'POST_WINDOW_TRUST_MARKER', paneId);

    // マーカー出力後、念のため少し待ってから確認する。
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // (2) 時間窓を過ぎた後の信頼確認には自動応答していない（自動 Enter が一度も無い）。
    expect(await bufferContains(win, 'AUTO_ENTER_RECEIVED:', paneId)).toBe(false);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ─── issue #373: 時間窓の内側でも、信頼確認の文脈が無ければ応答しない ─────────
// issue #371 の時間ゲートだけでは、起動直後に出た一般的な選択メニューの
// "Enter to confirm" にも自動 Enter が送られる。信頼確認とは無関係なモデル選択相当の
// 画面を即座に出し、時間条件を満たしていても入力されないことを main.js の配線込みで固定する。
test('時間窓の内側でも、信頼確認ではない Enter to confirm だけの画面には自動応答しない（issue #373）', async () => {
  const port = await getFreePort();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-non-trust-confirm-'));
  const fakeClaude = createFakeClaude(fixtureRoot, `${STDIN_ECHO_PREAMBLE}
process.stdout.write('Choose a model\\r\\n');
process.stdout.write('1. Default\\r\\n');
process.stdout.write('2. Advanced\\r\\n');
process.stdout.write('Enter to confirm\\r\\n');
process.stdout.write('NON_TRUST_CONFIRM_MARKER\\r\\n');
`);
  let launched = null;

  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-non-trust-confirm-',
      env: {
        PATH: `${fakeClaude.binDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    });
    const { win } = launched;

    const created = await postNewPane(port, { noClaude: false });
    expect(created.status).toBe(200);
    expect(created.body && created.body.ok).toBe(true);
    const paneId = await waitForPaneIdForTermId(win, created.body.termId);
    expect(paneId).not.toBeNull();

    await waitForBufferText(win, 'NON_TRUST_CONFIRM_MARKER', paneId);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(await bufferContains(win, 'AUTO_ENTER_RECEIVED:', paneId)).toBe(false);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

// ─── 正常系: バナーとダイアログが別チャンクで届いても自動応答が維持される ──────────
// 上の3本はどれも「自動応答が送られないこと」しか見ていないため、ゲートが常に false を
// 返す実装に壊れていてもすべて PASS してしまう（安藤の指摘・MEDIUM・必須2）。また、
// main.js の配線側（ready のチャンクを受けた時点で stopWatchingIfDone が promptWatcher を
// 落としてしまわないこと。HIGH-1 の本体）は、この e2e が無いと検証されない。
// ここでは READY_GRACE_MS を既定値（3000ms）のまま、起動完了バナーと実機採取した
// Claude Code 現行 UI の信頼確認ダイアログを
// 別々の process.stdout.write（＝別の PTY チャンク）で、猶予の内側（200ms 後）に出す
// ことで、実 PTY 上で「バナーとダイアログが別チャンクで届いても自動応答が維持される」
// ことを固定する。
test('起動完了バナーと信頼確認ダイアログが別チャンクで届いても、猶予内であれば自動応答する（issue #371・正常系）', async () => {
  const port = await getFreePort();
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-trust-chunk-split-'));
  const fakeClaude = createFakeClaude(fixtureRoot, `${STDIN_ECHO_PREAMBLE}
// 1) 起動完了相当の文言（CLAUDE_READY_PATTERN の "Welcome to Claude" に一致）を出す。
process.stdout.write('Welcome to Claude Code!\\r\\n');

// 2) 200ms 後、別の write（＝別の PTY チャンク）で信頼確認ダイアログを出す。
//    READY_GRACE_MS は既定の 3000ms のまま（この spec では env を設定しない）なので、
//    猶予の内側（200ms < 3000ms）であり、自動応答されるはず。
setTimeout(() => {
  process.stdout.write(${JSON.stringify(CLAUDE_CURRENT_TRUST_PROMPT)});
}, 200);
`);
  let launched = null;

  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-trust-chunk-split-',
      env: {
        // フェイク claude を PATH の先頭に置く。VK_TERMINALS_READY_GRACE_MS は
        // 意図的に設定しない（既定の 3000ms を使う）。
        PATH: `${fakeClaude.binDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    });
    const { win } = launched;

    const created = await postNewPane(port, { noClaude: false });
    expect(created.status).toBe(200);
    expect(created.body && created.body.ok).toBe(true);
    const termId = created.body.termId;

    const paneId = await waitForPaneIdForTermId(win, termId);
    expect(paneId).not.toBeNull();

    // 起動完了バナーの直後（別チャンク）で届いた信頼確認ダイアログにも自動応答すること。
    await waitForBufferText(win, 'AUTO_ENTER_RECEIVED:1', paneId);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});
