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

/**
 * 起動時に作る最初のペインの判断（IPC setup:initial-pane の中身）。
 * 記録がある（2 回目以降）なら自動で開かないことは確定しているので、確認の結果を待たずに返す
 * （待つと doctor が遅いとき、起動のたびに最大 waitMs だけ最初のペインが遅れる）。
 * その場合 result は null で返し、renderer は既存の経路（setupPanel.recheck）で後から結果を取り込む。
 * 記録が無いときだけ、確認の結果を最大 waitMs 待つ。間に合わなければ通常のペイン（記録も残さない）。
 * claudeOk は、確認結果の中で id が `claude` の行が ok のときだけ true。行が無いときは Claude Code が
 * 無いものとして扱い、Claude 無しのシェルで開く（command not found を見せない側へ倒す）。
 */
async function decideSetupInitialPane({ recorded, getResult, waitMs, writeRecord }) {
  const normal = { autoOpen: false, claudeOk: false, result: null };
  if (recorded) return normal;
  let timer = null;
  let result;
  try {
    result = await Promise.race([
      getResult(),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), waitMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  if (!result) return normal;
  const claudeOk = result.ok === true
    && result.status.requirements.some((row) => row.id === 'claude' && row.ok);
  // 記録を書けたときだけ自動で開く（書けないまま開くと、起動のたびに開いてしまうため）。
  const autoOpen = shouldAutoOpenSetupPane({ result, recorded }) && writeRecord();
  return { autoOpen, claudeOk, result };
}

module.exports = {
  decideSetupInitialPane,
  AUTO_OPEN_RECORD_FILE,
  hasAutoOpenRecord,
  writeAutoOpenRecord,
  isSetupIncomplete,
  shouldAutoOpenSetupPane,
};
