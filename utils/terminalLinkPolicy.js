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
// #385 のレビュー（安藤・植草）で、単クリック化が開けた穴が複数見つかっている
// （右クリック・中クリックでも開いてしまう／URL をドラッグ選択しようとすると開いてしまう）。
// activate() のガードの並びと各コメントは、その指摘を踏まえたもの。安易に順序を
// 入れ替えたり削ったりしないこと。
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
//   - getClickMode(): 呼び出しの都度モード（'click' | 'modifier'。正規化前の値でよい。
//     ここで normalizeTerminalLinkClickMode() する）を取得する関数。省略時は 'click'（既定）。
//     生成時に固定値を1回だけ渡す形（旧 clickMode 引数）にはしていない。renderer/app.js
//     側にはツールチップ文言（termLinkTooltipMessage）が実行時に読む生きたグローバル変数
//     terminalLinkClickModePref があり、固定値を別途渡すとモード参照経路が2本に分かれ、
//     将来設定のライブリロードを入れた瞬間に「表示は単クリック、実際の判定は修飾キー必須」
//     のような食い違いが起きうる（レビュー指摘・LOW-2）。関数で毎回取りに行くことで
//     参照経路を1本化する。
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
//     （renderer/app.js の paneFocusBeforeMousedown / recordPaneFocusBeforeMousedown 参照）。
//     グリッド（.pane）だけでなく格納ペイン（.stash-item）の mousedown からも同じ記録
//     ヘルパーを呼ぶこと（レビュー指摘・MEDIUM-1。ヘルパーを分けて片方でしか呼ばないと、
//     もう片方の経路でガードが機能しない・もしくは逆に常に開かなくなる）。
//
//     wasPaneFocused() が false を返した場合、activate() は preventDefault() を呼ばずに
//     openUrl の呼び出しだけをスキップする（xterm 本来のフォーカス移譲・カーソル配置を
//     妨げないため）。deps 省略時は false 相当（fail-closed）として扱う（レビュー指摘・
//     MEDIUM-2）。wasPaneFocused はこの issue #385 で新設した依存であり、世の中に既に
//     出回っている「渡し忘れたら true 扱いになる旧挙動」は存在しないため、渡し忘れを
//     安全側（開く）へ倒す理由が無い。渡し忘れ・接続ミスは黙って「開かない」側に倒し、
//     気づきやすくする。
//   - wasDragged(): このクリックがドラッグ選択だったかどうかを呼び出し側が判定して
//     返す関数（issue #385 レビュー指摘・HIGH-2）。
//
//     xterm.js の Linkifier の activate 発火条件は「mousedown 時点のリンクと mouseup
//     時点のリンクが一致し、かつ mouseup 位置がその範囲内」であることだけで、選択の
//     有無やポインタの移動量は一切見ない。これは「別々のリンクをまたぐドラッグ」だけで
//     なく「同一リンクの中をなぞって選択する（＝ URL をコピーしようとする）」操作も
//     満たしてしまう。つまり URL をコピーしようとドラッグしただけでブラウザが開く
//     （#349 で植草が避けたかった誤爆そのもの。以前このファイル・renderer/app.js に
//     あった「単クリックにしてもドラッグ選択とは元々衝突しない」という趣旨のコメントは、
//     この「同一リンク内のドラッグ」を見落とした誤った安全性の主張だったため削除した）。
//     xterm.js 本体はこの区別をしないため、呼び出し側（renderer/app.js）で mousedown から
//     mouseup までの移動量を計測し、判定結果をここへ渡してもらう。deps 省略時は false
//     相当（＝ドラッグ扱いしない）として扱う。
function createTerminalLinkHandlers(deps) {
  const { openUrl, showTooltip, hideTooltip, isMac, getClickMode, wasPaneFocused, wasDragged } = deps || {};
  return {
    activate(event, url) {
      // 主ボタン（左クリック）以外では開かない（issue #385 レビュー指摘・HIGH-1）。
      // xterm.js の Linkifier は event.button を見ずに mouseup で activate を呼ぶため、
      // 右クリック・中クリック（Linux のプライマリ選択貼り付け操作を含む）でも無条件に
      // 呼ばれてしまう。'modifier' モードでは metaKey/ctrlKey 判定が偶然フィルタとして
      // 働いていたが、既定の 'click' モードにはそのフィルタが無いため、ここで明示的に弾く。
      if (event && typeof event.button === 'number' && event.button !== 0) return;

      // ドラッグ選択では開かない（issue #385 レビュー指摘・HIGH-2。詳細は上の
      // wasDragged() の説明を参照）。
      if (typeof wasDragged === 'function' && wasDragged()) return;

      // フォーカス移動だけに使う最初のクリックでは開かない（issue #385）。
      const focused = typeof wasPaneFocused === 'function' ? wasPaneFocused() : false;
      if (!focused) return;

      // 'modifier' モードでは従来どおり修飾キー必須（このガードだけは仕様を変えない）。
      const mode = normalizeTerminalLinkClickMode(typeof getClickMode === 'function' ? getClickMode() : undefined);
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
