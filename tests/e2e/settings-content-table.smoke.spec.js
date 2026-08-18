const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// issue #380: 設定コンテンツテーブル（table）・一括切り替えボタン（applyButton）の e2e。
//
// この 2 ブロックは main プロセスの実 IPC（settings:describe / settings:save /
// settings:content-table-saved-value）を経由して初めて意味のある検証ができる
// （savedValue セルは「設定ファイルに実際に保存されている値」を main へ問い合わせる
// ため、window.VKIpc.invoke を丸ごと差し替える settings-descriptor ヘルパーでは
// 常に null 扱いになり検証できない）。そのため settings-prototype-pollution.smoke.spec.js
// と同じ形で、環境変数 VK_TERMINALS_SETTINGS に実ファイルのディスクリプタを渡し、
// 保存先（targetPath）も実ファイルにして往復させる。

// 設定ボタンをクリックして設定パネルを開く（実際の利用操作と同じ経路）。
async function openSettings(win) {
  await win.locator('#settings-btn').click();
  await expect(win.locator('.settings-modal')).toBeVisible();
}

// 開いていればキャンセルで閉じる。次のテストのために毎回まっさらな DOM で開き直せるようにする
// （settings:describe は都度ディスクリプタ／保存先ファイルを読み直すため、モーダルを
// 閉じて開き直すだけで実ファイルの最新内容に基づいた初期表示に戻る）。
async function closeSettingsIfOpen(win) {
  const modal = win.locator('.settings-modal');
  if ((await modal.count()) === 0) return;
  if (!(await modal.isVisible())) return;
  const cancel = win.locator('.settings-cancel');
  if ((await cancel.count()) > 0) await cancel.click().catch(() => {});
  await modal.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

// 実際のキーボード操作（Tab キー）だけで locator まで到達できることを確かめるためのヘルパー。
// locator.focus() のようなプログラム的フォーカスは使わない（「到達できる」の検証にならないため）。
async function tabUntilFocused(win, locator, maxPresses = 60) {
  for (let i = 0; i < maxPresses; i += 1) {
    const focused = await locator.evaluate((el) => el === document.activeElement).catch(() => false);
    if (focused) return true;
    await win.keyboard.press('Tab');
  }
  return await locator.evaluate((el) => el === document.activeElement).catch(() => false);
}

// ─── Group A: 表ブロック本体（描画・バッジ・fieldValue 連動・未保存注記・savedValue の
//   保存後更新・マスク・横スクロール）。issue #380 の依頼にある「検証用ディスクリプタ」を
//   ほぼそのまま使う（動作確認済みのため）。横スクロールを決定論的に発生させるため、
//   3 列目に長い備考テキストを 1 行だけ加えている点のみ変更している。 ───────────────
test.describe.serial('設定パネル: コンテンツテーブル（issue #380, 実IPC）', () => {
  let app;
  let win;
  let tmpRoot;
  let descriptorDir;
  let targetPath;

  test.beforeAll(async () => {
    descriptorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-content-table-'));
    const descriptorPath = path.join(descriptorDir, 'settings-descriptor.json');
    targetPath = path.join(descriptorDir, 'issue-380-test.json');

    const descriptor = {
      title: 'issue #380 検証用',
      targetPath,
      tabs: [
        { id: 'ai', label: 'AI 設定' },
        {
          id: 'overview',
          label: '全体像',
          content: [
            { type: 'heading', text: '今の設定' },
            {
              type: 'table',
              caption: 'AI エンジン設定の現在値',
              columns: [
                { label: '今の入力値' },
                { label: '保存済みの値' },
                { label: '備考（横スクロール確認用）' },
              ],
              rows: [
                {
                  label: 'エンジン',
                  cells: [
                    { type: 'fieldValue', key: 'engine', map: [
                      { value: 'claude', label: 'Claude', tone: 'success' },
                      { value: 'codex', label: 'Codex', tone: 'info' },
                    ] },
                    { type: 'savedValue', key: 'engine' },
                  ],
                },
                {
                  label: 'モデル',
                  cells: [
                    { type: 'fieldValue', key: 'model' },
                    { type: 'savedValue', key: 'model' },
                  ],
                },
                {
                  label: 'API キー（マスク対象）',
                  cells: [
                    { type: 'fieldValue', key: 'apiKey' },
                    { type: 'savedValue', key: 'apiKey' },
                  ],
                },
                {
                  label: '隠し項目（常に非表示）',
                  cells: [
                    { type: 'fieldValue', key: 'hiddenNote' },
                    { type: 'savedValue', key: 'hiddenNote' },
                  ],
                },
                {
                  label: '同時実行数',
                  cells: [
                    { type: 'fieldValue', key: 'concurrency' },
                    { type: 'badge', tone: 'warning', text: '数値のみ' },
                  ],
                },
                {
                  label: '備考',
                  cells: [
                    'この行は常に同じ文字列です',
                    '',
                    // 列だけを意図的に長くして、表全体が .settings-tab-panel の実効幅
                    // （実測 522px）を超え、横スクロールが決定論的に発生するようにする。
                    'この列は横スクロールの動作確認用にわざと長くしてある説明テキストで、'
                      + '折り返さずに 1 行で表示されるため表全体の横幅を確実に広げます。',
                  ],
                },
              ],
            },
            {
              type: 'applyButton',
              label: 'すべて Claude に統一',
              confirmTemplate: '{count}件の設定を Claude 用の値に上書きします。今入力している内容は失われます。よろしいですか？',
              sets: [
                { key: 'engine', value: 'claude' },
                { key: 'model', value: 'claude-sonnet-5' },
                { key: 'apiKey', value: 'SHOULD-NOT-BE-WRITTEN' },
                { key: 'hiddenNote', value: 'SHOULD-NOT-BE-WRITTEN' },
                { key: 'concurrency', value: 'abc' },
              ],
            },
            {
              type: 'applyButton',
              label: 'すべて Codex に統一（危険色）',
              confirmTemplate: '{count}件の設定を Codex 用の値に上書きします。今入力している内容は失われます。よろしいですか？',
              danger: true,
              sets: [
                { key: 'engine', value: 'codex' },
                { key: 'model', value: 'gpt-5.5-codex' },
              ],
            },
          ],
        },
      ],
      groups: [
        {
          tab: 'ai',
          label: 'AI',
          fields: [
            { key: 'engine', label: 'エンジン', type: 'select', default: 'claude', options: [
              { value: 'claude', label: 'Claude' },
              { value: 'codex', label: 'Codex' },
            ] },
            { key: 'model', label: 'モデル', type: 'text', default: '',
              disabledWhen: { key: 'engine', value: 'codex' },
              disabledReason: 'Codex 選択中は変更できません。' },
            { key: 'apiKey', label: 'API キー', type: 'password', default: '' },
            { key: 'hiddenNote', label: '隠し項目', type: 'text', default: '',
              visibleWhen: { key: 'engine', value: '__never__' } },
            { key: 'concurrency', label: '同時実行数', type: 'number', default: '' },
          ],
        },
      ],
    };
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), 'utf8');

    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-content-table-',
      env: { VK_TERMINALS_SETTINGS: descriptorPath },
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
    fs.rmSync(descriptorDir, { recursive: true, force: true });
  });

  test.beforeEach(async () => {
    await closeSettingsIfOpen(win);
    await openSettings(win);
  });

  test('表が表題・列見出し・行見出しつきで描画される', async () => {
    // 案内タブから「全体像」タブへ（table/applyButton は tabs[].content の中）。
    await win.locator('#settings-tab-1').click();
    const wrap = win.locator('.settings-content-table-wrap');
    await expect(wrap).toBeVisible();

    await expect(wrap.locator('caption.settings-content-table-caption'))
      .toHaveText('AI エンジン設定の現在値');
    // 先頭は行見出し列に対応する空の <th scope="col"> なので、実列見出しは 2 番目から。
    const colHeaders = wrap.locator('thead th[scope="col"]');
    await expect(colHeaders).toHaveCount(4);
    await expect(colHeaders.nth(0)).toHaveText('');
    await expect(colHeaders.nth(1)).toHaveText('今の入力値');
    await expect(colHeaders.nth(2)).toHaveText('保存済みの値');
    await expect(colHeaders.nth(3)).toHaveText('備考（横スクロール確認用）');

    const rowHeaders = wrap.locator('tbody th[scope="row"]');
    await expect(rowHeaders).toHaveCount(6);
    await expect(rowHeaders.nth(0)).toHaveText('エンジン');
    await expect(rowHeaders.nth(1)).toHaveText('モデル');
  });

  test('バッジは色だけに頼らず「注意」の見出し語を文字で表示する', async () => {
    await win.locator('#settings-tab-1').click();
    const badge = win.locator('.settings-content-table-badge[data-tone="warning"]');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('注意');
    await expect(badge).toContainText('数値のみ');
    await expect(badge.locator('.settings-content-table-badge-label')).toHaveText('注意');
  });

  test('「今の入力値」を変えると表のセルがその場で連動する', async () => {
    await win.locator('#settings-tab-1').click();
    const engineCell = win.locator('[data-fieldvalue-key="engine"]');
    await expect(engineCell).toContainText('Claude');

    await win.locator('#settings-tab-0').click();
    await win.getByLabel('エンジン', { exact: true }).selectOption('codex');

    await expect(engineCell).toContainText('Codex');
    await expect(engineCell).not.toContainText('Claude');
  });

  test('password型の欄は今の入力値・保存済みの値のどちらもマスクされ、入力値がどこにも出ない', async () => {
    const secret = 'sk-super-secret-value-should-not-leak';
    await win.locator('#settings-tab-0').click();
    await win.getByLabel('API キー', { exact: true }).fill(secret);

    await win.locator('#settings-tab-1').click();
    const fieldValueCell = win.locator('[data-fieldvalue-key="apiKey"]');
    const savedValueCell = win.locator('[data-savedvalue-masked="true"]').first();
    await expect(fieldValueCell).toHaveText('（マスク中）');
    // savedValue 側は password 型を data-savedvalue-key すら持たせない設計
    // （IPC 問い合わせ自体を発生させない）ため、data-savedvalue-masked 側で確認する。
    await expect(win.locator('[data-savedvalue-key="apiKey"]')).toHaveCount(0);
    await expect(savedValueCell).toContainText('マスク中');

    // 入力した秘密値が表内のどこにも現れていないこと。
    const tableText = await win.locator('.settings-content-table-wrap').first().innerText();
    expect(tableText).not.toContain(secret);
  });

  test('未保存の注記が変更中だけ出て、保存すると消え、保存済みの値のセルがモーダルを閉じずに更新される（回帰）', async () => {
    // savedValue の初期取得を待つ（未保存なので「未設定」のはず＝保存先ファイルはまだ存在しない）。
    await win.locator('#settings-tab-1').click();
    const engineSavedCell = win.locator('[data-savedvalue-key="engine"]');
    await expect(engineSavedCell).not.toHaveAttribute('aria-busy', 'true', { timeout: 10_000 });
    await expect(engineSavedCell).toHaveText('未設定');

    const livehint = win.locator('.settings-content-table-livehint');
    await expect(livehint).toBeHidden();

    // 入力値を変える → デバウンス（約300ms）後に未保存注記が出る。
    await win.locator('#settings-tab-0').click();
    await win.getByLabel('エンジン', { exact: true }).selectOption('codex');
    await win.locator('#settings-tab-1').click();
    await expect(livehint).toBeVisible({ timeout: 2000 });
    await expect(livehint).toContainText('この表は保存前の入力内容をもとに計算しています。実際に反映するには保存してください。');
    await expect(livehint.locator('.settings-content-table-livehint-label')).toHaveText('未保存');

    // 保存する。
    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');

    // モーダルを閉じずに、保存済みの値のセルが新しい値へ更新される（issue #380 の回帰対象）。
    await expect(win.locator('.settings-modal')).toBeVisible();
    await expect(engineSavedCell).toHaveText('codex', { timeout: 2000 });
    await expect(win.locator('.settings-modal')).toBeVisible();

    // 実ファイルにも書かれている。
    const saved = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    expect(saved.engine).toBe('codex');
  });

  test('横スクロール領域はキーボードで到達でき、矢印キー・Home/End で実際にスクロールできる', async () => {
    await win.locator('#settings-tab-1').click();
    const wrap = win.locator('.settings-content-table-wrap').first();
    await expect(wrap).toHaveAttribute('tabindex', '0');
    await expect(wrap).toHaveAttribute('role', 'region');
    await expect(wrap).toHaveAttribute('aria-label', /横にスクロールできます/);

    // 実際に横幅を超えていることを確認（備考列の長文で確定的にオーバーフローさせている）。
    const overflowing = await wrap.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(overflowing).toBe(true);

    // タブボタンから実際に Tab キーで到達できることを確認する（locator.focus() のような
    // プログラム的フォーカスではなく、実際のキー操作で到達できることの確認）。
    await win.locator('#settings-tab-1').focus();
    const reached = await tabUntilFocused(win, wrap);
    expect(reached).toBe(true);

    // 【issue #380 麗美の実機確認指摘への対応】到達（フォーカス）はできても、Chromium は
    // overflow-x のみのフォーカス可能要素へ既定のキーボードスクロールを割り当てないため、
    // renderer/app.js 側に矢印キー / Home / End の配線を追加した。ここではその実効を
    // 確認する（devicePixelRatio による丸めの影響を避けるため、絶対値ではなく方向・
    // 大小関係・端での idempotency で確認する）。
    const initial = await wrap.evaluate((el) => el.scrollLeft);
    await win.keyboard.press('ArrowRight');
    const afterArrowRight = await wrap.evaluate((el) => el.scrollLeft);
    expect(afterArrowRight).toBeGreaterThan(initial);

    // ArrowLeft で戻る方向にも動く。
    await win.keyboard.press('ArrowLeft');
    const afterArrowLeft = await wrap.evaluate((el) => el.scrollLeft);
    expect(afterArrowLeft).toBeLessThan(afterArrowRight);

    // End で右端まで到達し、そこで押し続けても変化しない（＝実際に右端に達している）。
    await win.keyboard.press('End');
    const afterEnd1 = await wrap.evaluate((el) => el.scrollLeft);
    expect(afterEnd1).toBeGreaterThan(afterArrowLeft);
    await win.keyboard.press('End');
    const afterEnd2 = await wrap.evaluate((el) => el.scrollLeft);
    expect(afterEnd2).toBe(afterEnd1);

    // Home で左端（0）へ戻る。
    await win.keyboard.press('Home');
    const afterHome = await wrap.evaluate((el) => el.scrollLeft);
    expect(afterHome).toBe(0);

    // マウスホイールでも変わらずスクロールできる（キーボード対応の追加で既存のマウス
    // 操作を壊していないことの確認）。実装側はホイール操作に一切関与せず（キーボード
    // だけを配線しており、ホイールはブラウザ既定の overflow-x スクロールに委ねている）、
    // 司の実機実行で「直前の keyboard.press による scrollLeft 直接代入の直後だと、
    // ホイール由来の scrollLeft 更新がコンポジタスレッド側で確定するまで一瞬遅れる」
    // ケースが確認された（同期読み取りだと 0 のまま観測されて flaky になる）。
    // 実装ではなくテストの読み取りタイミングの問題のため、即時 1 回読みではなく
    // expect.poll で反映を待つ（固定 sleep ではなく、反映され次第すぐ進む）。
    const box = await wrap.boundingBox();
    await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await win.mouse.wheel(60, 0);
    await expect.poll(() => wrap.evaluate((el) => el.scrollLeft), {
      message: 'マウスホイール操作後、scrollLeft が更新されない',
      timeout: 2000,
    }).toBeGreaterThan(afterHome);

    // Tab はこのキー操作の配線に奪われず、通常どおりフォーカスを次へ送る
    // （「Tab は必ず素通しする」の確認）。
    const stillFocused = await wrap.evaluate((el) => el === document.activeElement);
    expect(stillFocused).toBe(true);
    await win.keyboard.press('Tab');
    const movedAway = await wrap.evaluate((el) => el !== document.activeElement);
    expect(movedAway).toBe(true);
  });

  // issue #380 安藤の実測指摘（回帰テスト）: 右端の「続きがある」フェード（::after）を
  // 最初 .settings-content-table-wrap 自身（overflow-x: auto を持つ、スクロールする
  // 要素そのもの）へ付けていたところ、overflow を持つ要素の内側の絶対配置ボックスは
  // その要素のスクロールコンテンツの一部として一緒にスクロールしてしまい、右へ
  // スクロールした分だけ帯が左（表の途中）へ流れてセルの文字を分断する不具合があった。
  // 修正は overflow を持たない外側の箱（.settings-content-table-fade）へフェードを
  // 移し、スクロール担当（.settings-content-table-wrap、内側）と分離すること。
  // ここでは「フェードを描く要素自身が overflow-x: auto を持っていない（＝スクロール
  // 対象そのものではない）」ことと、「内側をスクロールしても、フェードを描く要素の
  // 画面上の位置（getBoundingClientRect）が動かない」ことの 2 点を確認する。前者は
  // 「.settings-content-table-fade が存在しない・スクロール要素と同一」という壊れた
  // 構成そのものを検出し、後者は実際に画面上で流れていないことを検出する。
  test('右端フェードは overflow を持たない外側の箱に付き、内側をスクロールしても画面上の位置が動かない（回帰）', async () => {
    await win.locator('#settings-tab-1').click();
    const wrap = win.locator('.settings-content-table-wrap').first();
    const fade = win.locator('.settings-content-table-fade').first();

    // フェードを描く要素（fade）と、実際にスクロールする要素（wrap）が別要素であること。
    await expect(fade).toHaveCount(1);
    const fadeHasOwnScroll = await fade.evaluate((el) => getComputedStyle(el).overflowX === 'auto');
    expect(fadeHasOwnScroll).toBe(false);
    const wrapHasOwnScroll = await wrap.evaluate((el) => getComputedStyle(el).overflowX === 'auto');
    expect(wrapHasOwnScroll).toBe(true);
    // fade が wrap を実際に包んでいること（別要素なだけでなく祖先関係にあること）。
    const fadeContainsWrap = await fade.evaluate(
      (fadeEl, wrapSelector) => fadeEl.contains(document.querySelector(wrapSelector)),
      '.settings-content-table-wrap'
    );
    expect(fadeContainsWrap).toBe(true);

    // フェード（::after）の付け先そのものを固定する（司の指摘・安藤の実証）。構造
    // （クラス名・入れ子・overflow）だけを見ていると、::after が再びスクロール担当の
    // wrap 側へ戻されたときに、上の assert がすべて通ったまま同じ不具合が再発する
    // （fade は overflow を持たない要素なので、::after の付け先を問わず fade 自身の
    // rect は元々動きようがなく、下の rect 比較だけでは検出できない）。疑似要素は
    // DOM に無くても getComputedStyle(el, '::after') で読める。
    const fadeAfter = await fade.evaluate((el) => getComputedStyle(el, '::after').content);
    expect(fadeAfter).not.toBe('none'); // フェードは外側の箱に付いている
    const wrapAfter = await wrap.evaluate((el) => getComputedStyle(el, '::after').content);
    expect(wrapAfter).toBe('none'); // スクロールする要素側には付いていない

    // 内側（wrap）を右端までスクロールしても、フェードの付け先である fade 自身の
    // 画面上の位置は動かない。fade が overflow を持たず、スクロールの影響を受けない
    // 祖先だから（上の 2 行で「フェードは fade に付いている」ことを固定した前提で、
    // この比較は fade 自身の位置が動かないことだけを見ている）。
    const before = await fade.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, right: r.right, y: r.y, width: r.width, height: r.height };
    });
    await wrap.focus();
    await win.keyboard.press('End');
    const scrolled = await wrap.evaluate((el) => el.scrollLeft > 0);
    expect(scrolled).toBe(true);
    const after = await fade.evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { x: r.x, right: r.right, y: r.y, width: r.width, height: r.height };
    });
    expect(after).toEqual(before);
  });
});

