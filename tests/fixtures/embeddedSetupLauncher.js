'use strict';
// e2e 用の起動ファイル（issue #456）。組み込み側（VK Orchestrator のアプリ）の代わりに embedded.js を呼び、
// セットアップ状況の一覧を出す部品（getSetupStatus / setupPane）を渡して起動する。
//
// 環境変数:
//   VK_TEST_SETUP_STATUS_FILE  doctor の結果の代わりに読む JSON ファイル。呼ばれるたびに読み直すので、
//                              テストの途中で書き換えて状態を変えられる。
//                              { "__throw": "message" } なら例外、{ "__hang": true } なら終わらない（abort で止まる）。
//   VK_TEST_SETUP_CWD          setupPane.cwd（実在する絶対パス）

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..', '..');

async function getSetupStatus({ signal } = {}) {
  const file = process.env.VK_TEST_SETUP_STATUS_FILE;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (data.__throw) throw new Error(String(data.__throw));
  if (data.__hang) {
    await new Promise((resolve, reject) => {
      if (signal) signal.addEventListener('abort', () => reject(new Error('aborted')));
    });
  }
  return data;
}

require(path.join(repoRoot, 'embedded')).start({
  appTitle: 'VK Orchestrator',
  resourceRoot: repoRoot,
  selfUpdate: false,
  singleInstance: false,
  getSetupStatus,
  setupPane: { cwd: process.env.VK_TEST_SETUP_CWD, prompt: '/vk-orchestrator-setup' },
});
