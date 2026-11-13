'use strict';
// e2e 用の起動ファイル（issue #613）。tmux 保持役を使う組み込み起動を再現し、
// 終了時に保存したペインの並び（panes.json）と、再起動後の復元を確かめる。
//
// 環境変数:
//   VK_TERMINALS_HOLDER_RUN_DIR  保持役のソケットと panes.json を置くフォルダ（paneHolder.js が読む）

const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

require(path.join(repoRoot, 'embedded')).start({
  resourceRoot: repoRoot,
  selfUpdate: false,
  singleInstance: false,
  paneHolder: 'tmux',
  paneHolderFallback: 'error',
});
