'use strict';

const fs = require('fs');

// 外部プロセスが差し替える小さな状態ファイル。読めない状態は案内なしに倒す。
function normalizeRestartRequired(raw, tabIds) {
  if (!raw || raw.restartRequired !== true || !Array.isArray(raw.tabs)) return { restartRequired: false, tabs: [] };
  const allowed = new Set(tabIds);
  const tabs = [...new Set(raw.tabs.filter((tab) => typeof tab === 'string' && allowed.has(tab)))];
  return { restartRequired: tabs.length > 0, tabs };
}

function readRestartRequired(filePath, tabIds) {
  try {
    const text = fs.readFileSync(filePath, 'utf8');
    if (text.length > 65536) return { restartRequired: false, tabs: [] };
    return normalizeRestartRequired(JSON.parse(text), tabIds);
  } catch (_error) {
    return { restartRequired: false, tabs: [] };
  }
}

module.exports = { normalizeRestartRequired, readRestartRequired };
