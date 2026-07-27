'use strict';

// 設定モーダルの「保存成功 → 一定時間後に自動で閉じる」タイマーの寿命管理。
//
// このタイマーは、閉じたモーダルのクロージャに残ったまま発火すると、「今開いている
// モーダル」ではなく前回のモーダルを対象に後始末を走らせ、二重オープンの抑止フラグを
// 巻き戻してしまう（設定パネルが 2 枚重なる）。取り消し漏れが起きやすい割に症状が
// 分かりにくいので、寿命の判断だけをここへ切り出してユニットテストで押さえる。
//
// 守る性質は 3 つ。実運用ではどれか 1 つが外れても他が症状を止めるよう重ねてあるが、
// 重ねてあるがゆえに DOM 越しの結合テストでは「1 つだけ外れた」状態を検知できない。
// そのため、ここで 1 つずつ独立に検証できる形にしている。
//
//  1. 閉じたあとは二度と武装しない（arm が closed を見る）
//  2. 閉じるときにタイマーを取り消す（markClosed が cancel する）
//  3. 閉じる処理は冪等（markClosed が 2 回目以降 false を返す）
function createAutoCloseController(options = {}) {
  const delayMs = Number.isFinite(options.delayMs) ? options.delayMs : 2500;
  const schedule = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout;
  const unschedule = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout;
  const onFire = typeof options.onFire === 'function' ? options.onFire : () => {};

  let timer = null;
  let closed = false;

  const cancel = () => {
    if (timer === null) return;
    unschedule(timer);
    timer = null;
  };

  return {
    // 保存成功時に呼ぶ。保存を連打されてもタイマーが積み残らないよう、張り直す前に
    // 必ず取り消す。閉じたあとの呼び出しは弾く（武装しなかったときは false を返す）。
    arm() {
      if (closed) return false;
      cancel();
      timer = schedule(onFire, delayMs);
      return true;
    },
    cancel,
    // 閉じる直前に呼ぶ。実際に閉じる処理を行うべきときだけ true を返すので、
    // 呼び出し側は戻り値で早期 return すれば close 処理が冪等になる。
    markClosed() {
      cancel();
      if (closed) return false;
      closed = true;
      return true;
    },
    get isClosed() { return closed; },
    get isArmed() { return timer !== null; },
  };
}

module.exports = { createAutoCloseController };
