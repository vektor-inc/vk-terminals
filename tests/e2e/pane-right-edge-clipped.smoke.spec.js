const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// ─── ペイン右端の文字が見切れる不具合の回帰確認（issue #408） ────────────────────────
//
// 【症状】日本語中心の長い行（Claude Code の出力）が、行が折り返し直前まで全角文字で
// 埋まる（余りセルが無い）ときだけ、右端の文字が 1〜2 文字ぶん見えなくなる。
//
// 【原因（実測で特定。司への調査報告参照）】xterm.js（@xterm/xterm 6.0.0・DOM
// レンダラー）は各行（.xterm-rows 直下の div）に `overflow: hidden` と
// `width: cols * セル幅(px)` を JS で直接設定し、CJK フォールバックフォント
// （fontFamily は Menlo で日本語は非対応のため別フォントに委譲される）の実際の文字幅と
// セル幅のずれを letter-spacing で補正して cols 分の幅に収めようとする。行が折り返し
// 直前まで全角文字で埋まる（余りセルが無い）ときだけこの補正がわずかに足りず、行自身の
// 描画幅が計算上の `width`（行自身の box）を最大 30px 程度（全角文字 2 つ弱）超え、
// 行自身の overflow: hidden によって末尾の文字がそのまま見えなくなる（.term-container
// 側の余白に届くより先に、行自身でクリップされる）。
//
// 【対処（2点セット。renderer/style.css・renderer/app.js の該当コメント参照）】
//  1. renderer/style.css の `.xterm-rows > div` へ `overflow-x: visible !important` と
//     `overflow-y: clip !important` をあわせて上書きし、行自身の水平クリップを解除して
//     .term-container を唯一のクリップ境界にする（overflow-x だけを visible にしても、
//     CSS の visible/非visible 混在時の自動変換規則で auto に化けて効かない。安藤レビュー
//     指摘・HIGH-1）。
//  2. renderer/app.js の fitTerminal() で、fitAddon.proposeDimensions() の cols から
//     安全マージン（2 列。実測根拠は fitTerminal() 直前のコメント参照）を引いて
//     .term-container 側の可視範囲そのものからもはみ出さないようにする。
// 1 だけでは .term-container レベルでわずかにはみ出す場合があり、2 だけでは行自身の
// overflow: hidden が先に効くため見た目は変わらない。両対処が揃って初めて解消する
// （司への調査報告に実測値つきで記録済み）。
//
// 【この spec の見方（安藤レビュー指摘・MEDIUM-3 を反映）】実際に見える右端は、
//  - 行自身が横方向をクリップする設定（overflow-x が visible ではない）なら、
//    行自身の box の右端（.term-container まで届く前に切り取られる）
//  - クリップしない設定なら .term-container の可視右端
// のどちらか近い方（＝小さい方）で決まる。行の実描画幅（Range.getBoundingClientRect）
// が、その「実際に見える右端」を超えていれば、その超過分は確実に非表示（見切れている）。
// .term-container の可視右端だけを見ると、上記 1（行自身のクリップ解除）が効いていない
// 状態でも「たまたま .term-container 側の余白に収まっている」ケースで見逃してしまう
// （2 だけ・1 が入っていない状態がこれに当たる）。

async function postSend(port, input) {
  const res = await fetch(`http://127.0.0.1:${port}/api/send`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ termId: '1', input }),
  });
  let body = null;
  try { body = await res.json(); } catch (_e) { /* 診断用 */ }
  return { res, body };
}

// termId "1" は起動時に renderer が作る最初のペインの PTY。登録前は 404 を返すため、
// 200 になるまで短くリトライする（他 spec の waitForPtyRegistration と同じ考え方）。
async function waitForPtyRegistration(port) {
  const deadline = Date.now() + 20_000;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const { res, body } = await postSend(port, '');
      if (res.status === 200) return;
      lastError = new Error(`terminal 1 not ready: ${JSON.stringify(body)}`);
    } catch (e) {
      lastError = e;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw lastError || new Error('terminal 1 was not registered in time');
}

// 安藤レビュー指摘・MEDIUM-4（固定待ちの排除）: needle（送った文の末尾）が現在行に
// そのまま現れるか、直前行との連結に現れるまで待つ。長い文は cols いっぱいで折り返される
// ため、単独の行には現れないことがある（tests/e2e/terminal-link-open-url.smoke.spec.js の
// findTailRow と同じ考え方。詳細コメントは重複させずそちらを参照）。固定の setTimeout
// 待ちを使わず、実際にバッファへ描画されたことをポーリングで確認する。
async function waitForWrappedTail(win, needle, paneId = 'pane-1', tailLen = 10, timeout = 15_000) {
  const tail = needle.slice(-tailLen);
  await win.waitForFunction(({ u, id }) => {
    const t = terminals[id];
    if (!t) return false;
    const buf = t.term.buffer.active;
    let prevText = '';
    for (let i = 0; i < t.term.rows; i += 1) {
      const line = buf.getLine(buf.viewportY + i);
      const text = line ? line.translateToString(true) : '';
      if (text.includes(u) || (prevText + text).includes(u)) return true;
      prevText = text;
    }
    return false;
  }, { u: tail, id: paneId }, { timeout });
}

