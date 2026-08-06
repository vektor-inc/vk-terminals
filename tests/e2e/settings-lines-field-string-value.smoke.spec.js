const { test, expect } = require('@playwright/test');
const path = require('path');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
// 設定ディスクリプタの差し込みと後始末は共通ヘルパーへ集約している（issue #293）。
// この spec は「保存処理がどの欄を採用したか」を payload で直接観測するため、
// 保存内容を記録する差し込み（実 IPC へは一切流さない方）を使う。
const {
  installDescriptorRecordingSaves,
  lastSavedPayload,
  restoreInvoke,
} = require('./helpers/settings-descriptor');

// issue #339: lines 型フィールドの表示（renderer/app.js の renderSettingsField）は
// 「値が配列でなければ空文字」としており、保存側（settingsTargets.js の coerceFieldValue、
// 「配列でなければ文字列として扱い改行で分割する」）と食い違っていた。判定ロジック自体は
// tests/settingsLinesField.test.js が renderer/settingsLinesField.js の
// linesFieldDisplayText を直接見て確認しているが、それだけでは renderer/app.js の
// call-site（escText の有無・呼び出し漏れ）までは守れない。この spec は実際の設定画面で
// 「文字列の値を開いたら空欄に見えない」「そのまま保存しても値が消えない」という
// 症状そのものを固定する（安藤レビュー指摘）。
//
// 保存 payload について: renderer は textarea.value（生の文字列）をそのまま
// settings:save へ渡し、改行区切りの配列への変換は main プロセス側
// （settingsTargets.js の coerceFieldValue。単体テストは tests/settingsTargets.test.js）が
// 担う。installDescriptorRecordingSaves は settings:save を実 IPC の手前で横取りするため、
// ここで観測できる payload は変換前の生の文字列のまま。そのため以下のテストでは
// 「表示された内容が欠落せずに payload まで届く」ことを確認する（＝配列化まではこの
// spec の観測範囲外で、main 側の変換は settingsTargets.test.js の責務）。
//
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

test.describe.serial('設定パネルの lines フィールドに文字列値を注入した表示・保存（issue #339）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-lines-field-string-value-',
    }));
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
  });

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
    // 記録している payload は、その変換前の生の文字列そのもの。
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
