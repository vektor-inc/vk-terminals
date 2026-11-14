// タスク一覧の再取得ボタン（issue #617）の「取得中」状態を管理する。
// 依頼ごとに世代番号を振り、タイマーや遅れて返ってきた送信結果は、その世代が今の依頼と
// 一致するときだけ取得中を解除する（古い依頼の結果が、押し直した依頼の取得中を消さないため）。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.VKTaskRefreshState = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  /**
   * @param {{ timeoutMs: number, onChange: (busy: boolean) => void,
   *   setTimer?: Function, clearTimer?: Function, now?: () => number }} options
   */
  function createTaskRefreshState(options) {
    const timeoutMs = options.timeoutMs;
    const onChange = options.onChange || (() => {});
    const setTimer = options.setTimer || ((fn, ms) => setTimeout(fn, ms));
    const clearTimer = options.clearTimer || ((id) => clearTimeout(id));
    const now = options.now || (() => Date.now());

    let generation = 0;
    let current = null; // { generation, requestedAt, timer }

    function end() {
      if (!current) return;
      clearTimer(current.timer);
      current = null;
      onChange(false);
    }

    // 取得中でなければ新しい依頼を始め、その世代番号を返す。取得中なら null（連打を受け付けない）。
    function start() {
      if (current) return null;
      generation += 1;
      const mine = generation;
      current = { generation: mine, requestedAt: now(), timer: null };
      current.timer = setTimer(() => finish(mine), timeoutMs);
      onChange(true);
      return mine;
    }

    // 指定した世代が今の依頼のときだけ解除する。解除したら true。
    function finish(token) {
      if (!current || current.generation !== token) return false;
      end();
      return true;
    }

    // 押した時刻より新しい一覧が届いたら解除する。
    function finishIfNewer(updatedAtMs) {
      if (!current || !Number.isFinite(updatedAtMs) || updatedAtMs <= current.requestedAt) return false;
      end();
      return true;
    }

    // ボタンを出せなくなったときなど、今の依頼を無条件に解除する。
    function cancel() {
      if (!current) return false;
      end();
      return true;
    }

    return {
      start,
      finish,
      finishIfNewer,
      cancel,
      isBusy: () => !!current,
    };
  }

  return { createTaskRefreshState };
});
