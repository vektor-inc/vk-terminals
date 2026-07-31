'use strict';

// モーダル（設定パネル・ペインを閉じる確認ダイアログ）が開いている間、キーボード操作を
// その中へ閉じ込める（issue #282）。
//
// 各モーダルが自前で Tab を捕まえると、重なったときに背後のモーダルまで反応してしまう。
// ここでは capture フェーズのリスナーを 1 本だけ置き、最後に登録されたトラップだけへ
// Tab を渡す。escapeLayer.js と同じ「後から登録されたものが視覚的にも最前面」という
// 重なり順を前提とし、トラップがある間の Tab は背後の要素へ到達させない。
//
// 背後の無効化には inert を使う。overlay は document.body 直下に置かれるため、body 直下の
// 「最前面のモーダル以外」の子要素へ付ける。トラップが増減するたびに一度すべて元へ戻して
// から引き直すので、モーダルが 2 枚重なった状態で最前面だけを閉じても、下のモーダルが
// inert のまま取り残される（＝閉じたのに操作できない）事故が起きない。
//
// 解除関数は escapeLayer.js と同じく「閉じる処理の最初の方で呼ぶ」前提。inert が残ったまま
// では復帰先へ focus() しても空振りするため、フォーカスを戻すより前に必ず呼ぶこと。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKFocusTrap = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

// Tab で止まりうる要素の「種類」だけを絞り込むセレクタ。実際に止まれるかどうか
// （disabled / 非表示 / tabindex="-1"）は isTabbable で判定する。
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'area[href]',
  'button',
  'input',
  'select',
  'textarea',
  'iframe',
  'audio[controls]',
  'video[controls]',
  '[contenteditable]',
  '[tabindex]',
].join(',');

function isTabbable(element) {
  if (!element) return false;
  if (element.disabled === true) return false;
  if (element.inert === true) return false;
  // tabindex="-1" は「プログラムからは当てられるが Tab では止まらない」。設定パネルの
  // 非アクティブなタブボタンがこれに当たる（矢印キーで移動する tablist のため）。
  const tabIndexAttr = typeof element.getAttribute === 'function'
    ? element.getAttribute('tabindex')
    : null;
  if (tabIndexAttr !== null && Number(tabIndexAttr) < 0) return false;
  // hidden 属性・display:none（非表示のタブパネル、隠した保存ボタン）はここで落とす。
  // offsetParent ではなく矩形の有無を見るのは、position:fixed の要素でも正しく判定するため。
  if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) {
    return false;
  }
  return true;
}

function collectTabbable(container) {
  if (!container || typeof container.querySelectorAll !== 'function') return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(isTabbable);
}

function createFocusTrapStack(documentRef) {
  if (!documentRef
    || typeof documentRef.addEventListener !== 'function'
    || typeof documentRef.removeEventListener !== 'function') {
    throw new TypeError('documentRef must support addEventListener and removeEventListener');
  }

  const traps = [];
  // inert を付けた要素と、付ける前の値。付け外しは必ずこの記録経由で行い、
  // 「どのトラップが付けたか」を追わなくても元の状態へ戻せるようにする。
  const inertBackup = new Map();
  let listening = false;

  const topTrap = () => (traps.length > 0 ? traps[traps.length - 1] : null);

  // 最前面のモーダルだけを操作できる状態にする。差分ではなく毎回「全部戻す → 引き直す」
  // にしてあるのは、トラップが解除された順序に関わらず結果が同じになるようにするため。
  const applyInert = () => {
    for (const [element, original] of inertBackup) {
      element.inert = original;
    }
    inertBackup.clear();

    const trap = topTrap();
    if (!trap) return;
    const body = documentRef.body;
    if (!body || !body.children) return;
    for (const child of Array.from(body.children)) {
      // 最前面のモーダル自身と、その祖先は対象外。祖先へ付けると中まで無効になる。
      if (child === trap.container) continue;
      if (typeof child.contains === 'function' && child.contains(trap.container)) continue;
      inertBackup.set(child, child.inert);
      child.inert = true;
    }
  };

  const onKeyDown = (event) => {
    if (event.key !== 'Tab') return;
    const trap = topTrap();
    if (!trap) return;

    const tabbables = collectTabbable(trap.container);
    if (tabbables.length === 0) {
      // 止まれる要素が 1 つも無いモーダルでは、外へ出さないことだけを担保する。
      event.preventDefault();
      return;
    }

    const first = tabbables[0];
    const last = tabbables[tabbables.length - 1];
    const active = documentRef.activeElement;
    const inside = !!active
      && typeof trap.container.contains === 'function'
      && trap.container.contains(active);

    if (!inside) {
      // 背後は inert なので通常は起きないが、何らかの理由でフォーカスが外に出ていても
      // 次の Tab で必ず中へ戻す（Shift+Tab なら末尾へ）。
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
      return;
    }
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return {
    // container の中へフォーカスを閉じ込め、解除関数を返す。戻り値の関数はモーダルの
    // cleanup / close の最初の方で呼ぶ（背後の inert を外してからでないと、復帰先への
    // focus() が空振りする）。
    //
    // options.initialFocus に要素を渡すと、そこへ初期フォーカスを入れる（確認ダイアログの
    // 「キャンセル」のように、先頭ではなく安全側の選択肢を既定にしたい場合に使う）。
    // 省略時は先頭の操作対象へ入れる。
    activate(container, options = {}) {
      if (!container || typeof container.querySelectorAll !== 'function') {
        throw new TypeError('container must be an element');
      }

      const trap = { container };
      traps.push(trap);
      if (!listening) {
        documentRef.addEventListener('keydown', onKeyDown, true);
        listening = true;
      }
      // 初期フォーカスより先に inert を引く。背後にフォーカスが残ったままだと、
      // inert を付けた時点でブラウザがそれを外し、行き先が body へ落ちてしまう。
      applyInert();

      const requested = options.initialFocus;
      const initial = requested && isTabbable(requested) ? requested : collectTabbable(container)[0];
      if (initial && typeof initial.focus === 'function') initial.focus();

      let active = true;
      return () => {
        if (!active) return false;
        active = false;

        const index = traps.indexOf(trap);
        if (index !== -1) traps.splice(index, 1);
        // 残ったトラップ（重なっていた下のモーダル）へ引き直す。無ければ全解除。
        applyInert();
        if (traps.length === 0 && listening) {
          documentRef.removeEventListener('keydown', onKeyDown, true);
          listening = false;
        }
        return true;
      };
    },
  };
}

return { createFocusTrapStack };
});
