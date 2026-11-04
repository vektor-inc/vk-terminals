const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
const { installDescriptor, restoreInvoke } = require('./helpers/settings-descriptor');

// issue #525 / PR #531: 設定パネルの説明タブに置ける openFolder ブロック（指定フォルダを
// Finder で開くボタン）の e2e。PR 本文「確認手順」の手順 1〜6 を自動化している。
//
// 前提の置き方:
//   - アプリは共通ヘルパーが作る一時 HOME で起動する。main プロセスの os.homedir() は
//     HOME 環境変数を見るため、ディスクリプタに書いた `~/.vk-agents` は一時 HOME の中に
//     解決される。利用者の実 HOME（~/.vk-agents など）には一切書き込まない。
//   - Finder は実際には開かない。main プロセスの shell.openPath を「渡されたパスを記録する
//     だけ」のスタブへ差し替え（external-url-toast.smoke.spec.js の shell.openExternal の
//     差し替えと同じ方式）、開く処理に渡されたパスを記録から確かめる。
//   - 設定ディスクリプタは settings-descriptor ヘルパーで差し込む。openFolder ボタンが
//     呼ぶ VKShell.openPath は window.VKIpc.invoke を通らず preload の bridge.shell を直接
//     叩くため、ディスクリプタを差し替えても「開く」要求は本物の IPC（shell:open-path）と
//     main 側の判定（utils/openPathPolicy.js）を通る。
//
// 検証の観点（PR の確認手順との対応）:
//   A: 範囲内の既存フォルダ（~/.vk-agents）→ 開く処理が呼ばれ「開きました」
//   C: create 指定なしで未作成（~/.vk-agents/tmp-525-none）→ 開かず「フォルダがまだありません」、
//      フォルダは作られない
//   B: create: true で未作成（~/.vk-agents/tmp-525-test）→ 作られて開き
//      「フォルダが無かったため作成して開きました」。もう一度押すと前の文言が消えてから
//      「開きました」に変わる
//   D: 範囲外（~/Desktop）→ 開かず、赤い文字で「この場所は開けないため、開きませんでした」

const MESSAGES = Object.freeze({
  opened: '開きました',
  created: 'フォルダが無かったため作成して開きました',
  notFound: 'フォルダがまだありません',
  notAllowed: 'この場所は開けないため、開きませんでした',
});

// 結果表示の文字色（renderer/style.css の .settings-content-openfolder-status）。
const STATUS_COLOR_SUCCESS = 'rgb(63, 185, 80)'; // #3fb950
const STATUS_COLOR_ERROR = 'rgb(248, 81, 73)'; // #f85149

const LABELS = Object.freeze({
  a: 'A: vk-agents を開く',
  b: 'B: 未作成フォルダを作って開く',
  c: 'C: 作る指定なし',
  d: 'D: 範囲外',
  e: 'E: 相対パス（表示されないはず）',
});

// 説明タブに置くブロック。PR 本文「確認手順 > 前提条件」の 4 ブロックに、形が不正で
// 捨てられるべき 1 ブロック（E: 相対パス）を足している。パスの文字表示は部品に含めない
// 仕様なので、直前に code ブロックを置く書き方も一緒に確かめる。
function buildDescriptor() {
  return {
    available: true,
    title: 'issue #525 openFolder 検証',
    note: '',
    targetPath: '/tmp/settings-open-folder-525.json',
    appVersion: '0.0.0-test',
    tabs: [
      { id: 'fields', label: '基本' },
      {
        id: 'guide',
        label: '説明',
        content: [
          { type: 'heading', text: 'ルールの差し替え' },
          { type: 'paragraph', text: '差し替え用フォルダを Finder で開くボタンの動作確認です。' },
          { type: 'code', text: '~/.vk-agents' },
          { type: 'openFolder', label: LABELS.a, path: '~/.vk-agents' },
          { type: 'code', text: '~/.vk-agents/tmp-525-test' },
          { type: 'openFolder', label: LABELS.b, path: '~/.vk-agents/tmp-525-test', create: true },
          { type: 'code', text: '~/.vk-agents/tmp-525-none' },
          { type: 'openFolder', label: LABELS.c, path: '~/.vk-agents/tmp-525-none' },
          { type: 'code', text: '~/Desktop' },
          { type: 'openFolder', label: LABELS.d, path: '~/Desktop' },
          // 先頭が / でも ~/ でもないパスは正規化で捨てられ、ボタンは出ない（fail-closed）。
          { type: 'openFolder', label: LABELS.e, path: 'relative/dir' },
        ],
      },
    ],
    groups: [
      {
        label: '基本設定',
        tab: 'fields',
        fields: [{ key: 'host', label: '接続先', type: 'text' }],
      },
    ],
    values: { host: '' },
  };
}

