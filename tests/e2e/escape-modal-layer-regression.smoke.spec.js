const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// 麗美が e2e レビューで追加した、issue #257 の修正（renderer/escapeLayer.js）に対するデグレ確認。
//
// escape-modal-layer.smoke.spec.js が「モーダルが開いている間の Escape」を担保するのに対し、
// こちらは「モーダルが無い / モーダルの外にフォーカスがある」ときに従来の Escape 経路が
// 壊れていないかを見る。capture フェーズの見張りは document 全体へ効くため、ここが壊れると
// ターミナルで Vim の挿入モードを抜けられなくなるなど実害が大きい。

// メインプロセス側に terminal:input の控えを仕掛ける。
// 既存ハンドラはそのまま残るので、PTY への送信自体には干渉しない。
async function installTerminalInputSpy(app) {
  await app.evaluate(({ ipcMain }) => {
    globalThis.__escapeSpyInputs = [];
    globalThis.__escapeSpyListener = (_event, _id, data) => {
      globalThis.__escapeSpyInputs.push(String(data));
    };
    ipcMain.on('terminal:input', globalThis.__escapeSpyListener);
  });
}

// 控えを空にし、直前の操作で送られた入力を持ち越さないようにする。
async function resetTerminalInputSpy(app) {
  await app.evaluate(() => { globalThis.__escapeSpyInputs = []; });
}

// 控えの中に ESC（\x1b 単体）が含まれるか。
async function sawEscapeInput(app) {
  return await app.evaluate(
    () => (globalThis.__escapeSpyInputs || []).some((data) => data === '\u001b')
  );
}

// 先頭ペインの xterm 入力欄（.xterm-helper-textarea）へフォーカスを当てる。
async function focusTerminal(win) {
  const paneId = await win.evaluate(() => document.querySelector('.pane')?.dataset.id || '');
  expect(paneId).not.toBe('');
  const textarea = win.locator(`.pane[data-id="${paneId}"] .xterm-helper-textarea`);
  await textarea.focus();
  await expect(textarea).toBeFocused();
  return paneId;
}

