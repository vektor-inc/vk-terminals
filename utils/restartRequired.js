'use strict';

const fs = require('fs');

const emptyState = () => ({ restartRequired: false, tabs: [] });

// 外部プロセスが差し替える小さな状態ファイル。読めない状態は案内なしに倒す。
function normalizeRestartRequired(raw, tabIds) {
  if (!raw || raw.restartRequired !== true || !Array.isArray(raw.tabs)) return emptyState();
  const allowed = new Set(tabIds);
  const tabs = [...new Set(raw.tabs.filter((tab) => typeof tab === 'string' && allowed.has(tab)))];
  return { restartRequired: tabs.length > 0, tabs };
}

function readRestartRequired(filePath, tabIds) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 65536) return emptyState();
    const text = fs.readFileSync(filePath, 'utf8');
    return normalizeRestartRequired(JSON.parse(text), tabIds);
  } catch (_error) {
    return emptyState();
  }
}

module.exports = { normalizeRestartRequired, readRestartRequired };
