'use strict';

// ─── アプリ終了時の pty 待ち合わせ状態機械（issue #409 レビュー対応・MEDIUM-2）────────
// before-quit の「今回のイベントをどう扱うべきか」の判断と、その待ち合わせ中に新しく
// ペインを作らせない判断を main.js から切り出したもの。main.js は Electron の app / ipcMain
// に依存していてそのまま単体テストしにくいため、状態遷移そのものはここへ集約し、
// tests/ptyShutdownGate.test.js で Electron 抜きに検証できるようにしている。
//
// 状態は 3 つ:
//   'idle'    … まだ終了処理を始めていない（通常時。ペイン作成も許可する）
//   'pending' … 生きている pty の終了を待っている最中（cleanupPtys() 実行中）
//   'done'    … 後始末済み。以降の before-quit は素通りさせる
//
// 'pending' の間に新しい pty が作られると、その pty は cleanupPtys() が待つ対象に
// 含まれないまま終了処理に巻き込まれ、#409 と同じ競合になりうる（MEDIUM-2）。
// 「cleanupPtys() が終わったあとに ptys.size > 0 ならもう一度待つ」という形も検討したが、
// 上限（graceMs / forceMs）を超えて待ちきれず諦めた pty は onExit を出さないまま Map に
// 残り続けるため、その形だと待ち直しが完了しなくなる。そのため 'pending'（および 'done'）
// の間はペイン作成そのものを拒否する方針にしている。

/**
 * pty 終了待ち合わせの状態機械を作る。
 * @returns {{
 *   state: 'idle'|'pending'|'done',
 *   beginBeforeQuit: (hasPendingPtys: boolean) => 'skip'|'finalize'|'wait'|'start',
 *   finish: () => void,
 *   isPaneCreationBlocked: () => boolean,
 *   markShuttingDown: () => void,
 * }}
 */
function createPtyShutdownGate() {
  let state = 'idle';

  return {
    /** 現在の状態を返す（テスト・デバッグ用）。 */
    get state() {
      return state;
    },

    /**
     * before-quit ハンドラの冒頭で呼ぶ。今回のイベントをどう扱うべきかを返す。
     * @param {boolean} hasPendingPtys 待つべき pty（ptys / exitingPtys 双方）が
     *   1件でも残っているか。
     * @returns {'skip'|'finalize'|'wait'|'start'}
     *   'skip'     … 既に後始末済み。何もしなくてよい（preventDefault も不要）。
     *   'finalize' … 待つべき pty が無かった。すぐ後始末（finalizeBeforeQuit 相当）を
     *                行ってよい（preventDefault も不要。呼び出し元がそのまま
     *                終了処理を継続する）。
     *   'wait'     … 既に別の before-quit で待ち合わせ中。preventDefault だけして
     *                何もしない（cleanupPtys() の二重起動を防ぐ）。
     *   'start'    … これから待ち合わせを始める。preventDefault したうえで、
     *                呼び出し元が pty の終了待ち処理を開始する。
     */
    beginBeforeQuit(hasPendingPtys) {
      if (state === 'done') return 'skip';
      if (state === 'pending') return 'wait';
      if (!hasPendingPtys) {
        state = 'done';
        return 'finalize';
      }
      state = 'pending';
      return 'start';
    },

    /** 待ち合わせ完了時に呼ぶ。以降の before-quit・ペイン作成判定は 'done' 扱いになる。 */
    finish() {
      state = 'done';
    },

    /**
     * ペイン作成（IPC の terminal:create、HTTP の POST /api/new-pane）を
     * 拒否すべきかどうか。'idle' 以外（'pending'・'done'）では拒否する。
     * @returns {boolean}
     */
    isPaneCreationBlocked() {
      return state !== 'idle';
    },

    /**
     * before-quit を経由しない終了経路（アップデート検知後の再起動。
     * main.js の checkAndUpdate() が `app.relaunch(); app.exit(0);` の前に呼ぶ）から、
     * 「pty の終了待ちを始めた」ことをゲートへ伝える（安藤の指摘・LOW-C）。
     * app.exit() は before-quit を発火させないため、beginBeforeQuit() を経由せずに
     * 直接 'pending' へ遷移させる必要がある。呼び出し後は isPaneCreationBlocked() が
     * true になり、この経路の cleanupPtys() が完了するまで新しいペイン作成を拒否する。
     *
     * 既に 'pending'（同じ経路の多重発火、または他経路が先に待ち合わせを始めていた場合）
     * や 'done' のときは何もしない（idle からのみ遷移する。二重に待ち合わせを始めない）。
     * 呼び出し後に before-quit が発火しても、beginBeforeQuit() は state が 'pending' なら
     * 'wait' を返すため、cleanupPtys() を二重に起動することはない（この経路の
     * cleanupPtys() 完了後は app.exit(0) がプロセスを直接終了させるため、before-quit 側
     * からの追加の後始末は不要。状態を 'done' へ戻す処理もここでは行わない）。
     */
    markShuttingDown() {
      if (state === 'idle') {
        state = 'pending';
      }
    },
  };
}

module.exports = { createPtyShutdownGate };