test.describe.serial('Escape レイヤー導入後のデグレ確認（issue #257）', () => {
  let port;
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    port = await getFreePort();
    const launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-escape-regression-',
    });
    app = launched.app;
    win = launched.win;
    tmpRoot = launched.tmpRoot;
    await installTerminalInputSpy(app);
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  // 各テストはサイドバー・モーダルの状態を前提にするため、開始時に必ず揃える。
  test.beforeEach(async () => {
    // 重なっている場合は最前面から閉じる。issue #282 で背後は inert になるため、
    // 下のモーダルの ✕ を先に押しても届かない。
    await win.evaluate(() => {
      document.querySelector('.confirm-cancel')?.click();
      document.querySelector('.settings-close')?.click();
    });
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('.confirm-overlay')).toHaveCount(0);
    const sidebarOpen = await win.locator('#root').evaluate(
      (root) => root.classList.contains('sidebar-open')
    );
    if (!sidebarOpen) await win.locator('#menu-btn').click();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
    await resetTerminalInputSpy(app);
  });

  test('モーダルが無いときの Escape はターミナルへ届く', async () => {
    // サイドバーが開いていても、フォーカスがターミナルにある間は Escape が
    // PTY まで到達する（Vim の挿入モード脱出などが従来どおり効く）。
    await focusTerminal(win);
    await win.keyboard.press('Escape');

    await expect.poll(() => sawEscapeInput(app)).toBe(true);
  });

  // 【経緯】#257 の時点ではパネルを開いたままターミナルへフォーカスを移せたため、
  // 「パネル外にフォーカスがある状態の Escape」を再現して見張りの効きを確かめていた。
  // #282 でフォーカストラップが入り、背後（ペイン領域）が inert になってその状態自体を
  // 作れなくなったので、確認内容を「フォーカスも Escape も背後へ届かない」へ改めた。
  test('設定パネルが開いている間はターミナルへフォーカスも Escape も通さない', async () => {
    const paneId = await win.evaluate(() => document.querySelector('.pane')?.dataset.id || '');
    expect(paneId).not.toBe('');
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    // 背後が inert なので、直接 focus() を呼んでもターミナルへは入らない。
    await win.locator(`.pane[data-id="${paneId}"] .xterm-helper-textarea`)
      .evaluate((textarea) => textarea.focus());
    expect(
      await win.evaluate(() => Boolean(document.activeElement?.closest('.settings-modal'))),
      'パネル表示中にフォーカスがターミナルへ抜けた'
    ).toBe(true);

    // capture フェーズの見張りが先に消費するため、PTY へは何も送られない。
    await resetTerminalInputSpy(app);
    await win.keyboard.press('Escape');

    await expect(win.locator('.settings-modal')).toHaveCount(0);
    expect(await sawEscapeInput(app)).toBe(false);
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
    // 閉じる時点でフォーカスはパネル内にあるため、操作元の歯車へ戻る。
    // サイドバーが誤って閉じた場合の遅延フォーカス（約 220ms）を越えても変わらない。
    await win.waitForTimeout(400);
    await expect(win.locator('#settings-btn')).toBeFocused();

    // 閉じたあとは見張りも inert も外れ、同じ操作で再び ESC が PTY へ届く。
    await focusTerminal(win);
    await resetTerminalInputSpy(app);
    await win.keyboard.press('Escape');
    await expect.poll(() => sawEscapeInput(app)).toBe(true);
  });

  test('サイドバーだけが開いた状態の Escape は従来どおりサイドバーを閉じる', async () => {
    // ターミナル以外（☰ ボタン）にフォーカスがある平常時の経路。
    await win.locator('#menu-btn').focus();
    await win.keyboard.press('Escape');

    await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
    await expect
      .poll(() => win.evaluate(() => (document.activeElement && document.activeElement.id) || ''))
      .toBe('menu-btn');
  });

  test('重なった確認ダイアログは最前面から順に 1 つずつ閉じる', async () => {
    // 設定パネルの上に確認ダイアログを重ね、Escape が LIFO で消費されるかを見る。
    // 確認ダイアログはペインの ✕ から開くが、設定パネルが前面にあるとクリックできないため
    // 同じ関数を直接呼ぶ。
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    const paneId = await win.evaluate(() => document.querySelector('.pane')?.dataset.id || '');
    await win.evaluate((id) => window.openCloseConfirmDialog(id), paneId);
    await expect(win.locator('.confirm-overlay')).toBeVisible();

    // 1 回目: 最後に開いた確認ダイアログだけが閉じ、設定パネルは残る。
    await win.keyboard.press('Escape');
    await expect(win.locator('.confirm-overlay')).toHaveCount(0);
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // 2 回目: 設定パネルが閉じる。サイドバーはまだ開いたまま。
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // 3 回目: ようやくサイドバーが閉じ、☰ へフォーカスが戻る。
    await win.keyboard.press('Escape');
    await expect(win.locator('#root')).not.toHaveClass(/\bsidebar-open\b/);
    await expect
      .poll(() => win.evaluate(() => (document.activeElement && document.activeElement.id) || ''))
      .toBe('menu-btn');
  });

  test('IME 変換中の Escape はパネルもサイドバーも閉じない', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    // Playwright の keyboard では isComposing を立てられないため、変換中の Escape を
    // 合成イベントで再現する（入力欄から bubbles させ、document の capture へ届かせる）。
    await win.locator('#set-field-0').focus();
    await win.locator('#set-field-0').evaluate((el) => {
      el.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        isComposing: true,
        bubbles: true,
        cancelable: true,
        composed: true,
      }));
    });

    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    // 変換確定後の Escape は従来どおりパネルだけを閉じる。
    await win.keyboard.press('Escape');
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
  });

  // issue #347: toBeFocused() は既定の expect タイムアウト（5 秒）のままだと、
  // 負荷試験で実際に不安定（フォーカスの復帰が 5 秒以内に終わらず失敗）として
  // 現れた。他ファイルの同種の描画確認に合わせて明示的に延ばす。
  test('✕ / キャンセルで閉じても操作元のボタンへフォーカスが戻る', async () => {
    // ✕ ボタン
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('.settings-close').click();
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#settings-btn')).toBeFocused({ timeout: 10_000 });

    // キャンセルボタン
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('.settings-cancel').click();
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#settings-btn')).toBeFocused({ timeout: 10_000 });

    // どちらもサイドバーは開いたまま。
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);
  });

  // mousedown の既定動作より先にパネルを閉じても、フォーカスの復帰先を維持する。
  test('背景クリックで閉じても操作元のボタンへフォーカスが戻る', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();
    await win.locator('.settings-overlay').click({ position: { x: 4, y: 4 } });
    await expect(win.locator('.settings-modal')).toHaveCount(0);
    await expect(win.locator('#settings-btn')).toBeFocused();
  });

  // 背景クリック時の既定動作を止める対処は設定パネルと確認ダイアログの両方に入れてある。
  // 設定パネル側だけを見ていると、片方だけ戻し忘れても気づけないため両方を押さえる。
  test('確認ダイアログを背景クリックで閉じても ✕ ボタンへフォーカスが戻る', async () => {
    const paneId = await win.evaluate(() => document.querySelector('.pane')?.dataset.id || '');
    const closeBtn = win.locator(`.pane[data-id="${paneId}"] .btn-close`);
    await closeBtn.focus();
    await win.evaluate((id) => window.openCloseConfirmDialog(id), paneId);
    await expect(win.locator('.confirm-overlay')).toBeVisible();

    await win.locator('.confirm-overlay').click({ position: { x: 4, y: 4 } });
    await expect(win.locator('.confirm-overlay')).toHaveCount(0);
    await expect(closeBtn).toBeFocused();
    // 背景クリックはキャンセル扱い。ペインは閉じられずに残る。
    await expect(win.locator(`.pane[data-id="${paneId}"]`)).toHaveCount(1);
  });

  // 既定動作を止めるのは背景（オーバーレイ自身）を押したときだけで、モーダルの中は
  // 素通しにしてある。ここが効きすぎるとテキスト選択や入力欄のクリックまで死ぬ。
  //
  // 【確かめ方（issue #294）】主たる確認は「モーダル内の mousedown が preventDefault
  // されていないこと」そのものを見る。当初はドラッグで文字が選べたかという“結果”だけを
  // 見ていたが、それは環境と負荷に左右されるため、確認したい性質より先にドラッグの成否で
  // 落ちていた。背景を押したときは逆に true になることも併せて見る（常に false を返すだけの
  // 空検査になっていないかの担保）。
  //
  // 【ドラッグの対象にラベルを使わない理由（issue #294）】label は押下すると紐づく入力欄へ
  // フォーカスを移し、そのとき文書の選択が解除される（実測: ラベル上の文字を選んだ状態で
  // 対応する input に focus() すると選択が空になる。ラベル以外の文字の選択はそのまま残る）。
  // Chromium はラベル上の文字が選択済みならこの転送を抑止するため、ドラッグが選択として
  // 成立した回だけ選択が残り、負荷でドラッグが選択にならなかった回はフォーカスが移って
  // 選択が空になる、という不安定さを抱えていた。押してもフォーカスが移らない普通のテキスト
  // （説明文）を対象にすれば、この経路を丸ごと避けられる。
  test('背景の preventDefault はモーダル内の選択・クリックを妨げない', async () => {
    await win.locator('#settings-btn').click();
    await expect(win.locator('.settings-modal')).toBeVisible();

    // document のバブリング段で mousedown を拾う。overlay 自身に張ってあるハンドラより
    // 後に走るので、そこで既定動作が止められたかを defaultPrevented で見分けられる。
    await win.evaluate(() => {
      globalThis.__mousedownLog = [];
      globalThis.__mousedownProbe = (e) => {
        globalThis.__mousedownLog.push({
          inModal: Boolean(e.target.closest && e.target.closest('.settings-modal')),
          prevented: e.defaultPrevented,
        });
      };
      document.addEventListener('mousedown', globalThis.__mousedownProbe);
    });
    const takeMousedownLog = () => win.evaluate(() => {
      const log = globalThis.__mousedownLog || [];
      globalThis.__mousedownLog = [];
      return log;
    });
    // 直前の操作で溜まった分を捨て、次に押した 1 回だけを見られるようにする
    // （中身は takeMousedownLog と同じで、戻り値を使わないことを名前で示すための別名）。
    const drainMousedownLog = takeMousedownLog;

    // プローブは document へ張るため、途中で assertion が落ちても必ず外す。残ると
    // 後続テストの mousedown が __mousedownLog に溜まり、次の取得が余計な要素を
    // 拾って落ちる、という追いにくい壊れ方をする。
    try {
      // モーダル内を押しても既定動作は止められていない。
      await drainMousedownLog();
      await win.locator('#set-field-0').click();
      expect(
        await takeMousedownLog(),
        'モーダル内の mousedown で既定動作が止められている'
      ).toEqual([{ inModal: true, prevented: false }]);

      // モーダル内の入力欄はクリックで従来どおりフォーカスできる。
      await expect(win.locator('#set-field-0')).toBeFocused();

      // モーダル内の説明文はドラッグで範囲選択できる。負荷でマウスの動きが丸められると
      // 選択が成立しないことがあるため、ドラッグごとやり直す（1 回のドラッグ結果を
      // ポーリングしても、成立しなかった回は何度見ても空のままで意味がない）。
      const helpText = win.locator('.settings-modal .settings-help').first();
      const helpToggle = win.locator('.settings-modal .settings-help-toggle').first();
      // 説明文はスキーマ側の help の有無で存在が決まる。将来 .first() が非表示タブの
      // ものを掴むと boundingBox() が null になり、toPass を 10 秒回した末に box.x の
      // 例外という読めない失敗になるため、対応するボタンで開いてから可視性を確かめる。
      await expect(helpToggle).toBeVisible();
      await helpToggle.click();
      await expect(helpText).toBeVisible();
      await expect(async () => {
        await win.evaluate(() => window.getSelection()?.removeAllRanges());
        const box = await helpText.boundingBox();
        await win.mouse.move(box.x + 2, box.y + box.height / 2);
        await win.mouse.down();
        await win.mouse.move(box.x + box.width - 2, box.y + box.height / 2, { steps: 10 });
        await win.mouse.up();
        expect(await win.evaluate(() => String(window.getSelection()))).not.toBe('');
      }).toPass({ timeout: 10_000 });

      // 対称性の確認: 背景そのものを押したときは既定動作が止まる（= 上の false が
      // 「そもそも誰も止めていない」ではなく、モーダル内だけ素通しである証拠になる）。
      await drainMousedownLog();
      await win.locator('.settings-overlay').click({ position: { x: 4, y: 4 } });
      expect(
        await takeMousedownLog(),
        '背景の mousedown で既定動作が止められていない'
      ).toEqual([{ inModal: false, prevented: true }]);
      await expect(win.locator('.settings-modal')).toHaveCount(0);
    } finally {
      await win.evaluate(() => {
        document.removeEventListener('mousedown', globalThis.__mousedownProbe);
        delete globalThis.__mousedownProbe;
        delete globalThis.__mousedownLog;
      });
    }
  });
});
