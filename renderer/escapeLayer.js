'use strict';

// モーダルや確認ダイアログなど、画面上に重なる UI の Escape 操作を管理する。
//
// 各 UI が document に個別の keydown リスナーを置くと、同じキー操作で背後の UI まで
// 動いてしまう。ここでは capture フェーズのリスナーを 1 本だけ置き、最後に登録された
// レイヤーだけへ Escape を渡す。レイヤーがある間の Escape はその場で消費し、document
// 上の既存リスナーやフォーカス中の要素には到達させない。
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
    // コールバック内で自分自身を解除しても、次のレイヤーを同じキー操作で呼ばないよう、
    // 発火時点の最前面だけを取得して 1 回だけ実行する。
    const topLayer = layers[layers.length - 1];
    topLayer.onEscape(event);
  };

  return {
    // 戻り値の関数を UI の cleanup / close から呼び、レイヤーの寿命と DOM の寿命を揃える。
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

module.exports = { createEscapeLayerStack };
