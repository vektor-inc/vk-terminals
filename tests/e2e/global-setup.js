'use strict';

const { getFailedExitCode, runElectronInstall } = require('../../scripts/postinstall');

// npm の lifecycle を実行しないキャッシュ復元などでも、並列ワーカーが初回取得を
// 同時実行しないよう、Playwright の親プロセスで一度だけ本体取得を完了させる。
module.exports = function globalSetup() {
  const result = runElectronInstall();

  if (result.error) {
    throw new Error(`Electron 本体の取得処理を起動できませんでした: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Electron 本体の取得に失敗しました (exit ${getFailedExitCode(result)})`);
  }

  // install.js が成功しても意図的なダウンロード抑止などで本体が無い場合は、
  // ワーカー開始前に単一の明確なエラーとして報告する。
  require('electron');
};
