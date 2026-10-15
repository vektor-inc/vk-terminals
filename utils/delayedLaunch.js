// 新規ペインの PTY へ起動コマンドを遅延して書き込む（issue #428）。
//
// PTY 作成から書き込みまでの待ち時間中に PTY が消える・書き込みが例外になることがある。
// どちらも Codex が起動しないので、専用 CODEX_HOME（discard）を回収する。例外はタイマーの外へ漏らさない。

/**
 * 起動コマンドの書き込みを予約する。
 * @param {object} params
 * @param {Map<string, object>} params.ptys ペイン ID → PTY の登録簿
 * @param {string} params.id ペイン ID
 * @param {{write: Function}} params.ptyProcess 書き込み先の PTY
 * @param {string} params.command 書き込む起動コマンド（改行は付けない）
 * @param {() => unknown} params.discard 書き込めなかったときに専用 CODEX_HOME を回収する関数
 * @param {number} params.delayMs 書き込むまでの待ち時間
 * @param {(message: string) => void} [params.log] 失敗の記録先
 * @param {Function} [params.setTimer] テスト用の setTimeout 差し替え
 * @returns {unknown} タイマーのハンドル
 */
function scheduleLaunchCommand({ ptys, id, ptyProcess, command, discard, delayMs, log = () => {}, setTimer = setTimeout }) {
  const discardSafely = () => {
    try {
      discard();
    } catch (error) {
      log(`failed to discard launch home: ${error && error.message ? error.message : error}`);
    }
  };
  return setTimer(() => {
    // 待っている間にペインが閉じた・同じ ID が別の PTY になった場合は、書き込まず回収する。
    if (ptys.get(id) !== ptyProcess) {
      discardSafely();
      return;
    }
    try {
      ptyProcess.write(`${command}\r`);
    } catch (error) {
      log(`failed to write launch command to terminal ${id}: ${error && error.message ? error.message : error}`);
      discardSafely();
    }
  }, delayMs);
}

module.exports = { scheduleLaunchCommand };
