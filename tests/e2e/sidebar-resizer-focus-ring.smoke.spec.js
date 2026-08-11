const { test, expect } = require('@playwright/test');
// 起動〜初期描画待ちは共通ヘルパーへ集約している（issue #263 / #269）。
const { closeApp, getFreePort, launchAppAndWait } = require('./helpers/electron-app');
// キーボードフォーカス操作・outline の読み取り・比較は共通ヘルパーへ集約している（issue #357）。
const { expectOutline, focusByKeyboard } = require('./helpers/focus-ring');

// .sidebar-resizer は、アプリ内で唯一 outline-offset を意図的に「内側」（-2px）にしている
// 例外（renderer/style.css の .sidebar-resizer:focus-visible）。幅 8px の帯の外側に
// 通常どおり 2px の枠を出すと隣接ペインへ食い込むため、outline は内側オフセットにし、
// さらに box-shadow の inset で内側の線を重ねて描いている。
//
// settings-focus-ring.smoke.spec.js は設定パネル内（.settings-modal 配下）の要素だけを
// 見るテストで、設定ディスクリプタの差し込み等セットアップが専用になっている。
// .sidebar-resizer は設定パネルの外（常設のサイドバー）にあり、そのセットアップは不要な
// ため、別ファイルに分離した（issue #302）。

async function launchSidebarResizerApp(port) {
  return await launchAppAndWait({ port, prefix: 'vk-terminals-e2e-sidebar-resizer-focus-ring-' });
}

test('サイドバーの幅リサイズハンドルは、キーボードフォーカス時に内側オフセットの枠と内側の線を描く（issue #302）', async () => {
  const port = await getFreePort();
  const { app, win, tmpRoot } = await launchSidebarResizerApp(port);
  try {
    // issue #169 以降、起動直後からサイドバーが開いており .sidebar-resizer も表示される
    // （閉じているときは display: none でフォーカス対象からも外れるため、開状態が前提）。
    await expect(win.locator('#root')).toHaveClass(/\bsidebar-open\b/);

    const resizer = win.locator('.sidebar-resizer');
    await expect(resizer).toBeVisible();

    await focusByKeyboard(win, '.sidebar-resizer');

    // outline は共通ヘルパーの比較を使う。width / offset を devicePixelRatio 由来の
    // 丸めを許容しつつ比較している理由は helpers/focus-ring.js の冒頭コメントを参照
    // （issue #357）。色・太さ・スタイルはアプリ共通の値（shared.css の
    // --vktm--outline--focus-ring）だが、offset だけ共通の外側 2px ではなく内側 -2px の
    // 個別上書きが効いている。
    await expectOutline(win, '.sidebar-resizer', {
      color: 'rgb(88, 166, 255)',
      style: 'solid',
      width: 2,
      offset: -2,
    }, '.sidebar-resizer');

    // box-shadow は outline とは別に読む（expectOutline は outline-* だけを扱うヘルパーのため）。
    // box-shadow の spread（inset の内側の線の太さ）は実測で devicePixelRatio が 1 以外
    // （1.24 相当）でも "2px" のまま丸めを受けなかった（outline-width / outline-offset /
    // border-width とは挙動が違う。Chromium が box-shadow をレイアウト単位のデバイスピクセル
    // 丸めとは別経路で描画しているためと見られる）。影響を受けないためここは固定値の完全
    // 一致のまま書き換えていない（issue #357）。
    //
    // box-shadow の inset（内側の線）が重なって描かれている。
    // computed 値は Chromium では「色 offset-x offset-y blur spread inset」の順で
    // 正規化される（実測: "rgb(88, 166, 255) 0px 0px 0px 2px inset"）。toContain('2px') だと
    // spread と offset-y が入れ替わった別物（例: "0px 2px 0px 0px inset"）でも通ってしまうため、
    // 各値の位置まで固定した正規表現で判定する。
    const boxShadow = await win.evaluate(() => getComputedStyle(document.querySelector('.sidebar-resizer')).boxShadow);
    expect(boxShadow, '.sidebar-resizer の box-shadow').toMatch(
      /^rgb\(88, 166, 255\) 0px 0px 0px 2px inset$/
    );
  } finally {
    await closeApp({ app, tmpRoot });
  }
});
