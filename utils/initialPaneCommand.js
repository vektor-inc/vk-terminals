'use strict';

// 起動時に通常の初期ペインを作る場合だけ、初回コマンドの対象にする。
// セットアップ用ペイン・セットアップ専用シェル・使い方ガイドのペインは対象外。
function isInitialCommandTarget({ initialPane, firstTerminalCreated, setupLaunch, setupShellLaunch, guideLaunch }) {
  return initialPane === true && !firstTerminalCreated && !setupLaunch && !setupShellLaunch && !guideLaunch;
}

module.exports = { isInitialCommandTarget };
