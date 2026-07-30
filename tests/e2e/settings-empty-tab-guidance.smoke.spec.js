const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #258 / PR #272 の副作用側（重複除去でタブが空になったときの見せ方と導線）を確かめる。
//
// 重複キーの除去そのものは settings-duplicate-key.smoke.spec.js が見ている。こちらは
// 「除去した結果としてタブが空になる」ことで変わりうる周辺の挙動をまとめて固定する。
// 案内メッセージを出す／出さないの境界、保存ボタンとフッターの出し分け、未保存
// インジケータの行き先、移動ボタンの導線、そして保存対象が 1 つも無い極端な定義。
//
// 案内メッセージの境界は 5 パターンあり（説明だけのタブ / 項目が空のグループだけの
// タブ / note だけのタブ / グループも説明も無いタブ / 重複除去で空になったタブ）、うち
// 出すのは後ろ 2 つだけ。ここを 1 つのディスクリプタに同居させて、片方を直したらもう
// 片方が崩れる形の退行を 1 テストで捕まえられるようにする。
//
// ※ issue #275 で導線側の判断が更新されている。「開いても案内メッセージだけが出るタブ」を
//   指す移動ボタンは、押した先が行き止まりになるため表示しない。PR #272 の時点では同じ
//   ボタンが案内メッセージへ着地することを確かめていたが、着地したときの安全（案内が読める
//   ／キーボードで抜け出せる／パネルにフォーカスできる）は残したまま、確認する経路を
//   「タブバーから直接そのタブを開く」側へ移した。したがって、このファイルで移動ボタンが
//   表示されないことを確かめているのは #272 の退行ではなく、#275 の仕様である。

// window.VKIpc.invoke（renderer 側の中継レイヤ／issue #268）を差し替えてテスト用の設定ディスクリプタを読み込ませる。
// 保存は実ファイルへ書かず、渡された payload を window.__savedPayloads に積むだけにする
// （保存処理がどの欄を採用したかを payload で直接観測するため）。
async function installDescriptor(win, desc) {
  await win.evaluate((descriptor) => {
    const vkIpc = window.VKIpc;
    if (!window.__origInvoke) window.__origInvoke = vkIpc.invoke.bind(vkIpc);
    window.__savedPayloads = [];
    vkIpc.invoke = (channel, payload) => {
      if (channel === 'settings:describe') return Promise.resolve(descriptor);
      if (channel === 'settings:save') {
        window.__savedPayloads.push(payload);
        return Promise.resolve({ ok: true });
      }
      return Promise.resolve(null);
    };
  }, desc);
}

// 差し替えを戻す（組み込みスキーマを読ませるテストのため）。
async function restoreInvoke(win) {
  await win.evaluate(() => {
    const vkIpc = window.VKIpc;
    if (!window.__origInvoke) return;
    vkIpc.invoke = window.__origInvoke;
    delete window.__origInvoke;
  });
}

const lastPayload = (win) => win.evaluate(
  () => window.__savedPayloads[window.__savedPayloads.length - 1]
);

async function openSettings(win) {
  await win.evaluate(() => window.openSettingsModal());
  await win.waitForSelector('.settings-modal', { state: 'visible' });
}

const EMPTY_MESSAGE = 'このタブに表示できる設定項目はありません。';

// 案内メッセージの 5 パターンを 1 つに詰めたディスクリプタ。
// タブの並びは MATRIX_TAB を正とする（タブを増やすと後続の index がずれるため、
// テスト側は数値ではなく名前で参照する）。
const MATRIX_TAB = {
  fields: 0,      // 実欄あり
  onlyDesc: 1,    // 説明だけ
  emptyGroup: 2,  // 項目が空のグループだけ
  noteOnly: 3,    // note だけ
  noGroup: 4,     // グループも説明も無い
  deduped: 5,     // 重複除去で空になる
};

const NOTE_ONLY_TEXT = 'この機能は環境変数で設定します。';

