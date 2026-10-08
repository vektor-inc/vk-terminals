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
//   という不具合があった。ここでは実物の Electron + PTY で、その 2 つを再現する出力を
//   流し、/api/states の lastLines が壊れていないことを確かめる。

// 出力が lastLines へ届いたことを検知するための後続マーカー（タイプするコマンド行には現れない）。
const READY_MARKER = 'LLREADYMARK413';
const STATUS_OLD = 'LLSTATUSOLD413';
const STATUS_NEW = 'LLSTATUSNEW413';

// 色指定を途中で区切って出力し、ステータス行をカーソルを上げて描き直すスクリプト。
// チャンクを確実に分けるため、区切りの間に sleep を挟む（PTY は 1 回の read 単位で届く）。
function writeRedrawScript(tmpRoot) {
  const scriptPath = path.join(tmpRoot, 'redraw-413.sh');
  const lines = [
    '#!/bin/sh',
    // 1) 赤色指定 ESC[31m を「ESC[3」と「1m」に分けて送る（チャンク境界で SGR が割れる）。
    "printf '\\033[3'",
    'sleep 0.4',
    `printf '1m${STATUS_OLD}\\033[0m\\n'`,
    'sleep 0.4',
    // 2) 1 行上へ戻り、行頭へ移動して行を消去し、新しいステータス行で描き直す。
    //    描き直し後はカーソルを元の行（1 行下）へ戻す。
    "printf '\\033[1A\\r\\033[2K'",
    'sleep 0.4',
    `printf '${STATUS_NEW}\\033[1B\\r'`,
    'sleep 0.4',
    `printf '%s\\n' '${READY_MARKER}'`,
  ];
  fs.writeFileSync(scriptPath, `${lines.join('\n')}\n`, 'utf8');
  return scriptPath;
}

// 最初のペインの lastLines を /api/states から読む（renderer の報告は 2000ms 間隔）。
async function readFirstLastLines(port) {
  const res = await fetch(`http://127.0.0.1:${port}/api/states`);
  if (res.status !== 200) throw new Error(`/api/states returned ${res.status}`);
  const json = await res.json();
  const terms = Object.values(json.terminals || {});
  const t = terms.find((x) => x && String(x.termId) === '1') || terms[0];
  return t ? t.lastLines : undefined;
}

// 合図のマーカーが lastLines に現れるまで待つ。時間切れは最後に見えた値を添えて失敗させる。
async function waitForMarker(port, timeoutMs = 25_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await readFirstLastLines(port);
    if (typeof last === 'string' && last.includes(READY_MARKER)) return last;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`lastLines にマーカーが現れなかった（最後に見えた値: ${JSON.stringify(last)}）`);
}

test('分割された色指定と描き直しのあとも、lastLines に断片・重複が残らない', async () => {
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
    await win.keyboard.type(`sh ${scriptPath}`);
    await win.keyboard.press('Enter');

    const lastLines = await waitForMarker(port);

    // 色指定の断片（ESC 本体・「[31m」「31m」「1m」の残り）が文字として残っていない。
    expect(lastLines, 'ESC が残っていない').not.toContain('\x1b');
    expect(lastLines, '[31m 等の断片が残っていない').not.toMatch(/\[[0-9;]*m/);
    expect(lastLines, '分割された SGR の後半「1m」が本文に付着していない').not.toMatch(/\d+m\s*LLSTATUS/);
    expect(lastLines, '分割された SGR の前半「[3」が残っていない').not.toMatch(/\[3(?!\d)/);

    // 描き直し前のステータス行は上書きされて消え、新しいステータス行が 1 行だけ残る。
    expect(lastLines, '描き直し前のステータス行が残っていない').not.toContain(STATUS_OLD);
    const newLines = lastLines.split('\n').filter((l) => l.includes(STATUS_NEW));
    expect(newLines, '描き直し後のステータス行がちょうど 1 行').toHaveLength(1);
    expect(newLines[0].trim(), 'ステータス行は新しい文言だけ').toBe(STATUS_NEW);
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
