'use strict';

// 設定モーダルの「生成開始から閉じるまで 1 つだけ開ける」ロックの寿命管理。
//
// DOM の有無だけでは、設定データの取得を待っていてまだ要素が無い間の二重生成を防げない。
// 一方、描画途中の例外でロックが残ると、アプリを再起動するまで設定を開けなくなる。
// そこで、取得・明示解放・例外時解放の判断だけをここへ切り出してテストで押さえる。
//
// acquire が返す release は、その取得にだけ対応する。閉じたモーダルの遅延処理が release
// を再実行しても、後から開いた別のモーダルのロックを巻き戻さない。
//
// Node（require）とブラウザ（<script>）の両方から使える UMD 形式（issue #268）。
// renderer は nodeIntegration 無効のため require が無く、index.html が <script> で読む。
// ※ 差分を追いやすいよう、factory の中身は元のインデントのままにしている。
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.VKSettingsModalGuard = api;
  }
})(typeof self !== 'undefined' ? self : this, function () {

function createSingleOpenGuard() {
  let activeRelease = null;

  return {
    // 取得できたときは専用の解放関数、すでに開いているときは null を返す。
    acquire() {
      if (activeRelease) return null;
      const release = () => {
        if (activeRelease !== release) return false;
        activeRelease = null;
        return true;
      };
      activeRelease = release;
      return release;
    },
    // ロックを取得して生成処理を実行する。正常終了後は、生成したモーダルが閉じるまで
    // release を呼ばずに維持する。例外時だけ、その時点までに登録された後片付けを実行し、
    // 原因の例外は呼び出し側へそのまま伝える。
    async protect(task) {
      const release = this.acquire();
      if (!release) return false;
      let failureCleanup = release;
      try {
        await task({
          release,
          // 描画の進行に応じ、例外時に使える最も完全な後片付けへ差し替える。
          setFailureCleanup(cleanup) {
            if (typeof cleanup !== 'function') {
              throw new TypeError('failure cleanup must be a function');
            }
            failureCleanup = cleanup;
          },
        });
      } catch (error) {
        let cleanupError = null;
        try {
          failureCleanup();
        } catch (caughtError) {
          cleanupError = caughtError;
        } finally {
          // 後片付け側が途中で失敗しても、設定を開き直せる状態だけは必ず取り戻す。
          release();
        }
        if (cleanupError) {
          try {
            console.error('設定パネルの例外時の後片付けに失敗しました', cleanupError);
          } catch {
            // エラー記録の失敗で、呼び出し側へ伝える元の例外を置き換えない。
          }
        }
        throw error;
      }
      return true;
    },
  };
}

return { createSingleOpenGuard };
});