function matrixDescriptor() {
  return {
    available: true,
    title: '空タブ案内の検証',
    note: '保存後に反映されます。',
    targetPath: '/tmp/settings.json',
    appVersion: '0.0.0-test',
    tabs: [
      { id: 'fields', label: '実欄あり' },
      {
        id: 'onlyDesc',
        label: '説明だけ',
        content: [
          { type: 'paragraph', text: '説明だけのタブです。' },
          { type: 'tabLink', label: '接続先の設定へ移動', tab: 'fields', field: 'host' },
          // 重複除去で欄が消えて空になるタブへ向けた移動ボタン。押した先が案内メッセージ
          // だけの行き止まりになるため、issue #275 でブロックごと表示しないようにした。
          { type: 'tabLink', label: '重複タブへ移動', tab: 'deduped', field: 'host' },
          // field の所属タブ（fields）が宣言した tab と食い違う移動ボタン。移動先自体は
          // 空ではないので、field の指定だけを落としてタブ移動は効かせる（#272 の仕様）。
          { type: 'tabLink', label: '空グループタブへ移動', tab: 'emptyGroup', field: 'host' },
          // note だけのタブは「表示できる内容がある」ので移動先として有効（ボタンは残る）。
          { type: 'tabLink', label: 'note だけのタブへ移動', tab: 'noteOnly' },
        ],
      },
      { id: 'emptyGroup', label: '空グループ' },
      { id: 'noteOnly', label: 'note だけ', note: NOTE_ONLY_TEXT },
      { id: 'noGroup', label: '中身なし' },
      { id: 'deduped', label: '重複' },
    ],
    groups: [
      {
        label: '基本設定',
        tab: 'fields',
        fields: [
          { key: 'host', label: '接続先', type: 'text' },
          { key: 'port', label: 'ポート', type: 'text' },
        ],
      },
      // 元から fields が空のグループ。既存の見た目（legend だけの枠）を変えない対象。
      { label: '未実装の設定', tab: 'emptyGroup', fields: [] },
      // 重複除去で空になるグループ。host は fields タブ側が先に描画されるので落ちる。
      {
        label: '重複した設定',
        tab: 'deduped',
        fields: [{ key: 'host', label: '後から描画される接続先', type: 'text' }],
      },
    ],
    values: { host: '', port: '' },
  };
}

const PANEL = (index) => `#settings-panel-${index}`;
const TAB = (index) => `#settings-tab-${index}`;

