'use strict';

// 起動時の最初のペインで使う AI エンジン・モデルを config から決める純粋関数。
// 許可リストの検証は renderer/claudeModel.js に一本化してあり、ここでは重複させない。
// 設定が無い・不正な場合は従来どおり Claude Code（エンジン・モデルとも未指定）に倒す。
const { isValidEngine, isValidModelForEngine } = require('../renderer/claudeModel');

/**
 * config.json の initialEngine / initialCodexModel から、最初のペインの起動指定を返す。
 *
 * @param {object} config - loadUserConfig() が返す設定オブジェクト。
 * @returns {{ engine: 'claude'|'codex', model: string }} model は Codex のときだけ値が入る。未指定は空文字。
 */
function resolveInitialPaneLaunch(config) {
  const source = config && typeof config === 'object' ? config : {};

  // エンジンは許可リストで検証し、不正値・未指定は 'claude' へ倒す。
  const rawEngine = typeof source.initialEngine === 'string' ? source.initialEngine.trim() : '';
  const engine = isValidEngine(rawEngine) ? rawEngine : 'claude';

  // Codex のモデルは Codex 用の許可リストで検証する。Claude 選択時は無視する。
  const rawModel = typeof source.initialCodexModel === 'string' ? source.initialCodexModel.trim() : '';
  const model = engine === 'codex' && isValidModelForEngine('codex', rawModel) ? rawModel : '';

  return { engine, model };
}

module.exports = { resolveInitialPaneLaunch };
