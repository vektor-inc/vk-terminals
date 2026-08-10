const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
// 設定ディスクリプタの差し込みと後始末は共通ヘルパーへ集約している（issue #293）。
const {
  installDescriptor,
  installDescriptorRecordingSaves,
  lastSavedPayload,
  restoreInvoke,
} = require('./helpers/settings-descriptor');

// issue #348: 以下 4 spec（settings-tabs / settings-multitarget-display /
// settings-empty-tab-guidance / settings-render-error-recovery）を統合したもの。
// 統合の根拠: 全テストが env / config の指定なしで launchAppAndWait を呼び、
// window.VKIpc.invoke の差し替え（または settings-descriptor ヘルパー経由の差し替え）で
// タブ構造を持つ設定ディスクリプタを注入し、タブの描画・切替・保存先表示を確認する
// 同じ形をしている。起動時の設定値・環境変数を変えて確かめる spec ではないため、
// Electron の起動 1 回を全テストで共有できる。
//
// 各サブグループ（元の spec 単位）は test.describe としてネストし、元のヘルパー関数・
// 定数はそのブロック内のローカルスコープに置く。外側の beforeEach で win.reload() し、
// window.VKIpc.invoke の差し替えを毎回リセットする（差し替えは JS 実行コンテキストに
// 乗っているため reload で消える。各サブグループの元の beforeEach/afterEach はそのまま
// 内側に残し、reload の後に実行される）。
test.describe.serial('設定パネル: タブ・保存先表示系（issue #348 で起動共有）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-shared-tabs-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  test.beforeEach(async () => {
    await win.reload();
    await win.waitForSelector('#sidebar', { state: 'attached' });
  });

  // ─── 旧 settings-tabs.smoke.spec.js（issue #167） ────────────────────────
  test.describe('設定モーダルのタブ UI（issue #167）', () => {
    // renderer の window.VKIpc.invoke（renderer 側の中継レイヤ／issue #268）を差し替え、
    // tabs 付き descriptor を返させる。main.js の settings:describe が tabs を含めて
    // 返す形（PR の変更）を模したもの。groups には tab キーで所属タブを指定し、
    // group ごとに targetPaths（保存先）を持たせる。
    async function installTabbedDescriptor(win) {
      await win.evaluate(() => {
        const vkIpc = window.VKIpc;
        const desc = {
          available: true,
          title: 'タブ設定',
          note: 'すべてのタブの内容は保存時にまとめて反映されます。',
          targetPath: '',
          appVersion: '0.0.0-test',
          hasMultipleTargets: true,
          // タブ定義（PR の新機能）。
          tabs: [
            { id: 'general', label: '基本' },
            { id: 'tokens', label: 'トークン' },
          ],
          targetPaths: ['/tmp/general.json', '/tmp/tokens.json'],
          groups: [
            {
              label: 'API 設定',
              tab: 'general',
              targetPaths: ['/tmp/general.json'],
              fields: [{ key: 'host', label: 'API ホスト', type: 'text' }],
            },
            {
              label: 'トークン設定',
              tab: 'tokens',
              targetPaths: ['/tmp/tokens.json'],
              fields: [
                {
                  key: 'limit',
                  label: 'トークン上限',
                  type: 'text',
                  // 数字のみ許容する pattern（非アクティブタブの不正値→保存時自動切替の検証用）。
                  pattern: '^[0-9]+$',
                  invalidMessage: '数字のみで入力してください',
                },
              ],
            },
          ],
          values: { host: '', limit: '' },
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

    // group が tab 順にグルーピングされるため、フィールド id は general(host)=0 → tokens(limit)=1。
    const HOST_ID = '#set-field-0';
    const LIMIT_ID = '#set-field-1';
    const TAB0 = '#settings-tab-0'; // 基本
    const TAB1 = '#settings-tab-1'; // トークン

    // 各テストの前にモックを入れ直し、モーダルを開き直す（DOM を毎回まっさらに）。
    test.beforeEach(async () => {
      await installTabbedDescriptor(win);
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.waitForSelector('.settings-tabs', { state: 'visible' });
    });

    // 各テストの後に閉じるボタンでモーダルを閉じる（次テストで再オープンできるように）。
    test.afterEach(async () => {
      const closeBtn = win.locator('.settings-close');
      if (await closeBtn.count()) {
        await closeBtn.click().catch(() => {});
      }
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    });

    test('ARIA 構造: tablist/tab/tabpanel と roving tabindex が正しい', async () => {
      // tablist ロール。
      await expect(win.locator('.settings-tabs')).toHaveAttribute('role', 'tablist');
      // タブは 2 つ、role=tab。
      const tabs = win.locator('.settings-tab');
      await expect(tabs).toHaveCount(2);
      // 先頭タブが選択済み（aria-selected=true / tabindex=0）、2 番目は未選択（-1）。
      await expect(win.locator(TAB0)).toHaveAttribute('aria-selected', 'true');
      await expect(win.locator(TAB0)).toHaveAttribute('tabindex', '0');
      await expect(win.locator(TAB1)).toHaveAttribute('aria-selected', 'false');
      await expect(win.locator(TAB1)).toHaveAttribute('tabindex', '-1');
      // aria-controls が対応する tabpanel を指す。
      await expect(win.locator(TAB0)).toHaveAttribute('aria-controls', 'settings-panel-0');
      // tabpanel は role=tabpanel / aria-labelledby でタブと関連付く。
      await expect(win.locator('#settings-panel-0')).toHaveAttribute('role', 'tabpanel');
      await expect(win.locator('#settings-panel-0')).toHaveAttribute('aria-labelledby', 'settings-tab-0');
      await expect(win.locator('#settings-panel-0')).toHaveAttribute('tabindex', '0');
      // 先頭パネルのみ可視、2 番目は hidden。
      await expect(win.locator('#settings-panel-0')).toBeVisible();
      await expect(win.locator('#settings-panel-1')).toBeHidden();
    });

    test('各タブ先頭に保存先が表示される', async () => {
      // 基本タブのパネル先頭に general.json の保存先。
      await expect(win.locator('#settings-panel-0 .settings-tab-target')).toContainText('/tmp/general.json');
      // トークンタブに切り替えると tokens.json の保存先。
      await win.locator(TAB1).click();
      await expect(win.locator('#settings-panel-1 .settings-tab-target')).toContainText('/tmp/tokens.json');
      // タブ UI 時はヘッダー下の従来型保存先案内（.settings-target）は出ない。
      await expect(win.locator('.settings-target')).toHaveCount(0);
    });

    test('タブ切替で他タブの入力値が保持される', async () => {
      // 基本タブで host を入力。
      await win.locator(HOST_ID).fill('example.com');
      // トークンタブへ切替 → limit を入力。
      await win.locator(TAB1).click();
      await expect(win.locator('#settings-panel-1')).toBeVisible();
      await win.locator(LIMIT_ID).fill('100');
      // 基本タブへ戻ると host の入力が保持されている。
      await win.locator(TAB0).click();
      await expect(win.locator(HOST_ID)).toHaveValue('example.com');
      // 再度トークンタブへ戻っても limit が保持されている。
      await win.locator(TAB1).click();
      await expect(win.locator(LIMIT_ID)).toHaveValue('100');
    });

    test('キーボード操作: ←/→/Home/End でタブ移動できる', async () => {
      // 先頭タブへフォーカスを当ててから矢印操作。
      await win.locator(TAB0).focus();
      // → で次のタブへ（自動選択）。
      await win.keyboard.press('ArrowRight');
      await expect(win.locator(TAB1)).toHaveAttribute('aria-selected', 'true');
      await expect(win.locator(TAB1)).toHaveAttribute('tabindex', '0');
      await expect(win.locator(TAB0)).toHaveAttribute('tabindex', '-1');
      await expect(win.locator('#settings-panel-1')).toBeVisible();
      // ← で前のタブへ戻る。
      await win.keyboard.press('ArrowLeft');
      await expect(win.locator(TAB0)).toHaveAttribute('aria-selected', 'true');
      await expect(win.locator('#settings-panel-0')).toBeVisible();
      // End で最後のタブへ。
      await win.keyboard.press('End');
      await expect(win.locator(TAB1)).toHaveAttribute('aria-selected', 'true');
      // Home で先頭のタブへ。
      await win.keyboard.press('Home');
      await expect(win.locator(TAB0)).toHaveAttribute('aria-selected', 'true');
      // フォーカスが移動先タブに乗っている（roving）。
      const focusedId = await win.evaluate(() => document.activeElement && document.activeElement.id);
      expect(focusedId).toBe('settings-tab-0');
    });

    test('編集したタブに未保存インジケータと SR 向け aria-label が付く', async () => {
      // 初期はどのタブも dirty ではない。
      await expect(win.locator(TAB0)).not.toHaveClass(/is-dirty/);
      // 基本タブの host を編集する。
      await win.locator(HOST_ID).fill('changed.example');
      // 基本タブに is-dirty が付き、未保存ドットが可視になる。
      await expect(win.locator(TAB0)).toHaveClass(/is-dirty/);
      const dotOpacity = await win.locator(`${TAB0} .settings-tab-dirty`).evaluate(
        (el) => getComputedStyle(el).opacity
      );
      expect(dotOpacity).toBe('1');
      // スクリーンリーダー向けに「未保存の変更あり」を含む aria-label が付く。
      await expect(win.locator(TAB0)).toHaveAttribute('aria-label', /未保存の変更あり/);
      // 編集していないトークンタブには付かない。
      await expect(win.locator(TAB1)).not.toHaveClass(/is-dirty/);
    });

    test('非アクティブタブの pattern 不正値は保存時に該当タブへ自動切替＋フォーカス', async () => {
      // トークンタブへ切替 → limit に不正値（数字以外）を入力。
      await win.locator(TAB1).click();
      await win.locator(LIMIT_ID).fill('abc');
      // 基本タブへ戻し、トークンタブを非アクティブ（hidden）にする。
      await win.locator(TAB0).click();
      await expect(win.locator('#settings-panel-1')).toBeHidden();

      // 保存を押す。
      await win.locator('.settings-save').click();

      // 保存は中断される（settings:save は呼ばれない）。
      const saved = await win.evaluate(() => window.__savedPayloads.length);
      expect(saved).toBe(0);
      // 不正値のあるトークンタブへ自動で切り替わり、パネルが可視になる。
      await expect(win.locator(TAB1)).toHaveAttribute('aria-selected', 'true');
      await expect(win.locator('#settings-panel-1')).toBeVisible();
      // 最初の不正欄（limit）へフォーカスが移動する。
      const focusedId = await win.evaluate(() => document.activeElement && document.activeElement.id);
      expect(focusedId).toBe('set-field-1');
      // 総括メッセージも表示される。
      await expect(win.locator('.settings-msg')).toHaveText('入力内容に問題があります');
    });

    test('全タブ正常値で保存すると成功し、未保存インジケータが解除される', async () => {
      // 基本タブ host を編集（dirty 化）。
      await win.locator(HOST_ID).fill('ok.example');
      await expect(win.locator(TAB0)).toHaveClass(/is-dirty/);
      // トークンタブへ切替 → 正常な数字を入力（dirty 化）。
      await win.locator(TAB1).click();
      await win.locator(LIMIT_ID).fill('200');
      await expect(win.locator(TAB1)).toHaveClass(/is-dirty/);

      // 保存する。
      await win.locator('.settings-save').click();
      await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');
      // 両タブの値がまとめて保存される。
      const payload = await win.evaluate(() => window.__savedPayloads[window.__savedPayloads.length - 1]);
      expect(payload.host).toBe('ok.example');
      expect(payload.limit).toBe('200');
      // 保存成功で未保存インジケータが両タブとも解除される。
      await expect(win.locator(TAB0)).not.toHaveClass(/is-dirty/);
      await expect(win.locator(TAB1)).not.toHaveClass(/is-dirty/);
    });
  });

  // ─── 旧 settings-multitarget-display.smoke.spec.js（PR #160） ────────────
  test.describe('設定モーダルのマルチターゲット表示（PR #160）', () => {
    // renderer の window.VKIpc.invoke（renderer 側の中継レイヤ／issue #268）を差し替え、
    // settings:describe の応答を注入する。main.js の settings:describe が返す形
    // （group ごとに targetPaths を持ち、hasMultipleTargets / targetPath / targetPaths
    // を含む）を模したもの。
    async function installMultiTargetDescriptor(win) {
      await win.evaluate(() => {
        const vkIpc = window.VKIpc;
        const desc = {
          available: true,
          title: 'マルチターゲット設定',
          note: '',
          // マルチターゲット時はトップレベル targetPath は空（各 group が別ファイル）。
          targetPath: '',
          appVersion: '0.0.0-test',
          hasMultipleTargets: true,
          targetPaths: ['/tmp/group-a.json', '/tmp/group-b.json'],
          groups: [
            {
              label: 'グループA',
              targetPaths: ['/tmp/group-a.json'],
              fields: [{ key: 'aValue', label: 'A の値', type: 'text' }],
            },
            {
              label: 'グループB',
              targetPaths: ['/tmp/group-b.json'],
              fields: [{ key: 'bValue', label: 'B の値', type: 'text' }],
            },
          ],
          values: { aValue: '', bValue: '' },
        };
        vkIpc.invoke = (channel) => {
          if (channel === 'settings:describe') return Promise.resolve(desc);
          if (channel === 'settings:save') return Promise.resolve({ ok: true });
          return Promise.resolve(null);
        };
      });
    }

    // 単一ターゲット（従来 descriptor）の describe 応答を注入する。
    async function installSingleTargetDescriptor(win) {
      await win.evaluate(() => {
        const vkIpc = window.VKIpc;
        const desc = {
          available: true,
          title: '単一ターゲット設定',
          note: '',
          targetPath: '/tmp/single-config.json',
          appVersion: '0.0.0-test',
          hasMultipleTargets: false,
          targetPaths: ['/tmp/single-config.json'],
          groups: [
            {
              label: 'グループA',
              // 単一ターゲット時も describe は group ごとの targetPaths を返しうるが、
              // hasMultipleTargets が false なので renderer は group 別表示を出さない。
              targetPaths: ['/tmp/single-config.json'],
              fields: [{ key: 'aValue', label: 'A の値', type: 'text' }],
            },
          ],
          values: { aValue: '' },
        };
        vkIpc.invoke = (channel) => {
          if (channel === 'settings:describe') return Promise.resolve(desc);
          if (channel === 'settings:save') return Promise.resolve({ ok: true });
          return Promise.resolve(null);
        };
      });
    }

    // 各テストの後に閉じるボタンでモーダルを閉じる（二重オープン抑止のロックを確実に解放し、
    // 次テストで再オープンできるようにする。Escape でも閉じるが、閉じ処理を確定させるため
    // 閉じるボタンを明示クリックし、DOM から detach されるまで待つ）。
    test.afterEach(async () => {
      const closeBtn = win.locator('.settings-close');
      if (await closeBtn.count()) {
        await closeBtn.click().catch(() => {});
      } else {
        await win.keyboard.press('Escape');
      }
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
    });

    test('マルチターゲット: ヘッダー下に案内、各 fieldset 直下に group 別保存先が表示される', async () => {
      // 前テストのモーダルが残っていないことを保証してから開く。
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
      await installMultiTargetDescriptor(win);
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });

      // ヘッダー下の案内文（単一パスではなく項目またはグループごとに異なる旨）。
      const targetNotice = win.locator('.settings-target');
      await expect(targetNotice).toHaveText('保存先: 項目またはグループごとに異なります（各項目・グループの下に表示）');

      // 各 group（fieldset）直下に保存先パス表示（.settings-group-target）が出る。
      const groupTargets = win.locator('.settings-group-target');
      await expect(groupTargets).toHaveCount(2);
      await expect(groupTargets.nth(0)).toContainText('/tmp/group-a.json');
      await expect(groupTargets.nth(1)).toContainText('/tmp/group-b.json');

      // 保存先パスは fieldset.settings-group の中（legend 直後）にある。
      const firstGroupTargetInFieldset = win.locator('fieldset.settings-group', { has: win.locator('.settings-group-target') });
      await expect(firstGroupTargetInFieldset).toHaveCount(2);

      // ヘッダー案内が単一パス表示（code 要素）を含まないこと。
      await expect(win.locator('.settings-target code')).toHaveCount(0);
    });

    test('単一ターゲット: 従来どおり単一パス表示、group 別保存先は出ない（挙動不変）', async () => {
      // 前テストのモーダルが残っていないことを保証してから開く。
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
      await installSingleTargetDescriptor(win);
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      // 単一ターゲットのモーダルが描画され切るまで待つ（前テストの残骸ではないことを確認）。
      await expect(win.locator('.settings-modal h2')).toContainText('単一ターゲット設定');

      // ヘッダー下は単一パスを code で表示。
      const targetNotice = win.locator('.settings-target');
      await expect(targetNotice).toContainText('保存先:');
      await expect(win.locator('.settings-target code')).toHaveText('/tmp/single-config.json');

      // 「グループごとに異なります」の案内は出ない。
      await expect(targetNotice).not.toContainText('グループごとに異なります');

      // group 別保存先表示は 1 つも出ない。
      await expect(win.locator('.settings-group-target')).toHaveCount(0);
    });
  });

  // ─── 旧 settings-empty-tab-guidance.smoke.spec.js（PR #272 / issue #275） ─
  test.describe('重複除去で空になったタブの案内と導線（PR #272 / issue #275）', () => {
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
          // 元から fields が空のグループ。このタブのグループはこれ 1 つだけなので、legend を
          // 省く条件（グループが 1 つ）に当たるが、欄が無いので省かず legend を出す。
          // 省くと枠線と余白だけの空箱になり、案内文も出ないまま行き止まりが残る（issue #275）。
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
      await installDescriptorRecordingSaves(win, matrixDescriptor());
      await openSettings(win);

      // 実欄があるタブには出さない。
      await expect(win.locator(`${PANEL(MATRIX_TAB.fields)} .settings-empty`)).toHaveCount(0);
      await expect(win.locator(`${PANEL(MATRIX_TAB.fields)} input`)).toHaveCount(2);

      // 説明コンテンツがあるタブには出さない（読むものがあるので空ではない）。
      await win.locator(TAB(MATRIX_TAB.onlyDesc)).click();
      await expect(win.locator(`${PANEL(MATRIX_TAB.onlyDesc)} .settings-content`)).toBeVisible();
      await expect(win.locator(`${PANEL(MATRIX_TAB.onlyDesc)} .settings-empty`)).toHaveCount(0);

      // 項目が空のグループがあるタブには出さない。案内文の代わりにグループ名（legend）が
      // 読めるため。legend まで消えると枠線と余白だけの空箱になり、案内文も出ないので
      // 行き止まりになる。個数だけでなく legend の文字列も固定する（issue #275）。
      await win.locator(TAB(MATRIX_TAB.emptyGroup)).click();
      await expect(win.locator(`${PANEL(MATRIX_TAB.emptyGroup)} fieldset.settings-group`)).toHaveCount(1);
      await expect(win.locator(`${PANEL(MATRIX_TAB.emptyGroup)} fieldset.settings-group legend`)).toHaveText('未実装の設定');
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
      await installDescriptorRecordingSaves(win, matrixDescriptor());
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
      expect((await lastSavedPayload(win)).host).toBe('landed.example');
    });

    test('移動ボタンをキーボード（Enter / Space）で押しても同じ欄へ着地する', async () => {
      await installDescriptorRecordingSaves(win, matrixDescriptor());
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
      await installDescriptorRecordingSaves(win, matrixDescriptor());
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
      await installDescriptorRecordingSaves(win, matrixDescriptor());
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
      await installDescriptorRecordingSaves(win, matrixDescriptor());
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
      await installDescriptorRecordingSaves(win, matrixDescriptor());
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
      await installDescriptorRecordingSaves(win, matrixDescriptor());
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
      await installDescriptorRecordingSaves(win, matrixDescriptor());
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
      expect((await lastSavedPayload(win)).host).toBe('dirty.example');
      // 保存が済めば印は解除される。
      await expect(win.locator(TAB(MATRIX_TAB.fields))).not.toHaveClass(/is-dirty/);
    });

    // ─── 観点 5: 保存対象が 1 つも無い極端な定義 ───────────────────────────────

    test('全タブが空の定義でもパネルは壊れず、閉じる操作だけが残る', async () => {
      await installDescriptorRecordingSaves(win, {
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
      await installDescriptorRecordingSaves(win, {
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
      expect((await lastSavedPayload(win)).host).toBe('notabs.example');
    });

    test('重複の無い定義では案内メッセージが出ず、全欄が表示・保存できる', async () => {
      await installDescriptorRecordingSaves(win, {
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
      expect(await lastSavedPayload(win)).toMatchObject({ host: 'b', port: '2', secure: false });
    });

    test('組み込みスキーマでは案内メッセージが出ず、設定項目が従来どおり表示される', async () => {
      // window.VKIpc の差し替えを外し、settings-schema.json を読む実経路で確認する。
      await restoreInvoke(win);
      await openSettings(win);

      // 組み込みは「設定」「モバイルから確認」の 2 タブ。どちらも空ではないので案内は出ない。
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

  // ─── 入力欄グループの後ろの説明（contentAfter） ─────────────────────────────
  //
  // 描画位置は単体テストでは確かめられない（normalizeSettingsTabs はブロックの配列を
  // 返すだけで、パネル内のどこに置かれるかは描画側が決める）。ここでは
  // 「content → 入力欄グループ → contentAfter」の並びを実 DOM で見る。
  test.describe('入力欄の後ろに置く説明', () => {
    function contentAfterDescriptor() {
      return {
        available: true,
        title: 'contentAfter の検証',
        targetPath: '/tmp/settings.json',
        appVersion: '0.0.0-test',
        tabs: [
          {
            id: 'orchestrator',
            label: 'Orchestrator',
            content: [{ type: 'paragraph', text: '入力欄より前の説明' }],
            contentAfter: [{ type: 'paragraph', text: '入力欄より後ろの説明' }],
          },
          {
            id: 'agents',
            label: 'VK Agents',
            contentAfter: [
              { type: 'heading', text: 'ルールの差し替え' },
              { type: 'paragraph', text: 'ルールを上書きできます。' },
            ],
          },
        ],
        groups: [
          {
            label: '基本設定',
            tab: 'orchestrator',
            fields: [{ key: 'template', label: 'コマンドテンプレート', type: 'text' }],
          },
          {
            label: 'エージェント共通設定',
            tab: 'agents',
            fields: [{ key: 'model', label: 'モデル', type: 'text' }],
          },
        ],
        values: { template: '', model: '' },
      };
    }

    test.beforeEach(async () => {
      await installDescriptor(win, contentAfterDescriptor());
      await win.evaluate(() => window.openSettingsModal());
      await win.waitForSelector('.settings-modal', { state: 'visible' });
      await win.waitForSelector('.settings-tabs', { state: 'visible' });
    });

    test.afterEach(async () => {
      const closeButton = win.locator('.settings-close');
      if (await closeButton.count() && await closeButton.isVisible()) {
        await closeButton.click().catch(() => {});
      }
      await win.waitForSelector('.settings-modal', { state: 'detached' }).catch(() => {});
      await restoreInvoke(win).catch(() => {});
    });

    test('contentAfter は入力欄グループより後ろに描く', async () => {
      const order = await win.evaluate(() => Array.from(
        document.querySelector('#settings-panel-0').children
      ).map((el) => el.className.split(' ')[0]));

      expect(order).toEqual(['settings-content', 'settings-group', 'settings-content']);

      // VK Agents 側は content を持たないので、説明は入力欄グループの後ろだけに出る。
      const agentsOrder = await win.evaluate(() => Array.from(
        document.querySelector('#settings-panel-1').children
      ).map((el) => el.className.split(' ')[0]));
      expect(agentsOrder).toEqual(['settings-group', 'settings-content']);
    });
  });

  // ─── 旧 settings-render-error-recovery.smoke.spec.js（issue #259） ───────
  test.describe('設定パネル描画エラー後のロック解放（issue #259）', () => {
    // settings:describe の初回応答だけ values を欠落させ、設定フィールドの描画中に
    // desc.values[f.key] の参照エラーを起こす。2 回目以降は正常な応答へ戻すことで、
    // Electron アプリを再起動せずに同じ画面から復帰できるかを検証する。
    async function installRecoverableDescribeFailure(win) {
      await win.evaluate(() => {
        const vkIpc = window.VKIpc;
        const originalInvoke = vkIpc.invoke.bind(vkIpc);
        const descriptor = {
          available: true,
          title: '描画エラー復帰テスト',
          note: '',
          targetPath: '/tmp/render-error-recovery.json',
          appVersion: '0.0.0-test',
          hasMultipleTargets: false,
          targetPaths: ['/tmp/render-error-recovery.json'],
          groups: [{
            label: 'テストグループ',
            targetPaths: ['/tmp/render-error-recovery.json'],
            fields: [{ key: 'sample', label: 'サンプル値', type: 'text' }],
          }],
          values: { sample: '復帰後の初期値' },
        };

        window.__settingsDescribeCalls = 0;
        vkIpc.invoke = (channel, ...args) => {
          if (channel !== 'settings:describe') return originalInvoke(channel, ...args);
          window.__settingsDescribeCalls += 1;
          if (window.__settingsDescribeCalls === 1) {
            const { values: _values, ...descriptorWithoutValues } = descriptor;
            return Promise.resolve(descriptorWithoutValues);
          }
          return Promise.resolve(descriptor);
        };
      });
    }

    test('描画失敗後も作りかけの要素を残さず、再起動なしで正常に開き直せる', async () => {
      await installRecoverableDescribeFailure(win);
      const settingsButton = win.locator('#settings-btn');

      // 1 回目は values の欠落で描画を失敗させる。実際の設定ボタンから開く経路を使う。
      await settingsButton.click();
      await expect.poll(
        () => win.evaluate(() => window.__settingsDescribeCalls),
        { message: 'settings:describe の初回応答が処理されること' }
      ).toBe(1);

      // 描画自体は失敗するため、モーダルも作りかけの overlay も画面に残らない。
      await expect(win.locator('.settings-modal')).toHaveCount(0);
      await expect(win.locator('.settings-overlay')).toHaveCount(0);

      // IPC 応答は 2 回目から正常に戻る。同じ Electron プロセスのまま再度ボタンを押すと、
      // ロックが解放済みなので設定パネルを正常に開き直せる。
      await settingsButton.click();
      await expect(win.locator('.settings-modal')).toBeVisible();
      await expect(win.locator('#set-field-0')).toHaveValue('復帰後の初期値');
      await expect.poll(() => win.evaluate(() => window.__settingsDescribeCalls)).toBe(2);

      // 開いたパネルは通常どおり入力でき、設定ボタンを連続クリックしても 2 枚に増えない。
      await win.locator('#set-field-0').fill('操作できる');
      await expect(win.locator('#set-field-0')).toHaveValue('操作できる');
      // overlay は背面のボタンへの物理クリックを遮るため、ボタン要素自身へ連続 click
      // イベントを送る。これで設定ボタンのイベントハンドラを通る二重起動要求を再現する。
      await settingsButton.evaluate((button) => {
        button.click();
        button.click();
      });
      await expect(win.locator('.settings-modal')).toHaveCount(1);
      await expect(win.locator('.settings-overlay')).toHaveCount(1);

      // 通常の閉じる操作でもロックが解放され、さらにもう一度開けることを確認する。
      await win.locator('.settings-close').click();
      await expect(win.locator('.settings-overlay')).toHaveCount(0);
      await settingsButton.click();
      await expect(win.locator('.settings-modal')).toBeVisible();
      await expect(win.locator('.settings-modal')).toHaveCount(1);

      // 背景の暗い部分をクリックする従来の閉じ方も、復帰後のパネルで機能する。
      await win.locator('.settings-overlay').click({ position: { x: 5, y: 5 } });
      await expect(win.locator('.settings-overlay')).toHaveCount(0);
    });
  });
});
