'use strict';

const path = require('node:path');
const { descriptorFieldTargetEntries } = require('../settingsTargets');
const { normalizeOptionalHttpUrl } = require('../renderer/urlSafety');
const { readSmallJson, USER_CONFIG_MAX_BYTES } = require('./configLiveReload');

function readOrchestratorOwners(descriptor, homeDir) {
  // 設定パネルと同じ保存先を優先し、単体起動では利用者の標準設定先を読む。
  const entry = descriptorFieldTargetEntries(descriptor).find(({ field }) => field.key === 'github.owner');
  if (entry?.field.type === 'password') return undefined;
  const configPath = entry?.targetPath || path.join(homeDir, '.vk-orchestrator', 'config.json');
  try {
    return readSmallJson(configPath, USER_CONFIG_MAX_BYTES)?.github?.owner;
  } catch {
    return undefined;
  }
}

function resolveInternalBrowserHomeUrl(configuredUrl, readOwners) {
  const url = normalizeOptionalHttpUrl(configuredUrl);
  if (url !== '') return url || '';

  // 空行は設定パネルと同じく無視し、旧形式の文字列も先頭の値として受け付ける。
  const owners = readOwners();
  const first = Array.isArray(owners) ? owners.find(owner => typeof owner !== 'string' || owner.trim()) : owners;
  const owner = typeof first === 'string' ? first.trim() : '';
  return /^[a-z\d](?:[a-z\d-]{0,37}[a-z\d])?$/i.test(owner) ? `https://github.com/${owner}` : '';
}

module.exports = { readOrchestratorOwners, resolveInternalBrowserHomeUrl };