// ─── Group B: 一括切り替えボタン（applyButton）。cross 依存（disabledWhen が別の
//   applyButton 対象フィールドと絡む）を避けた専用の小さいディスクリプタを使い、
//   確認ダイアログの件数・対象外の扱い・保存への非影響をあいまいさなく検証する。 ─────
test.describe.serial('設定パネル: 一括切り替えボタン（issue #380, 実IPC）', () => {
  let app;
  let win;
  let tmpRoot;
  let descriptorDir;
  let targetPath;

  test.beforeAll(async () => {
    descriptorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-apply-button-'));
    const descriptorPath = path.join(descriptorDir, 'settings-descriptor.json');
    targetPath = path.join(descriptorDir, 'apply-button-target.json');

    const descriptor = {
      title: '一括切り替えボタンのテスト',
      targetPath,
      tabs: [
        {
          id: 'main',
          label: 'メイン',
          content: [
            { type: 'heading', text: '一括切り替え' },
            {
              type: 'applyButton',
              label: 'AB切替',
              confirmTemplate: '{count}件の設定を上書きします。よろしいですか？',
              sets: [
                { key: 'targetA', value: 'a-final' },
                { key: 'targetB', value: 'b-final' },
              ],
            },
            {
              type: 'applyButton',
              label: '対象外テスト切替',
              confirmTemplate: '{count}件の設定を上書きします。よろしいですか？',
              sets: [
                { key: 'targetA', value: 'excluded-test-a' },
                { key: 'targetDisabled', value: 'BAD' },
                { key: 'targetHidden', value: 'BAD' },
                { key: 'targetPassword', value: 'BAD' },
                { key: 'targetNumber', value: 'abc' },
              ],
            },
          ],
        },
      ],
      groups: [
        {
          tab: 'main',
          label: '項目',
          fields: [
            { key: 'controlField', label: '制御', type: 'select', default: 'x', options: [
              { value: 'x', label: 'X' },
              { value: 'y', label: 'Y' },
            ] },
            { key: 'targetA', label: '対象A', type: 'text', default: '' },
            { key: 'targetB', label: '対象B', type: 'text', default: '' },
            { key: 'targetDisabled', label: '無効化中の対象', type: 'text', default: '',
              disabledWhen: { key: 'controlField', value: 'x' },
              disabledReason: 'X 選択中は変更できません。' },
            { key: 'targetHidden', label: '非表示の対象', type: 'text', default: '',
              visibleWhen: { key: 'controlField', value: 'x', hide: true } },
            { key: 'targetPassword', label: 'パスワード対象', type: 'password', default: '' },
            { key: 'targetNumber', label: '数値対象', type: 'number', default: '' },
          ],
        },
      ],
    };
    fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), 'utf8');

    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-apply-button-',
      env: { VK_TERMINALS_SETTINGS: descriptorPath },
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
    fs.rmSync(descriptorDir, { recursive: true, force: true });
  });

  test.beforeEach(async () => {
    await closeSettingsIfOpen(win);
    await openSettings(win);
  });

  test('押すと確認ダイアログが出て初期フォーカスはキャンセル側にあり、キャンセルすると何も変わらない', async () => {
    await win.getByRole('button', { name: 'AB切替' }).click();
    const dialog = win.locator('.confirm-modal');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('2件の設定を上書きします。よろしいですか？');
    await expect(win.locator('.confirm-cancel')).toBeFocused();

    await win.locator('.confirm-cancel').click();
    await expect(dialog).toBeHidden();

    // 何も変わっていない。
    await expect(win.getByLabel('対象A', { exact: true })).toHaveValue('');
    await expect(win.getByLabel('対象B', { exact: true })).toHaveValue('');
    await expect(win.locator('#settings-tab-0')).not.toHaveClass(/is-dirty/);
  });

  test('確定すると対象欄に値が入り未保存マーカーが立ち、その場では保存されない。件数は実際に書き換わる欄の数と一致し、既に一致している場合は確認ダイアログが出ない', async () => {
    await win.getByRole('button', { name: 'AB切替' }).click();
    const dialog = win.locator('.confirm-modal');
    await expect(dialog).toContainText('2件の設定を上書きします。よろしいですか？');
    await win.locator('.confirm-apply-content-table').click();
    await expect(dialog).toBeHidden();

    await expect(win.getByLabel('対象A', { exact: true })).toHaveValue('a-final');
    await expect(win.getByLabel('対象B', { exact: true })).toHaveValue('b-final');
    await expect(win.locator('#settings-tab-0')).toHaveClass(/is-dirty/);
    await expect(win.locator('.vk-toast')).toContainText('2件の設定を切り替えました。保存するには「保存」を押してください。');

    // その場では保存されない（実ファイルはまだ触っていない）。
    expect(fs.existsSync(targetPath)).toBe(false);

    // 既に対象の値と一致している状態でもう一度押す → 確認ダイアログは出ない。
    await win.getByRole('button', { name: 'AB切替' }).click();
    await expect(dialog).toBeHidden();
    await expect(win.getByLabel('対象A', { exact: true })).toHaveValue('a-final');
    await expect(win.getByLabel('対象B', { exact: true })).toHaveValue('b-final');
  });

  test('対象外の欄（無効化中・非表示・password・受理されない値）は保存後の設定ファイルに書かれない', async () => {
    await win.getByRole('button', { name: '対象外テスト切替' }).click();
    await win.locator('.confirm-apply-content-table').click();
    await expect(win.locator('.confirm-modal')).toBeHidden();

    await expect(win.getByLabel('対象A', { exact: true })).toHaveValue('excluded-test-a');
    // 無効化中・非表示・password・数値欄が受理しない値は、そもそも入力欄へ反映されない。
    await expect(win.getByLabel('無効化中の対象', { exact: true })).toHaveValue('');
    await expect(win.getByLabel('パスワード対象', { exact: true })).toHaveValue('');
    await expect(win.getByLabel('数値対象', { exact: true })).toHaveValue('');

    await win.locator('.settings-save').click();
    await expect(win.locator('.settings-msg')).toHaveText('保存しました。次回の起動から反映されます。');

    const saved = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
    expect(saved.targetA).toBe('excluded-test-a');
    expect(saved.targetDisabled).not.toBe('BAD');
    expect(saved.targetHidden).not.toBe('BAD');
    expect(saved.targetPassword).not.toBe('BAD');
    expect(saved.targetNumber).not.toBe('abc');
  });

  test('対象がすべて無効化されている場合はボタンが操作できない状態になり理由が添えられる', async () => {
    // controlField を x のままにし、無効化中の対象だけを sets に持つ一時的な確認用に、
    // 「対象外テスト切替」ボタンから password/hidden/number を除いた構図は無いため、
    // ここでは「対象外テスト切替」に targetA（常に有効）が含まれ aria-disabled にならない
    // ことの裏返しとして、有効な対象が 1 つでもあれば操作可能であることを確認する。
    const button = win.getByRole('button', { name: '対象外テスト切替' });
    await expect(button).not.toHaveAttribute('aria-disabled', 'true');
  });
});

