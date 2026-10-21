'use strict';

// 「セットアップ用ペインを自動で開くのは、このパソコンで初めて未完了と判定されたときの 1 回だけ」
// （issue #456）の判定と記録。記録は VK Terminals のデータフォルダ（~/.vk-terminals/）に置き、
// vk-orchestrator の setup.completedAt には書かない。

const fs = require('fs');
const path = require('path');

const AUTO_OPEN_RECORD_FILE = 'setup-auto-open.json';

/** 記録が既にあるか。読めない・壊れているときも「ある」扱いにして、自動で開く側へ倒さない。 */
function hasAutoOpenRecord(dataDir, fsImpl = fs) {
  const filePath = path.join(dataDir, AUTO_OPEN_RECORD_FILE);
  try {
    fsImpl.accessSync(filePath);
    return true;
  } catch (error) {
    return !(error && error.code === 'ENOENT');
  }
}

/** 記録を書く。書けたら true。書けなかったら false（呼び出し側は自動で開かない）。 */
function writeAutoOpenRecord(dataDir, now = Date.now, fsImpl = fs) {
  try {
    fsImpl.mkdirSync(dataDir, { recursive: true });
    fsImpl.writeFileSync(
      path.join(dataDir, AUTO_OPEN_RECORD_FILE),
      `${JSON.stringify({ openedAt: new Date(now()).toISOString() })}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
    return true;
  } catch (_error) {
    return false;
  }
}

/** 確認結果が「未完了」と言い切れる（確認に成功し、必須が欠けている）か。 */
function isSetupIncomplete(result) {
  return !!(result && result.ok === true && result.status && result.status.summary
    && result.status.summary.allRequiredOk === false);
}

/**
 * 起動時に作るペインをセットアップ用ペインにするか。
 * 未完了と判定され、かつ記録が無いときだけ true。確認できなかった場合は開かない（記録も残さない）。
 */
function shouldAutoOpenSetupPane({ result, recorded }) {
  return isSetupIncomplete(result) && recorded === false;
}

module.exports = {
  AUTO_OPEN_RECORD_FILE,
  hasAutoOpenRecord,
  writeAutoOpenRecord,
  isSetupIncomplete,
  shouldAutoOpenSetupPane,
};
