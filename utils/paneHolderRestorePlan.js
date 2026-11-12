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

module.exports = { missingSavedPaneCount, chooseUntrackedPaneIdentity };
