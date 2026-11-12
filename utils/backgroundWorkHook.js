'use strict';

// 認証情報は起動ごとの非公開ファイルから読み、コマンド引数やログへ出さない。
// 接続ファイルは本人だけのフォルダ（0700）の 0600 ファイルに限り、検査に通らなければ送らない（issue #587）。
// このファイルは Claude Code から単独で起動されるため、同じフォルダの標準モジュールだけの部品に頼る。
const path = require('node:path');
const http = require('node:http');
const { readPrivateJsonFile } = require('./privateFile');
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 8 * 1024 * 1024) process.exit(0); });
process.stdin.on('end', () => {
  try {
    if (typeof process.argv[2] !== 'string' || !path.isAbsolute(process.argv[2])) return;
    const config = readPrivateJsonFile(process.argv[2]);
    const input = JSON.parse(body);
    const payload = JSON.stringify({ termId: config.termId, epoch: config.epoch, input: {
      hook_event_name: input.hook_event_name, source: input.source, agent_id: input.agent_id,
      session_id: input.session_id, transcript_path: input.transcript_path,
      agent_transcript_path: input.agent_transcript_path,
    } });
    const req = http.request(config.url, { method: 'POST', headers: {
      Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }, timeout: 2000 }, res => res.resume());
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.end(payload);
  } catch (_) {}
});
