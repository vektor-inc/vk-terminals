const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// renderer の ipcRenderer.invoke を差し替え、pattern 付き descriptor を返させる。
// app.js は `const { ipcRenderer } = require('electron')` で同一のモジュールオブジェクトを
// 参照しているため、そのオブジェクトの invoke を上書きすれば openSettingsModal 内の
// 呼び出しにも効く。settings:save は成功を返しつつ payload を window に記録する。
async function installMockDescriptor(win) {
  await win.evaluate(() => {
    const { ipcRenderer } = require('electron');
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
    ipcRenderer.invoke = (channel, payload) => {
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

test.describe.serial('設定ダイアログの pattern 形式チェック（issue #140）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-pattern-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

  // 各テストの前にモックを入れ直し、設定モーダルを開き直す（DOM を毎回まっさらに）。
  test.beforeEach(async () => {
    await installMockDescriptor(win);
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    await win.waitForSelector(REPO_ID, { state: 'visible' });
  });

  // 各テストの後にモーダルを閉じる（次テストで再オープンできるように）。
  // 閉じる操作に Escape を使わないのは、Escape がモーダルだけでなくサイドバーも閉じ、
  // その開閉アニメーション後（約 220ms）に ☰ ボタンへフォーカスを戻すため。この遅延
  // フォーカスが次テストへ持ち越されると、入力欄に当てたはずのフォーカスを ☰ に奪われ、
  // activeElement を見る検証が実装とは無関係に落ちる。他の settings 系 spec と同じく
  // ✕ ボタンで閉じれば、サイドバー側のハンドラを起こさずに済む。
  test.afterEach(async () => {
    const closeBtn = win.locator('.settings-close');
    if (await closeBtn.count()) {
      await closeBtn.click().catch(() => {});
    }
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
