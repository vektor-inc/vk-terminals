'use strict';

// 保存済みの復元結果と、保存後に増えたペインの識別子を別々に扱う。
function missingSavedPaneCount(savedCount, matchedCount) {
  return Math.max(0, savedCount - matchedCount);
}

function chooseUntrackedPaneIdentity(termId, usedTermIds, usedPaneIds, nextId) {
  let id = String(termId);
  let next = nextId;
  if (usedTermIds.has(id)) id = String(next++);
  while (usedTermIds.has(id) || usedPaneIds.has(`pane-${id}`)) id = String(next++);
  return { id, paneId: `pane-${id}`, nextId: Math.max(next, Number(id) + 1), renumbered: id !== String(termId) };
}

/**
 * 生存ペインの AI の有無・エンジン・世代番号を、tmux に置いた値を優先して決める（issue #587）。
 * 画面の保存記録は異常終了で欠けたり、保存後のエンジン切り替えを反映していなかったりするため、
 * 接続情報のフォルダ名と世代番号がペインにあれば、Claude Code の作業ペインとして扱う。
 * @param {{backgroundWorkDir?: string|null, agentGeneration?: number|null}} identity tmux から得た生存ペイン。
 * @param {object|null} saved 画面の保存記録（無ければ null）。
 * @returns {{hasAgent: boolean, engine: string, generation: number, restoreBackgroundWork: boolean}}
 */
function resolveHolderPaneAgent(identity, saved = null) {
  const paneGeneration = Number.isSafeInteger(identity.agentGeneration) && identity.agentGeneration > 0 ? identity.agentGeneration : null;
  const restoreBackgroundWork = typeof identity.backgroundWorkDir === 'string' && identity.backgroundWorkDir !== '' && paneGeneration !== null;
  const hasAgent = restoreBackgroundWork || saved?.hasAgent === true;
  const engine = restoreBackgroundWork ? 'claude' : saved?.engine === 'codex' ? 'codex' : 'claude';
  const savedGeneration = saved && Number.isSafeInteger(saved.generation) && saved.generation > 0 ? saved.generation : null;
  let generation;
  if (saved) generation = paneGeneration ?? savedGeneration ?? 1;
  else generation = hasAgent ? paneGeneration : 0;
  return { hasAgent, engine, generation, restoreBackgroundWork };
}

module.exports = { missingSavedPaneCount, chooseUntrackedPaneIdentity, resolveHolderPaneAgent };
