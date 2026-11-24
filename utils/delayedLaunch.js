// 新規ペインの PTY へ起動コマンドを遅延して書き込む（issue #428）。
//
// PTY 作成から書き込みまでの待ち時間中に PTY が消える・書き込みが例外になることがある。
// どちらも Codex が起動しないので、専用 CODEX_HOME（discard）を回収する。例外はタイマーの外へ漏らさない。

// 起動直後の終了を検知してから起動し直すまでの待ち時間（issue #621）。
const DEFAULT_RELAUNCH_DELAY_MS = 500;

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
 * @param {Promise<{status: string, userInput: boolean}>|null} [params.shellReady] シェルの初期化待ち
 * @param {() => void} [params.onWriteSuccess] 書き込み成功時の通知先
 * @param {() => void} [params.onLaunchWritten] 起動コマンドを書き込むたびの通知先（起動し直しを含む）
 * @param {() => Promise<boolean>} [params.waitForEarlyExit] 起動直後に AI が終了したら true を返す待ち（issue #621）
 * @param {() => void} [params.onEarlyExit] 指定すると、起動直後の終了では起動し直さず、これを呼ぶ（起動試行。issue #657）
 * @param {() => boolean} [params.beforeLaunchWrite] 起動コマンドを書く直前の確認。false なら書かずに回収する（issue #657）
 * @param {() => void} [params.onLaunchWriteFailed] 起動コマンドの書き込みが例外になったときの通知先（issue #657）
 * @param {number} [params.relaunchDelayMs] 終了を検知してから起動し直すまでの待ち時間
 * @param {() => number} [params.getUserInputRevision] 利用者入力の番号（入力があるたびに進む）
 * @param {(message: string) => void} [params.log] 失敗の記録先
 * @param {Function} [params.setTimer] テスト用の setTimeout 差し替え
 * @returns {unknown} タイマーのハンドル
 */