test.describe.serial('重複除去で空になったタブの案内と導線（PR #272 / issue #275）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-empty-tab-',
      // 実環境のディスクリプタを読み込ませない。組み込みスキーマを見るテストだけ
      // window.VKIpc の差し替えを外して素の経路に戻す。
      env: { VK_TERMINALS_APP_TITLE: '', VK_TERMINALS_SETTINGS: '' },
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.afterEach(async () => {
    const closeButton = win.locator('.settings-close');
    if (await closeButton.count() && await closeButton.isVisible()) {
      await closeButton.click().catch(() => {});
    }
    await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    await restoreInvoke(win).catch(() => {});
  });

  // ─── 観点 2: 案内メッセージの出る／出ないの境界 ─────────────────────────────

  test('案内メッセージは「中身なし」「重複除去で空」の 2 タブにだけ出る', async () => {
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    // 実欄があるタブには出さない。
    await expect(win.locator(`${PANEL(MATRIX_TAB.fields)} .settings-empty`)).toHaveCount(0);
    await expect(win.locator(`${PANEL(MATRIX_TAB.fields)} input`)).toHaveCount(2);

    // 説明コンテンツがあるタブには出さない（読むものがあるので空ではない）。
    await win.locator(TAB(MATRIX_TAB.onlyDesc)).click();
    await expect(win.locator(`${PANEL(MATRIX_TAB.onlyDesc)} .settings-content`)).toBeVisible();
    await expect(win.locator(`${PANEL(MATRIX_TAB.onlyDesc)} .settings-empty`)).toHaveCount(0);

    // 項目が空のグループがあるタブには出さない（legend だけの枠を出す既存の見た目を保つ）。
    await win.locator(TAB(MATRIX_TAB.emptyGroup)).click();
    await expect(win.locator(`${PANEL(MATRIX_TAB.emptyGroup)} fieldset.settings-group`)).toHaveCount(1);
    await expect(win.locator(`${PANEL(MATRIX_TAB.emptyGroup)} input`)).toHaveCount(0);
    await expect(win.locator(`${PANEL(MATRIX_TAB.emptyGroup)} .settings-empty`)).toHaveCount(0);

    // note だけのタブには出さない（書いた案内を打ち消してしまうため / issue #275）。
    await win.locator(TAB(MATRIX_TAB.noteOnly)).click();
    await expect(win.locator(`${PANEL(MATRIX_TAB.noteOnly)} .settings-tab-note`)).toHaveText(NOTE_ONLY_TEXT);
    await expect(win.locator(`${PANEL(MATRIX_TAB.noteOnly)} .settings-empty`)).toHaveCount(0);

    // グループも説明も無いタブには出す（従来は完全な空白パネルだった）。
    await win.locator(TAB(MATRIX_TAB.noGroup)).click();
    await expect(win.locator(`${PANEL(MATRIX_TAB.noGroup)} .settings-empty`)).toHaveText(EMPTY_MESSAGE);

    // 重複除去で空になったタブにも出す。落ちた欄は描画されない。
    await win.locator(TAB(MATRIX_TAB.deduped)).click();
    await expect(win.locator(`${PANEL(MATRIX_TAB.deduped)} .settings-empty`)).toHaveText(EMPTY_MESSAGE);
    await expect(win.getByLabel('後から描画される接続先', { exact: true })).toHaveCount(0);
    // 空になったグループは legend だけの枠も残さない。
    await expect(win.locator(`${PANEL(MATRIX_TAB.deduped)} fieldset.settings-group`)).toHaveCount(0);

    // 案内メッセージはモーダル全体で 2 つだけ（出しすぎていない）。
    await expect(win.locator('.settings-tab-panel .settings-empty')).toHaveCount(2);
    // 保存対象が無いタブには「保存後に反映されます」を継承しない（保存できる誤誘導を避ける）。
    await expect(win.locator(`${PANEL(MATRIX_TAB.noGroup)} .settings-tab-note`)).toHaveCount(0);
    await expect(win.locator(`${PANEL(MATRIX_TAB.deduped)} .settings-tab-note`)).toHaveCount(0);
  });

  // ─── 観点 1: 移動ボタンの導線（重複あり） ─────────────────────────────────

  test('移動ボタンは重複の 1 件目へ着地し、その値がそのまま保存される', async () => {
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    await win.locator(TAB(MATRIX_TAB.onlyDesc)).click();
    await win.getByRole('button', { name: '接続先の設定へ移動' }).click();

    // 着地先タブがアクティブになり、欄にフォーカスが乗り、表示領域内に収まる。
    await expect(win.locator(TAB(MATRIX_TAB.fields))).toHaveAttribute('aria-selected', 'true');
    const target = win.getByLabel('接続先', { exact: true });
    await expect(target).toBeFocused();
    const inView = await target.evaluate((el) => {
      const view = el.closest('.settings-view-config').getBoundingClientRect();
      const box = el.getBoundingClientRect();
      return box.top >= view.top && box.bottom <= view.bottom;
    });
    expect(inView).toBe(true);

    // 着地した欄へ入力 → 保存すると、その値が保存処理へ渡る。
    await target.fill('landed.example');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);
    expect((await lastPayload(win)).host).toBe('landed.example');
  });

  test('移動ボタンをキーボード（Enter / Space）で押しても同じ欄へ着地する', async () => {
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    // 矢印キーだけで説明タブへ移り、Tab でパネル内の移動ボタンまで到達する。
    await win.locator(TAB(MATRIX_TAB.fields)).focus();
    await win.keyboard.press('ArrowRight');
    await expect(win.locator(TAB(MATRIX_TAB.onlyDesc))).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(TAB(MATRIX_TAB.onlyDesc))).toBeFocused();

    // Tab を送って移動ボタンへ辿り着けること（マウス前提の導線になっていない）。
    const tabLink = win.locator(`${PANEL(MATRIX_TAB.onlyDesc)} .settings-content-tablink`).first();
    let reached = false;
    for (let i = 0; i < 6 && !reached; i += 1) {
      await win.keyboard.press('Tab');
      reached = await tabLink.evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'Tab キーで移動ボタンへ到達できない').toBe(true);

    // Enter で押すと欄まで運ばれる。
    await win.keyboard.press('Enter');
    await expect(win.locator(TAB(MATRIX_TAB.fields))).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByLabel('接続先', { exact: true })).toBeFocused();

    // Space でも同じ（button 要素の既定の活性化キー両方を確かめる）。
    await win.locator(TAB(MATRIX_TAB.onlyDesc)).click();
    await tabLink.focus();
    await win.keyboard.press('Space');
    await expect(win.locator(TAB(MATRIX_TAB.fields))).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByLabel('接続先', { exact: true })).toBeFocused();
  });

  test('表示できる内容が無いタブへの移動ボタンは、そもそも表示されない', async () => {
    // issue #275: 押しても案内メッセージだけが出るタブへは、ボタン自体を出さない
    // （ボタンは「向こうに続きがある」という約束のため、行き止まりへ送ると他の移動
    // ボタンまで信用されなくなる）。タブ自体はタブバーに残るので自力では開ける。
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    await win.locator(TAB(MATRIX_TAB.onlyDesc)).click();
    await expect(win.locator(`${PANEL(MATRIX_TAB.onlyDesc)} .settings-content`)).toBeVisible();

    // 重複除去で空になるタブ（deduped）へ向けたボタンは描画されない。
    await expect(win.getByRole('button', { name: '重複タブへ移動' })).toHaveCount(0);

    // 巻き込みが無いこと。残るべき移動ボタン 3 つ（実欄あり / 空グループ / note だけ）は
    // そのまま出る。ここが無いと「全部消えた」バグを取り逃す。
    await expect(win.locator(`${PANEL(MATRIX_TAB.onlyDesc)} .settings-content-tablink`)).toHaveCount(3);
    await expect(win.getByRole('button', { name: '接続先の設定へ移動' })).toBeVisible();
    await expect(win.getByRole('button', { name: '空グループタブへ移動' })).toBeVisible();
    await expect(win.getByRole('button', { name: 'note だけのタブへ移動' })).toBeVisible();
    // 段落などボタン以外のブロックも消えない。
    await expect(win.locator(`${PANEL(MATRIX_TAB.onlyDesc)} .settings-content-text`))
      .toHaveText('説明だけのタブです。');
    // タブバーからは今後もそのタブを開ける（タブ自体は消していない）。
    await expect(win.locator(TAB(MATRIX_TAB.deduped))).toBeVisible();
  });

  test('note だけのタブへの移動ボタンは残り、着地先に案内メッセージは出ない', async () => {
    // note に代替手段を書いたタブは「表示できる内容がある」ので移動先として有効。
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    await win.locator(TAB(MATRIX_TAB.onlyDesc)).click();
    await win.getByRole('button', { name: 'note だけのタブへ移動' }).click();

    await expect(win.locator(TAB(MATRIX_TAB.noteOnly))).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(TAB(MATRIX_TAB.noteOnly))).toBeFocused();
    await expect(win.locator(`${PANEL(MATRIX_TAB.noteOnly)} .settings-tab-note`)).toHaveText(NOTE_ONLY_TEXT);
    // note を打ち消す案内メッセージは出ない。
    await expect(win.locator(`${PANEL(MATRIX_TAB.noteOnly)} .settings-empty`)).toHaveCount(0);
  });

  test('移動先タブに属さない field を指す移動ボタンは、タブ移動だけが効く', async () => {
    // field（host）は「実欄あり」タブの欄で、宣言された tab（空グループ）とは食い違う。
    // 採用すると経路によって別のタブへ飛ぶため field だけを落とし、タブ移動は効かせる。
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    await win.locator(TAB(MATRIX_TAB.onlyDesc)).click();
    await win.getByRole('button', { name: '空グループタブへ移動' }).click();

    // 宣言どおり「空グループ」タブへ着地し、食い違う field のタブへは飛ばない。
    await expect(win.locator(TAB(MATRIX_TAB.emptyGroup))).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(PANEL(MATRIX_TAB.emptyGroup))).toBeVisible();
    await expect(win.locator(TAB(MATRIX_TAB.fields))).toHaveAttribute('aria-selected', 'false');
    // field を落としたぶん、フォーカスは移動先のタブボタンへフォールバックする
    // （食い違う field が属する「実欄あり」タブは開かれないままになる）。
    await expect(win.locator(TAB(MATRIX_TAB.emptyGroup))).toBeFocused();
    await expect(win.locator(PANEL(MATRIX_TAB.fields))).toBeHidden();
  });

  test('タブバーから直接開いた空タブは、案内メッセージが読めてキーボードでも抜け出せる', async () => {
    // #258 / #272 の成果（着いてしまった人に理由が読める・そこから抜け出せる）は残す。
    // #275 で移動ボタンからは行けなくなったため、確認はタブバーから開く経路で行う。
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    await win.locator(TAB(MATRIX_TAB.deduped)).click();
    await expect(win.locator(TAB(MATRIX_TAB.deduped))).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(PANEL(MATRIX_TAB.deduped))).toBeVisible();
    // 真っ白ではなく理由が読める。
    await expect(win.locator(`${PANEL(MATRIX_TAB.deduped)} .settings-empty`)).toHaveText(EMPTY_MESSAGE);
    // パネル自身もフォーカス可能（入力欄が無くても読み上げで辿れる）。
    await expect(win.locator(PANEL(MATRIX_TAB.deduped))).toHaveAttribute('tabindex', '0');

    // タブボタンへフォーカスを置けば、そこから矢印キーで隣のタブへ抜けられる。
    await win.locator(TAB(MATRIX_TAB.deduped)).focus();
    await expect(win.locator(TAB(MATRIX_TAB.deduped))).toBeFocused();
    await win.keyboard.press('ArrowLeft');
    await expect(win.locator(TAB(MATRIX_TAB.noGroup))).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(TAB(MATRIX_TAB.noGroup))).toBeFocused();
  });

  test('空タブを開いたまま Home / End / 矢印キーでタブ移動を続けられる', async () => {
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    // deduped は末尾のタブ（End / 回り込みの着地先も deduped になる）。
    await win.locator(TAB(MATRIX_TAB.deduped)).click();
    await win.locator(TAB(MATRIX_TAB.deduped)).focus();
    await win.keyboard.press('Home');
    await expect(win.locator(TAB(MATRIX_TAB.fields))).toHaveAttribute('aria-selected', 'true');
    await win.keyboard.press('End');
    await expect(win.locator(TAB(MATRIX_TAB.deduped))).toHaveAttribute('aria-selected', 'true');
    // 末尾から右へ回り込んで先頭へ戻る。
    await win.keyboard.press('ArrowRight');
    await expect(win.locator(TAB(MATRIX_TAB.fields))).toHaveAttribute('aria-selected', 'true');
    await win.keyboard.press('ArrowLeft');
    await expect(win.locator(TAB(MATRIX_TAB.deduped))).toHaveAttribute('aria-selected', 'true');

    // 空タブを見ている状態でも Escape で閉じられる。
    await win.keyboard.press('Escape');
    await win.waitForSelector('.settings-modal', { state: 'detached' });
    await expect(win.locator('.settings-modal')).toHaveCount(0);
  });

  // ─── 観点 3 / 4: フッターの出し分けと未保存インジケータ ─────────────────────

  test('空になったタブでは保存が隠れるが、他タブに未保存の変更があれば隠れない', async () => {
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    // 空になったタブ単体では保存対象が無いので「閉じる」だけ。
    await win.locator(TAB(MATRIX_TAB.deduped)).click();
    await expect(win.locator('.settings-save')).toBeHidden();
    await expect(win.locator('.settings-save-hint')).toBeHidden();
    await expect(win.locator('.settings-cancel')).toHaveText('閉じる');

    // 実欄があるタブへ戻して編集する。
    await win.locator(TAB(MATRIX_TAB.fields)).click();
    await expect(win.locator('.settings-save')).toBeVisible();
    await win.getByLabel('接続先', { exact: true }).fill('dirty.example');

    // 未保存インジケータは編集した欄が描画されているタブにだけ付く。
    // 重複した 2 件目が消えた分、印が別タブへ迷子になっていないことを確かめる。
    await expect(win.locator(TAB(MATRIX_TAB.fields))).toHaveClass(/is-dirty/);
    await expect(win.locator(TAB(MATRIX_TAB.fields))).toHaveAttribute('aria-label', '実欄あり（未保存の変更あり）');
    for (const index of [
      MATRIX_TAB.onlyDesc,
      MATRIX_TAB.emptyGroup,
      MATRIX_TAB.noteOnly,
      MATRIX_TAB.noGroup,
      MATRIX_TAB.deduped,
    ]) {
      await expect(win.locator(TAB(index))).not.toHaveClass(/is-dirty/);
    }

    // 未保存の変更を抱えた状態で空タブへ移っても、保存する手段は残る
    // （隠すと「閉じる」しか押せず編集内容を捨てることになる）。
    await win.locator(TAB(MATRIX_TAB.deduped)).click();
    await expect(win.locator('.settings-save')).toBeVisible();
    await expect(win.locator('.settings-cancel')).toHaveText('キャンセル');
    // 空タブから押しても保存でき、値も正しい。
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);
    expect((await lastPayload(win)).host).toBe('dirty.example');
    // 保存が済めば印は解除される。
    await expect(win.locator(TAB(MATRIX_TAB.fields))).not.toHaveClass(/is-dirty/);
  });

  // ─── 観点 5: 保存対象が 1 つも無い極端な定義 ───────────────────────────────

  test('全タブが空の定義でもパネルは壊れず、閉じる操作だけが残る', async () => {
    await installDescriptor(win, {
      available: true,
      title: '全タブ空の検証',
      note: '保存後に反映されます。',
      targetPath: '/tmp/settings.json',
      tabs: [
        { id: 'a', label: 'あ' },
        { id: 'b', label: 'い' },
        { id: 'c', label: 'う' },
      ],
      groups: [],
      values: {},
    });
    await openSettings(win);

    // 3 タブすべてに案内メッセージが出る。
    await expect(win.locator('.settings-tab')).toHaveCount(3);
    await expect(win.locator('.settings-tab-panel .settings-empty')).toHaveCount(3);
    await expect(win.locator('.settings-empty').first()).toHaveText(EMPTY_MESSAGE);
    // 入力欄は 1 つも無く、保存はどのタブでも出ない。
    await expect(win.locator('.settings-form input, .settings-form select, .settings-form textarea'))
      .toHaveCount(0);
    for (const index of [0, 1, 2]) {
      await win.locator(TAB(index)).click();
      await expect(win.locator(TAB(index))).toHaveAttribute('aria-selected', 'true');
      await expect(win.locator(PANEL(index))).toBeVisible();
      await expect(win.locator('.settings-save')).toBeHidden();
      await expect(win.locator('.settings-cancel')).toHaveText('閉じる');
    }
    // 操作不能にはならない（閉じられる）。
    await win.locator('.settings-cancel').click();
    await win.waitForSelector('.settings-modal', { state: 'detached' });
    await expect(win.locator('.settings-modal')).toHaveCount(0);
  });

  // ─── 観点 6: デグレ確認 ───────────────────────────────────────────────────

  test('タブを使わない表示でも重複除去が効き、最初の欄の値が保存される', async () => {
    // タブ無しモードは案内メッセージの対象外。重複除去だけが効いていることを確かめる。
    await installDescriptor(win, {
      available: true,
      title: 'タブ無しの重複検証',
      note: '保存後に反映されます。',
      targetPath: '/tmp/settings.json',
      groups: [
        { label: '先の設定', fields: [{ key: 'host', label: '先の接続先', type: 'text' }] },
        { label: '後の設定', fields: [{ key: 'host', label: '後の接続先', type: 'text' }] },
      ],
      values: { host: '' },
    });
    await openSettings(win);

    // タブ UI は出ず、重複した 2 件目の欄は描画されない。
    await expect(win.locator('.settings-tabs')).toHaveCount(0);
    await expect(win.getByLabel('先の接続先', { exact: true })).toBeVisible();
    await expect(win.getByLabel('後の接続先', { exact: true })).toHaveCount(0);
    // 空になったグループは枠ごと消え、残るのは 1 グループだけ。
    await expect(win.locator('fieldset.settings-group')).toHaveCount(1);

    await win.getByLabel('先の接続先', { exact: true }).fill('notabs.example');
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);
    expect((await lastPayload(win)).host).toBe('notabs.example');
  });

  test('重複の無い定義では案内メッセージが出ず、全欄が表示・保存できる', async () => {
    await installDescriptor(win, {
      available: true,
      title: '重複なしの検証',
      note: '保存後に反映されます。',
      targetPath: '/tmp/settings.json',
      tabs: [
        { id: 'general', label: '基本' },
        { id: 'net', label: '通信' },
      ],
      groups: [
        { label: '基本設定', tab: 'general', fields: [{ key: 'host', label: '接続先', type: 'text' }] },
        {
          label: '通信設定',
          tab: 'net',
          fields: [
            { key: 'port', label: 'ポート', type: 'text' },
            { key: 'secure', label: 'TLS を使う', type: 'boolean' },
          ],
        },
      ],
      values: { host: 'a', port: '1', secure: false },
    });
    await openSettings(win);

    await expect(win.locator('.settings-empty')).toHaveCount(0);
    await expect(win.locator(`${PANEL(0)} input`)).toHaveCount(1);
    await win.locator(TAB(1)).click();
    await expect(win.locator(`${PANEL(1)} input`)).toHaveCount(2);

    // 両タブを編集して 1 回の保存でまとめて送れる（従来どおり）。
    await win.getByLabel('ポート', { exact: true }).fill('2');
    await win.locator(TAB(0)).click();
    await win.getByLabel('接続先', { exact: true }).fill('b');
    await expect(win.locator(TAB(0))).toHaveClass(/is-dirty/);
    await expect(win.locator(TAB(1))).toHaveClass(/is-dirty/);
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);
    expect(await lastPayload(win)).toMatchObject({ host: 'b', port: '2', secure: false });
  });

  test('組み込みスキーマでは案内メッセージが出ず、設定項目が従来どおり表示される', async () => {
    // window.VKIpc の差し替えを外し、settings-schema.json を読む実経路で確認する。
    await restoreInvoke(win);
    await openSettings(win);

    // 組み込みは「設定」「外出先から確認」の 2 タブ。どちらも空ではないので案内は出ない。
    await expect(win.locator('.settings-tab')).toHaveCount(2);
    await expect(win.locator('.settings-empty')).toHaveCount(0);
    await expect(win.locator(`${PANEL(0)} input`).first()).toBeVisible();
    await expect(win.locator('.settings-save')).toBeVisible();

    // 説明タブへ移っても案内メッセージは増えない（説明コンテンツがあるため）。
    await win.locator(TAB(1)).click();
    await expect(win.locator('.settings-empty')).toHaveCount(0);
    await expect(win.locator('.settings-save')).toBeHidden();
  });
});
