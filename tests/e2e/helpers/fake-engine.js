// 一時 PATH の先頭へ置く偽 claude / 偽 codex のスクリプトに足す断片。
//
// VK Terminals は Codex が起動から 5 秒以内に終了すると、1 回だけ起動し直す（issue #621）。
// 呼び出しを記録してすぐ終了する偽 codex だと、この起動し直しで呼び出しが 1 回増えるため、
// 偽 codex は本物の Codex と同じく起動したまま残す。
// アプリ終了時の後始末から漏れても残り続けないよう、60 秒たったら自分から終了する。
// 偽 claude は起動し直しの対象外のため、従来どおり記録後すぐ終了する。
const FAKE_CODEX_STAY_ALIVE_MS = 60_000;

function fakeEngineStayAliveSource(binName) {
  return binName === 'codex' ? `setTimeout(() => {}, ${FAKE_CODEX_STAY_ALIVE_MS});\n` : '';
}

// 起動試行（issue #657）の E2E 用。偽 codex が、`--` の後ろで受け取った初期指示を、
// 本物の Codex と同じ形の rollout（専用 CODEX_HOME の sessions 配下）へ書く。
// 環境変数 VK_TERMINALS_E2E_CODEX_ROLLOUT=1 のときだけ動き、他の spec の偽 codex の動作は変えない。
// 本文に次の印があるときは、受領を確認できない場合を再現する。
//   [[e2e:no-rollout]]  rollout を書かずに起動したまま残る
//   [[e2e:exit-early]]  rollout を書かずに 1 秒後に終了する（起動直後の終了）
const FAKE_CODEX_NO_ROLLOUT_MARK = '[[e2e:no-rollout]]';
const FAKE_CODEX_EXIT_EARLY_MARK = '[[e2e:exit-early]]';

function fakeCodexRolloutSource(binName) {
  if (binName !== 'codex') return '';
  return `
if (process.env.VK_TERMINALS_E2E_CODEX_ROLLOUT === '1' && process.env.CODEX_HOME) {
  const path = require('path');
  const crypto = require('crypto');
  const argv = process.argv.slice(2);
  const separator = argv.indexOf('--');
  const prompt = separator >= 0 ? argv[separator + 1] : undefined;
  if (typeof prompt === 'string') {
    // 本物の Codex と同じく、起動の検知が追跡できる程度（1 秒）は動いてから終了する。
    if (prompt.includes(${JSON.stringify(FAKE_CODEX_EXIT_EARLY_MARK)})) { setTimeout(() => process.exit(0), 1000); return; }
    if (!prompt.includes(${JSON.stringify(FAKE_CODEX_NO_ROLLOUT_MARK)})) {
      const now = new Date();
      const dir = path.join(process.env.CODEX_HOME, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
      fs.mkdirSync(dir, { recursive: true });
      const sessionId = crypto.randomUUID();
      const lines = [
        { type: 'session_meta', payload: { id: sessionId, cwd: process.cwd(), cli_version: 'e2e-fake' } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions (e2e)' }] } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] } },
        { type: 'event_msg', payload: { type: 'item_completed', item: { type: 'UserMessage', content: [{ type: 'text', text: prompt }] } } },
      ];
      fs.writeFileSync(path.join(dir, 'rollout-e2e-' + sessionId + '.jsonl'), lines.map((line) => JSON.stringify(line)).join('\\n') + '\\n');
    }
  }
}
`;
}

module.exports = {
  fakeEngineStayAliveSource,
  fakeCodexRolloutSource,
  FAKE_CODEX_STAY_ALIVE_MS,
  FAKE_CODEX_NO_ROLLOUT_MARK,
  FAKE_CODEX_EXIT_EARLY_MARK,
};