// 安藤レビュー指摘・MEDIUM-4（再現条件の確認）: このテストが実際に「折り返し直前まで
// 全角文字で埋まった行」を作れているかを、はみ出し判定の前に確認する。cols-1 列目・
// cols-2 列目（ワイド文字が右端に来て 1 つ前のセルへ追い出された場合を考慮）のいずれかに
// 空白以外の文字がある行の数を返す。
async function countFullyPackedRows(win, paneId = 'pane-1') {
  return win.evaluate(({ id }) => {
    const t = terminals[id];
    if (!t) return 0;
    const term = t.term;
    const buf = term.buffer.active;
    let count = 0;
    for (let i = 0; i < term.rows; i += 1) {
      const line = buf.getLine(buf.viewportY + i);
      if (!line) continue;
      const isNonSpace = (x) => {
        const cell = line.getCell(x);
        if (!cell) return false;
        const ch = cell.getChars();
        return ch !== '' && ch !== ' ';
      };
      if (isNonSpace(term.cols - 1) || isNonSpace(term.cols - 2)) count += 1;
    }
    return count;
  }, { id: paneId });
}

// 可視バッファの各行について、行の実描画幅（.xterm-rows の子 div の中身を Range で
// 測った右端）が「実際に見える右端」をはみ出していないか（＝見切れていないか）をまとめて
// 返す。安藤レビュー指摘・MEDIUM-3: 「実際に見える右端」は、行自身が横方向をクリップする
// 設定（overflow-x が visible ではない）なら行自身の box の右端、そうでなければ
// .term-container の可視右端のうち小さい方で決まる（行自身の box の右端は常に
// .term-container の可視右端以下のため、実質「行がクリップするなら行の右端、
// しないなら container の右端」になる）。
async function measureRowOverflow(win, paneId = 'pane-1') {
  return win.evaluate(({ id }) => {
    const t = terminals[id];
    if (!t) return null;
    const term = t.term;
    const containerEl = document.querySelector(`.pane[data-id="${id}"] .term-container`);
    const screenEl = document.querySelector(`.pane[data-id="${id}"] .xterm-screen`);
    const rowsContainer = screenEl.querySelector('.xterm-rows');
    const containerRect = containerEl.getBoundingClientRect();

    const buf = term.buffer.active;
    const rows = [];
    for (let i = 0; i < term.rows; i += 1) {
      const line = buf.getLine(buf.viewportY + i);
      if (!line) continue;
      const text = line.translateToString(true);
      if (!text.trim()) continue;
      const rowEl = rowsContainer.children[i];
      if (!rowEl) continue;
      const range = document.createRange();
      range.selectNodeContents(rowEl);
      const textRect = range.getBoundingClientRect();
      const rowRect = rowEl.getBoundingClientRect();
      const rowClipsHorizontally = getComputedStyle(rowEl).overflowX !== 'visible';
      const effectiveRight = rowClipsHorizontally
        ? Math.min(containerRect.right, rowRect.right)
        : containerRect.right;
      rows.push({
        i,
        text,
        overflowVsContainer: textRect.right - effectiveRight,
      });
    }
    return { cols: term.cols, rows };
  }, { id: paneId });
}

test.describe('ペイン右端の文字が見切れる不具合の回帰確認（issue #408）', () => {
  let app;
  let win;
  let tmpRoot;
  let port;

  test.beforeAll(async () => {
    port = await getFreePort();
    ({ app, win, tmpRoot } = await launchApp({
      port,
      prefix: 'vk-terminals-e2e-pane-right-edge-clipped-',
    }));
    await waitForPtyRegistration(port);
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test('折り返し直前まで全角文字で埋まった行でも、右端の文字が見切れない', async () => {
    // 実際の Claude Code 出力に近い、日本語中心の長文を複数行送る。cols いっぱいまで
    // 全角文字で埋まる行が複数できるように、あえて長めの文を選んでいる（司への調査
    // 報告で再現を確認済みの組み合わせ）。各文の送信後は、固定時間の待ちではなく
    // waitForWrappedTail() でその文の末尾が実際にバッファへ描画されたことを確認してから
    // 次へ進む。
    const sentences = [
      '事業者の通知先メールアドレスは、既定では空です。設定していない店舗では、事業者宛ての通知が毎回何回も記録されずに送られていません。',
      'リマインダーにも、送り直しが実際に起きています。15分おきの確認で、同じリマインダーが最大4回ほど送信されます（要確認）。',
      'メールログ一覧の列は増やしません。件名の下に通知の種類と予約番号を出し、ステータスの下には再送のときだけ「再送（2回目）」などを出します。',
      '宛先が空で送らなかった場合は「未送信」と記録し、理由も残します。ただしリマインダーで送らなかった場合、今回は記録しません。',
    ];
    for (const s of sentences) {
      await postSend(port, `printf '%s\\n' "${s}"\r`);
      await waitForWrappedTail(win, s);
    }

    // 再現条件の確認（安藤レビュー指摘・MEDIUM-4）: 行末まで全角文字で埋まった行が
    // 実際に1行以上できていなければ、この先のはみ出し判定は意味を持たない
    // （何も検証できないまま green になってしまう）。
    const packedRowCount = await countFullyPackedRows(win);
    expect(
      packedRowCount,
      '再現条件（行末まで全角文字で埋まった行）が1行も作れていない。テスト文面を見直す必要がある',
    ).toBeGreaterThan(0);

    const result = await measureRowOverflow(win);
    expect(result).not.toBeNull();
    expect(result.rows.length).toBeGreaterThan(0);

    const overflowingRows = result.rows.filter((r) => r.overflowVsContainer > 0.5);
    // 失敗時に「どの行が・何 px はみ出したか」がそのまま読めるよう、メッセージへ
    // 実測値を埋め込む（見切れの再発を機械的に検知できるようにする）。
    expect(
      overflowingRows,
      `以下の行が見切れている（行自身または .term-container の可視右端をはみ出している）:\n${
        overflowingRows.map((r) => `  row ${r.i}: +${r.overflowVsContainer.toFixed(2)}px "${r.text}"`).join('\n')
      }`,
    ).toEqual([]);
  });
});
