const { test, expect } = require('@playwright/test');
const path = require('path');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
// 設定ディスクリプタの差し込みと後始末は共通ヘルパーへ集約している（issue #293）。
const {
  installDescriptorRecordingSaves,
  lastSavedPayload,
  restoreInvoke,
} = require('./helpers/settings-descriptor');

// issue #348: 以下 4 spec（settings-duplicate-key / settings-lines-field-string-value /
// settings-pattern-validation / settings-visible-when）を統合したもの。
// 統合の根拠: 全テストが env / config の指定なしで launchAppAndWait を呼び、
// window.VKIpc.invoke の差し替え（または settings-descriptor ヘルパー経由の差し替え）で
// 設定ディスクリプタを注入し、設定モーダルの入力・保存・表示切替を確認するだけの
// 同じ形をしている。起動時の設定値・環境変数を変えて確かめる spec ではないため、
// Electron の起動 1 回を全テストで共有できる。
//
// 各サブグループ（元の spec 単位）は test.describe としてネストし、元のヘルパー関数・
// 定数はそのブロック内のローカルスコープに置く（同名の installMockDescriptor が
// pattern-validation と visible-when の両方にあるが、別スコープなので衝突しない）。
// 外側の beforeEach で win.reload() し、window.VKIpc.invoke の差し替えを毎回リセットする
// （差し替えは JS 実行コンテキストに乗っているため reload で消える。各サブグループの
// 元の beforeEach/afterEach はそのまま内側に残し、reload の後に実行される）。
test.describe.serial('設定パネル: 基本フィールド系（issue #348 で起動共有）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-shared-fields-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  // ─── 旧 settings-duplicate-key.smoke.spec.js（issue #258） ───────────────
  test.describe('設定キー重複時の移動先と保存値（issue #258）', () => {
    // 同じ key の欄を別タブへ置き、説明タブの移動ボタンから先に描画される欄へ着地させる。
    // 保存処理が別の欄を採用すると、着地した欄へ入力した値と保存値が食い違う。
    async function installDuplicateKeyDescriptor(win) {
      await win.evaluate(() => {
        const vkIpc = window.VKIpc;
        const desc = {
          available: true,
          title: '重複キー設定',
          note: '保存後に反映されます。',
          targetPath: '/tmp/settings.json',
          appVersion: '0.0.0-test',
          tabs: [
            { id: 'general', label: '基本' },
            { id: 'tokens', label: 'トークン' },
            {
              id: 'guide',
              label: '案内',
              content: [
                {
                  type: 'tabLink',
                  label: '接続先を設定',
                  tab: 'general',
                  field: 'duplicate',
                },
              ],
            },
          ],
          // 宣言順と描画順を逆にし、実際の描画順（タブ順）で先に現れる基本タブの欄を
          // 移動先・保存対象として一貫して採用できることを確かめる。
          groups: [
            {
              label: 'トークン設定',
              tab: 'tokens',
              fields: [
                { key: 'duplicate', label: '後から描画される接続先', type: 'text' },
              ],
            },
            {
              label: '基本設定',
              tab: 'general',
              fields: [
                { key: 'duplicate', label: '移動先の接続先', type: 'text' },
              ],
            },
          ],
          values: { duplicate: '' },
        };

        window.__savedPayloads = [];
        vkIpc.invoke = (channel, payload) => {
          if (channel === 'settings:describe') return Promise.resolve(desc);
          if (channel === 'settings:save') {
            window.__savedPayloads.push(payload);
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve(null);
        };
      });
    }

    test.afterEach(async () => {
      const closeButton = win.locator('.settings-close');
      if (await closeButton.isVisible()) await closeButton.click();
    });

    test('移動ボタンで着地した欄の入力値がそのまま保存される', async () => {
      await installDuplicateKeyDescriptor(win);
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });

      // 案内タブから、重複キーのうち描画順で先に現れる基本タブの欄へ移動する。
      await win.getByRole('tab', { name: '案内' }).click();
      await win.getByRole('button', { name: '接続先を設定' }).click();
      const target = win.getByLabel('移動先の接続先', { exact: true });
      await expect(target).toBeFocused();

      // 移動先へ入力して保存し、保存処理も同じ欄を採用したことを IPC の payload で観測する。
      await target.fill('guided.example');
      await win.locator('.settings-save').click();
      await expect(win.locator('.settings-msg')).toHaveText(
        '保存しました。次回の起動から反映されます。'
      );
      const payload = await win.evaluate(
        () => window.__savedPayloads[window.__savedPayloads.length - 1]
      );
      expect(payload.duplicate).toBe('guided.example');
    });

    test('重複した欄は描画されず、そのタブは保存対象なしになる', async () => {
      await installDuplicateKeyDescriptor(win);
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });

      // 後から描画される重複欄だけのグループは消え、このタブは説明だけのタブと同様に
      // 保存対象無しになる。legend だけの空 fieldset と保存ボタンを残さず、代わりに
      // パネルが空であることを伝える。
      await win.getByRole('tab', { name: 'トークン' }).click();
      await expect(win.getByLabel('後から描画される接続先', { exact: true })).toHaveCount(0);
      await expect(win.locator('#settings-panel-1 .settings-empty'))
        .toHaveText('このタブに表示できる設定項目はありません。');
      await expect(win.locator('.settings-save')).toBeHidden();
    });
  });

  // ─── 旧 settings-lines-field-string-value.smoke.spec.js（issue #339） ─────
  test.describe('設定パネルの lines フィールドに文字列値を注入した表示・保存（issue #339）', () => {
    // 3 つの lines フィールドを 1 つのディスクリプタに同居させ、1 つの spec で回帰を
    // まとめて捕まえる。
    //   - stringPaths: 文字列で保存された値（今回の修正対象）
    //   - arrayPaths:  配列で保存された値（従来どおりの表示・保存を確認する回帰用）
    //   - xssPaths:    文字列に </textarea> を含む値（escText によるエスケープの回帰確認）
    function descriptorWithLinesFields(targetPath) {
      return {
        available: true,
        title: 'lines フィールド文字列値の検証',
        note: '保存後に反映されます。',
        targetPath,
        appVersion: '0.0.0-test',
        groups: [{
          label: '検索パス',
          fields: [
            { key: 'stringPaths', label: '文字列で保存された検索パス', type: 'lines' },
            { key: 'arrayPaths', label: '配列で保存された検索パス', type: 'lines' },
            { key: 'xssPaths', label: 'エスケープ確認用パス', type: 'lines' },
          ],
        }],
        values: {
          // 設定ファイルに workspace.search_paths を文字列で直接書いたケースの再現。
          stringPaths: '/a\n/b',
          arrayPaths: ['/x', '/y'],
          // textarea を早期に閉じて後続の <script> をノードとして生やそうとする値。
          xssPaths: '</textarea><script>1</script>',
        },
      };
    }

    const STRING_PATHS_ID = '#set-field-0';
    const ARRAY_PATHS_ID = '#set-field-1';
    const XSS_PATHS_ID = '#set-field-2';

    async function openSettings(win) {
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
    }

    test.beforeEach(async () => {
      const targetPath = path.join(tmpRoot, 'settings.json');
      await installDescriptorRecordingSaves(win, descriptorWithLinesFields(targetPath));
      await openSettings(win);
    });

    test.afterEach(async () => {
      const closeButton = win.locator('.settings-close');
      if ((await closeButton.count()) > 0 && await closeButton.isVisible()) {
        await closeButton.click().catch(() => {});
      }
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
      await restoreInvoke(win).catch(() => {});
    });

    test('文字列で保存された値は空欄にならず、そのまま textarea に表示される', async () => {
      // 修正前は Array.isArray(value) だけを見ていたため、文字列は空文字になっていた。
      await expect(win.locator(STRING_PATHS_ID)).toHaveValue('/a\n/b');
    });

    test('文字列の値をそのまま保存しても、textarea に表示された内容がそのまま送信され値が消えない', async () => {
      // renderer は textarea.value（生の文字列）をそのまま settings:save の payload に載せ、
      // 改行区切りの配列への変換は main プロセス側（settingsTargets.js の coerceFieldValue。
      // 単体テストは tests/settingsTargets.test.js）が担う。この spec が実 IPC へ届く手前で
      // 記録している payload は、その変換前の生の文字列そのまま。
      // 修正前は textarea が空欄のまま描画されていたため、ここで手を触れずに保存すると
      // payload.stringPaths が '' になり、値が消えていた。修正後は表示どおりの内容が届く。
      await win.locator('.settings-save').click();
      await expect(win.locator('.settings-msg')).toHaveClass(/ok/);

      const payload = await lastSavedPayload(win);
      expect(payload.stringPaths).toBe('/a\n/b');
    });

    test('配列で保存された値の表示・保存は変わらない（回帰確認）', async () => {
      await expect(win.locator(ARRAY_PATHS_ID)).toHaveValue('/x\n/y');

      await win.locator('.settings-save').click();
      await expect(win.locator('.settings-msg')).toHaveClass(/ok/);
      const payload = await lastSavedPayload(win);
      expect(payload.arrayPaths).toBe('/x\n/y');
    });

    test('値に </textarea> を含んでいてもエスケープされ、textarea を閉じずそのまま表示される', async () => {
      // escText でエスケープされていれば textarea.value は元の文字列どおりに読める
      // （ブラウザが HTML エンティティを復元する）。エスケープが外れて途中で
      // textarea を閉じてしまうと、後続の文字列が DOM 構造として解釈され、
      // 値が途中で切れる（toHaveValue が落ちる）か <script> 要素が生成される。
      await expect(win.locator(XSS_PATHS_ID)).toHaveValue('</textarea><script>1</script>');

      // 「スクリプトが実行されないこと」は assert しない。このアプリでは以下の 2 点により、
      // エスケープを外して <script>/onerror などを混ぜても実行経路そのものが存在せず、
      // 実行有無の assert は原理的に必ず green になり検証にならないため（安藤レビュー指摘）。
      //   1. 設定モーダルは renderer/app.js の overlay.innerHTML = … で組まれる。HTML 仕様上、
      //      innerHTML 経由で挿入された <script> は要素としては生成されるが実行されない。
      //   2. 仮に実行経路があっても CSP script-src 'self'（'unsafe-inline' なし。tests/csp.test.js
      //      が固定）がインラインスクリプトの実行を塞ぐ。
      // そのため、エスケープが外れたときに実際に変化する「DOM 構造」の方を見る。
      // escText が効いていれば <script> はテキストとしてエスケープされ要素化しないので 0 件、
      // 外れれば innerHTML パース時にノードとして生成されるため件数が増えて red になる。
      const injectedScripts = await win.evaluate(
        () => document.querySelectorAll('.settings-form script').length
      );
      expect(injectedScripts).toBe(0);
    });
  });

  // ─── 旧 settings-pattern-validation.smoke.spec.js（issue #140） ──────────
  test.describe('設定ダイアログの pattern 形式チェック（issue #140）', () => {
    // renderer の window.VKIpc.invoke を差し替え、pattern 付き descriptor を返させる。
    async function installMockDescriptor(win) {
      await win.evaluate(() => {
        const vkIpc = window.VKIpc;
        // <owner>/<repo> 形式（親 vk-orchestrator が付与する pattern の代表例）。
        const REPO_PATTERN = '^[^/\\s]+/[^/\\s]+$';
        const desc = {
          available: true,
          title: 'テスト設定',
          note: '',
          targetPath: '/tmp/mock-settings.json',
          appVersion: '0.0.0-test',
          groups: [{
            label: 'テストグループ',
            fields: [
              {
                key: 'repo',
                label: 'レビュー用アセットリポジトリ',
                type: 'text',
                help: 'owner/repo 形式で入力してください',
                placeholder: 'vektor-inc/task-queue',
                pattern: REPO_PATTERN,
                invalidMessage: 'owner/repo の形式で入力してください（例: vektor-inc/task-queue）',
              },
              {
                // pattern を持たない従来フィールド（後方互換の確認用）。
                key: 'legacy',
                label: '従来フィールド',
                type: 'text',
                help: '検証なし',
              },
            ],
          }],
          values: { repo: '', legacy: '' },
        };
        window.__savedPayloads = [];
        vkIpc.invoke = (channel, payload) => {
          if (channel === 'settings:describe') return Promise.resolve(desc);
          if (channel === 'settings:save') {
            window.__savedPayloads.push(payload);
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve(null);
        };
      });
    }

    // フィールド id は描画順採番（repo=0, legacy=1）。
    const REPO_ID = '#set-field-0';
    const REPO_ERR = '#set-field-0-error';
    const LEGACY_ID = '#set-field-1';
    const INVALID_MSG = 'owner/repo の形式で入力してください（例: vektor-inc/task-queue）';

    // 各テストの前にモックを入れ直し、設定モーダルを開き直す（DOM を毎回まっさらに）。
    test.beforeEach(async () => {
      await installMockDescriptor(win);
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.waitForSelector(REPO_ID, { state: 'visible' });
    });

    // 各テストの後に Escape でモーダルを閉じる（次テストで再オープンできるように）。
    test.afterEach(async () => {
      if (await win.locator('.settings-modal').count()) await win.keyboard.press('Escape');
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    });

    test('1 & 6: 不正形式を blur すると赤枠＋エラー文＋aria が付く', async () => {
      // 初期状態: 空エラー行は display:none（余白を作らない）。
      await expect(win.locator(REPO_ERR)).toBeHidden();

      // 不正形式を入力して blur。
      await win.locator(REPO_ID).fill('foobar');
      await win.locator(REPO_ID).blur();

      // aria-invalid="true"（赤枠の CSS トリガ）が付く。
      await expect(win.locator(REPO_ID)).toHaveAttribute('aria-invalid', 'true');
      // 直下にエラー行が role="alert" で invalidMessage を表示。
      const err = win.locator(REPO_ERR);
      await expect(err).toBeVisible();
      await expect(err).toHaveText(INVALID_MSG);
      await expect(err).toHaveAttribute('role', 'alert');
      // aria-describedby が help と error の両方を関連付けている。
      await expect(win.locator(REPO_ID)).toHaveAttribute(
        'aria-describedby', 'set-field-0-help set-field-0-error'
      );
      // 赤枠が実際に適用されているか（computed border-color を確認）。
      const borderColor = await win.locator(REPO_ID).evaluate(
        (el) => getComputedStyle(el).borderTopColor
      );
      // #f85149 = rgb(248, 81, 73)
      expect(borderColor).toBe('rgb(248, 81, 73)');
    });

    test('2: 不正なまま保存すると保存されず、総括メッセージ＋最初の不正欄へフォーカス', async () => {
      await win.locator(REPO_ID).fill('foobar');
      await win.locator('.settings-save').click();

      // settings:save は呼ばれない（保存中断）。
      const saved = await win.evaluate(() => window.__savedPayloads.length);
      expect(saved).toBe(0);
      // フッターに総括メッセージ。
      await expect(win.locator('.settings-msg')).toHaveText('入力内容に問題があります');
      await expect(win.locator('.settings-msg')).toHaveClass(/err/);
      // 最初の不正欄にフォーカスが移動。
      const focusedId = await win.evaluate(() => document.activeElement && document.activeElement.id);
      expect(focusedId).toBe('set-field-0');
      // 保存押下で検証されたため赤枠＋エラー文も出ている。
      await expect(win.locator(REPO_ID)).toHaveAttribute('aria-invalid', 'true');
      await expect(win.locator(REPO_ERR)).toHaveText(INVALID_MSG);
    });

    test('3: 正しい形式に直すと入力中に即解除され、保存が通る', async () => {
      // まず不正にして blur でエラーを付ける。
      await win.locator(REPO_ID).fill('foobar');
      await win.locator(REPO_ID).blur();
      await expect(win.locator(REPO_ID)).toHaveAttribute('aria-invalid', 'true');

      // 正しい形式に打ち直す（fill は input イベントを発火 → 即再検証で解除）。
      await win.locator(REPO_ID).fill('vektor-inc/vk-terminals');
      // 赤枠（aria-invalid）が外れ、エラー文が消える。
      await expect(win.locator(REPO_ID)).not.toHaveAttribute('aria-invalid', 'true');
      await expect(win.locator(REPO_ERR)).toBeHidden();

      // 保存が通る。
      await win.locator('.settings-save').click();
      await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');
      const payload = await win.evaluate(() => window.__savedPayloads[window.__savedPayloads.length - 1]);
      expect(payload.repo).toBe('vektor-inc/vk-terminals');
    });

    test('4: 空欄は警告されず保存できる（空欄許容）', async () => {
      // repo を空欄のまま blur しても警告されない。
      await win.locator(REPO_ID).fill('');
      await win.locator(REPO_ID).blur();
      await expect(win.locator(REPO_ID)).not.toHaveAttribute('aria-invalid', 'true');
      await expect(win.locator(REPO_ERR)).toBeHidden();

      // 保存が通る。
      await win.locator('.settings-save').click();
      await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');
      const payload = await win.evaluate(() => window.__savedPayloads[window.__savedPayloads.length - 1]);
      expect(payload.repo).toBe('');
    });

    test('5: pattern を持たない従来フィールドは無検証（後方互換）', async () => {
      // 従来フィールドに、repo pattern には合わない任意の値を入れて blur。
      await win.locator(LEGACY_ID).fill('foobar-not-a-repo');
      await win.locator(LEGACY_ID).blur();
      // 検証対象外なので aria-invalid は付かない。
      await expect(win.locator(LEGACY_ID)).not.toHaveAttribute('aria-invalid', 'true');
      await expect(win.locator('#set-field-1-error')).toBeHidden();

      // repo は空欄のまま（valid）なので保存が通り、legacy 値もそのまま保存される。
      await win.locator('.settings-save').click();
      await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');
      const payload = await win.evaluate(() => window.__savedPayloads[window.__savedPayloads.length - 1]);
      expect(payload.legacy).toBe('foobar-not-a-repo');
    });

    test('7: フッターの総括エラーは不正が残る間は消えず、直しきると消える', async () => {
      // 不正なまま保存して総括エラーを出す。
      await win.locator(REPO_ID).fill('foobar');
      await win.locator('.settings-save').click();
      await expect(win.locator('.settings-msg')).toHaveText('入力内容に問題があります');

      // まだ不正なうちは消さない。打鍵のたびに消すと、直している最中に何を指摘されたのか
      // 見失う（"owner/repo の形式" の 2 つ目が空なので、これもまだ不正）。
      await win.locator(REPO_ID).fill('foobar/');
      await expect(win.locator('.settings-msg')).toHaveText('入力内容に問題があります');
      await expect(win.locator('.settings-msg')).toHaveClass(/err/);

      // 直しきったら消す。問題が 1 つも無いのに赤字が残ると、存在しない不正欄を探させる。
      await win.locator(REPO_ID).fill('vektor-inc/vk-terminals');
      await expect(win.locator('.settings-msg')).toHaveText('');
      await expect(win.locator('.settings-msg')).not.toHaveClass(/err/);
      // 欄側の表示（赤枠・エラー文）も揃って消えている。
      await expect(win.locator(REPO_ID)).not.toHaveAttribute('aria-invalid', 'true');
      await expect(win.locator(REPO_ERR)).toBeHidden();
    });
  });

  // ─── 旧 settings-visible-when.smoke.spec.js（issue #213） ────────────────
  test.describe('設定ダイアログの visibleWhen 表示切替（issue #213）', () => {
    // renderer の window.VKIpc.invoke（renderer 側の中継レイヤ／issue #268）を差し替え、
    // visibleWhen 付き descriptor を返させる。制御フィールド confirmClose（select）を
    // never にすると、依存フィールド initialCommand（text, visibleWhen hide:true）が
    // 隠れる、という PR の代表例を再現する。あわせて pattern 付きの依存フィールド
    // depPattern も置き、非表示時に検証がスキップされる（保存を妨げない）ことも確認する。
    async function installMockDescriptor(win) {
      await win.evaluate(() => {
        const vkIpc = window.VKIpc;
        const desc = {
          available: true,
          title: 'テスト設定',
          note: '',
          targetPath: '/tmp/mock-settings.json',
          appVersion: '0.0.0-test',
          groups: [{
            label: '基本',
            fields: [
              // 制御フィールド（select）。この値に応じて依存行の表示が切り替わる。
              {
                key: 'confirmClose',
                label: 'ペインを閉じる時の確認ダイアログ',
                type: 'select',
                options: [
                  { value: 'busy', label: '実行中・入力待ちの場合は表示（既定）' },
                  { value: 'always', label: '常に表示' },
                  { value: 'never', label: '確認なし' },
                ],
              },
              // 依存フィールド1（text）。confirmClose が never のとき隠れる。
              {
                key: 'initialCommand',
                label: '初期コマンド',
                type: 'text',
                visibleWhen: { key: 'confirmClose', value: 'never', hide: true },
              },
              // 依存フィールド2（pattern 付き text）。confirmClose が never のとき隠れる。
              // 非表示時は pattern 検証がスキップされることの確認用。
              {
                key: 'depPattern',
                label: 'owner/repo 形式',
                type: 'text',
                pattern: '^[^/\\s]+/[^/\\s]+$',
                invalidMessage: 'owner/repo の形式で入力してください',
                visibleWhen: { key: 'confirmClose', value: 'never', hide: true },
              },
            ],
          }],
          values: { confirmClose: 'busy', initialCommand: '', depPattern: '' },
        };
        window.__savedPayloads = [];
        vkIpc.invoke = (channel, payload) => {
          if (channel === 'settings:describe') return Promise.resolve(desc);
          if (channel === 'settings:save') {
            window.__savedPayloads.push(payload);
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve(null);
        };
      });
    }

    // フィールド id は描画順採番（confirmClose=0, initialCommand=1, depPattern=2）。
    const CONFIRM_ID = '#set-field-0';
    const INITIAL_ID = '#set-field-1';
    const DEP_PATTERN_ID = '#set-field-2';

    // 指定入力の属する .settings-row 要素を取得する。
    function rowOf(win, inputSelector) {
      return win.locator(inputSelector).locator('xpath=ancestor::*[contains(@class,"settings-row")][1]');
    }

    // 各テストの前にモックを入れ直し、設定モーダルを開き直す（DOM を毎回まっさらに）。
    test.beforeEach(async () => {
      await installMockDescriptor(win);
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.waitForSelector(CONFIRM_ID, { state: 'visible' });
    });

    // 各テストの後にキャンセルボタンで確実に閉じる（次テストで再オープンできるように）。
    // ※ Escape は <select> にフォーカスがあると select 側に飲み込まれて閉じないことが
    //    あるため、ボタンクリックで閉じる。
    test.afterEach(async () => {
      await win.locator('.settings-cancel').click().catch(() => {});
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    });

    test('1: 初期状態（busy）では依存行が表示されている', async () => {
      // 初期値 busy では visibleWhen(hide:true) の条件に一致しないので表示。
      await expect(win.locator(INITIAL_ID)).toBeVisible();
      await expect(rowOf(win, INITIAL_ID)).toBeVisible();
    });

    test('2: never に切り替えると依存行がその場で消える（display も none）', async () => {
      const initialRow = rowOf(win, INITIAL_ID);
      // never に切替 → その場で非表示（再読み込み不要）。
      await win.locator(CONFIRM_ID).selectOption('never');

      // Playwright 的に hidden（＝レイアウトから除外されている）。
      await expect(initialRow).toBeHidden();
      await expect(win.locator(INITIAL_ID)).toBeHidden();

      // hidden 属性が付いている。
      await expect(initialRow).toHaveAttribute('hidden', /.*/);

      // computed display が none（style.css の .settings-row[hidden]{display:none} が効いている）。
      const display = await initialRow.evaluate((el) => getComputedStyle(el).display);
      expect(display).toBe('none');
    });

    test('3: never→busy に戻すと依存行が再表示され、入力値が保持される', async () => {
      // まず値を入れてから非表示にする。
      await win.locator(INITIAL_ID).fill('claude --resume');
      await win.locator(CONFIRM_ID).selectOption('never');
      await expect(rowOf(win, INITIAL_ID)).toBeHidden();

      // busy に戻すと再表示。
      await win.locator(CONFIRM_ID).selectOption('busy');
      await expect(rowOf(win, INITIAL_ID)).toBeVisible();

      // 入力値が保持されている。
      await expect(win.locator(INITIAL_ID)).toHaveValue('claude --resume');
    });

    test('4: 非表示中の pattern 不正値は保存を妨げない（検証スキップ）', async () => {
      // depPattern に pattern 不正な値を入れる（表示中なので後で赤枠が付く状態）。
      await win.locator(DEP_PATTERN_ID).fill('invalid value with spaces');

      // never に切替 → depPattern 行が非表示になる。
      await win.locator(CONFIRM_ID).selectOption('never');
      await expect(rowOf(win, DEP_PATTERN_ID)).toBeHidden();

      // この状態で保存 → 非表示項目は検証対象外なので保存が通る。
      await win.locator('.settings-save').click();
      await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');

      const saved = await win.evaluate(() => window.__savedPayloads.length);
      expect(saved).toBe(1);
      // 非表示でも値自体は保持され、保存 payload に含まれる。
      const payload = await win.evaluate(() => window.__savedPayloads[0]);
      expect(payload.depPattern).toBe('invalid value with spaces');
      expect(payload.confirmClose).toBe('never');
    });

    test('5: 表示中の pattern 不正値は従来どおり保存を止める（回帰確認）', async () => {
      // busy のまま（depPattern 表示中）で不正値を入れて保存 → 止まる。
      await win.locator(DEP_PATTERN_ID).fill('invalid value with spaces');
      await win.locator('.settings-save').click();

      // 保存されない。
      const saved = await win.evaluate(() => window.__savedPayloads.length);
      expect(saved).toBe(0);
      await expect(win.locator('.settings-msg')).toHaveText('入力内容に問題があります');
      await expect(win.locator(DEP_PATTERN_ID)).toHaveAttribute('aria-invalid', 'true');
    });
  });
});
