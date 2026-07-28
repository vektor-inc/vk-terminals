// ─── renderer のブートストラップ（issue #268） ────────────────────────────────
//
// nodeIntegration を切ったので、app.js から xterm を require できなくなった。
// 代わりに UMD ビルドを <script> で読み込み、window.Terminal / window.FitAddon を
// 生やしてから app.js を読み込む。
//
// なぜ index.html に <script src="../node_modules/..."> と直書きしないのか:
//   vk-terminals が npm 依存としてインストールされた場合（例: vk-orchestrator の
//   node_modules 内から起動）、依存パッケージは上位の node_modules へホイストされ、
//   自身の node_modules ディレクトリが存在しない。相対パスはそこを遡れず 404 になる。
//   そのため preload が require.resolve で実体の絶対パス（file:// URL）を解決し、
//   ここではそれを読み込むだけにしている。xterm.css も同じ理由で <link> ではなく
//   preload が読んだ中身を <style> として注入する。
//
// 読み込み順は決定的にする必要がある:
//   1. xterm（window.Terminal）
//   2. addon-fit（window.FitAddon）— xterm に依存
//   3. xterm.css を <style> で注入
//   4. app.js（1〜3 が揃っていることを前提に読み込み時点で参照する）
(function () {
  'use strict';

  const bridge = window.vkBridge;

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = src;
      el.async = false;
      el.onload = () => resolve();
      el.onerror = () => reject(new Error(`[vk-terminals] script の読み込みに失敗しました: ${src}`));
      document.head.appendChild(el);
    });
  }

  // 空文字でないことは呼び出し側（boot）が保証する。
  function injectXtermCss(css) {
    const style = document.createElement('style');
    style.textContent = css;
    // xterm.css には IME 用 textarea を画面外へ逃がす必須スタイル
    // （.xterm-helper-textarea の position: absolute / opacity: 0 / left: -9999em 等）が
    // 含まれており、欠落すると textarea が文書フロー上（ペイン左上）に可視状態で置かれ、
    // 日本語入力の変換候補ウィンドウがペイン左上に表示される。
    //
    // アプリ側 style.css より前に挿入し、既存の上書き関係（style.css が後勝ち）を維持する。
    const appCss = document.querySelector('link[href="style.css"]');
    document.head.insertBefore(style, appCss);
  }

  // 初期化に失敗したときの可視フォールバック。
  // ここへ落ちると画面はダーク背景の titlebar と空の #root だけになり、☰ も ⚙ も
  // 反応しない。console にだけ出しても、ユーザーからは「無言で固まった」ようにしか
  // 見えず、復旧手段がアプリの終了しか無いことにも気づけない。何が起きたかと
  // 次に取れる手を画面に出す。
  function showBootFailure(message) {
    const root = document.getElementById('root');
    if (!root) return;
    root.textContent = '';
    const box = document.createElement('div');
    box.className = 'boot-error';
    // 画面の内容が入れ替わったことを支援技術にも伝える。
    box.setAttribute('role', 'alert');
    box.textContent = message;
    root.appendChild(box);
  }

  async function boot() {
    const urls = (bridge && bridge.xterm && bridge.xterm.scriptUrls) || [];
    // 解決に失敗した URL は preload が落としてくるため、2 本（xterm 本体と addon-fit）
    // 揃っていなければ先に失敗させる。空のまま app.js を読むと
    // window.FitAddon.FitAddon で TypeError になり、catch を素通りして
    // 同じ「無言の空画面」になる。
    if (urls.length < 2) throw new Error('[vk-terminals] xterm の実体を解決できませんでした');
    for (const src of urls) await loadScript(src);

    // xterm.css も必須扱いにする。欠けても画面は一見動くが、IME 用 textarea が
    // 文書フロー上（ペイン左上）に可視で置かれ、日本語入力の変換候補がそこに出る。
    // 原因の分からない表示不具合として現れるだけなので、ここで明示的に失敗させる。
    const css = bridge && bridge.xterm ? bridge.xterm.css : '';
    if (!css) throw new Error('[vk-terminals] xterm.css を読み込めませんでした');
    injectXtermCss(css);

    await loadScript('app.js');
  }

  boot().catch((e) => {
    console.error('[vk-terminals] renderer の初期化に失敗しました', e);
    // 最初に試すべき手（再起動）を条件節に埋めず独立した 1 文にする。条件節に入れると
    // 拾い読みで「インストールし直す」だけが目に入り、重い手段から始めさせてしまう。
    showBootFailure('ターミナルの初期化に失敗しました。アプリを再起動してください。それでも直らない場合は、インストールし直してください。');
  });
})();
