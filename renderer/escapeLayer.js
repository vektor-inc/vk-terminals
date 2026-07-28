'use strict';

// モーダルや確認ダイアログなど、画面上に重なる UI の Escape 操作を管理する。
//
// 各 UI が document に個別の keydown リスナーを置くと、同じキー操作で背後の UI まで
// 動いてしまう。ここでは capture フェーズのリスナーを 1 本だけ置き、最後に登録された
// レイヤーだけへ Escape を渡す。「後から登録されたレイヤーは視覚的にも最前面にある」
// という重なり順を前提とする。レイヤーがある間の Escape はその場で消費し、document
// 上の既存リスナーやフォーカス中の要素には到達させない。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKEscapeLayer = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

function createEscapeLayerStack(eventTarget) {
  if (!eventTarget
    || typeof eventTarget.addEventListener !== 'function'
    || typeof eventTarget.removeEventListener !== 'function') {
    throw new TypeError('eventTarget must support addEventListener and removeEventListener');
  }

  const layers = [];
  let listening = false;

  const onKeyDown = (event) => {
    if (event.key !== 'Escape' || layers.length === 0) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    // IME 変換中の Escape は変換の取り消し。モーダルは閉じないが、背後へも通さない。
    if (event.isComposing) return;
    // コールバック内で自分自身を解除しても、次のレイヤーを同じキー操作で呼ばないよう、
    // 発火時点の最前面だけを取得して 1 回だけ実行する。
    const topLayer = layers[layers.length - 1];
    topLayer.onEscape(event);
  };

  return {
    // 戻り値の関数を UI の cleanup / close から呼び、レイヤーの寿命と DOM の寿命を揃える。
    // onEscape が例外で抜けるとレイヤーが残り続けるため、閉じる処理は最初に戻り値の
    // 解除関数を呼び、後続処理の成否にかかわらず Escape を再び受け取れる状態にする。
    register(onEscape) {
      if (typeof onEscape !== 'function') {
        throw new TypeError('onEscape must be a function');
      }

      const layer = { onEscape };
      layers.push(layer);
      if (!listening) {
        eventTarget.addEventListener('keydown', onKeyDown, true);
        listening = true;
      }

      let active = true;
      return () => {
        if (!active) return false;
        active = false;

        const index = layers.indexOf(layer);
        if (index !== -1) layers.splice(index, 1);
        if (layers.length === 0 && listening) {
          eventTarget.removeEventListener('keydown', onKeyDown, true);
          listening = false;
        }
        return true;
      };
    },
  };
}

return { createEscapeLayerStack };
});
