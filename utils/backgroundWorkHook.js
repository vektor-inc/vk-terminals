'use strict';

// 認証情報は起動ごとの非公開ファイルから読み、コマンド引数やログへ出さない。
const fs = require('node:fs');
const http = require('node:http');
let body = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { body += chunk; if (Buffer.byteLength(body) > 8 * 1024 * 1024) process.exit(0); });
process.stdin.on('end', () => {
  try {
    const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
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
