'use strict';

// 起動時に通常の初期ペインを作る場合だけ、初回コマンドの対象にする。
function isInitialCommandTarget({ initialPane, firstTerminalCreated, setupLaunch, guideLaunch }) {
  return initialPane === true && !firstTerminalCreated && !setupLaunch && !guideLaunch;
}

module.exports = { isInitialCommandTarget };
