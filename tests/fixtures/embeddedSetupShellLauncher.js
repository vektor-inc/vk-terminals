'use strict';
// e2e 用の起動ファイル（issue #649）。初回に素のシェルだけを開く組み込み起動（setupShell）を再現し、
// ウィンドウを閉じて作り直したときに、新しいシェルを作らず同じペインへつなぎ直すことを確かめる。

const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

require(path.join(repoRoot, 'embedded')).start({
  resourceRoot: repoRoot,
  selfUpdate: false,
  singleInstance: false,
  setupShell: { command: 'echo setup' },
});
