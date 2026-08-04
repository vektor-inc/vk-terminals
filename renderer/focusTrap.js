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
// ※ inert を引き直すのはトラップの増減時だけなので、**トラップ中に document.body 直下へ
//    追加された要素は inert にならない**。現状これに当たるのはペイン D&D のドロップ位置
//    表示（#pane-drop-indicator）だけで、pointer-events: none かつフォーカスできないため
//    実害は無い。将来ここへ操作できる要素を足す場合は、この経路が抜け道になる
//    （Tab はキー操作側のトラップが拾うので循環からは漏れないが、inert は当たらない）。
//
// 例外: `data-vk-inert-exempt` 属性を持つ body 直下の子要素は、モーダルより後ろへ
// 無効化しない（issue #326）。汎用トースト（renderer/app.js の .vk-toast-layer）が
// これに当たる。トーストは設定モーダル内の説明リンクが失敗したときにこそ見える必要が
// あり、他のモーダルより手前（z-index 2200）に置く方針のため、inert で操作不可に
// なると本末転倒になる。既存の「トラップ中に追加された要素は inert にならない」抜け道
// とは別に、**トーストは先に作られてから後でモーダルが開くケースもある**（一度でも
// 失敗すればトーストの DOM は常設され続けるため）ので、明示的な除外を設けている。
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

// focus() で当てられるか。tabindex="-1" は「Tab では止まらないが focus はできる」ので
// ここでは弾かない。モーダル本体のような着地点専用の要素を initialFocus に渡せるようにする。
//
// 既知の穴（いずれも現在の DOM に該当が無いので割り切っている）:
//   - visibility: hidden / opacity: 0 は矩形を持つため通ってしまう
//   - <summary> は selector に載せていないので拾えない
//   - contenteditable="false" は selector に載るが編集不可なので本来は停止位置ではない
//   - <fieldset disabled> 配下の子は自身の disabled が false のまま通ってしまう
//     （設定パネルは .settings-group を fieldset に使っているが disabled は付けていない）
function isFocusable(element) {
  if (!element) return false;
  if (element.disabled === true) return false;
  if (element.inert === true) return false;
  // hidden 属性・display:none（非表示のタブパネル、隠した保存ボタン）はここで落とす。
  // offsetParent ではなく矩形の有無を見るのは、position:fixed の要素でも正しく判定するため。
  if (typeof element.getClientRects === 'function' && element.getClientRects().length === 0) {
    return false;
  }
  return true;
}

function isTabbable(element) {
  if (!isFocusable(element)) return false;
  // tabindex="-1" は「プログラムからは当てられるが Tab では止まらない」。設定パネルの
  // 非アクティブなタブボタンがこれに当たる（矢印キーで移動する tablist のため）。
  const tabIndexAttr = typeof element.getAttribute === 'function'
    ? element.getAttribute('tabindex')
    : null;
  if (tabIndexAttr !== null && Number(tabIndexAttr) < 0) return false;
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
      // data-vk-inert-exempt を持つ要素は対象外（issue #326。汎用トーストなど、
      // モーダルより手前に置いてどのモーダル表示中でも操作できる必要がある要素向け）。
      if (typeof child.hasAttribute === 'function' && child.hasAttribute('data-vk-inert-exempt')) continue;
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
    if (active === trap.container) {
      // tabindex="-1" の着地点（モーダル本体）にいる状態。ここからの Shift+Tab の行き先は
      // ブラウザ既定では「背後がすべて inert のときにどこへ巻き戻るか」に委ねられるため、
      // 前後どちらへ進むかを明示して結果を固定する。
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
    // 「キャンセル」のように安全側の選択肢を既定にしたい場合や、設定パネルのように
    // tabindex="-1" のモーダル本体を着地点にしたい場合に使う）。省略時は先頭の操作対象へ入れる。
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

      let active = true;
      const release = () => {
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

      // 解除関数は inert を引く前に組み立てておく。ここから先で例外が出ると呼び出し側は
      // 解除関数を受け取れず、背後が inert のまま外す手段が無くなる（アプリの再起動以外に
      // 復帰路が無い）ため、自分で巻き戻してから例外を投げ直す。
      try {
        // 初期フォーカスより先に inert を引く。背後にフォーカスが残ったままだと、
        // inert を付けた時点でブラウザがそれを外し、行き先が body へ落ちてしまう。
        applyInert();

        const requested = options.initialFocus;
        // 判定は isTabbable ではなく isFocusable。tabindex="-1" の着地点を渡されたときに
        // 弾いて先頭の操作対象へ落としてしまうと、指定した意味が無くなる。
        const initial = requested && isFocusable(requested)
          ? requested
          : collectTabbable(container)[0];
        if (initial && typeof initial.focus === 'function') initial.focus();
      } catch (error) {
        release();
        throw error;
      }

      return release;
    },
  };
}

return { createFocusTrapStack };
});
