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
 * @param {(command: string) => object|Promise<object>} [params.prepareCommand] 書き込み直前の変換
 * @param {() => boolean|Promise<boolean>} [params.activateCommand] ready 後の取得開始
 * @param {() => boolean} [params.isLaunchCurrent] 起動世代と token の最終照合
 * @param {() => unknown} params.discard 書き込めなかったときに専用 CODEX_HOME を回収する関数
 * @param {number} params.delayMs 書き込むまでの待ち時間
 * @param {() => void} [params.onWriteSuccess] 書き込み成功時の通知先
 * @param {(message: string) => void} [params.log] 失敗の記録先
 * @param {Function} [params.setTimer] テスト用の setTimeout 差し替え
 * @returns {unknown} タイマーのハンドル
 */
function scheduleLaunchCommand({ ptys, id, ptyProcess, command, prepareCommand = (value) => ({ status: 'passthrough', command: value }), activateCommand = () => true, isLaunchCurrent = () => true, discard, delayMs, onWriteSuccess = () => {}, log = () => {}, setTimer = setTimeout }) {
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
    const writePreparedCommand = async (result) => {
      let setupWritten = false;
      const cleanupPromptHook = () => {
        if (!setupWritten || !result?.cleanupCommand || ptys.get(id) !== ptyProcess) return;
        try { ptyProcess.write(`${result.cleanupCommand}\r`); } catch (_error) {}
      };
      if (result?.status === 'cancelled') {
        discardSafely();
        return;
      }
      if (!result || (result.status !== 'ready' && result.status !== 'passthrough')) {
        log(`failed to prepare launch command for terminal ${id}: invalid result`);
        discardSafely();
        return;
      }
      if (ptys.get(id) !== ptyProcess || !isLaunchCurrent()) {
        discardSafely();
        return;
      }
      try {
        if (result.status === 'ready') {
          ptyProcess.write(`${result.setupCommand}\r`);
          setupWritten = true;
          const hookReady = await result.ready;
          // hook の出力待ちの間にも PTY identity・世代を再確認する。失敗時も元行は無加工で送る。
          if (ptys.get(id) !== ptyProcess || !isLaunchCurrent()) {
            cleanupPromptHook();
            discardSafely();
            return;
          }
          if (!hookReady) {
            cleanupPromptHook();
            log(`prompt hook setup failed for terminal ${id}; lifecycle state is unknown`);
          }
          if (hookReady) await activateCommand();
          if (ptys.get(id) !== ptyProcess || !isLaunchCurrent()) {
            cleanupPromptHook();
            discardSafely();
            return;
          }
        }
        if (ptys.get(id) !== ptyProcess || !isLaunchCurrent()) {
          discardSafely();
          return;
        }
        ptyProcess.write(`${result.command}\r`);
        onWriteSuccess();
      } catch (error) {
        log(`failed to write launch command to terminal ${id}: ${error && error.message ? error.message : error}`);
        discardSafely();
      }
    };
    try {
      const preparedCommand = prepareCommand(command);
      if (preparedCommand && typeof preparedCommand.then === 'function') {
        preparedCommand.then(writePreparedCommand, (error) => {
          log(`failed to prepare launch command for terminal ${id}: ${error && error.message ? error.message : error}`);
          discardSafely();
        });
      } else {
        writePreparedCommand(preparedCommand);
      }
    } catch (error) {
      log(`failed to prepare launch command for terminal ${id}: ${error && error.message ? error.message : error}`);
      discardSafely();
    }
  }, delayMs);
}

module.exports = { scheduleLaunchCommand };
