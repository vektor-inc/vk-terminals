'use strict';

const fs = require('fs');

const unknownState = () => ({ unknown: true });
const emptyState = () => ({ restartRequired: false, tabs: [] });

// 書き換え途中の破損を「不要」と誤認しないよう、未確認を区別する。
function normalizeRestartRequired(raw, tabIds) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)
    || typeof raw.restartRequired !== 'boolean' || !Array.isArray(raw.tabs)
    || !raw.tabs.every((tab) => typeof tab === 'string')) return unknownState();
  if (!raw.restartRequired) return emptyState();
  const allowed = new Set(tabIds);
  const tabs = [...new Set(raw.tabs.filter((tab) => typeof tab === 'string' && allowed.has(tab)))];
  return { restartRequired: tabs.length > 0, tabs };
}

function readRestartRequired(filePath, tabIds) {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 65536) return unknownState();
    const text = fs.readFileSync(filePath, 'utf8');
    return normalizeRestartRequired(JSON.parse(text), tabIds);
  } catch (error) {
    return error.code === 'ENOENT' ? emptyState() : unknownState();
  }
}

module.exports = { normalizeRestartRequired, readRestartRequired };
