const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchApp } = require('./helpers/electron-app');

// ─── ペイン右端の文字が見切れる不具合の回帰確認（issue #408） ────────────────────────
//
// 【症状】日本語中心の長い行（Claude Code の出力）が、行が折り返し直前まで全角文字で
// 埋まる（余りセルが無い）ときだけ、右端の文字が 1〜2 文字ぶん見えなくなる。
//
// 【原因（実測で特定。司への報告参照）】xterm.js（@xterm/xterm 6.0.0・DOM レンダラー）は
// 各行（.xterm-rows 直下の div）に `overflow: hidden` と `width: cols * セル幅(px)` を
// JS で直接設定し、CJK フォールバックフォント（fontFamily は Menlo で日本語は非対応の
// ため別フォントに委譲される）の実際の文字幅とセル幅のずれを letter-spacing で補正して
// cols 分の幅に収めようとする。行が折り返し直前まで全角文字で埋まる（余りセルが無い）
// ときだけこの補正がわずかに足りず、行自身の描画幅が計算上の `width` を最大 30px 程度
// （全角文字 2 つ弱）超え、行自身の overflow: hidden によって末尾の文字がそのまま
// 見えなくなる（.term-container 側の余白に届くより先に、行自身でクリップされる）。
//
// 【対処】renderer/style.css の `.xterm-rows > div { overflow-x: visible !important; }`
// で行自身の水平クリップを解除し、.term-container（addon-fit がスクロールバー分の余白を
// 見込んで広めに確保している）を唯一のクリップ境界にする。あわせて renderer/app.js の
// fitTerminal() で cols を 1 列分減らす安全マージンを設け、.term-container の可視範囲
// そのものからもはみ出さないようにしている（cols だけを 1 減らしても、行自身の
// overflow: hidden が先に効くため単独では直らない。両対処が揃って初めて解消する。
// この経緯は司への調査報告に実測値つきで記録済み）。
//
// 【この spec の見方】実際の見た目のクリップ有無を、行の実描画幅（Range.getBoundingClientRect）
// と .term-container の可視右端の位置関係で判定する。.term-container は overflow: hidden
// のため、行の実描画幅がこの右端を超えていれば、その超過分は確実に非表示（見切れている）。

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

// 可視バッファの各行について、行の実描画幅（.xterm-rows の子 div の中身を Range で
// 測った右端）が .term-container の可視右端をはみ出していないか（＝見切れていないか）を
// まとめて返す。overflowVsContainer が 0 より大きい行は、その分だけ右端が見えていない。
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
      rows.push({
        i,
        text,
        overflowVsContainer: textRect.right - containerRect.right,
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

  test('折り返し直前まで全角文字で埋まった行でも、右端の文字が .term-container の可視範囲からはみ出さない', async () => {
    // 実際の Claude Code 出力に近い、日本語中心の長文を複数行送る。cols いっぱいまで
    // 全角文字で埋まる行が複数できるように、あえて長めの文を選んでいる（麗美の実測で
    // 再現を確認済みの組み合わせ）。
    const sentences = [
      '事業者の通知先メールアドレスは、既定では空です。設定していない店舗では、事業者宛ての通知が毎回何回も記録されずに送られていません。',
      'リマインダーにも、送り直しが実際に起きています。15分おきの確認で、同じリマインダーが最大4回ほど送信されます（要確認）。',
      'メールログ一覧の列は増やしません。件名の下に通知の種類と予約番号を出し、ステータスの下には再送のときだけ「再送（2回目）」などを出します。',
      '宛先が空で送らなかった場合は「未送信」と記録し、理由も残します。ただしリマインダーで送らなかった場合、今回は記録しません。',
    ];
    for (const s of sentences) {
      await postSend(port, `printf '%s\\n' "${s}"\r`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    // 最後の出力行の描画が落ち着くまで少し待つ。
    await new Promise((resolve) => setTimeout(resolve, 500));

    const result = await measureRowOverflow(win);
    expect(result).not.toBeNull();
    expect(result.rows.length).toBeGreaterThan(0);

    const overflowingRows = result.rows.filter((r) => r.overflowVsContainer > 0.5);
    // 失敗時に「どの行が・何 px はみ出したか」がそのまま読めるよう、メッセージへ
    // 実測値を埋め込む（見切れの再発を機械的に検知できるようにする）。
    expect(
      overflowingRows,
      `以下の行が .term-container の可視右端をはみ出している（見切れている）:\n${
        overflowingRows.map((r) => `  row ${r.i}: +${r.overflowVsContainer.toFixed(2)}px "${r.text}"`).join('\n')
      }`,
    ).toEqual([]);
  });
});
