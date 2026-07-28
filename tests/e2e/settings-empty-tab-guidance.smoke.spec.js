const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #258 / PR #272 の副作用側（重複除去でタブが空になったときの見せ方と導線）を確かめる。
//
// 重複キーの除去そのものは settings-duplicate-key.smoke.spec.js が見ている。こちらは
// 「除去した結果としてタブが空になる」ことで変わりうる周辺の挙動をまとめて固定する。
// 案内メッセージを出す／出さないの境界、保存ボタンとフッターの出し分け、未保存
// インジケータの行き先、移動ボタンの導線、そして保存対象が 1 つも無い極端な定義。
//
// 案内メッセージの境界は 4 パターンあり（説明だけのタブ / 項目が空のグループだけの
// タブ / グループも説明も無いタブ / 重複除去で空になったタブ）、うち出すのは後ろ 2 つ
// だけ。ここを 1 つのディスクリプタに同居させて、片方を直したらもう片方が崩れる形の
// 退行を 1 テストで捕まえられるようにする。

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

// 案内メッセージの 4 パターンを 1 つに詰めたディスクリプタ。
// タブ 0: 実欄あり / タブ 1: 説明だけ / タブ 2: 項目が空のグループだけ /
// タブ 3: グループも説明も無い / タブ 4: 重複除去で空になる
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
          // 重複除去で欄が消えたタブへ向けた移動ボタン。field は所属タブが食い違うため
          // 落ち、タブ移動だけが効く（＝押した先が空タブになる導線）。
          { type: 'tabLink', label: '重複タブへ移動', tab: 'deduped', field: 'host' },
        ],
      },
      { id: 'emptyGroup', label: '空グループ' },
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

