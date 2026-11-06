'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 本文を受け取らず、送信結果だけを上限付きのファイルへ保存する。 */
function createPaneSendLog(dataDir, { maxBytes = 1024 * 1024, fsImpl = fs } = {}) {
  const file = path.join(dataDir, 'pane-send-log.jsonl');
  return record => {
    try {
      fsImpl.mkdirSync(dataDir, { recursive: true });
      const { time, id, source, target, engine, result, reason } = record;
      const line = JSON.stringify({ time, id, source, target, engine, result, reason }) + '\n';
      // 現行と退避の2ファイルだけに抑える。
      if (fsImpl.existsSync(file) && fsImpl.statSync(file).size + Buffer.byteLength(line) > maxBytes) {
        fsImpl.renameSync(file, file + '.1');
        fsImpl.chmodSync(file + '.1', 0o600);
      }
      fsImpl.appendFileSync(file, line, { mode: 0o600 });
      fsImpl.chmodSync(file, 0o600);
    } catch (error) { console.warn('pane-send log failed:', error.message); }
  };
}
module.exports = { createPaneSendLog };
