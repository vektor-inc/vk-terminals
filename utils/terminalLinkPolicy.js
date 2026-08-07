'use strict';

// ─── ペイン内 URL を開く際の「修飾キー判定」ポリシー（issue #349）─────────────────
// 単クリックでは開かず、Cmd（macOS）/ Ctrl（Windows・Linux）+クリックのときだけ開く、
// という判定はこの機能で最もセキュリティに効く分岐（誤クリック・悪意あるログ内の
// 見た目誘導だけでは外部 URL を起動させない最後の砦）。renderer/app.js の
// 非エクスポート関数のままだとユニットテストできず、将来のリファクタで壊れても
// 気づけない状態だったため utils/closeConfirm.js と同じ理由で utils/ の UMD へ切り出す
// （安藤レビュー指摘・MEDIUM）。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKTerminalLinkPolicy = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

// macOS かどうかの判定。navigator.platform は非推奨だが、Electron が同梱する Chromium
// では引き続き利用でき、contextIsolation の影響を受けない標準 Web API のため preload
// 経由の橋渡しは不要。node --test など navigator が無い環境やテストでは
// platformOverride を明示的に渡す。
function isMacPlatform(platformOverride) {
  const platform = typeof platformOverride === 'string'
    ? platformOverride
    : ((typeof navigator !== 'undefined' && navigator.platform) || '');
  return /Mac|iPhone|iPod|iPad/i.test(platform);
}

// リンクを開く修飾キーが押されているか。macOS は Cmd（metaKey）、Windows・Linux は
// Ctrl（ctrlKey）（植草の確定仕様）。isMac 省略時は実行環境（isMacPlatform()）で判定する。
function isLinkOpenModifierPressed(event, isMac) {
  if (!event) return false;
  const mac = typeof isMac === 'boolean' ? isMac : isMacPlatform();
  return mac ? !!event.metaKey : !!event.ctrlKey;
}

// term.registerLinkProvider() に渡すハンドラ一式を作る。
// 見た目（ホバー時の下線・pointer カーソル）は xterm.js 本体が自動で付けるため、ここでは
// 「修飾キー付きクリックかどうかの判定」と「ツールチップ表示への橋渡し」だけを扱う。
// 実際に URL を開く処理・ツールチップの DOM 操作そのものは呼び出し側（renderer/app.js）の
// 責務のまま、依存として注入してもらう（新しい経路を増やさない・DOM に依存しない形で
// このファイル単体をテストできるようにするため）。
//
// deps:
//   - openUrl(url): 修飾キー付きクリックが確定したときに呼ぶ
//     （renderer/app.js の openExternalUrlSafe を渡す想定）。
//   - showTooltip(event, url) / hideTooltip(event, url): ホバー時・ホバー解除時のツールチップ制御。
//   - isMac: テストで明示指定するための上書き（省略時は isMacPlatform()）。
function createTerminalLinkHandlers(deps) {
  const { openUrl, showTooltip, hideTooltip, isMac } = deps || {};
  return {
    activate(event, url) {
      if (!isLinkOpenModifierPressed(event, isMac)) return;
      if (event && typeof event.preventDefault === 'function') event.preventDefault();
      if (typeof openUrl === 'function') openUrl(url);
    },
    hover(event, url) {
      if (typeof showTooltip === 'function') showTooltip(event, url);
    },
    leave(event, url) {
      if (typeof hideTooltip === 'function') hideTooltip(event, url);
    },
  };
}

return {
  isMacPlatform,
  isLinkOpenModifierPressed,
  createTerminalLinkHandlers,
};
});