function scheduleLaunchCommand({ ptys, id, ptyProcess, command, prepareCommand = (value) => ({ status: 'passthrough', command: value }), activateCommand = () => true, isLaunchCurrent = () => true, discard, delayMs, shellReady = null, onWriteSuccess = () => {}, onLaunchWritten = () => {}, waitForEarlyExit = null, onEarlyExit = null, beforeLaunchWrite = () => true, onLaunchWriteFailed = () => {}, relaunchDelayMs = DEFAULT_RELAUNCH_DELAY_MS, getUserInputRevision = () => 0, log = () => {}, setTimer = setTimeout }) {
  const discardSafely = () => {
    try {
      discard();
    } catch (error) {
      log(`failed to discard launch home: ${error && error.message ? error.message : error}`);
    }
  };
  // 起動し直しでは、1 度 Codex が使った専用フォルダを回収しない。
  let relaunching = false;
  const abandon = () => { if (!relaunching) discardSafely(); };
  // 起動後に利用者が入力していたら、起動し直しの書き込み（Ctrl+U・準備・起動コマンド）をしない。
  // 入力中の文字列を消したり、利用者が起動した別のプログラムへ書き込んだりしないため。
  let launchedUserInputRevision = null;
  const hasNoUserInputSinceLaunch = () => !relaunching || getUserInputRevision() === launchedUserInputRevision;
  const isLaunchValid = () => isLaunchCurrent() && hasNoUserInputSinceLaunch();
  const isStillCurrent = () => ptys.get(id) === ptyProcess && isLaunchValid();
  return setTimer(() => {
    // 待っている間にペインが閉じた・同じ ID が別の PTY になった場合は、書き込まず回収する。
    if (ptys.get(id) !== ptyProcess) {
      discardSafely();
      return;
    }
    // 起動直後に AI が終了したら、同じ起動コマンドで 1 回だけ起動し直す（issue #621）。
    // 起動し直した後は終了を確認しないため、何度も起動し直すことはない。
    const scheduleRelaunchOnEarlyExit = async () => {
      if (!waitForEarlyExit) return;
      let exited = false;
      try { exited = await waitForEarlyExit(); } catch (_error) { exited = false; }
      if (!exited) return;
      // 起動試行（issue #657）は初期指示を起動引数で渡すため、起動し直すと指示が二重に渡る。起動し直さず通知だけする。
      if (onEarlyExit) {
        try { onEarlyExit(); } catch (_error) {}
        return;
      }
      if (ptys.get(id) !== ptyProcess || !isLaunchCurrent() || getUserInputRevision() !== launchedUserInputRevision) return;
      log(`agent exited right after launch in terminal ${id}; relaunching once`);
      relaunching = true;
      // 終了直後の入力とシェルの再描画が落ち着いてから書き込む。
      setTimer(() => {
        if (!isStillCurrent()) return;
        runPrepare();
      }, relaunchDelayMs);
    };
    const writePreparedCommand = async (result) => {
      if (shellReady) {
        const readiness = await shellReady;
        // 時間切れまでに利用者が別プログラムを起動した場合は盲打ちしない。
        if (readiness?.status === 'timeout' && readiness.userInput) {
          log(`launch cancelled for terminal ${id}: shell readiness timed out after user input`);
          abandon();
          return;
        }
      }
      let setupWritten = false;
      let commandWriteStarted = false;
      let commandWritten = false;
      // 起動し直しの途中で利用者が入力していたら、cleanup も書き込まない。入力中の行や利用者が起動した別のプログラムへ
      // 混ざるため。残った bash の prompt hook は次のプロンプト表示で自分を外す（issue #621）。
      const cleanupPromptHook = () => {
        if (!setupWritten || !result?.cleanupCommand || ptys.get(id) !== ptyProcess || !hasNoUserInputSinceLaunch()) return;
        try { ptyProcess.write(`${result.cleanupCommand}\r`); } catch (_error) {}
      };
      if (result?.status === 'cancelled') {
        abandon();
        return;
      }
      if (!result || (result.status !== 'ready' && result.status !== 'passthrough')) {
        log(`failed to prepare launch command for terminal ${id}: invalid result`);
        abandon();
        return;
      }
      if (!isStillCurrent()) {
        abandon();
        return;
      }
      try {
        // 終了した Codex が残した入力がシェルの行に混ざらないよう、先に行を消す（Ctrl+U）。
        if (relaunching) ptyProcess.write('\x15');
        if (result.status === 'ready') {
          ptyProcess.write(`${result.setupCommand}\r`);
          setupWritten = true;
          const hookReady = await result.ready;
          // hook の出力待ちの間にも PTY identity・世代を再確認する。失敗時も元行は無加工で送る。
          if (!isStillCurrent()) {
            cleanupPromptHook();
            abandon();
            return;
          }
          if (!hookReady) {
            cleanupPromptHook();
            log(`prompt hook setup failed for terminal ${id}; lifecycle state is unknown`);
          }
          if (hookReady) await activateCommand();
          if (!isStillCurrent()) {
            cleanupPromptHook();
            abandon();
            return;
          }
        }
        if (!isStillCurrent()) {
          abandon();
          return;
        }
        if (!relaunching && !beforeLaunchWrite()) {
          cleanupPromptHook();
          abandon();
          return;
        }
        commandWriteStarted = true;
        ptyProcess.write(`${result.command}\r`);
        commandWritten = true;
        onLaunchWritten();
        if (relaunching) return;
        launchedUserInputRevision = getUserInputRevision();
        onWriteSuccess();
        scheduleRelaunchOnEarlyExit();
      } catch (error) {
        log(`failed to write launch command to terminal ${id}: ${error && error.message ? error.message : error}`);
        if (commandWriteStarted && !commandWritten && !relaunching) {
          try { onLaunchWriteFailed(); } catch (_error) {}
        }
        abandon();
      }
    };
    function runPrepare() {
      try {
        const preparedCommand = prepareCommand(command);
        if (preparedCommand && typeof preparedCommand.then === 'function') {
          preparedCommand.then(writePreparedCommand, (error) => {
            log(`failed to prepare launch command for terminal ${id}: ${error && error.message ? error.message : error}`);
            abandon();
          });
        } else {
          writePreparedCommand(preparedCommand);
        }
      } catch (error) {
        log(`failed to prepare launch command for terminal ${id}: ${error && error.message ? error.message : error}`);
        abandon();
      }
    }
    runPrepare();
  }, delayMs);
}

module.exports = { scheduleLaunchCommand, DEFAULT_RELAUNCH_DELAY_MS };
