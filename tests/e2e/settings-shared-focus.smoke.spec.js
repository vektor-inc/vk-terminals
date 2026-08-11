const { test, expect } = require('@playwright/test');
const path = require('path');
const builtinDescriptor = require('../../settings-schema.json');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
// 設定ディスクリプタの差し込みと後始末は共通ヘルパーへ集約している（issue #293）。
const { installDescriptor, restoreInvoke } = require('./helpers/settings-descriptor');
// キーボードフォーカス操作・outline の読み取り・比較は共通ヘルパーへ集約している（issue #357）。
const { expectOutline, focusByKeyboard, readOutline } = require('./helpers/focus-ring');

// issue #348: 以下 3 spec（settings-focus-ring / settings-code-wrap /
// settings-apihost-loopback-notice）を統合したもの。統合の根拠: 全テストが env / config
// の指定なしで launchAppAndWait を呼び（settings-focus-ring の env 指定はヘルパーの
// 既定と同値のため実質差分なし）、組み込みスキーマまたはそこに項目を注入した
// ディスクリプタを使って設定パネルの見た目・フォーカス・入力を確認する同じ形をしている。
// 起動時の設定値・環境変数を変えて確かめる spec ではないため、Electron の起動 1 回を
// 全テストで共有できる。
//
// settings-apihost-loopback-notice は元々 beforeAll でモーダルを 1 回だけ開き、4 テスト
// 全部がそのモーダルを使い続ける設計だった。起動共有後は外側の beforeEach で
// win.reload() するため、reload の都度モーダルが失われる。そのためモーダルを開く処理を
// beforeEach へ変更した（各テストが独立して入力・確認するだけの内容なので、モーダルを
// 都度開き直しても検証内容は変わらない）。
test.describe.serial('設定パネル: フォーカス・スタイル系（issue #348 で起動共有）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-shared-focus-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  // ─── 旧 settings-focus-ring.smoke.spec.js（issue #280） ──────────────────
  test.describe('設定パネルのフォーカスリングの統一（issue #280）', () => {
    function descriptorWithPassword(targetPath) {
      const descriptor = structuredClone(builtinDescriptor);
      descriptor.available = true;
      descriptor.targetPath = targetPath;
      descriptor.appVersion = '0.0.0-test';
      descriptor.values = {};
      const group = descriptor.groups?.[0];
      if (!group || !Array.isArray(group.fields)) throw new Error('settings-schema.json に fields を持つ groups が無い');
      // パスワード欄はグループ先頭に置き、スクロールしなくても操作できる位置に描かせる。
      group.fields.unshift({
        key: 'e2eSecret',
        label: 'テスト用パスワード',
        type: 'password',
        help: 'フォーカスリング確認用の項目。',
      });
      return descriptor;
    }

    // アプリ共通の自前フォーカスリング（.settings-tab / .settings-content-copy 等と同じ）。
    // width / offset は CSS px の数値で持つ（devicePixelRatio 由来の丸めを許容比較する
    // helpers/focus-ring.js の expectOutline に渡すため）。丸めの理由と、太さ・オフセットの
    // 検証を弱めずに倍率非依存にした方針は helpers/focus-ring.js の冒頭コメントを参照
    // （issue #357）。
    const APP_FOCUS_RING = {
      color: 'rgb(88, 166, 255)',
      style: 'solid',
      width: 2,
      offset: 2,
    };

    async function expectAppFocusRing(win, selector) {
      // OS 標準リングは outline-style が auto（macOS ではアンバー）になる。
      // 色・太さ・オフセットまで見て、アプリ共通の自前リングであることを主張する。
      await expectOutline(win, selector, APP_FOCUS_RING, `${selector} のフォーカスリング`);
    }

    // text/number/password/select/textarea はリングではなく border-color（青枠線）で
    // フォーカスを示す従来方式のまま（issue #291 で checkbox だけをリング対象に切り出した
    // ときの回帰確認用）。
    const INPUT_FOCUS_BORDER_COLOR = 'rgb(88, 166, 255)';

    async function readBorderColor(win, selector) {
      return await win.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) throw new Error(`${sel} が見つからない`);
        return getComputedStyle(el).borderTopColor;
      }, selector);
    }

    const TAB_GENERAL = '#settings-tab-0';
    // tabpanel は全タブ分が DOM に存在し、非アクティブなものは hidden で隠れている。
    // hidden の要素はフォーカスできないため、常に「表示中のパネル」を指すセレクタを使う。
    const ACTIVE_TAB_PANEL = '.settings-tab-panel:not([hidden])';

    test.beforeEach(async () => {
      // 起動ヘルパーが spec ごとに作成・後片付けする一時領域内だけを保存先として示す。
      await installDescriptor(win, descriptorWithPassword(path.join(tmpRoot, 'settings.json')));
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.locator(TAB_GENERAL).click();
    });

    test.afterEach(async () => {
      const closeButton = win.locator('.settings-close');
      if ((await closeButton.count()) > 0 && await closeButton.isVisible()) {
        await closeButton.click().catch(() => {});
      }
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
      await restoreInvoke(win).catch(() => {});
    });

    test('ヘッダーの閉じるボタンにアプリ共通のフォーカスリングが当たる', async () => {
      await expect(win.locator('.settings-close')).toBeVisible();
      await focusByKeyboard(win, '.settings-close');
      await expectAppFocusRing(win, '.settings-close');
    });

    test('パスワードの表示切替ボタンにアプリ共通のフォーカスリングが当たる', async () => {
      await expect(win.locator('.settings-reveal')).toBeVisible();
      await focusByKeyboard(win, '.settings-reveal');
      await expectAppFocusRing(win, '.settings-reveal');
    });

    test('フッターの保存・キャンセルにアプリ共通のフォーカスリングが当たる', async () => {
      // .settings-footer button は共通ルール。面の色が違う 2 バリアントの両方で確認する
      // （リングは面の外側に出るため、緑の保存でもグレーのキャンセルでも同じ指定になる）。
      for (const selector of ['.settings-save', '.settings-cancel']) {
        await expect(win.locator(selector)).toBeVisible();
        await focusByKeyboard(win, selector);
        await expectAppFocusRing(win, selector);
      }
    });

    test('タブの内容領域にアプリ共通のフォーカスリングが当たる', async () => {
      // tabindex="0" を持つ内容領域は Tab 順（タブボタンの直後）に止まる。
      // 全幅・全高に枠が出るぶん、ここが OS 標準リングのままだとパネル内で最も目立つ。
      await expect(win.locator(ACTIVE_TAB_PANEL)).toHaveAttribute('tabindex', '0');
      await focusByKeyboard(win, ACTIVE_TAB_PANEL);
      await expectAppFocusRing(win, ACTIVE_TAB_PANEL);
    });

    test('同じパネル内のコピーボタンとフッターのボタン・内容領域でフォーカスリングが揃う', async () => {
      // issue #280 の本題は「同じパネル内で見え方が違う」こと。既に自前リングを持つ
      // コピーボタンを基準に取り、今回そろえた要素が同じ値になることを直接比べる
      // （対象が増えても書き換えずに済むよう、ここに個数は書かない）。
      await win.locator('#settings-tab-1').click();
      await expect(win.locator('.settings-content-copy').first()).toBeVisible();
      await focusByKeyboard(win, '.settings-content-copy');
      const baseline = await readOutline(win, '.settings-content-copy');

      for (const selector of ['.settings-close', '.settings-cancel', ACTIVE_TAB_PANEL]) {
        await focusByKeyboard(win, selector);
        expect(
          await readOutline(win, selector),
          `${selector} とコピーボタンでフォーカスリングが揃わない`
        ).toEqual(baseline);
      }
    });

    test('チェックボックスにフォーカスするとアプリ共通のフォーカスリングが当たる（issue #291）', async () => {
      // チェックボックスは border-color が効かない OS 標準の見た目で描かれるため、
      // .settings-row input:focus の outline: none だけが効くとフォーカス時に何も
      // 表示されなくなる（WCAG 2.4.7 違反）。.settings-check input:focus-visible で
      // 別途アプリ共通のリングを出す指定が効いていることを確認する。
      const checkboxRow = win.locator('.settings-row-check', { hasText: 'Claude Code を自動的に起動する' });
      const checkbox = checkboxRow.locator('input[type="checkbox"]');
      await expect(checkbox).toBeVisible();
      const checkboxId = await checkbox.getAttribute('id');
      await focusByKeyboard(win, `#${checkboxId}`);
      await expectAppFocusRing(win, `#${checkboxId}`);
    });

    test('テキスト欄・セレクトボックス・複数行入力・パスワード欄はフォーカス時に従来どおり青枠線が付き、アプリ共通リングは出ない（issue #291 の回帰確認）', async () => {
      // .settings-row input:focus / select:focus / textarea:focus の対象種類を絞った
      // 変更（issue #291）が、text/select/textarea/password のフォーカス時の見た目
      // （border-color）を巻き込んでいないかを確認する。
      for (const [rowText, inputSelector] of [
        // issue #313 で追加された apiRequireAuthAlways（常にアクセストークン認証を
        // 必須にする）の説明文が「API ホストが 127.0.0.1 のままでも…」と "API ホスト"
        // を含むため、hasText: 'API ホスト' だけでは apiHost の行とチェックボックスの行の
        // 2 件にマッチしてしまう（strict mode violation）。種類まで指定して一意にする。
        ['API ホスト', 'input[type="text"]'],
        ['ペインを閉じる時の確認ダイアログ', 'select'],
        ['サイドバーメニュー (JSON 配列)', 'textarea'],
        ['テスト用パスワード', 'input'],
      ]) {
        const row = win.locator('.settings-row', { hasText: rowText });
        const field = row.locator(inputSelector);
        await expect(field).toBeVisible();
        const fieldId = await field.getAttribute('id');
        await focusByKeyboard(win, `#${fieldId}`);
        // outline は従来どおり none（アプリ共通リングの対象ではない）。
        const ring = await readOutline(win, `#${fieldId}`);
        expect(ring.style, `#${fieldId} の outline-style`).toBe('none');
        // border-color が従来どおりの青（#58a6ff）に変わっている。
        expect(
          await readBorderColor(win, `#${fieldId}`),
          `#${fieldId} の border-color`
        ).toBe(INPUT_FOCUS_BORDER_COLOR);
      }
    });
  });

  // ─── 旧 settings-code-wrap.smoke.spec.js（issue #267） ───────────────────
  test.describe('設定パネルのコード折り返しとボタン境界色（issue #267）', () => {
    function descriptorWithLongCommand(targetPath) {
      const descriptor = structuredClone(builtinDescriptor);
      descriptor.available = true;
      descriptor.targetPath = targetPath;
      descriptor.appVersion = '0.0.0-test';
      descriptor.values = {};
      const mobileTab = descriptor.tabs.find((tab) => tab.id === 'mobile');
      if (!mobileTab) throw new Error('settings-schema.json に mobile タブが無い');
      const command = `curl https://example.test/${'unbroken-command-segment-'.repeat(8)}done`;
      const target = mobileTab.content.find(
        (block) => block.type === 'code' && block.text === 'tailscale serve --bg 13847'
      );
      if (!target) throw new Error('mobile タブに "tailscale serve --bg 13847" の code ブロックが無い');
      target.text = command;
      // コピーボタンの有無で Tab 停止位置を変えず、組み込みスキーマと同じ構造を保つ。
      return { descriptor, command };
    }

    const TAB_MOBILE = '#settings-tab-1';
    const PANEL_MOBILE = '#settings-panel-1';
    let command;

    test.beforeEach(async () => {
      // 起動ヘルパーが spec ごとに作成・後片付けする一時領域内だけを保存先として示す。
      const injected = descriptorWithLongCommand(path.join(tmpRoot, 'settings.json'));
      command = injected.command;
      await installDescriptor(win, injected.descriptor);
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.locator(TAB_MOBILE).click();
    });

    test.afterEach(async () => {
      const closeButton = win.locator('.settings-close');
      if ((await closeButton.count()) > 0 && await closeButton.isVisible()) {
        await closeButton.click().catch(() => {});
      }
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
      await restoreInvoke(win).catch(() => {});
    });

    test('長いコマンドを枠内で折り返し、コード自身を Tab 停止位置に増やさない', async () => {
      const code = win.locator(`${PANEL_MOBILE} .settings-content-code`, { hasText: command });
      await expect(code).toHaveCount(1);

      // 整数丸めによる 1px の誤差だけを許し、横方向にはみ出していないことを確かめる。
      const box = await code.evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);

      // 折り返して全文を読めるため、pre 自体は余分なキーボード停止位置にしない。
      await expect(code).not.toHaveAttribute('tabindex');
    });

    test('「モバイルから確認」タブの Tab キー停止位置にコードブロックを含まない', async () => {
      await win.locator('.settings-close').focus();

      // モーダル先頭の閉じるボタンから Tab を送り、そこへ戻ってくるまでを 1 周として数える。
      // issue #282 でフォーカストラップが入り、Tab はモーダルの中で循環するようになったため、
      // 「モーダル外へ出たら 1 周」ではなく「先頭へ戻ったら 1 周」で区切る。
      // 上限を設け、循環の起点へ戻れない場合も無限ループにしない。issue #313 でアクセス
      // トークンパネル（表示・コピー・再発行等）と 2 つ目の tabLink が「モバイルから確認」
      // タブに増え、Tab 停止位置の総数が増えたため上限に余裕を持たせている。
      const stops = ['button.settings-close'];
      let cycled = false;
      for (let i = 0; i < 30; i += 1) {
        await win.keyboard.press('Tab');
        const current = await win.evaluate(() => {
          const el = document.activeElement;
          if (!el) return { stop: '(none)', inModal: false, isFirst: false };
          const className = typeof el.className === 'string'
            ? el.className.trim().split(/\s+/).filter(Boolean).join('.')
            : '';
          const stop = el.id
            ? `#${el.id}`
            : `${el.tagName.toLowerCase()}${className ? `.${className}` : ''}`;
          return {
            stop,
            inModal: Boolean(el.closest('.settings-modal')),
            isFirst: el === document.querySelector('.settings-close'),
          };
        });
        // 途中でモーダル外へ抜けたら、その時点でトラップが壊れている。
        expect(current.inModal, `Tab がモーダル外へ抜けた: ${[...stops, current.stop].join(' -> ')}`).toBe(true);
        if (current.isFirst) {
          cycled = true;
          break;
        }
        stops.push(current.stop);
      }

      expect(cycled, `Tab が先頭へ戻らない: ${stops.join(' -> ')}`).toBe(true);
      // 停止位置が空振りしていないことの担保（本文が描かれず空パスするのを防ぐ）。
      expect(stops.some((stop) => stop.includes('settings-content-copy'))).toBe(true);
      // 本題の不変条件: 折り返したコードブロック（pre）は Tab 停止位置に現れない。
      // 停止位置の「数」を固定すると、説明コンテンツにリンクやコードブロックが増えただけで
      // 落ちるうえ、「pre が増えた」のかどうかも分からない。性質そのものを主張する。
      expect(
        stops.filter((stop) => stop.includes('settings-content-code')),
        `実測した停止位置: ${stops.join(' -> ')}`
      ).toEqual([]);
    });

    test('二次ボタンと保存ボタンの枠線の色が共通スタイルに上書きされない', async () => {
      await win.locator('#settings-tab-0').click();
      const save = win.locator('.settings-save');
      await expect(save).toBeVisible();
      const cancel = win.locator('.settings-cancel');
      // 共通ルール（.settings-footer button）が border-color を直接持つと詳細度で勝ち、
      // 保存ボタンの緑がグレー（#30363d）へ戻る。issue #267 の回帰をここで押さえる。
      //
      // このテストが守る不変条件は「色そのもの」ではなく、共通ルールの border-color が
      // バリアント指定（.settings-save の --vktm--color--border-override、無ければ
      // フォールバックの --vktm--color--border-interactive）に詳細度で勝たないこと。
      // 以前は期待値を rgb(...) で直書きしていたが、#343 で --vktm--color--border-interactive
      // を #8b949e → #6e7681 に変更した際、この直書きだけが旧い値のまま残されて
      // この 1 件が落ちた（今回の e2e 失敗の原因の一つ）。同じ更新漏れを防ぐため、
      // 期待値も CSS 変数の実際の値から作る（色コードの直書きをしない）。
      const [saveBorderVar, cancelBorderVar] = await Promise.all([
        save.evaluate((el) => getComputedStyle(el).getPropertyValue('--vktm--color--border-override').trim()),
        cancel.evaluate((el) => getComputedStyle(el).getPropertyValue('--vktm--color--border-interactive').trim()),
      ]);
      // 変数が読めない／色として解釈できない値だと、下の正規化が既定色や直前の色へ
      // 静かに落ちて比較が空振りする。生値の段階で弾いておく。
      expect(saveBorderVar, '.settings-save の --vktm--color--border-override が読めない').toMatch(/^(#|rgb|hsl)/);
      expect(cancelBorderVar, ':root の --vktm--color--border-interactive が読めない').toMatch(/^(#|rgb|hsl)/);
      // 変数の生の値（#2ea043 等）を getComputedStyle が返す rgb(...) 形式に正規化するため、
      // 使い捨てのプローブ要素の color に代入して読み直す。プローブは呼び出しごとに
      // 作り直し、不正な値で style.color の代入が黙って無視されても直前の色を
      // 読んでしまわないようにする。
      const [expectedSaveBorder, expectedCancelBorder] = await win.evaluate(([saveColor, cancelColor]) => {
        const normalize = (value) => {
          const probe = document.createElement('div');
          probe.style.display = 'none';
          document.body.appendChild(probe);
          probe.style.color = value;
          const result = getComputedStyle(probe).color;
          probe.remove();
          return result;
        };
        return [normalize(saveColor), normalize(cancelColor)];
      }, [saveBorderVar, cancelBorderVar]);
      // 2 つの期待値が同値なら、どちらかが既定色へ落ちているか、バリアント指定が
      // 潰れている。ボタンの色分けが消えていないことの担保も兼ねる。
      expect(expectedSaveBorder).not.toBe(expectedCancelBorder);

      await expect(save).toHaveCSS('border-color', expectedSaveBorder);
      await expect(cancel).toHaveCSS('border-color', expectedCancelBorder);
    });
  });

  // ─── 旧 settings-apihost-loopback-notice.smoke.spec.js（issue #313 / PR #315） ─
  test.describe('設定パネルの API ホスト欄の即時案内（issue #313 / PR #315）', () => {
    // utils/loopbackHost.js の isLoopbackHost() は main.js が実際に bind したアドレス
    // （IP リテラル）だけを見る前提で、認証ゲート側（utils/apiAuth.js の
    // shouldRequireAuth）と共有している。'localhost' のような名前をここに混ぜると
    // 認証ゲートの判定そのものが緩んでしまうため入れていない（安藤のセキュリティ
    // レビュー指摘）。代わりに画面の即時案内だけは isLoopbackDisplayValue() で
    // 'localhost' も loopback 扱いにする。
    //
    // 'localhost' は Node の名前解決順によっては 127.0.0.1 / ::1 へ bind され実際には
    // 認証不要になりうるが、'127.0.0.1' と書くより自然に入力されやすい文字列でもある。
    // ここで「認証が必須になります」と誤案内すると、利用者が「もう保護されている」と
    // 誤認したまま tailscale serve 公開時に apiRequireAuthAlways を有効化し忘れる実害に
    // つながる（画面は必須と言うが実際は不要、という危険な方向にだけ倒れるズレ）。
    //
    // issue #348: 元は beforeAll で 1 回だけモーダルを開き 4 テストで使い続ける設計
    // だったが、起動共有の外側 beforeEach で毎回 win.reload() するため、モーダルを
    // 開く処理を beforeEach へ移した（各テストは独立して入力・確認するだけなので、
    // モーダルを都度開き直しても検証内容は変わらない）。
    test.beforeEach(async () => {
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.locator('#settings-tab-0').click();
    });

    test.afterEach(async () => {
      const closeButton = win.locator('.settings-close');
      if ((await closeButton.count()) > 0 && await closeButton.isVisible()) {
        await closeButton.click().catch(() => {});
      }
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    });

    // 対象欄は「API ホスト」を含む行が apiHost 本体と apiRequireAuthAlways の説明文
    // （「API ホストが 127.0.0.1 のままでも…」）の 2 件あるため（issue #291 修正時と
    // 同じ事情）、input[type="text"] まで指定して一意にする。
    function apiHostInput() {
      return win.locator('.settings-row', { hasText: 'API ホスト' }).locator('input[type="text"]');
    }

    async function noticeFor(input) {
      const id = await input.getAttribute('id');
      return win.locator(`#${id}-notice`);
    }

    for (const value of ['localhost', '::1', '127.0.0.2']) {
      test(`"${value}" を入力しても認証必須の案内は出ない`, async () => {
        const input = apiHostInput();
        const notice = await noticeFor(input);
        await input.fill(value);
        await expect(notice).toBeHidden();
      });
    }

    test('回帰確認: ループバックでない値（Tailscale IP 相当）を入力すると案内が出る', async () => {
      const input = apiHostInput();
      const notice = await noticeFor(input);
      await input.fill('100.101.102.103');
      await expect(notice).toBeVisible();
      await expect(notice).toContainText('認証が必須になります');
    });
  });
});
