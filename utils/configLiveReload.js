'use strict';

const fs = require('fs');
const path = require('path');
const USER_CONFIG_MAX_BYTES = 1024 * 1024;
const KEYS = ['newPaneStartupDir', 'newPaneAutoLaunchClaude', 'confirmClose', 'terminalLinkClickMode', 'menuItems', 'waitingExcludeCwdPatterns'];

// 未指定値は起動時と同じ既定値へ寄せ、対象キーを一括検証する。
function normalizeLiveConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid config');
  const { normalizeConfirmClose } = require('./closeConfirm');
  const { normalizeWaitingExcludeCwdPatterns } = require('../renderer/waitingState');
  const { normalizeTerminalLinkClickMode } = require('./terminalLinkPolicy');
  const result = {
    newPaneStartupDir: typeof raw.newPaneStartupDir === 'string' ? raw.newPaneStartupDir.trim() : '',
    newPaneAutoLaunchClaude: raw.newPaneAutoLaunchClaude === true,
    confirmClose: normalizeConfirmClose(raw.confirmClose),
    terminalLinkClickMode: normalizeTerminalLinkClickMode(raw.terminalLinkClickMode),
    menuItems: Array.isArray(raw.menuItems) ? raw.menuItems : [],
    waitingExcludeCwdPatterns: normalizeWaitingExcludeCwdPatterns(raw.waitingExcludeCwdPatterns),
  };
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

function readSmallJson(filePath, maxBytes = 65536) {
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > maxBytes) throw new Error('invalid file');
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// 失敗中の差分は復旧まで保持し、反映イベント自体はその周期で消費する。
function advanceReflection(previous, input) {
  const config = input.config || previous.config;
  const changedKeys = config ? changedLiveKeys(previous.config || normalizeLiveConfig({}), config) : [];
  const pendingKeys = [...new Set([...(previous.pendingKeys || []), ...changedKeys])];
  const failed = input.failedFiles.length > 0;
  return {
    config,
    eventId: input.eventId,
    initialized: true,
    pendingKeys: failed ? pendingKeys : [],
    changedKeys: failed ? [] : pendingKeys,
    eventChanged: !failed && !!previous.initialized && !!input.eventId && input.eventId !== previous.eventId,
    failedFiles: [...new Set(input.failedFiles)].sort(),
  };
}

module.exports = { USER_CONFIG_MAX_BYTES, normalizeLiveConfig, changedLiveKeys, normalizeReflection, readSmallJson, advanceReflection };
