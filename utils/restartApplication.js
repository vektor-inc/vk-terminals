'use strict';

// 更新後と設定パネルからの再起動で、安全な終了順序を共用する。
function createRestartApplication({ gate, cleanupPtys, app, log }) {
  return async function restartApplication() {
    // idle 以外なら先行する終了処理に任せ、再起動はしない。
    if (gate.state !== 'idle') return false;
    // before-quit を通らない経路でも、新しいペインの作成を拒否する（LOW-C）。
    gate.markShuttingDown();
    try {
      // 終了通知を待たないと Node 環境破棄と競合し SIGABRT になる（#409）。
      await cleanupPtys();
    } finally {
      // 例外でも pending のまま操作不能にせず、必ず終了まで進める。
      try {
        app.relaunch();
      } catch (error) {
        // relaunch の失敗で exit を飛ばすと、終了ゲートだけが閉じたアプリが残る。
        log.error('app.relaunch() failed', error);
      }
      app.exit(0);
    }
    return true;
  };
}

module.exports = { createRestartApplication };
