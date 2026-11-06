'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 本文を受け取らず、送信結果だけを上限付きのファイルへ保存する。 */
function createPaneSendLog(dataDir, { maxBytes = 1024 * 1024, fsImpl = fs } = {}) {
  const file = path.join(dataDir, 'pane-send-log.jsonl');
  return record => {
    let fd;
    // リンクを辿らず、FIFO でも main プロセスを待たせない。
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT
      | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const openRegular = () => {
      fd = fsImpl.openSync(file, flags, 0o600);
      const stat = fsImpl.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error('pane-send log is not a regular file');
      fsImpl.fchmodSync(fd, 0o600);
      return stat;
    };
    try {
      fsImpl.mkdirSync(dataDir, { recursive: true });
      const { time, id, source, target, engine, result, reason } = record;
      const line = JSON.stringify({ time, id, source, target, engine, result, reason }) + '\n';
      // サイズと権限は開いた通常ファイルで確認する。
      if (openRegular().size + Buffer.byteLength(line) > maxBytes) {
        fsImpl.renameSync(file, file + '.1');
        fsImpl.closeSync(fd);
        fd = undefined;
        openRegular();
      }
      fsImpl.writeSync(fd, line);
    } catch (error) { console.warn('pane-send log failed:', error.message); }
    finally { if (fd !== undefined) fsImpl.closeSync(fd); }
  };
}
module.exports = { createPaneSendLog };