// shell.openPath を main プロセス側で「記録するだけ」のスタブへ差し替える。
// 戻り値の空文字は Electron の「エラーなし」の表現。__openPathHold が true の間は応答を
// 止めておき、テスト側が __openPathRelease() を呼ぶまで「処理中」の状態を観察できるようにする。
async function stubShellOpenPath(app) {
  await app.evaluate(({ shell }) => {
    if (!globalThis.__origOpenPath) globalThis.__origOpenPath = shell.openPath;
    globalThis.__openPathCalls = [];
    globalThis.__openPathHold = false;
    globalThis.__openPathRelease = null;
    shell.openPath = async (target) => {
      globalThis.__openPathCalls.push(target);
      if (globalThis.__openPathHold) {
        await new Promise((resolve) => { globalThis.__openPathRelease = resolve; });
      }
      return '';
    };
  });
}
async function restoreShellOpenPath(app) {
  await app.evaluate(({ shell }) => {
    if (!globalThis.__origOpenPath) return;
    shell.openPath = globalThis.__origOpenPath;
    delete globalThis.__origOpenPath;
    delete globalThis.__openPathCalls;
    delete globalThis.__openPathHold;
    delete globalThis.__openPathRelease;
  });
}
const openPathCalls = (app) => app.evaluate(() => (globalThis.__openPathCalls || []).slice());
async function holdOpenPath(app, hold) {
  // app.evaluate の第 1 引数は electron モジュールで、spec から渡した値は第 2 引数に入る。
  await app.evaluate((_electron, shouldHold) => {
    globalThis.__openPathHold = shouldHold;
    if (!shouldHold && typeof globalThis.__openPathRelease === 'function') {
      globalThis.__openPathRelease();
      globalThis.__openPathRelease = null;
    }
  }, hold);
}

// ボタンと、その右隣の結果表示（同じ .settings-content-openfolder の中の role="status"）。
function openFolderRow(win, label) {
  const button = win.getByRole('button', { name: label, exact: true });
  const status = win.locator('.settings-content-openfolder').filter({ has: button }).getByRole('status');
  return { button, status };
}

// 設定パネル（モーダル）だけを撮る。ウィンドウ全体ではなくモーダルに絞るのは、サイドバー等に
// 一時 HOME のパスが映り込むのを避けるため。レビュー報告（PR コメント）に貼る画像の元になる。
async function shootModal(win, testInfo, name) {
  // 直前に押したボタンの上にマウスが残っていると hover 色で写るので、見出しの上へ退避する。
  await win.locator('.settings-modal .settings-content-heading, .settings-modal h2').first().hover().catch(() => {});
  await win.locator('.settings-modal').screenshot({ path: testInfo.outputPath(`${name}.png`) });
}