test.describe.serial('重複除去で空になったタブの案内と導線（PR #272 の副作用側）', () => {
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
    await expect(win.locator(`${PANEL(0)} .settings-empty`)).toHaveCount(0);
    await expect(win.locator(`${PANEL(0)} input`)).toHaveCount(2);

    // 説明コンテンツがあるタブには出さない（読むものがあるので空ではない）。
    await win.locator(TAB(1)).click();
    await expect(win.locator(`${PANEL(1)} .settings-content`)).toBeVisible();
    await expect(win.locator(`${PANEL(1)} .settings-empty`)).toHaveCount(0);

    // 項目が空のグループがあるタブには出さない（legend だけの枠を出す既存の見た目を保つ）。
    await win.locator(TAB(2)).click();
    await expect(win.locator(`${PANEL(2)} fieldset.settings-group`)).toHaveCount(1);
    await expect(win.locator(`${PANEL(2)} input`)).toHaveCount(0);
    await expect(win.locator(`${PANEL(2)} .settings-empty`)).toHaveCount(0);

    // グループも説明も無いタブには出す（従来は完全な空白パネルだった）。
    await win.locator(TAB(3)).click();
    await expect(win.locator(`${PANEL(3)} .settings-empty`)).toHaveText(EMPTY_MESSAGE);

    // 重複除去で空になったタブにも出す。落ちた欄は描画されない。
    await win.locator(TAB(4)).click();
    await expect(win.locator(`${PANEL(4)} .settings-empty`)).toHaveText(EMPTY_MESSAGE);
    await expect(win.getByLabel('後から描画される接続先', { exact: true })).toHaveCount(0);
    // 空になったグループは legend だけの枠も残さない。
    await expect(win.locator(`${PANEL(4)} fieldset.settings-group`)).toHaveCount(0);

    // 案内メッセージはモーダル全体で 2 つだけ（出しすぎていない）。
    await expect(win.locator('.settings-tab-panel .settings-empty')).toHaveCount(2);
    // 保存対象が無いタブには「保存後に反映されます」を継承しない（保存できる誤誘導を避ける）。
    await expect(win.locator(`${PANEL(3)} .settings-tab-note`)).toHaveCount(0);
    await expect(win.locator(`${PANEL(4)} .settings-tab-note`)).toHaveCount(0);
  });

  // ─── 観点 1: 移動ボタンの導線（重複あり） ─────────────────────────────────

  test('移動ボタンは重複の 1 件目へ着地し、その値がそのまま保存される', async () => {
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    await win.locator(TAB(1)).click();
    await win.getByRole('button', { name: '接続先の設定へ移動' }).click();

    // 着地先タブがアクティブになり、欄にフォーカスが乗り、表示領域内に収まる。
    await expect(win.locator(TAB(0))).toHaveAttribute('aria-selected', 'true');
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
    await win.locator(TAB(0)).focus();
    await win.keyboard.press('ArrowRight');
    await expect(win.locator(TAB(1))).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(TAB(1))).toBeFocused();

    // Tab を送って移動ボタンへ辿り着けること（マウス前提の導線になっていない）。
    const tabLink = win.locator(`${PANEL(1)} .settings-content-tablink`).first();
    let reached = false;
    for (let i = 0; i < 6 && !reached; i += 1) {
      await win.keyboard.press('Tab');
      reached = await tabLink.evaluate((el) => el === document.activeElement);
    }
    expect(reached, 'Tab キーで移動ボタンへ到達できない').toBe(true);

    // Enter で押すと欄まで運ばれる。
    await win.keyboard.press('Enter');
    await expect(win.locator(TAB(0))).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByLabel('接続先', { exact: true })).toBeFocused();

    // Space でも同じ（button 要素の既定の活性化キー両方を確かめる）。
    await win.locator(TAB(1)).click();
    await tabLink.focus();
    await win.keyboard.press('Space');
    await expect(win.locator(TAB(0))).toHaveAttribute('aria-selected', 'true');
    await expect(win.getByLabel('接続先', { exact: true })).toBeFocused();
  });

  test('空になったタブへの移動ボタンは行き止まりにならず、案内メッセージとタブへ着地する', async () => {
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    await win.locator(TAB(1)).click();
    // 移動先の欄は重複除去で消えているため、ボタンはタブ移動だけを行う。
    await win.getByRole('button', { name: '重複タブへ移動' }).click();

    await expect(win.locator(TAB(4))).toHaveAttribute('aria-selected', 'true');
    await expect(win.locator(PANEL(4))).toBeVisible();
    // 真っ白ではなく理由が読める（PR #272 が潰した行き止まり）。
    await expect(win.locator(`${PANEL(4)} .settings-empty`)).toHaveText(EMPTY_MESSAGE);
    // フォーカスは移動先のタブボタンへ移り、キーボードでも流れが途切れない。
    await expect(win.locator(TAB(4))).toBeFocused();
    // パネル自身もフォーカス可能（入力欄が無くても読み上げで辿れる）。
    await expect(win.locator(PANEL(4))).toHaveAttribute('tabindex', '0');
  });

  test('空タブを開いたまま Home / End / 矢印キーでタブ移動を続けられる', async () => {
    await installDescriptor(win, matrixDescriptor());
    await openSettings(win);

    await win.locator(TAB(4)).click();
    await win.locator(TAB(4)).focus();
    await win.keyboard.press('Home');
    await expect(win.locator(TAB(0))).toHaveAttribute('aria-selected', 'true');
    await win.keyboard.press('End');
    await expect(win.locator(TAB(4))).toHaveAttribute('aria-selected', 'true');
    // 末尾から右へ回り込んで先頭へ戻る。
    await win.keyboard.press('ArrowRight');
    await expect(win.locator(TAB(0))).toHaveAttribute('aria-selected', 'true');
    await win.keyboard.press('ArrowLeft');
    await expect(win.locator(TAB(4))).toHaveAttribute('aria-selected', 'true');

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
    await win.locator(TAB(4)).click();
    await expect(win.locator('.settings-save')).toBeHidden();
    await expect(win.locator('.settings-save-hint')).toBeHidden();
    await expect(win.locator('.settings-cancel')).toHaveText('閉じる');

    // 実欄があるタブへ戻して編集する。
    await win.locator(TAB(0)).click();
    await expect(win.locator('.settings-save')).toBeVisible();
    await win.getByLabel('接続先', { exact: true }).fill('dirty.example');

    // 未保存インジケータは編集した欄が描画されているタブにだけ付く。
    // 重複した 2 件目が消えた分、印が別タブへ迷子になっていないことを確かめる。
    await expect(win.locator(TAB(0))).toHaveClass(/is-dirty/);
    await expect(win.locator(TAB(0))).toHaveAttribute('aria-label', '実欄あり（未保存の変更あり）');
    for (const index of [1, 2, 3, 4]) {
      await expect(win.locator(TAB(index))).not.toHaveClass(/is-dirty/);
    }

    // 未保存の変更を抱えた状態で空タブへ移っても、保存する手段は残る
    // （隠すと「閉じる」しか押せず編集内容を捨てることになる）。
    await win.locator(TAB(4)).click();
    await expect(win.locator('.settings-save')).toBeVisible();
    await expect(win.locator('.settings-cancel')).toHaveText('キャンセル');
    // 空タブから押しても保存でき、値も正しい。
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveClass(/ok/);
    expect((await lastPayload(win)).host).toBe('dirty.example');
    // 保存が済めば印は解除される。
    await expect(win.locator(TAB(0))).not.toHaveClass(/is-dirty/);
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
