const { test, expect } = require('@playwright/test');
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');

// 設定パネルの「API ホスト」入力欄が出す即時案内の回帰テスト（issue #313 / PR #315
// レビュー指摘）。
//
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
test.describe.serial('設定パネルの API ホスト欄の即時案内（issue #313 / PR #315）', () => {
  let app;
  let win;
  let tmpRoot;

  test.beforeAll(async () => {
    const port = await getFreePort();
    ({ app, win, tmpRoot } = await launchAppAndWait({
      port,
      prefix: 'vk-terminals-e2e-settings-apihost-notice-',
    }));
    await win.evaluate(() => window.openSettingsModal());
    await win.waitForSelector('.settings-modal', { state: 'visible' });
    await win.locator('#settings-tab-0').click();
  });

  test.afterAll(async () => {
    await closeApp({ app, tmpRoot });
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
