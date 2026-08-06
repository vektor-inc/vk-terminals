const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #340 / PR #342: GET /api/states の backgroundAgents フィールドの e2e。
//
// renderer/waitingState.js の detectBackgroundAgents / extractScreenLines には
// 手書きスタブ（makeStubBuffer）に対する unit test が多数あるが、実物の xterm の
// term.buffer.active / baseY / getLine().translateToString(true) / isWrapped が
// 想定どおりに振る舞うかどうかは unit test では確認できない。ここでは実際に
// Electron 上で xterm へ Claude Code のフッターを模した文字列を出力させ、
// GET /api/states の応答（main.js → readBackgroundAgents 経由）で正しく読めることを
// 実物で確認する。
//
// フッター文字列は renderer/waitingState.js のコメント（実機の
// ~/.vk-terminals/states.json に記録された実際の画面出力の例）から取っている。

async function getStates(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  return json.terminals || {};
}

function findTermState(states, termId) {
  return Object.values(states).find((t) => t && String(t.termId) === String(termId)) || null;
}

function termIdsOf(states) {
  return Object.values(states)
    .map((t) => (t && t.termId != null ? String(t.termId) : null))
    .filter(Boolean);
}

async function waitForTermId(port, termId, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen = null;
  while (Date.now() < deadline) {
    try {
      const states = await getStates(port);
      const ids = termIdsOf(states);
      lastSeen = ids;
      if (ids.includes(String(termId))) return findTermState(states, termId);
    } catch (e) {
      lastSeen = e.message;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`termId ${termId} が ${timeoutMs}ms 以内に現れなかった。lastSeen=${JSON.stringify(lastSeen)}`);
}

// backgroundAgents が期待値になるまで GET /api/states をポーリングする。
// renderer の terminal:report-states は 2000ms 間隔なので、余裕を持って待つ。
async function waitForBackgroundAgents(port, termId, expected, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastSeen;
  while (Date.now() < deadline) {
    const states = await getStates(port);
    const t = findTermState(states, termId);
    lastSeen = t ? t.backgroundAgents : undefined;
    if (t && t.backgroundAgents === expected) return t;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `backgroundAgents が ${timeoutMs}ms 以内に ${JSON.stringify(expected)} にならなかった（最後に見えた値: ${JSON.stringify(lastSeen)}）`,
  );
}

// 既存キー（waiting / status / lastOutputTime / lastLines）が backgroundAgents 追加後も
// 従来どおりの型で返っていることを確認する（今回の PR は追加のみのはずなので、
// 既存フィールドの型・存在が変わっていないことをここで芯にする）。
function assertExistingKeysIntact(t) {
  expect(typeof t.waiting).toBe('boolean');
  expect(typeof t.status).toBe('string');
  expect(typeof t.lastOutputTime).toBe('number');
  expect(typeof t.lastLines).toBe('string');
}

// extractScreenLines は「現在の画面（term.buffer.active）の末尾 20 行」を読む。
// これは *現在の viewport の末尾* であって *直近に出力された内容の末尾* ではない
// ——ここが手書きスタブ（makeStubBuffer）と実物の xterm で唯一かみ合わなかった点。
//
// 起動直後のペインは空の viewport（実測でも数十行分ある）を持っており、そこへ
// フッター文字列を 1 行 printf しただけでは、フッターはカーソル位置（画面の上寄り）に
// 乗るだけで、画面下側の残り行は「何も書かれていない空行」のままになる。
// extractScreenLines はその「画面下側の空行」を読んでしまい、フッターは末尾 20 行の
// 範囲外に取り残されて検知できない（実際にこの e2e を書く過程で一度これで失敗し、
// 原因を xterm の buffer を直接覗いて特定した）。
//
// 実機の Claude Code は全画面（alternate screen 相当）を使い、フッターは常に画面の
// 最終行に描画される。それを再現するため、フッター本文の前に画面を埋めるだけの
// 空行を printf で流し込み、実際に画面をスクロールさせてから目的の行を出す。
// ペイン行数は環境（ウィンドウサイズ）依存のため、想定される行数を十分に上回る
// 固定値で埋める（実測ではデフォルト起動時で 45 行程度だった）。
const SCREEN_FILL_LINES = 100;

// 任意の1行をターミナルへ「画面最終行として」出力させるシェルスクリプトを書き出す。
// printf '%s\n' の引数は JSON.stringify で二重引用符化するだけで足りる
// （本文に " / $ / ` を含まないため、シェルの変数展開・コマンド置換の影響を受けない）。
function writeFooterScript(tmpRoot, name, footerLine) {
  const scriptPath = path.join(tmpRoot, name);
  const body = [
    `i=1; while [ "$i" -le ${SCREEN_FILL_LINES} ]; do printf '\\n'; i=$((i+1)); done`,
    `printf '%s\\n' ${JSON.stringify(footerLine)}`,
  ].join('\n');
  fs.writeFileSync(scriptPath, `#!/bin/sh\n${body}\n`, 'utf8');
  return scriptPath;
}

// 端末へフォーカスし、任意のコマンド文字列を入力して Enter する。
async function typeAndEnter(win, commandText) {
  const screen = win.locator('.pane .xterm-screen').first();
  await expect(screen).toBeVisible();
  await screen.click(); // xterm の隠し textarea へフォーカスを移す
  await win.keyboard.type(commandText);
  await win.keyboard.press('Enter');
}

test('GET /api/states の backgroundAgents が実物の xterm 画面から正しく検知・解除される', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp({
    port,
    prefix: 'vk-terminals-e2e-background-agents-',
  });

  try {
    // ─── 準備: termId '1'（起動時の最初のペイン）が report-states に現れるまで待つ ───
    await waitForTermId(port, '1', 20_000);

    // ─── 眼目1-3: Claude Code の画面ではない（フッターの目印が無い）ペインでは null ───
    // 起動直後は素のシェルプロンプトのみで、CLAUDE_CODE_FOOTER_PATTERN に一致する
    // 文字列はどこにも出ていないはずなので、backgroundAgents は null になるはず。
    {
      const t = await waitForTermId(port, '1', 5_000);
      expect(t.backgroundAgents).toBeNull();
      // ─── 眼目1-4: 既存キーはこの時点でも従来どおり ───
      assertExistingKeysIntact(t);
    }

    // ─── 眼目1-1: フッターに "← 2 agents" が出ていれば backgroundAgents が 2 になる ───
    // 文字列は renderer/waitingState.js のコメントに実機記録として載っている、
    // 截断されていない完全なフッター行そのもの。
    const footerWithAgents =
      '⏵⏵ bypass permissions on (shift+tab to cycle) · ← 2 agents · ↓ to manage';
    const scriptWithAgents = writeFooterScript(tmpRoot, 'footer-with-agents.sh', footerWithAgents);
    await typeAndEnter(win, `sh ${scriptWithAgents}`);

    const stateWithAgents = await waitForBackgroundAgents(port, '1', 2);
    assertExistingKeysIntact(stateWithAgents);

    // ─── 眼目1-2: その表示を消すと 0 に戻る（目印 "bypass permissions on" は残す） ───
    // 新たに SCREEN_FILL_LINES 行分の空行を流してから agents セグメントの無いフッター
    // （目印のみ）を出す。これで画面が丸ごとスクロールし直され、直前の
    // 「← 2 agents」を含む古い行は現在の viewport（末尾 20 行の走査窓）から外れる。
    // collectAgentCounts は走査窓の全行から最大値を採る仕様（安藤の指摘 HIGH-1 対応）
    // なので、古い行が走査窓に残っていると誤って 2 を拾い続けてしまう——それを
    // 避けるための「画面を実際に描き直す」操作である（clear コマンドではなく、実際の
    // 出力でスクロールさせている点が、実物の xterm の baseY 更新を通す意味を持つ）。
    const footerNoAgents = '⏵⏵ bypass permissions on (shift+tab to cycle) · ? for shortcuts';
    const scriptNoAgents = writeFooterScript(tmpRoot, 'footer-no-agents.sh', footerNoAgents);
    await typeAndEnter(win, `sh ${scriptNoAgents}`);

    const stateNoAgents = await waitForBackgroundAgents(port, '1', 0);
    assertExistingKeysIntact(stateNoAgents);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
