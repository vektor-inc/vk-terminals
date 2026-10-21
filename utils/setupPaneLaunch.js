'use strict';

// セットアップ用ペインで実行する起動コマンド（issue #456）。
// claude '<prompt>' を作る経路はここ 1 本だけで、検証を通ったプロンプト（/^\/[a-z0-9-]+$/）以外は
// 例外にする。renderer からはプロンプトも作業フォルダも受け取らない（main が保持する setupPane を使う）。

const { isSetupPrompt } = require('./runtimeOptions');

/**
 * @param {string} prompt setupPane.prompt（組み込みオプションの検証済みの値）
 * @returns {string} 例: claude '/vk-orchestrator-setup'
 */
function buildSetupPaneLaunchCommand(prompt) {
  if (!isSetupPrompt(prompt)) throw new Error('invalid setup pane prompt');
  return `claude '${prompt}'`;
}

module.exports = { buildSetupPaneLaunchCommand };