test.describe.serial('設定パネル: 説明タブの openFolder ブロック（issue #525）', () => {
  let app;
  let win;
  let tmpRoot;
  let tmpHome;
  // 一時 HOME の中の ~/.vk-agents（実体パス。macOS の一時フォルダは /var → /private/var の
  // シンボリックリンクなので、main 側が realpath で解決した値と比べるため実体に揃える）。
  let vkAgentsReal;

  test.beforeAll(async () => {
    const port = await getFreePort();
    // @step 一時 HOME に .vk-agents と Desktop を用意してアプリを起動する
    const launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-open-folder-',
      seedHome: ({ tmpHome: home }) => {
        // A の対象（既存・範囲内）と D の対象（既存・範囲外）を実在させる。
        // B / C の対象（tmp-525-test / tmp-525-none）は作らない（未作成が前提）。
        fs.mkdirSync(path.join(home, '.vk-agents'), { recursive: true });
        fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
      },
    });
    ({ app, win, tmpRoot, tmpHome } = launched);
    vkAgentsReal = fs.realpathSync(path.join(tmpHome, '.vk-agents'));

    // @step Finder を開く処理を記録だけする形に差し替え、検証用の設定定義を読み込ませる
    await stubShellOpenPath(app);
    await installDescriptor(win, buildDescriptor());

    // @step 設定パネルを開いて「説明」タブへ切り替える
    await win.evaluate(() => window.openSettingsModal());
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('#settings-tab-1').click();
    await expect(win.locator('#settings-tab-1')).toHaveAttribute('aria-selected', 'true');
  });

  test.afterAll(async () => {
    if (win) await restoreInvoke(win).catch(() => {});
    if (app) await restoreShellOpenPath(app).catch(() => {});
    if (app) await closeApp({ app, tmpRoot });
  });

  test('手順 1: 説明タブに A〜D の 4 つのボタンが表示され、形が不正なブロックは出ない', async ({}, testInfo) => {
    // @step 説明タブの内容を見る
    const buttons = win.locator('.settings-content-openfolder-btn');
    // @check A〜D の 4 つのボタンが上から順に表示される
    await expect(buttons).toHaveCount(4);
    await expect(buttons).toHaveText([LABELS.a, LABELS.b, LABELS.c, LABELS.d]);
    for (const label of [LABELS.a, LABELS.b, LABELS.c, LABELS.d]) {
      await expect(win.getByRole('button', { name: label, exact: true })).toBeVisible();
    }
    // @check 先頭が / でも ~/ でもないパスのブロック（E）はボタンが出ない
    await expect(win.getByRole('button', { name: LABELS.e, exact: true })).toHaveCount(0);

    // 結果表示は最初から DOM にあり（後から足した領域は読み上げられないことがあるため）、
    // 初期状態では空。
    const statuses = win.locator('.settings-content-openfolder-status');
    await expect(statuses).toHaveCount(4);
    for (const status of await statuses.all()) {
      await expect(status).toHaveAttribute('role', 'status');
      await expect(status).toHaveText('');
    }
    // まだ何も押していないので、開く処理は一度も呼ばれていない。
    expect(await openPathCalls(app)).toEqual([]);
    await shootModal(win, testInfo, 'step1-initial');
  });

  test('手順 2（A）: 範囲内の既存フォルダは開く処理に渡され「開きました」と表示される', async ({}, testInfo) => {
    const { button, status } = openFolderRow(win, LABELS.a);
    // @step 「A: vk-agents を開く」を押す
    await button.click();
    // @check ボタンの右に「開きました」と緑の文字で表示される
    await expect(status).toHaveText(MESSAGES.opened);
    await expect(status).not.toHaveAttribute('data-state', 'error');
    await expect(status).toHaveCSS('color', STATUS_COLOR_SUCCESS);
    // @check 開く処理には一時 HOME の中の .vk-agents（実体パス）が 1 回だけ渡される
    expect(await openPathCalls(app)).toEqual([vkAgentsReal]);
    // 処理が終わればボタンは再び押せる状態（aria-busy が外れている）。
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
    await shootModal(win, testInfo, 'step2-a-opened');
  });

  test('手順 3（C）: create 指定なしの未作成フォルダは開かず「フォルダがまだありません」、作られもしない', async ({}, testInfo) => {
    const target = path.join(tmpHome, '.vk-agents', 'tmp-525-none');
    expect(fs.existsSync(target)).toBe(false);
    const before = await openPathCalls(app);
    const { button, status } = openFolderRow(win, LABELS.c);
    // @step 「C: 作る指定なし」を押す
    await button.click();
    // @check 「フォルダがまだありません」と赤い文字で表示される
    await expect(status).toHaveText(MESSAGES.notFound);
    await expect(status).toHaveAttribute('data-state', 'error');
    await expect(status).toHaveCSS('color', STATUS_COLOR_ERROR);
    // @check 開く処理は呼ばれず、フォルダも作られていない
    expect(await openPathCalls(app)).toEqual(before);
    expect(fs.existsSync(target)).toBe(false);
    await shootModal(win, testInfo, 'step3-c-not-found');
  });

  test('手順 4（B）: create: true の未作成フォルダは作られて開き「フォルダが無かったため作成して開きました」', async ({}, testInfo) => {
    const target = path.join(tmpHome, '.vk-agents', 'tmp-525-test');
    expect(fs.existsSync(target)).toBe(false);
    const before = await openPathCalls(app);
    const { button, status } = openFolderRow(win, LABELS.b);
    // @step 「B: 未作成フォルダを作って開く」を押す
    await button.click();
    // @check 「フォルダが無かったため作成して開きました」と緑の文字で表示される
    await expect(status).toHaveText(MESSAGES.created);
    await expect(status).not.toHaveAttribute('data-state', 'error');
    await expect(status).toHaveCSS('color', STATUS_COLOR_SUCCESS);
    // @check フォルダが実際に作られ、その実体パスが開く処理に渡される
    expect(fs.existsSync(target)).toBe(true);
    expect(fs.statSync(target).isDirectory()).toBe(true);
    const after = await openPathCalls(app);
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1]).toBe(fs.realpathSync(target));
    // 作られた場所は一時 HOME の .vk-agents の中（実 HOME ではない）。
    expect(fs.realpathSync(target).startsWith(`${vkAgentsReal}${path.sep}`)).toBe(true);
    await shootModal(win, testInfo, 'step4-b-created');
  });

  test('手順 5（B 再押下）: 押した直後に前の文言が消え、処理後に「開きました」へ変わる', async ({}, testInfo) => {
    const { button, status } = openFolderRow(win, LABELS.b);
    await expect(status).toHaveText(MESSAGES.created);
    const before = await openPathCalls(app);

    // 開く処理の応答を止めておき、「押した直後」の状態を観察できるようにする。
    await holdOpenPath(app, true);
    // @step もう一度「B: 未作成フォルダを作って開く」を押す
    await button.click();
    // @check 押した直後に前回の「フォルダが無かったため作成して開きました」が消える
    await expect(status).toHaveText('');
    await expect(status).not.toHaveAttribute('data-state', 'error');
    // 処理中はボタンに aria-busy が付き、同じボタンをもう一度押しても二重に要求されない。
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await button.click();
    expect((await openPathCalls(app)).length).toBe(before.length + 1);
    await shootModal(win, testInfo, 'step5-b-busy');

    // 止めていた応答を返す。
    await holdOpenPath(app, false);
    // @check 既にフォルダがあるので、作成の文言ではなく「開きました」と表示される
    await expect(status).toHaveText(MESSAGES.opened);
    await expect(status).toHaveCSS('color', STATUS_COLOR_SUCCESS);
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
    const after = await openPathCalls(app);
    expect(after.length).toBe(before.length + 1);
    expect(after[after.length - 1]).toBe(fs.realpathSync(path.join(tmpHome, '.vk-agents', 'tmp-525-test')));
    await shootModal(win, testInfo, 'step5-b-reopened');
  });

  test('手順 6（D）: 範囲外のフォルダは開かず、赤い文字で「この場所は開けないため、開きませんでした」', async ({}, testInfo) => {
    const before = await openPathCalls(app);
    const { button, status } = openFolderRow(win, LABELS.d);
    // @step 「D: 範囲外」を押す
    await button.click();
    // @check 赤い文字で「この場所は開けないため、開きませんでした」と表示される
    await expect(status).toHaveText(MESSAGES.notAllowed);
    await expect(status).toHaveAttribute('data-state', 'error');
    await expect(status).toHaveCSS('color', STATUS_COLOR_ERROR);
    // @check 開く処理は呼ばれない（Desktop は実在するが範囲外）
    expect(await openPathCalls(app)).toEqual(before);
    expect(fs.existsSync(path.join(tmpHome, 'Desktop'))).toBe(true);
    await shootModal(win, testInfo, 'step6-d-not-allowed');
  });

  test('全操作を通して、開く処理に渡されたパスはすべて一時 HOME の .vk-agents の中だけ', async () => {
    // @step ここまでに開く処理へ渡されたパスの一覧を見る
    const calls = await openPathCalls(app);
    // @check A・B（2 回）の 3 回だけで、いずれも一時 HOME の .vk-agents 配下（実 HOME や Desktop は含まない）
    expect(calls.length).toBe(3);
    for (const target of calls) {
      expect(target === vkAgentsReal || target.startsWith(`${vkAgentsReal}${path.sep}`)).toBe(true);
    }
    // 利用者の実 HOME 配下にテスト用フォルダを作っていないことも確かめる（読むだけで書かない）。
    const realHome = process.env.HOME;
    if (realHome && realHome !== tmpHome) {
      expect(fs.existsSync(path.join(realHome, '.vk-agents', 'tmp-525-test'))).toBe(false);
      expect(fs.existsSync(path.join(realHome, '.vk-agents', 'tmp-525-none'))).toBe(false);
    }
  });

  test('見た目: ボタンはコピーボタンと同じ配色で、結果表示との間隔・文字色のコントラストが基準を満たす', async ({}, testInfo) => {
    // @step 説明タブのボタンと結果表示の計算後のスタイルを測る
    // 直前に押したボタンの上にマウスが残っていると hover 色（#30363d）を測ってしまうので退避する。
    await win.locator('.settings-modal .settings-content-heading, .settings-modal h2').first().hover();
    const metrics = await win.evaluate(() => {
      const parseRgb = (value) => {
        const m = value.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const [r, g, b] = m[1].split(',').map((v) => parseFloat(v));
        return [r, g, b];
      };
      const luminance = ([r, g, b]) => {
        const f = (c) => {
          const s = c / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        };
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
      };
      const contrast = (fg, bg) => {
        const l1 = luminance(fg);
        const l2 = luminance(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
      };
      const panelBg = parseRgb(getComputedStyle(document.querySelector('.settings-modal')).backgroundColor);
      const rows = [...document.querySelectorAll('.settings-content-openfolder')];
      const copyButton = document.querySelector('.settings-content-copy');
      const copyStyle = copyButton ? getComputedStyle(copyButton) : null;
      return rows.map((row) => {
        const button = row.querySelector('.settings-content-openfolder-btn');
        const status = row.querySelector('.settings-content-openfolder-status');
        const bs = getComputedStyle(button);
        const ss = getComputedStyle(status);
        const br = button.getBoundingClientRect();
        const sr = status.getBoundingClientRect();
        const rs = getComputedStyle(row);
        const statusColor = parseRgb(ss.color);
        return {
          label: button.textContent,
          statusText: status.textContent,
          buttonHeight: br.height,
          buttonFontSize: bs.fontSize,
          buttonBg: bs.backgroundColor,
          buttonColor: bs.color,
          buttonBorderColor: bs.borderTopColor,
          copyButtonBg: copyStyle ? copyStyle.backgroundColor : null,
          copyButtonColor: copyStyle ? copyStyle.color : null,
          copyButtonBorderColor: copyStyle ? copyStyle.borderTopColor : null,
          // ボタン右端と結果表示の左端の見えている間隔（ボタンには枠線があるので枠の端、
          // 文字は inline の箱の左端 = 字面の左端）。
          gapButtonToStatus: status.textContent ? sr.left - br.right : null,
          rowGap: rs.columnGap,
          rowMarginBottom: rs.marginBottom,
          statusFontSize: ss.fontSize,
          statusLineHeight: ss.lineHeight,
          statusColor: ss.color,
          contrastStatusOnPanel: statusColor && panelBg ? contrast(statusColor, panelBg) : null,
          contrastButtonText: contrast(parseRgb(bs.color), parseRgb(bs.backgroundColor)),
          contrastButtonBorderOnPanel: panelBg ? contrast(parseRgb(bs.borderTopColor), panelBg) : null,
          contrastButtonBgOnPanel: panelBg ? contrast(parseRgb(bs.backgroundColor), panelBg) : null,
        };
      });
    });
    // 計算後の値はレビュー報告（design-rules.md 照合）で引用するため、ファイルにも残す。
    fs.writeFileSync(testInfo.outputPath('open-folder-metrics.json'), JSON.stringify(metrics, null, 2));

    // @check ボタンの配色（背景・文字・枠線）は説明タブのコピーボタンと同じ
    for (const m of metrics) {
      expect(m.buttonBg).toBe(m.copyButtonBg);
      expect(m.buttonColor).toBe(m.copyButtonColor);
      expect(m.buttonBorderColor).toBe(m.copyButtonBorderColor);
      // @check 4 つのボタンは同じ高さで、ボタンと結果表示の間は 8px 空く
      expect(m.buttonHeight).toBeCloseTo(metrics[0].buttonHeight, 0);
      expect(m.rowGap).toBe('8px');
      if (m.gapButtonToStatus !== null) expect(m.gapButtonToStatus).toBeGreaterThanOrEqual(8);
      // @check 文字色のコントラスト比は WCAG 2.1 AA（本文 4.5:1、UI 部品 3:1）を満たす
      expect(m.contrastButtonText).toBeGreaterThanOrEqual(4.5);
      if (m.contrastStatusOnPanel !== null) expect(m.contrastStatusOnPanel).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('キーボード: Tab でボタンへ到達でき、Enter で押せてフォーカスが残る', async () => {
    const { button, status } = openFolderRow(win, LABELS.a);
    // @step 説明タブの中で Tab キーを押して「A: vk-agents を開く」へ移動する
    await win.locator('#settings-tab-1').focus();
    let reached = false;
    for (let i = 0; i < 40 && !reached; i += 1) {
      await win.keyboard.press('Tab');
      reached = await button.evaluate((el) => el === document.activeElement);
    }
    // @check Tab キーだけでボタンへ到達できる
    expect(reached).toBe(true);
    const before = await openPathCalls(app);
    // @step Enter キーを押す
    await win.keyboard.press('Enter');
    // @check 「開きました」と表示され、処理後もフォーカスがボタンに残る（disabled にしないため）
    await expect(status).toHaveText(MESSAGES.opened);
    expect((await openPathCalls(app)).length).toBe(before.length + 1);
    expect(await button.evaluate((el) => el === document.activeElement)).toBe(true);
  });

  test('最小幅: ウィンドウを最小幅（600px）にしても結果表示はボタンの右に収まり、ボタンの文字は途中で割れない', async ({}, testInfo) => {
    // @step ウィンドウをアプリの最小幅（main.js の minWidth: 600）まで狭くして説明タブを見る
    // 設定パネルの幅は min(560px, 100vw − 48px) なので、最小幅では 552px になる（これより狭い実画面は無い）。
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(600, 760); });
    const { button, status } = openFolderRow(win, LABELS.d);
    await expect(status).toHaveText(MESSAGES.notAllowed);
    // サイズ変更の反映を待つ。
    await expect.poll(async () => (await win.locator('.settings-modal').boundingBox()).width).toBeLessThanOrEqual(552);
    try {
      const rects = await win.evaluate(() => {
        const rows = [...document.querySelectorAll('.settings-content-openfolder')];
        return rows.map((row) => {
          const b = row.querySelector('.settings-content-openfolder-btn').getBoundingClientRect();
          const s = row.querySelector('.settings-content-openfolder-status').getBoundingClientRect();
          return {
            label: row.querySelector('.settings-content-openfolder-btn').textContent,
            button: { left: b.left, right: b.right, top: b.top, bottom: b.bottom, height: b.height },
            status: { left: s.left, top: s.top, width: s.width },
          };
        });
      });
      fs.writeFileSync(testInfo.outputPath('open-folder-narrow-rects.json'), JSON.stringify(rects, null, 2));
      // @check ボタンは 4 つとも 1 行の高さのまま（ラベルが語の途中で折り返されていない）
      const heights = rects.map((r) => r.button.height);
      for (const h of heights) expect(h).toBeCloseTo(heights[0], 0);
      // @check 最も長い結果表示（D）もボタンの右に同じ行で収まり、ボタンの下へ落ちない
      const d = rects.find((r) => r.label === LABELS.d);
      expect(d.status.top).toBeLessThan(d.button.bottom);
      expect(d.status.left).toBeGreaterThanOrEqual(d.button.right + 8 - 0.5);
      // @check 文字が横へはみ出していない（説明タブの内側に収まる）
      const panel = await win.locator('.settings-tab-panel:not([hidden])').boundingBox();
      expect(d.status.left + d.status.width).toBeLessThanOrEqual(panel.x + panel.width + 1);
      await shootModal(win, testInfo, 'step7-min-width-600');
    } finally {
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].setSize(1400, 900); });
    }
    await expect(button).toBeVisible();
  });
});
