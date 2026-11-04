'use strict';

const fs = require('fs');
const path = require('path');
const KEYS = ['newPaneStartupDir', 'newPaneAutoLaunchClaude', 'confirmClose', 'terminalLinkClickMode', 'menuItems', 'waitingExcludeCwdPatterns'];

// 未指定値は起動時と同じ既定値へ寄せ、対象キーを一括検証する。
function normalizeLiveConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid config');
  const defaults = { newPaneStartupDir: '', newPaneAutoLaunchClaude: false, confirmClose: 'busy', terminalLinkClickMode: 'click', menuItems: [], waitingExcludeCwdPatterns: [] };
  const result = { ...defaults };
  for (const key of KEYS) {
    if (raw[key] == null) continue;
    const value = raw[key];
    if (key === 'newPaneStartupDir' && typeof value === 'string') result[key] = value.trim();
    else if (key === 'newPaneAutoLaunchClaude' && typeof value === 'boolean') result[key] = value;
    else if (key === 'confirmClose' && ['never', 'busy', 'always'].includes(value)) result[key] = value;
    else if (key === 'terminalLinkClickMode' && ['click', 'modifier'].includes(value)) result[key] = value;
    else if (key === 'waitingExcludeCwdPatterns' && Array.isArray(value) && value.every((v) => typeof v === 'string')) result[key] = value;
    else if (key === 'menuItems' && Array.isArray(value)) result[key] = value;
    else throw new Error(`invalid ${key}`);
  }
  return result;
}

function changedLiveKeys(before, after) {
  return KEYS.filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]));
}

function normalizeReflection(raw) {
  if (!raw || raw.version !== 1 || !(raw.eventId === null || typeof raw.eventId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw.eventId))
    || !Array.isArray(raw.appliedKeys) || !raw.appliedKeys.every((v) => typeof v === 'string')
    || !Array.isArray(raw.failedFiles) || !raw.failedFiles.every((v) => typeof v === 'string' && path.isAbsolute(v))) throw new Error('invalid reflection');
  return { eventId: raw.eventId, failedFiles: [...new Set(raw.failedFiles)] };
}

function readSmallJson(filePath) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > 65536) throw new Error('invalid file');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function reflectionMessage(restartRequired) {
  return restartRequired ? '一部の設定を反映しました' : '設定を反映しました';
}

module.exports = { normalizeLiveConfig, changedLiveKeys, normalizeReflection, readSmallJson, reflectionMessage };
