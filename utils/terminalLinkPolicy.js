'use strict';

// ─── ペイン内 URL を開く際の判定ポリシー（issue #349 → #385）─────────────────
// 元々は単クリックでは開かず、Cmd（macOS）/ Ctrl（Windows・Linux）+クリックのときだけ
// 開く仕様だった（issue #349・植草の確定仕様）。renderer/app.js の非エクスポート関数の
// ままだとユニットテストできず、将来のリファクタで壊れても気づけない状態だったため
// utils/closeConfirm.js と同じ理由で utils/ の UMD へ切り出した（安藤レビュー指摘・MEDIUM）。
//
// issue #385（オーナー本人の要望）で「修飾キー無しの単クリックで開く」へ仕様変更した。
// ただし従来挙動へ戻す設定（config.json の terminalLinkClickMode）も用意するため、
// 判定ロジックはモード分岐を持つ。config.json 側の正規化は normalizeTerminalLinkClickMode。
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

// ─── terminalLinkClickMode（issue #385）────────────────────────────────────────
// config.json の terminalLinkClickMode で「単クリックで開く（既定）」/「従来どおり
// 修飾キー必須」を切り替える。未知の値・未設定は必ず 'click'（既定）に正規化する
// （utils/closeConfirm.js の normalizeConfirmClose と同じ形）。
const TERMINAL_LINK_CLICK_MODES = ['click', 'modifier'];
const DEFAULT_TERMINAL_LINK_CLICK_MODE = 'click';

function normalizeTerminalLinkClickMode(value) {
  return TERMINAL_LINK_CLICK_MODES.includes(value) ? value : DEFAULT_TERMINAL_LINK_CLICK_MODE;
}

// term.registerLinkProvider() に渡すハンドラ一式を作る。
// 見た目（ホバー時の下線・pointer カーソル）は xterm.js 本体が自動で付けるため、ここでは
// 「クリックで開くべきかどうかの判定」と「ツールチップ表示への橋渡し」だけを扱う。
// 実際に URL を開く処理・ツールチップの DOM 操作そのものは呼び出し側（renderer/app.js）の
// 責務のまま、依存として注入してもらう（新しい経路を増やさない・DOM に依存しない形で
// このファイル単体をテストできるようにするため）。
//
// deps:
//   - openUrl(url): クリックが確定したときに呼ぶ（renderer/app.js の openExternalUrlSafe
//     を渡す想定。新しい「開く経路」は増やさない・issue #385）。
//   - showTooltip(event, url) / hideTooltip(event, url): ホバー時・ホバー解除時のツールチップ制御。
//   - isMac: テストで明示指定するための上書き（省略時は isMacPlatform()）。
//   - clickMode: normalizeTerminalLinkClickMode() 済みの値（'click' | 'modifier'）。
//     省略時は 'click'（既定）として扱う。
//   - wasPaneFocused(): このクリックがフォーカスされていないペインへの最初のクリック
//     だったかどうかを呼び出し側が判定して返す関数（issue #385）。
//
//     【重要・呼び出し側が守るべき契約】xterm.js の Linkifier は mousedown 時点の
//     リンクと mouseup 時点のリンクが一致したときだけこの activate を呼ぶ（つまり
//     activate は実質「mouseup 時点」で発火する）。一方 renderer/app.js の focusPane()
//     は mousedown 契機でフォーカス状態を書き換える。そのため activate 発火時点の
//     「現在のフォーカス状態」を素直に読むと、同じクリックの mousedown で既にフォーカスが
//     切り替わった後の値になってしまい、「フォーカス未取得ペインへの最初のクリックか」を
//     判定できない。呼び出し側は、focusPane() を呼ぶ“前”の mousedown ハンドラで
//     「切り替わる直前の状態」を記録しておき、wasPaneFocused() はその記録値を返すこと
//     （renderer/app.js の paneFocusBeforeMousedown 参照）。
//
//     wasPaneFocused() が false を返した場合、activate() は preventDefault() を呼ばずに
//     openUrl の呼び出しだけをスキップする（xterm 本来のフォーカス移譲・カーソル配置を
//     妨げないため）。deps 省略時（テスト等）は true 相当として扱う。
function createTerminalLinkHandlers(deps) {
  const { openUrl, showTooltip, hideTooltip, isMac, clickMode, wasPaneFocused } = deps || {};
  return {
    activate(event, url) {
      // フォーカス移動だけに使う最初のクリックでは開かない（issue #385）。
      const focused = typeof wasPaneFocused === 'function' ? wasPaneFocused() : true;
      if (!focused) return;

      // 'modifier' モードでは従来どおり修飾キー必須（このガードだけは仕様を変えない）。
      const mode = normalizeTerminalLinkClickMode(clickMode);
      if (mode === 'modifier' && !isLinkOpenModifierPressed(event, isMac)) return;

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
  TERMINAL_LINK_CLICK_MODES,
  DEFAULT_TERMINAL_LINK_CLICK_MODE,
  normalizeTerminalLinkClickMode,
  createTerminalLinkHandlers,
};
});
