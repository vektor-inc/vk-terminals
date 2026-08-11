const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
// キーボードフォーカス操作・outline の読み取り・比較は共通ヘルパーへ集約している（issue #357）。
const { expectOutline, focusByKeyboard } = require('./helpers/focus-ring');

// issue #302: #267 → #280 → #292 と続いた「新しい対話部品にフォーカスリングの指定を
// 書き忘れる」再発を、個別指定に頼らず shared.css の網羅指定（:where(...):focus-visible）
// 1 箇所で拾う構造に変えた。
//
// このファイルが守るのは「網羅指定そのものが効いていること」。既存の
// settings-focus-ring.smoke.spec.js / sidebar-resizer-focus-ring.smoke.spec.js は、
// 対象が全件すでに個別の :focus-visible 指定を持つ部品のため、網羅指定
// （renderer/shared.css の :where() ブロック）を丸ごと削除しても green のまま通ってしまう
// （安藤のレビュー指摘）。ここでは「個別指定を一切持たない部品にも、網羅指定 1 本だけで
// 枠が付くこと」を直接確かめる。網羅指定を削除・弱体化するとここが赤くなる。

// issue #348: 2 テストとも env/config の指定なしで launchAppAndWait を呼んでいるため、
// 起動を 1 回に共有する。どちらもフォーカスを当てて outline を読むだけで画面の状態を
// 変更しないため、win.reload() すら不要だが、他ファイルと同じ形に揃えて念のため行う。
test.describe.serial('shared.css の網羅的フォーカスリング指定（issue #302）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-focus-ring-catch-all-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  test('タイトルバー右端の ⚙（設定を開く）ボタンは、個別の :focus-visible 指定を持たないが shared.css の網羅指定でアプリ共通のフォーカスリングが付く（issue #302）', async () => {
    await expect(win.locator('#settings-btn')).toBeVisible();
    await focusByKeyboard(win, '#settings-btn');
    // renderer/style.css に #settings-btn / .titlebar-btn 向けの :focus-visible 指定は無い。
    // ここが solid の青い枠（OS 標準の outline-style: auto ではない）になっているのは、
    // shared.css の網羅指定だけが効いている証拠。
    // width / offset を devicePixelRatio 由来の丸めを許容しつつ比較している理由は
    // helpers/focus-ring.js の冒頭コメントを参照（issue #357）。
    await expectOutline(win, '#settings-btn', {
      color: 'rgb(88, 166, 255)',
      style: 'solid',
      width: 2,
      offset: 2,
    }, '#settings-btn のフォーカスリング');
  });

  test('ペインヘッダーの操作ボタンは、キーボードフォーカス時に内側オフセットの個別上書きが効く（issue #302）', async () => {
    // --no-claude で起動すると素のシェルのペインが 1 枚だけ作られる（他 spec と同じ既定挙動）。
    const stashBtn = win.locator('.pane-header .btn-stash');
    await expect(stashBtn).toBeVisible();
    await focusByKeyboard(win, '.pane-header .btn-stash');
    // 色・太さ・スタイルはアプリ共通の値のまま、offset だけ内側 -2px になっている。
    // .pane-header は高さ 28px・.btn は 26px で外向きの枠だとヘッダー外へはみ出すため
    // （renderer/style.css の .pane-header .btn:focus-visible 参照）。
    await expectOutline(win, '.pane-header .btn-stash', {
      color: 'rgb(88, 166, 255)',
      style: 'solid',
      width: 2,
      offset: -2,
    }, '.pane-header .btn-stash のフォーカスリング');
  });

  // .agent-room-summary（renderer/style.css の .agent-room-summary:focus-visible）は
  // このファイルではテストしない。main.js の ipcMain.handle('app:get-config') が issue #70
  // （エージェントルーム（β）の一旦無効化）により、config.json の agentroom の値によらず
  // 常に agentroom: false を返す実装になっている。renderer 側の agentRoomEnabled はこの
  // 戻り値だけで決まるため、現状のアプリでは config を渡しても .agent-room-summary は
  // 一切描画されず、e2e から到達できない。issue #70 が復帰して main.js 側の固定値が
  // 外れたら、このファイルの他テストと同じ形（focusByKeyboard + expectOutline で
  // offset: '-2px' を確認）でここに追加すること。CSS 側の修正（内側オフセットの個別上書き）
  // 自体は、復帰後すぐ正しく動くよう今回のうちに入れてある。
});
