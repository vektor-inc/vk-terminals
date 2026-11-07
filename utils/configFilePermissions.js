'use strict';
const fs = require('fs');
const { USER_CONFIG_MAX_BYTES } = require('./configLiveReload');

/** 設定の保存を通らない場合も、既存ファイルの権限を修復する。 */
function repairTokenConfigPermissions(targetPath, { fsImpl = fs, platform = process.platform, warn = console.warn } = {}) {
  if (platform === 'win32') return;
  let fd;
  try {
    // 読み込みと同じくリンク先を対象にし、確認と変更には同じ実体の FD を使う。
    fd = fsImpl.openSync(targetPath, 'r');
    const stat = fsImpl.fstatSync(fd);
    if (stat.isFile() && (stat.mode & 0o077) !== 0) fsImpl.fchmodSync(fd, 0o600);
  } catch (_error) {
    // 例外の詳細には秘密情報が混ざる可能性があるため出さない。
    warn('[vk-terminals] API token config permissions could not be secured.');
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch (_error) {
        warn('[vk-terminals] API token config file could not be closed.');
      }
    }
  }
}

/** 選択されなかった候補も、トークンを保持している場合や内容を判定できない場合に修復する。 */
function repairOtherTokenConfigPermissions(candidatePaths, selectedPath, { fsImpl = fs, platform = process.platform, warn = console.warn } = {}) {
  if (platform === 'win32') return;
  // 壊れた候補があっても、残りの候補の確認と起動を続ける。
  for (const candidatePath of candidatePaths) {
    if (candidatePath === selectedPath) continue;
    try {
      const stat = fsImpl.statSync(candidatePath);
      if (!stat.isFile()) continue;
      // 内容を判定できない候補は、トークンありとして修復する。
      let shouldRepair = true;
      if (stat.size <= USER_CONFIG_MAX_BYTES) {
        try {
          shouldRepair = typeof JSON.parse(fsImpl.readFileSync(candidatePath, 'utf8'))?.apiToken === 'string';
        } catch (_error) {
          // 本文に JSON の断片が入るため、例外は出力しない。
        }
      }
      if (shouldRepair) repairTokenConfigPermissions(candidatePath, { fsImpl, platform, warn });
    } catch (_error) {
      // 読み取り失敗の詳細には秘密情報が含まれうるため出力しない。
    }
  }
}

module.exports = { repairTokenConfigPermissions, repairOtherTokenConfigPermissions };