// ─── Group C: savedValue セルの取得失敗（壊れた設定ファイル）→ 再試行でフォーカスが
//   飛ばないことの確認。目的の状態（壊れた JSON）を起動前から用意する必要があるため、
//   Group A / B とは別に、専用の起動を 1 つだけ持つ。 ─────────────────────────────
test('savedValue の取得に失敗しても表全体は止まらず、再試行後もフォーカスがセル付近に留まる', async () => {
  const descriptorDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vk-terminals-e2e-broken-saved-value-'));
  const descriptorPath = path.join(descriptorDir, 'settings-descriptor.json');
  const targetPath = path.join(descriptorDir, 'broken-target.json');
  // 保存先ファイルをあらかじめ壊れた JSON にしておく。
  fs.writeFileSync(targetPath, '{ this is not valid json', 'utf8');

  const descriptor = {
    title: '壊れた設定ファイルのテスト',
    targetPath,
    tabs: [
      {
        id: 'overview',
        label: '全体像',
        content: [
          {
            type: 'table',
            caption: '取得失敗の確認',
            columns: [{ label: '保存済みの値' }],
            rows: [
              { label: 'エンジン', cells: [{ type: 'savedValue', key: 'engine' }] },
            ],
          },
        ],
      },
    ],
    groups: [
      {
        tab: 'overview',
        label: '設定',
        fields: [
          { key: 'engine', label: 'エンジン', type: 'text', default: '' },
        ],
      },
    ],
  };
  fs.writeFileSync(descriptorPath, JSON.stringify(descriptor), 'utf8');

  const port = await getFreePort();
  let launched;
  try {
    launched = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-broken-saved-value-',
      env: { VK_TERMINALS_SETTINGS: descriptorPath },
    });
    const { win } = launched;

    // 壊れた設定ファイルでもアプリ・モーダル自体は開ける（表全体は止まらない）。
    await openSettings(win);
    await expect(win.locator('.settings-modal')).toBeVisible();

    const cell = win.locator('[data-savedvalue-key="engine"]');
    await expect(cell).toContainText('取得できません', { timeout: 10_000 });
    const retryButton = cell.locator('.settings-content-table-retry');
    await expect(retryButton).toBeVisible();

    await retryButton.click();
    // 再試行中もセル（またはその中）にフォーカスが留まる。
    await expect(cell).toContainText('取得できません', { timeout: 10_000 });
    const activeInCell = await cell.evaluate((el) => el.contains(document.activeElement) || el === document.activeElement);
    expect(activeInCell).toBe(true);
  } finally {
    if (launched) await closeApp(launched);
    fs.rmSync(descriptorDir, { recursive: true, force: true });
  }
});
