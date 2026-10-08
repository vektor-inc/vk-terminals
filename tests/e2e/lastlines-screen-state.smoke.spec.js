const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// issue #413:
//   GET /api/states の lastLines（各ペインの画面テキスト）は、出力が届くたびに
//   「行・カーソル位置・途中まで届いた制御コード」を持ち越して組み立てる方式になった。
//   旧方式は処理済みの平文と生の出力をつなぎ直して再生していたため、
//     1. チャンク境界で途切れた色指定（SGR）が文字として残る
//     2. カーソルが末尾に戻り、上げ下げして描き直したステータス行が別の行に当たり
//        同じ行が重複する
//   という不具合があった。ここでは実物の Electron + PTY で、Claude Code の画面
//   （罫線 / 入力行 / 罫線 / ステータス行）を描き直す出力を流し、
//   /api/states の lastLines が壊れていないことを確かめる。

// 出力が lastLines へ届いたことを検知するための後続マーカー（タイプするコマンド行には現れない）。
const READY_MARKER = 'LLREADYMARK413';
const SPLIT_LINE = 'LLSPLITLINE413';
const RULE = '────LL413────';
const INPUT_LINE = '❯ LLINPUT413';
const STATUS_PREFIX = 'LLSTATUS413';
const STATUS_FINAL = `${STATUS_PREFIX} v4`;

// POSIX シェル用の単一引用符クォート（パス中の ' は '\'' にエスケープする）。
function shellQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

// Claude Code の画面を再現するスクリプト。
//   - 分割した SGR（ESC[3 と 1m）は、後で消されない独立した行（SPLIT_LINE）へ出す。
//   - 枠（罫線・入力行・罫線・ステータス行）を描いたあとカーソルを入力行へ戻し、
//     以降のチャンクでステータス行へ下りて消して書き直し、また入力行へ戻る、を 3 回繰り返す。
// チャンクを確実に分けるため、区切りの間に sleep を挟む（PTY は 1 回の read 単位で届く）。
function writeRedrawScript(tmpRoot) {
  const scriptPath = path.join(tmpRoot, 'redraw-413.sh');
  const lines = [
    '#!/bin/sh',
    "printf '\\033[3'",
    'sleep 0.4',
    `printf '1m${SPLIT_LINE}\\033[0m\\n'`,
    'sleep 0.4',
    `printf '${RULE}\\n${INPUT_LINE}\\n${RULE}\\n${STATUS_PREFIX} v1\\033[2A\\r'`,
  ];
  for (const v of ['v2', 'v3', 'v4']) {
    lines.push('sleep 0.4');
    lines.push(`printf '\\033[2B\\r\\033[2K${STATUS_PREFIX} ${v}\\033[2A\\r'`);
  }
  lines.push('sleep 0.4');
  // ステータス行へ下りて改行し、その次の行へ合図を出す。
  lines.push(`printf '\\033[2B\\r\\n%s\\n' '${READY_MARKER}'`);
  fs.writeFileSync(scriptPath, `${lines.join('\n')}\n`, 'utf8');
  return scriptPath;
}

// 最初のペインの lastLines を /api/states から読む（renderer の報告は 2000ms 間隔）。
// fetch には、残り時間を上限にした timeout を付ける。
async function readFirstLastLines(port, deadline) {
  const remaining = Math.max(1, deadline - Date.now());
  const res = await fetch(`http://127.0.0.1:${port}/api/states`, {
    signal: AbortSignal.timeout(Math.min(2000, remaining)),
  });
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  const terms = Object.values(json.terminals || {});
  const t = terms.find((x) => x && String(x.termId) === '1') || terms[0];
  return t ? t.lastLines : undefined;
}

// 合図のマーカーが lastLines に現れるまで待つ。一時的な接続失敗は期限内で再試行する。
// 期限切れは、最後に読めた値と最後の通信エラーを添えて失敗させる。
async function waitForMarker(port, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  let lastError;
  while (Date.now() < deadline) {
    try {
      last = await readFirstLastLines(port, deadline);
      lastError = undefined;
      if (typeof last === 'string' && last.includes(READY_MARKER)) return last;
    } catch (err) {
      lastError = err;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(
    `lastLines にマーカーが現れなかった（最後に読めた値: ${JSON.stringify(last)}、最後の通信エラー: ${lastError ? String(lastError) : 'なし'}）`,
  );
}

test('分割された色指定と枠の描き直しのあとも、lastLines に断片・重複が残らない', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchApp({
    port,
    prefix: 'vk-terminals-e2e-lastlines-screen-state-',
  });
  try {
    const scriptPath = writeRedrawScript(tmpRoot);
    const screen = win.locator('.pane .xterm-screen').first();
    await expect(screen).toBeVisible();
    await screen.click(); // xterm の隠し textarea へフォーカスを移す
    await win.keyboard.type(`sh ${shellQuote(scriptPath)}`);
    await win.keyboard.press('Enter');

    const lastLines = await waitForMarker(port);

    // ESC や色指定の断片が文字として残っていない。
    expect(lastLines, 'ESC が残っていない').not.toContain('\x1b');
    expect(lastLines, '[31m 等の断片が残っていない').not.toMatch(/\[[0-9;]*m/);

    const lines = lastLines.split('\n').map((l) => l.trimEnd());
    // 分割された SGR を含む行は、断片が付かず完全に一致する。
    expect(lines, '分割 SGR の行が完全一致で残る').toContain(SPLIT_LINE);
    // 枠の並び（罫線 → 入力行 → 罫線 → ステータス行 → 合図）が実際の画面と一致する。
    const start = lines.indexOf(SPLIT_LINE);
    expect(lines.slice(start, start + 6)).toEqual([
      SPLIT_LINE, RULE, INPUT_LINE, RULE, STATUS_FINAL, READY_MARKER,
    ]);
    // 描き直し前のステータス行は残らず、ステータス行はちょうど 1 行。
    expect(
      lines.filter((l) => l.includes(STATUS_PREFIX)),
      'ステータス行は 1 行だけ',
    ).toEqual([STATUS_FINAL]);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
