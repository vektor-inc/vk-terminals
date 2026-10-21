'use strict';

// 同じアプリ（または zip 版の VK Orchestrator）がすでに動いているときの検知と案内文。
// 二重起動のロックは userData ごとに効くため zip 版（別アプリ）とは衝突しない。
// そのため API サーバーのポートが埋まっているかも調べる（どちらの版も同じ既定ポートを使う）。

const net = require('net');

const ALREADY_RUNNING_MESSAGE = 'すでに起動しています。終了してから開いてください。';

/**
 * 指定のポート・ホストを別プロセスが使っているか。
 * 実際に listen を試し、EADDRINUSE のときだけ true を返す（それ以外のエラーは判定不能として false。
 * 起動を止めるのは確実に埋まっているときだけにする）。
 * @param {number} port
 * @param {string} host
 * @param {{ createServer?: Function }} [deps]
 * @returns {Promise<boolean>}
 */
function isPortInUse(port, host, deps = {}) {
  const createServer = deps.createServer || net.createServer;
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once('error', (e) => {
      resolve(!!e && e.code === 'EADDRINUSE');
    });
    probe.once('listening', () => {
      probe.close(() => resolve(false));
    });
    probe.listen(port, host);
  });
}

/**
 * 二重起動の案内ダイアログの文言。
 * @param {{ appTitle: string, reason: 'lock'|'port', port?: number }} params
 * @returns {{ title: string, message: string, detail: string }}
 */
function buildAlreadyRunningNotice({ appTitle, reason, port }) {
  const detail = reason === 'port'
    ? `API のポート ${port} を、すでに起動している別の ${appTitle}（zip 版など）が使っています。`
    : `${appTitle} はすでに起動しています。`;
  return { title: appTitle, message: ALREADY_RUNNING_MESSAGE, detail };
}

module.exports = {
  ALREADY_RUNNING_MESSAGE,
  isPortInUse,
  buildAlreadyRunningNotice,
};
